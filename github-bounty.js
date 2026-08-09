"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — GitHub Issue Bounty Hunter
//
// Scans public GitHub repos for open, unassigned issues Jarvis might
// realistically be able to fix, has a model triage each one for
// feasibility/difficulty, and drafts an offer comment ("I can take
// this on for $X — here's my plan"). It does NOT post anything, open
// a PR, or make any commitment on its own — every candidate sits in
// a pending queue until a human calls approveCandidate() (voice/chat:
// "approve bounty <id>", or the /api/bounty/:id/approve route from
// the dashboard). Only approval actually hits the GitHub API.
//
// Triage model order: Ollama Cloud first, Groq as fallback. If
// OLLAMA_API_KEY isn't set, this skips straight to Groq — same
// behavior as before. See groqJSON() below.
//
// Why the human gate matters here, specifically:
//   - The triage model's "feasible/easy" call is a heuristic read of
//     the issue text, not a guarantee. Jarvis hasn't cloned the repo,
//     built it, or run its test suite, so it can be wrong about scope.
//   - A price offer posted in public, under your GitHub identity, is
//     a real commitment to a real maintainer. Getting that wrong
//     costs reputation, not just money.
//   - Only "easy" + high-confidence issues are ever queued with a
//     price attached; "medium" ones are queued but flagged for a
//     closer look; "hard" ones are logged and skipped entirely.
//
// Posting requires a GitHub token with permission to comment on the
// target repo (GITHUB_BOUNTY_TOKEN, falling back to the existing
// GITHUB_TOKEN). Use a token tied to whatever GitHub account you
// actually want maintainers to see and pay.
//
// ── BOUNTY_AUTO_PUBLISH ────────────────────────────────────────
// Same idea as direct-store.js's STORE_AUTO_PUBLISH. Default is
// "false": every candidate lands in the pending queue as
// "pending_review" and a human calls approveCandidate() before
// anything is posted to GitHub. Set BOUNTY_AUTO_PUBLISH=true as a
// repo/Actions secret and scanForBounties() will post the offer
// comment itself for any "easy", high-confidence candidate the
// moment it's found — no queue, no manual approve step.
//
// This only auto-skips the "should we even offer on this" review.
// It does NOT skip the separate, more important gate later in the
// pipeline: coding only ever happens after checkPostedForReplies()
// reads an ACTUAL maintainer reply and classifies it as a clear
// yes (see the "awaiting_code" status below and bounty-coder.js).
// So with this on, the fully autonomous loop is: scan finds an
// issue -> auto-posts an offer -> next scheduled run checks for a
// maintainer reply -> only if they said yes, bounty-coder.js codes
// it and opens a draft PR for you to review. "Medium" candidates
// still always land in the queue for manual review regardless of
// this flag, since they're explicitly the ones Jarvis is less sure
// about.
//
// Turning the flag on also sweeps the EXISTING pending queue: any
// "easy" candidate already sitting there un-reviewed (found before
// the flag was set, or left behind by a failed auto-post) gets its
// offer posted too, at the start of the very next scan — see
// autoPublishBacklog() below. From there it flows through the same
// pipeline as everything else: scheduled-bounty-scan.js already
// runs checkPostedForReplies() and BountyCoder.codeAllAwaiting()
// right after every scan, so a backlog candidate that gets a "yes"
// reply is coded automatically in a later run, same as any other.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const GroqKeys = require("./groq-keys");
const Groq     = require("./hermes-engine");

// ── CONFIG ──────────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_BOUNTY_TOKEN || process.env.GITHUB_TOKEN || "";
const GITHUB_API    = "https://api.github.com";
const GROQ_API_URL  = "https://api.groq.com/openai/v1/chat/completions";

const MIN_PRICE   = Number(process.env.BOUNTY_MIN_PRICE_USD) || 5;
const MAX_PRICE   = Number(process.env.BOUNTY_MAX_PRICE_USD) || 40;
const MAX_PER_SCAN = Number(process.env.BOUNTY_MAX_PER_SCAN) || 8;
const MIN_CONFIDENCE = Number(process.env.BOUNTY_MIN_CONFIDENCE) || 0.6;
const AUTO_PUBLISH = String(process.env.BOUNTY_AUTO_PUBLISH || "false").toLowerCase() === "true";

