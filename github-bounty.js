"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — GitHub Issue Bounty Hunter
//
// Scans public GitHub repos for open, unassigned issues Jarvis might
// realistically be able to fix, has Groq triage each one for
// feasibility/difficulty, and drafts an offer comment ("I can take
// this on for $X — here's my plan"). It does NOT post anything, open
// a PR, or make any commitment on its own — every candidate sits in
// a pending queue until a human calls approveCandidate() (voice/chat:
// "approve bounty <id>", or the /api/bounty/:id/approve route from
// the dashboard). Only approval actually hits the GitHub API.
//
// Why the human gate matters here, specifically:
//   - Groq's "feasible/easy" call is a heuristic read of the issue
//     text, not a guarantee. Jarvis hasn't cloned the repo, built it,
//     or run its test suite, so it can be wrong about scope.
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

// ── GROQ TRIAGE ──────────────────────────────────────────────────
// Direct fetch (mirrors jarvis-agent.js's askGroq) so we can force
// response_format: json_object — hermes-engine's shared helper
// doesn't expose that option.
async function groqJSON(systemPrompt, userPrompt, { model } = {}) {
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

// ── SCAN ─────────────────────────────────────────────────────────
async function scanForBounties({ queries = DEFAULT_QUERIES, maxPerScan = MAX_PER_SCAN } = {}) {
  if (!isConfigured()) {
    return { error: "No GitHub token configured. Set GITHUB_BOUNTY_TOKEN (or GITHUB_TOKEN) in .env." };
  }
  const store = loadStore();
  const results = { queued: [], flagged_medium: [], skipped: [], errors: [] };

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

// Only function in this module that actually talks to GitHub in a
// way that's visible to the outside world. Never called from
// scanForBounties() — only from an explicit human "approve" action.
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
  listPending,
  listHistory,
  getCandidate,
  editCandidate,
  approveCandidate,
  rejectCandidate,
  getStats,
};
