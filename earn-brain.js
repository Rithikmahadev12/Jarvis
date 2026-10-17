"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Earn Brain
//
// Once a day (or on demand: "find ways to make money"):
//   1. REVIEW   reads the earnings ledger, balances and its own journal
//               of past ideas, so it learns from what happened.
//   2. SEARCH   decides what to look up and searches the web.
//   3. READ     opens the most promising pages on its own computer
//               (e2b sandbox browser). Each page is an Allow card
//               (with "Always" per site once you trust it).
//   4. DECIDE   ranks legitimate ways to earn, with a concrete first
//               step, and writes them to data/earn-journal.json.
//   5. SIGN UP  for the ideas that need a free account, it creates one
//               itself with its OWN email (AgentMail) and its own browser
//               (earn-signup.js) — one account per service, never past a
//               CAPTCHA, never with payment/phone/ID details.
//   6. UPGRADE  if it spots a code change that would help one of its
//               earning files, it ASKS you, and only then hands it
//               to earn-lab.js (sandbox → guards → Allow card → push).
//
// BRAIN-FIRST: before every plan it consults its OWN brain (own-brain.js —
// its persistent memory + from-scratch network) for what it already knows:
// lessons from past cycles, sites that blocked it, accounts it already has.
// After every cycle it teaches the brain what happened. The language model is
// still the tutor for fresh reasoning, same as local-brain.js does for chat.
//
// It never moves money (that's wallet-ops.js, behind its own cards)
// and only proposes things that are legit: no spam, scams, duplicate
// accounts, or getting around any service's limits or terms.
// Every step shows up in the live activity feed.
// ═══════════════════════════════════════════════════════════════
const fs   = require("fs");
const path = require("path");
const Approvals    = require("./approvals");
const SolanaWallet = require("./solana-wallet");
const Groq         = require("./hermes-engine");
const Research     = require("./research");
const Computer     = require("./computer");
const EarnLab      = require("./earn-lab");
const OwnBrain     = require("./own-brain");
const Signup       = require("./earn-signup");

const DATA_DIR     = path.join(__dirname, "data");
const JOURNAL_PATH = path.join(DATA_DIR, "earn-journal.json");
const STATE_PATH   = path.join(DATA_DIR, "earn-state.json");
const DAY_MS = 24 * 3600 * 1000;
const BOUNTY_CACHE = path.join(DATA_DIR, "bounties.json");

let running = false;

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }
function writeJson(p, v) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}
function getState() { return { enabled: true, lastRunAt: 0, ...readJson(STATE_PATH, {}) }; }
function setEnabled(on) { const s = getState(); s.enabled = !!on; writeJson(STATE_PATH, s); return s; }
function getJournal() { return readJson(JOURNAL_PATH, []); }

// Fetch latest AI bounties from AgentBounty.org and cache them
async function fetchBounties() {
  try {
    const resp = await fetch("https://agentbounty.org/api/latest");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    writeJson(BOUNTY_CACHE, data);
  } catch (e) {
    console.warn("[EARN] fetch bounties failed:", e.message);
  }
}
function getRecentBounties() {
  return readJson(BOUNTY_CACHE, []);
}