// Comma-separated allowlist, e.g. "javascript,typescript,python" —
// empty means "any language".
const LANGUAGES = (process.env.BOUNTY_LANGUAGES || "")
  .split(",").map(s => s.trim()).filter(Boolean);

const DEFAULT_QUERIES = [
  'label:"good first issue" state:open is:issue no:assignee',
  'label:"help wanted" state:open is:issue no:assignee',
  'label:bounty state:open is:issue',
];

const DATA_DIR    = path.join(__dirname, "data");
const STORE_PATH  = path.join(DATA_DIR, "bounty-queue.json");

function isConfigured() {
  return !!GITHUB_TOKEN;
}

// ── LOCAL STORE ─────────────────────────────────────────────────
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return { pending: [], history: [], seen: {}, nextId: 1 };
    const raw = JSON.parse(fs.readFileSync(STORE_PATH, "utf8") || "{}");
    return { pending: [], history: [], seen: {}, nextId: 1, ...raw };
  } catch {
    return { pending: [], history: [], seen: {}, nextId: 1 };
  }
}
function saveStore(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ── GITHUB API HELPERS ──────────────────────────────────────────
async function ghFetch(pathSuffix, { method = "GET", body } = {}) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "jarvis-bounty-hunter",
  };
  if (GITHUB_TOKEN) headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  if (body) headers["Content-Type"] = "application/json";

  const res = await fetch(`${GITHUB_API}${pathSuffix}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data?.message || `GitHub API returned ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function searchIssues(query, { perQuery = 10 } = {}) {
  let q = query;
  for (const lang of LANGUAGES) q += ` language:${lang}`;
  const data = await ghFetch(`/search/issues?q=${encodeURIComponent(q)}&sort=created&order=desc&per_page=${perQuery}`);
  return Array.isArray(data.items) ? data.items : [];
}

async function postComment(owner, repo, issueNumber, body) {
  return ghFetch(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    body: { body },
  });
}

// ── TRIAGE MODEL: OLLAMA CLOUD FIRST, GROQ AS FALLBACK ───────────
// The scan step (evaluateIssue's feasibility/difficulty call, and
// checkPostedForReplies' maintainer-verdict call) tries Ollama Cloud
// first — same hosted service local-llm.js already wires up for
// hermes-engine.js, just tried in the OPPOSITE order here: Ollama
// Cloud primary, Groq secondary. Only needs OLLAMA_API_KEY set; if
// it's not configured at all, this skips straight to Groq exactly
// like before. If Ollama Cloud IS configured but the call itself
// fails (quota, timeout, bad response), it falls through to the same
// multi-key Groq path that used to be the only option.
const LocalLLM = require("./local-llm");

async function ollamaCloudJSON(systemPrompt, userPrompt, { model } = {}) {
  const useModel = model || process.env.BOUNTY_OLLAMA_MODEL || LocalLLM.OLLAMA_CLOUD_MODEL_FAST;
  const msg = await LocalLLM.ollamaCloudChat(
    [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
    { model: useModel, temperature: 0.2, maxTokens: 1024, format: "json" }
  );
  return JSON.parse(msg.content || "{}");
}

// Direct fetch (mirrors jarvis-agent.js's askGroq) so we can force
// response_format: json_object — hermes-engine's shared helper
// doesn't expose that option.
async function groqJSONOnly(systemPrompt, userPrompt, { model } = {}) {
  if (!GroqKeys.hasGroqKey()) throw new Error("GROQ_API_KEY not set in .env");
  const useModel = model || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";
  const totalKeys = GroqKeys.groqKeyCount();
  let lastError = null;

  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = GroqKeys.currentGroqKey();
    const isLastKey = attempt === totalKeys - 1;
    try {
      const res = await fetch(GROQ_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: useModel,
          response_format: { type: "json_object" },
          temperature: 0.2,
          messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
        }),
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) {
        if ((res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) && !isLastKey) {
          GroqKeys.rotateGroqKey();
          continue;
        }
        throw new Error(`Groq API error ${res.status}`);
      }
      const data = await res.json();
      const raw = data?.choices?.[0]?.message?.content || "{}";
      return JSON.parse(raw);
    } catch (e) {
      lastError = e;
      if (!isLastKey) { GroqKeys.rotateGroqKey(); continue; }
    }
  }
  throw lastError || new Error("Groq triage failed.");
}

// Public entry point every caller in this file already uses — same
// name and signature as before, so nothing downstream needs to change.
async function groqJSON(systemPrompt, userPrompt, opts = {}) {
  if (LocalLLM.isCloudConfigured()) {
    try {
      return await ollamaCloudJSON(systemPrompt, userPrompt, opts);
    } catch (e) {
      console.warn(`[BOUNTY] Ollama Cloud triage failed (${e.message}) — falling back to Groq...`);
    }
  }
  return groqJSONOnly(systemPrompt, userPrompt, opts);
}

const TRIAGE_SYSTEM_PROMPT = `You are a careful software engineer triaging GitHub issues to decide whether an AI coding assistant could realistically fix one, unsupervised, without ever having built or run the target repo. Be conservative — false "easy" calls waste a maintainer's time and damage trust. Reply with ONLY this JSON shape, no prose, no markdown fences:
{
  "feasible": boolean,
  "difficulty": "easy" | "medium" | "hard",
  "confidence": 0.0-1.0,
  "estimated_minutes": number,
  "summary": "one sentence on what the fix likely involves",
  "risks": ["short phrase", "..."]
}
"easy" means: a small, well-localized change (typo, small logic bug, missing null check, simple config/docs fix, a clearly-described small feature) where the issue text alone gives enough info to know roughly what to change. "medium" means real but bounded work. "hard" or genuinely ambiguous issues (needs repo-specific context, large refactor, unclear repro, design decisions) should never be marked easy.`;

async function evaluateIssue(issue) {
  const body = String(issue.body || "").slice(0, 3000);
  const userPrompt = `Repo: ${issue.repository_url ? issue.repository_url.split("/").slice(-2).join("/") : "unknown"}
Title: ${issue.title}
Comments so far: ${issue.comments}
Body:
${body || "(no description provided)"}`;
  return groqJSON(TRIAGE_SYSTEM_PROMPT, userPrompt);
}

function priceForDifficulty(difficulty, estimatedMinutes) {
  const base = difficulty === "easy" ? MIN_PRICE : (difficulty === "medium" ? MIN_PRICE * 2 : MIN_PRICE * 3);
  const minuteBump = Math.floor((estimatedMinutes || 0) / 30) * 5;
  return Math.min(MAX_PRICE, base + minuteBump);
}

async function draftProposal(issue, evaluation, priceUsd) {
  const prompt = `Draft a short, professional GitHub issue comment offering to fix this issue.

Issue title: ${issue.title}
Likely fix (from triage): ${evaluation.summary}

Requirements for the comment:
- 3-5 sentences, plain and direct, no fluff or exclamation points.
- Reference what the fix likely involves, based on the triage summary above.
- Offer to do it for $${priceUsd} USD, explicitly framed as an ESTIMATE contingent on the scope not being bigger than it looks from the issue alone — invite the maintainer to confirm before work starts.
- Do not guarantee a delivery time more specific than "within a day or two of getting the go-ahead."
- Do not claim to have already written or tested a fix.
- Sign off as an offer, not a claim of ownership of the issue.
- Return ONLY the comment text, no markdown headers, no code fences.`;
  const { reply } = await Groq.codeChat(prompt, { userTitle: "Sir" });
  return reply.trim();
}