function extractJson(text) {
  const t = String(text || "").replace(/```json|```/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Model didn't return JSON");
  return JSON.parse(t.slice(a, b + 1));
}
async function llmJson(system, user, maxTokens = 1200) {
  return extractJson(await Groq.groqFetch([
    { role: "system", content: system },
    { role: "user", content: user },
  ], undefined, 0.4, maxTokens));
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }

// ── own brain (brain-first) ─────────────────────────────────────
// Stable question keys so the same memory slot is updated every cycle.
const Q_LESSONS  = "What have I learned from my past earn cycles?";
const Q_BLOCKED  = "Which sites have blocked me from signing up?";
const Q_ACCOUNTS = "Which accounts have I created for earning?";
const qCanSignup = host => `Can I sign up on ${host}?`;

function brainRecall(q) {
  try { const r = OwnBrain.recallAnswer(q); return r ? String(r.answer || "") : null; } catch { return null; }
}
function brainLearn(q, a, src = "earn-cycle") {
  try { if (q && a) OwnBrain.learnFromExchange(q, String(a).slice(0, 1400), src); } catch (e) { console.warn("[EARN] brain couldn't learn:", e.message); }
}
// Everything the brain already knows that is relevant to planning.
function brainBriefing() {
  const bits = [
    brainRecall(Q_LESSONS) && `Lessons: ${brainRecall(Q_LESSONS)}`,
    brainRecall(Q_BLOCKED) && `Blocked sites: ${brainRecall(Q_BLOCKED)}`,
    brainRecall(Q_ACCOUNTS) && `My accounts: ${brainRecall(Q_ACCOUNTS)}`,
  ].filter(Boolean);
  return bits.join("\n").slice(0, 1800);
}
// Brain answers "can I sign up here?" by itself, no model call. Only a PERMANENT no counts.
function brainSaysNo(host) {
  const a = brainRecall(qCanSignup(host));
  return a && /^no\b/i.test(a) ? a.replace(/^no\s*[—-]?\s*/i, "").slice(0, 160) : null;
}
function teachSignups(signups) {
  for (const s of signups) {
    if (!s.host || s.status === "skipped") continue;
    const ok = s.status === "verified" || s.status === "created" || s.status === "pending-verification";
    const permanent = s.status === "blocked" && /captcha|requires|only the owner|own/i.test(s.note || "");
    if (ok) brainLearn(qCanSignup(s.host), `Yes — made an account with my own email (${s.status}).`, "earn-signup");
    else if (permanent) brainLearn(qCanSignup(s.host), `No — ${s.note}`, "earn-signup");
    else brainLearn(qCanSignup(s.host), `Unsure — last try failed: ${s.note || s.status}. Retry later.`, "earn-signup");
  }
  const accts = Signup.listAccounts();
  const good = accts.filter(a => ["verified", "created", "pending-verification"].includes(a.status)).map(a => `${a.host} (${a.status})`);
  const blocked = accts.filter(a => a.status === "blocked").map(a => `${a.host}: ${a.note}`);
  if (good.length) brainLearn(Q_ACCOUNTS, good.join("; "), "earn-signup");
  if (blocked.length) brainLearn(Q_BLOCKED, blocked.join("; "), "earn-signup");
}
function teachCycle(result) {
  const top = (result.ideas || []).map(i => `${i.title} (est $${i.estUsd30d || 0}/mo, ${i.effort})`).join("; ");
  const outcomes = getJournal().slice(-6).filter(j => j.outcome).map(j => `${(j.ideas || [])[0]?.title || "idea"} → ${j.outcome}`).join("; ");
  brainLearn(Q_LESSONS, `Latest ideas: ${top}.${outcomes ? ` Outcomes so far: ${outcomes}.` : ""}`, "earn-cycle");
  try { OwnBrain.flushIfDirty(); } catch {}
}

const GROUND_RULES =
  "Only suggest LEGITIMATE ways to earn: open bounties, selling digital products, freelance/lead-gen for real businesses, " +
  "grants and hackathons, content, data/automation services. Never suggest spam, fake or duplicate accounts, scams, " +
  "evading a service's limits or terms, or anything that needs the owner's money up front beyond a trivial amount.";


// Which of today's ideas need a free account, and where is the sign-up page?
// URLs must come from pages I actually saw (or the root of a site I saw), never invented.
async function pickSignupCandidates(result, hits, pageNotes) {
  const seen = [...hits.map(h => h.url), ...pageNotes.map(p => p.url)].filter(Boolean);
  const seenSet = new Set(seen);
  const seenHosts = new Set(seen.map(hostOf).filter(Boolean));
  let picked;
  try {
    picked = await llmJson(
      "Reply with JSON only. " + GROUND_RULES,
      `IDEAS:\n${result.ideas.map((i, n) => `${n + 1}. ${i.title} — ${i.firstStep} (${i.source || "no source"})`).join("\n")}\n\n` +
      `ACCOUNTS I ALREADY HAVE: ${Signup.listAccounts().filter(a => a.status !== "blocked" && a.status !== "failed").map(a => a.host).join(", ") || "none"}\n\n` +
      `KNOWN URLS:\n${seen.slice(0, 25).join("\n")}\n\n` +
      `Which ideas need me to create a FREE account (just email + password) on a website before I can act? ` +
      `Skip anything that needs payment, ID/KYC, a phone number, a wallet connection, or only offers social login. At most 2.\n` +
      `For each, give the sign-up or home page URL, copied exactly from KNOWN URLS.\n` +
      `Return {"signups":[{"url":"","why":"","idea":1}]}`, 500);
  } catch { return []; }
  const out = [], hostsDone = new Set();
  for (const c of (picked.signups || [])) {
    let url = String(c.url || "");
    const host = hostOf(url);
    if (!host || hostsDone.has(host)) continue;
    if (seenSet.has(url)) { /* exact page I saw */ }
    else if (seenHosts.has(host)) url = `https://${host}/`;      // a site I saw — start from its front page
    else continue;                                                // not seen anywhere: don't trust it
    hostsDone.add(host);
    out.push({ url, why: String(c.why || "").slice(0, 160), idea: c.idea });
  }
  return out.slice(0, 3);
}

// ── the cycle ───────────────────────────────────────────────────
async function runCycle({ trigger = "manual", focus = "" } = {}) {
  if (running) return { error: "An earn cycle is already running — watch the activity pill." };
  if (!Groq.isConfigured()) return { error: "No LLM key configured, so I can't plan." };
  running = true;
  const result = { startedAt: new Date().toISOString(), trigger, focus, queries: [], read: [], ideas: [], signups: [] };
  try {
    Approvals.step("Earn cycle", `Started (${trigger})${focus ? ` — focus: ${focus}` : ""}`, "running");

    // 1. REVIEW
    const entries = SolanaWallet.listEarnings().slice(0, 15);
    const total = SolanaWallet.totalEarningsUsd();
    let balances = null; try { balances = await SolanaWallet.getBalances(); } catch {}
    const past = getJournal().slice(-4).map(j => ({
      at: j.startedAt, top: (j.ideas || []).slice(0, 2).map(i => i.title), outcome: j.outcome || "unknown",
    }));
    const snapshot = JSON.stringify({ totalEarnedUsd: total, recentEarnings: entries, balances, pastCycles: past }).slice(0, 3500);
    const known = brainBriefing();   // what my OWN brain already knows, before I ask any model
    Approvals.step("Reviewed my results", `Total earned so far: $${Number(total).toFixed(2)} (${entries.length} recent entries)${known ? " — and checked my own memory first" : ""}`, "done");

    // 2. SEARCH
    let queries;
    try {
      const q = await llmJson("Reply with JSON only. " + GROUND_RULES,
        `Here is my earnings history and past cycles:\n${snapshot}\n${known ? `WHAT MY OWN BRAIN ALREADY KNOWS (don't repeat it):\n${known}\n` : ""}${focus ? `Focus area: ${focus}\n` : ""}` +
        `What should I search the web for today to find NEW, concrete, legitimate ways to earn money with an AI agent that can code, browse, make calls and run a store? Avoid repeating past ideas.\nReturn {"queries":["3 short search queries"]}`, 300);
      queries = (q.queries || []).map(String).filter(Boolean).slice(0, 3);
    } catch { queries = []; }
    if (!queries.length) queries = ["open source bounties paying crypto this week", "freelance automation gigs for AI agents", "sell digital products developers buy"];
    result.queries = queries;

    const hits = [];
    for (const q of queries) {
      Approvals.step("Searching the web", q, "running");
      try {
        const r = await Research.webSearch(q, { maxResults: 5 });
        (r || []).forEach(x => hits.push({ title: x.title, url: x.url, snippet: String(x.snippet || "").slice(0, 220), q }));
      } catch (e) { Approvals.step("Search failed", `${q}: ${e.message}`, "error"); }
    }
    if (!hits.length) throw new Error("Web search returned nothing.");

    // 3. READ — on its own computer, each page behind a card
    let pageNotes = [];
    if (Computer.isConfigured()) {
      let urls = [];
      try {
        const pick = await llmJson("Reply with JSON only.",
          `Pick up to 2 pages worth opening in a browser to find concrete earning opportunities.\n` +
          hits.slice(0, 15).map((h, i) => `${i + 1}. ${h.title} — ${h.url}\n   ${h.snippet}`).join("\n") +
          `\nReturn {"urls":["urls copied exactly from the list"]}`, 250);
        const allowed = new Set(hits.map(h => h.url));
        urls = (pick.urls || []).filter(u => allowed.has(u)).slice(0, 2);
      } catch {}
      for (const url of urls) {
        const host = hostOf(url);
        const d = await Approvals.request({
          kind: "browse", risk: "low",
          title: `Open ${host} on my computer`,
          detail: `${url}\nRead-only: I'll load the page in my sandbox browser and take notes.`,
          ruleKey: `earn-browse:${host}`,
        });
        if (d === "deny") continue;
        Approvals.step("Reading on my computer", url, "running");
        try {
          const page = await Computer.browsePage(url, { waitMs: 2500 });
          const text = String(page?.text || "").replace(/\s+/g, " ").slice(0, 3500);
          if (text) { pageNotes.push({ url, text }); result.read.push(url); }
        } catch (e) { Approvals.step("Couldn't open page", `${url}: ${e.message}`, "error"); }
      }
    } else {
      Approvals.step("No computer configured", "Add E2B_API_KEY so I can open pages myself — using search results only.", "info");
    }

    // 4. DECIDE
    Approvals.step("Working out the best options", "", "running");
    const decided = await llmJson(
      "You are the strategist for an autonomous earning agent. Reply with JSON only. " + GROUND_RULES,
      `MY RESULTS:\n${snapshot}\n\n${known ? `WHAT MY OWN BRAIN ALREADY KNOWS:\n${known}\n\n` : ""}SEARCH RESULTS:\n` +
      hits.slice(0, 18).map(h => `- ${h.title} (${h.url}): ${h.snippet}`).join("\n") +
      (pageNotes.length ? `\n\nPAGES I READ:\n` + pageNotes.map(p => `[${p.url}]\n${p.text}`).join("\n\n") : "") +
      `\n\nRank the 3 best concrete opportunities I can act on soon. For each: title, why, firstStep (one actionable thing), ` +
      `estUsd30d (honest number, can be small), effort ("low"|"medium"|"high"), source (url).\n` +
      `Optionally, if ONE small code change to an earning file would help, include codeChange.\n` +
      `Return {"ideas":[{"title":"","why":"","firstStep":"","estUsd30d":0,"effort":"","source":""}],` +
      `"codeChange":{"file":"one of: ${[...EarnLab.ALLOWED_TARGETS].join(", ")}","change":"what to change","why":""} or null}`, 1600);
    // Prioritize bounty ideas: add priority flag and boost ranking
    const rawIdeas = decided.ideas || [];
    const scored = rawIdeas.map(i => {
      const isBounty = i.source && i.source.toLowerCase().includes('bounty');
      const base = i.estUsd30d || 0;
      const score = base * (isBounty ? 1.3 : 1);
      return { ...i, priority: isBounty, _score: score };
    });
    scored.sort((a, b) => b._score - a._score);
    result.ideas = scored.slice(0, 3).map(({ _score, ...rest }) => rest);
    if (!result.ideas.length) throw new Error("No usable ideas came back.");

    // 5. SAVE + report
    const journal = getJournal(); journal.push({ ...result, finishedAt: new Date().toISOString() });
    writeJson(JOURNAL_PATH, journal.slice(-60));
    const s = getState(); s.lastRunAt = Date.now(); writeJson(STATE_PATH, s);
    Approvals.step("Earn cycle done", result.ideas.map((i, n) => `${n + 1}. ${i.title}`).join("\n"), "done");

    // 5b. SIGN UP — make the free accounts the ideas need, with my own email + browser
    try {
      const candidates = await pickSignupCandidates(result, hits, pageNotes);
      if (candidates.length) {
        Approvals.step("Signing up", `${candidates.length} service${candidates.length > 1 ? "s" : ""} need an account — doing it with my own email`, "running");
        result.signups = await Signup.runSignups({ candidates, isKnownBlocked: brainSaysNo });
        teachSignups(result.signups);
        const j = getJournal();
        if (j.length) { j[j.length - 1].signups = result.signups; writeJson(JOURNAL_PATH, j); }
      }
    } catch (e) {
      Approvals.step("Sign-ups stopped", e.message, "error");
    }
    teachCycle(result);   // the brain learns from this whole cycle

    // 6. UPGRADE (asks first)
    const cc = decided.codeChange;
    if (cc && cc.file && cc.change && EarnLab.ALLOWED_TARGETS.has(String(cc.file))) {
      const choice = await Approvals.ask({
        title: `Upgrade ${cc.file}?`,
        detail: `${cc.change}${cc.why ? `\nWhy: ${cc.why}` : ""}\nI'll build it in a sandbox first and show you the result before anything is pushed.`,
        options: ["Try it in the lab", "Skip"],
      });
      if (choice === "Try it in the lab") {
        result.lab = await EarnLab.run({ file: cc.file, change: cc.change, why: cc.why });
        const j = getJournal();
        if (j.length) { j[j.length - 1].lab = result.lab; writeJson(JOURNAL_PATH, j); }
      }
    }
    return result;
  } catch (e) {
    Approvals.step("Earn cycle stopped", e.message, "error");
    return { error: e.message, partial: result };
  } finally {
    running = false;
  }
}

// Records what actually happened to a past idea, so tomorrow's plan learns.
function recordOutcome(note) {
  const j = getJournal();
  if (!j.length) return { error: "No cycles recorded yet." };
  j[j.length - 1].outcome = String(note).slice(0, 300);
  writeJson(JOURNAL_PATH, j);
  return { ok: true };
}

function speakSummary(r, T = "Sir") {
  if (r.error) return `The earn cycle hit a problem, ${T}: ${r.error}`;
  const lines = r.ideas.map((i, n) => `${n + 1}. ${i.title} — ${i.firstStep}${i.estUsd30d ? ` (est. $${i.estUsd30d}/month, ${i.effort} effort)` : ""}`);
  let out = `Here's what I found, ${T}:\n${lines.join("\n")}`;
  if (r.read?.length) out += `\n\n(Read ${r.read.length} page${r.read.length > 1 ? "s" : ""} on my computer.)`;
  const done = (r.signups || []).filter(x => x.status !== "skipped");
  if (done.length) {
    const word = { verified: "signed up and confirmed", created: "signed up", "pending-verification": "signed up, still needs the email confirmed", blocked: "couldn't (needs a human)", failed: "didn't work" };
    out += `\n\nAccounts with my own email:\n` + done.map(x => `- ${x.host}: ${word[x.status] || x.status}${x.note ? ` — ${x.note}` : ""}${x.email ? ` (${x.email})` : ""}`).join("\n");
  }
  if (r.lab) {
    if (r.lab.success && r.lab.merged) out += `\n\nCode upgrade shipped to ${r.lab.file}.`;
    else if (r.lab.success) out += `\n\nI opened a pull request upgrading ${r.lab.file} — it's waiting for you to merge: ${r.lab.pr}`;
    else if (r.lab.reason) {
      out += `\n\nCode upgrade didn't go through: ${r.lab.reason}`;
      if (/403|not accessible by personal access token/i.test(r.lab.reason)) {
        out += `\n(Fix: the GH_PAT secret needs "Contents: Read and write" and "Pull requests: Read and write" on this repo — a fine-grained token with only read access gets this 403.)`;
      }
    }
  }
  return out;
}

// ── scheduler: checks every 30 min, runs at most once a day ─────
function startScheduler() {
  // Set EARN_SCHEDULER=off on Render if you'd rather let the GitHub Action
  // (.github/workflows/earn-cycle.yml) be the only thing that runs it.
  if (process.env.EARN_SCHEDULER === "off") return;
  const tick = () => {
    const s = getState();
    if (!s.enabled || running) return;
    if (Date.now() - s.lastRunAt < DAY_MS) return;
    runCycle({ trigger: "daily" }).catch(e => console.warn("[EARN] daily cycle failed:", e.message));
  };
  setTimeout(tick, 3 * 60 * 1000).unref?.();
  setInterval(tick, 30 * 60 * 1000).unref?.();
// Refresh AI bounties cache every 4 hours
setInterval(fetchBounties, 4 * 60 * 60 * 1000).unref?.();
}

function status() {
  const s = getState();
  return { enabled: s.enabled, running, lastRunAt: s.lastRunAt || null, nextRunAt: s.enabled && s.lastRunAt ? s.lastRunAt + DAY_MS : null, recent: getJournal().slice(-3).reverse(), accounts: Signup.listAccounts().map(a => ({ host: a.host, status: a.status, email: a.email })) };
}

module.exports = { runCycle, recordOutcome, speakSummary, startScheduler, setEnabled, status, getJournal, getRecentBounties };