// ── BACKLOG SWEEP ──────────────────────────────────────────────
// When AUTO_PUBLISH just got turned on, there can already be "easy"
// candidates sitting in the pending queue from before (either found
// while auto-publish was off, or left behind by a failed auto-post
// attempt). This posts the offer for any of those too, so turning
// the flag on doesn't leave old candidates stuck waiting for a
// manual approve that's never coming. Same "easy only" restriction
// as the inline auto-publish path above. Called automatically at the
// top of scanForBounties() when AUTO_PUBLISH is true; also exported
// standalone so it can be triggered on its own (dashboard/voice) if
// the flag gets turned on between scheduled scans.
async function autoPublishBacklog() {
  const store = loadStore();
  const results = { autoPosted: [], errors: [] };
  if (!AUTO_PUBLISH || !isConfigured()) return results;

  const backlog = store.pending.filter(c => c.difficulty === "easy");
  for (const c of backlog) {
    const idx = store.pending.findIndex(x => x.id === c.id);
    if (idx === -1) continue;
    try {
      const comment = await postComment(c.owner, c.repo, c.issueNumber, c.proposalText);
      c.status = "posted";
      c.postedAt = new Date().toISOString();
      c.commentUrl = comment.html_url;
      c.autoPublished = true;
      c.autoPublishedFromBacklog = true;
      store.pending.splice(idx, 1);
      store.history.push(c);
      results.autoPosted.push({ id: c.id, key: c.key, title: c.title, priceUsd: c.priceUsd, commentUrl: comment.html_url });
    } catch (e) {
      results.errors.push({ issue: c.key, error: `Backlog auto-publish failed: ${e.message}` });
    }
  }

  saveStore(store);
  return results;
}

// ── SCAN ─────────────────────────────────────────────────────────
async function scanForBounties({ queries = DEFAULT_QUERIES, maxPerScan = MAX_PER_SCAN } = {}) {
  if (!isConfigured()) {
    return { error: "No GitHub token configured. Set GITHUB_BOUNTY_TOKEN (or GITHUB_TOKEN) in .env." };
  }

  // Sweep any pre-existing "easy" candidates left pending from before
  // AUTO_PUBLISH was turned on (or from a prior failed auto-post).
  const backlogResult = AUTO_PUBLISH
    ? await autoPublishBacklog()
    : { autoPosted: [], errors: [] };

  const store = loadStore();
  const results = {
    queued: [], flagged_medium: [], skipped: [], errors: [...backlogResult.errors],
    autoPosted: [...backlogResult.autoPosted],
  };

  outer:
  for (const query of queries) {
    let items;
    try {
      items = await searchIssues(query, { perQuery: 10 });
    } catch (e) {
      results.errors.push({ query, error: e.message });
      continue;
    }

    for (const issue of items) {
      if (results.queued.length + results.flagged_medium.length >= maxPerScan) break outer;
      if (issue.pull_request) continue; // search/issues can return PRs too
      const [owner, repo] = (issue.repository_url || "").split("/").slice(-2);
      if (!owner || !repo) continue;
      const key = `${owner}/${repo}#${issue.number}`;
      if (store.seen[key]) continue;

      let evaluation;
      try {
        evaluation = await evaluateIssue(issue);
      } catch (e) {
        results.errors.push({ issue: key, error: e.message });
        continue;
      }

      store.seen[key] = { at: new Date().toISOString(), difficulty: evaluation.difficulty };

      if (!evaluation.feasible || evaluation.difficulty === "hard" || evaluation.confidence < MIN_CONFIDENCE) {
        results.skipped.push({ issue: key, title: issue.title, evaluation });
        continue;
      }

      const priceUsd = priceForDifficulty(evaluation.difficulty, evaluation.estimated_minutes);
      let proposalText = "";
      try {
        proposalText = await draftProposal(issue, evaluation, priceUsd);
      } catch (e) {
        results.errors.push({ issue: key, error: `Draft failed: ${e.message}` });
        continue;
      }

      const candidate = {
        id: store.nextId++,
        key,
        owner, repo,
        issueNumber: issue.number,
        title: issue.title,
        url: issue.html_url,
        difficulty: evaluation.difficulty,
        confidence: evaluation.confidence,
        estimatedMinutes: evaluation.estimated_minutes,
        summary: evaluation.summary,
        risks: evaluation.risks || [],
        priceUsd,
        proposalText,
        status: "pending_review",
        discoveredAt: new Date().toISOString(),
      };

      // Auto-publish only ever applies to "easy" candidates — medium
      // ones always go to the manual queue, auto-publish or not.
      if (AUTO_PUBLISH && evaluation.difficulty === "easy") {
        try {
          const comment = await postComment(candidate.owner, candidate.repo, candidate.issueNumber, candidate.proposalText);
          candidate.status = "posted";
          candidate.postedAt = new Date().toISOString();
          candidate.commentUrl = comment.html_url;
          candidate.autoPublished = true;
          store.history.push(candidate);
          results.autoPosted.push({ id: candidate.id, key, title: issue.title, priceUsd, commentUrl: comment.html_url });
        } catch (e) {
          // Couldn't post it automatically — don't lose the candidate,
          // just fall back to the manual queue same as non-auto mode.
          candidate.status = "pending_review";
          store.pending.push(candidate);
          results.errors.push({ issue: key, error: `Auto-publish failed, left for manual review: ${e.message}` });
        }
        continue;
      }

      store.pending.push(candidate);
      (evaluation.difficulty === "easy" ? results.queued : results.flagged_medium).push({ id: candidate.id, key, title: issue.title, priceUsd });
    }
  }

  saveStore(store);
  return results;
}

// ── QUEUE MANAGEMENT ────────────────────────────────────────────
function listPending() {
  return loadStore().pending;
}
function listHistory() {
  return loadStore().history.slice(-50).reverse();
}
function getCandidate(id) {
  return loadStore().pending.find(c => c.id === Number(id)) || null;
}

function editCandidate(id, updates = {}) {
  const store = loadStore();
  const c = store.pending.find(x => x.id === Number(id));
  if (!c) return { error: `No pending candidate with id ${id}.` };
  if (updates.priceUsd != null) c.priceUsd = Number(updates.priceUsd);
  if (updates.message != null) c.proposalText = String(updates.message);
  saveStore(store);
  return c;
}

// Posts the offer comment for a single approved candidate — the core
// GitHub-writing action, used both by the explicit human "approve"
// action below and by the AUTO_PUBLISH paths above/in
// autoPublishBacklog(), which call postComment() directly the same
// way rather than going through this function (they need to move
// the candidate between store.pending/store.history as part of a
// batch, so they inline the same steps instead of loading/saving the
// store twice per candidate).
async function approveCandidate(id) {
  if (!isConfigured()) return { error: "No GitHub token configured." };
  const store = loadStore();
  const idx = store.pending.findIndex(x => x.id === Number(id));
  if (idx === -1) return { error: `No pending candidate with id ${id}.` };
  const c = store.pending[idx];

  try {
    const comment = await postComment(c.owner, c.repo, c.issueNumber, c.proposalText);
    c.status = "posted";
    c.postedAt = new Date().toISOString();
    c.commentUrl = comment.html_url;
    store.pending.splice(idx, 1);
    store.history.push(c);
    saveStore(store);
    return c;
  } catch (e) {
    return { error: `Failed to post comment: ${e.message}` };
  }
}

// ── MAINTAINER REPLY CHECK ──────────────────────────────────────
// For every posted-but-not-yet-resolved candidate, pulls new comments
// on the issue since we posted, and asks the model whether the
// maintainer's response reads as a clear go-ahead, a clear decline,
// or neither. This NEVER writes code and NEVER opens a PR itself —
// it only updates candidate.maintainerReply. codeApprovedCandidates()
// (bounty-coder.js) is the only thing that acts on a "yes".
const REPLY_SYSTEM_PROMPT = `You are reading GitHub issue comments to decide whether the REPO MAINTAINER (not a bystander) has clearly said "yes, go ahead" to a specific work offer that was posted. Reply with ONLY this JSON, no prose:
{
  "verdict": "approved" | "declined" | "unclear",
  "reason": "one short sentence"
}
Only use "approved" if a maintainer-sounding reply is unambiguously affirmative (e.g. "sounds good", "go for it", "yes please"). Requests for more detail, silence, or a bystander commenting counts as "unclear". An explicit "no"/"someone's already on it"/closed issue counts as "declined". Be conservative — a false "approved" causes unwanted code changes to be proposed on someone else's repo.`;

async function checkPostedForReplies() {
  const store = loadStore();
  const results = { approved: [], declined: [], unclear: [], errors: [] };
  const toCheck = store.history.filter(c => c.status === "posted" && !c.maintainerReply);

  for (const c of toCheck) {
    try {
      const comments = await ghFetch(`/repos/${c.owner}/${c.repo}/issues/${c.issueNumber}/comments?since=${c.postedAt}`);
      const others = (Array.isArray(comments) ? comments : []).filter(cm => !(c.commentUrl || "").includes(String(cm.id)));
      if (others.length === 0) continue; // nothing new yet, check again next scan

      const transcript = others.map(cm => `${cm.user?.login || "someone"}: ${String(cm.body || "").slice(0, 500)}`).join("\n---\n");
      const verdict = await groqJSON(REPLY_SYSTEM_PROMPT,
        `Our offer on "${c.title}" (${c.url}):\n${c.proposalText}\n\nNew comments since we posted:\n${transcript}`);

      c.maintainerReply = { verdict: verdict.verdict, reason: verdict.reason, checkedAt: new Date().toISOString() };
      if (verdict.verdict === "approved") {
        c.status = "awaiting_code"; // bounty-coder.js picks this up
        results.approved.push({ id: c.id, key: c.key, title: c.title });
      } else if (verdict.verdict === "declined") {
        c.status = "declined";
        results.declined.push({ id: c.id, key: c.key, title: c.title });
      } else {
        results.unclear.push({ id: c.id, key: c.key, title: c.title });
      }
    } catch (e) {
      results.errors.push({ issue: c.key, error: e.message });
    }
  }

  saveStore(store);
  return results;
}

function listAwaitingCode() {
  return loadStore().history.filter(c => c.status === "awaiting_code");
}

// Used by bounty-coder.js to move a candidate to its final state once
// the code step has run (successfully or not).
function updateCandidateStatus(id, updates = {}) {
  const store = loadStore();
  const c = store.history.find(x => x.id === Number(id));
  if (!c) return { error: `No history candidate with id ${id}.` };
  Object.assign(c, updates);
  saveStore(store);
  return c;
}

function rejectCandidate(id, reason) {
  const store = loadStore();
  const idx = store.pending.findIndex(x => x.id === Number(id));
  if (idx === -1) return { error: `No pending candidate with id ${id}.` };
  const c = store.pending[idx];
  c.status = "rejected";
  c.rejectedAt = new Date().toISOString();
  c.rejectReason = reason || "";
  store.pending.splice(idx, 1);
  store.history.push(c);
  saveStore(store);
  return c;
}

function getStats() {
  const store = loadStore();
  const posted = store.history.filter(c => c.status === "posted");
  return {
    pending: store.pending.length,
    posted: posted.length,
    rejected: store.history.filter(c => c.status === "rejected").length,
    totalOfferedUsd: posted.reduce((sum, c) => sum + (c.priceUsd || 0), 0),
    issuesSeen: Object.keys(store.seen).length,
  };
}

module.exports = {
  isConfigured,
  scanForBounties,
  autoPublishBacklog,
  listPending,
  listHistory,
  getCandidate,
  editCandidate,
  approveCandidate,
  rejectCandidate,
  getStats,
  checkPostedForReplies,
  listAwaitingCode,
  updateCandidateStatus,
  // exported so bounty-coder.js can reuse the same auth'd GitHub
  // client and Groq JSON helper instead of duplicating them
  ghFetch,
  groqJSON,
  GITHUB_TOKEN,
};
