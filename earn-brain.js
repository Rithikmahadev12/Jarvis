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
//   5. UPGRADE  if it spots a code change that would help one of its
//               earning files, it ASKS you, and only then hands it
//               to earn-lab.js (sandbox → guards → Allow card → push).
//
// It never moves money (that's wallet-ops.js, behind its own cards)
// and only proposes things that are legit: no spam, fake accounts,
// scams, or getting around any service's limits or terms.
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

const DATA_DIR     = path.join(__dirname, "data");
const JOURNAL_PATH = path.join(DATA_DIR, "earn-journal.json");
const STATE_PATH   = path.join(DATA_DIR, "earn-state.json");
const DAY_MS = 24 * 3600 * 1000;

let running = false;

function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }
function writeJson(p, v) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}
function getState() { return { enabled: true, lastRunAt: 0, ...readJson(STATE_PATH, {}) }; }
function setEnabled(on) { const s = getState(); s.enabled = !!on; writeJson(STATE_PATH, s); return s; }
function getJournal() { return readJson(JOURNAL_PATH, []); }

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

const GROUND_RULES =
  "Only suggest LEGITIMATE ways to earn: open bounties, selling digital products, freelance/lead-gen for real businesses, " +
  "grants and hackathons, content, data/automation services. Never suggest spam, fake or duplicate accounts, scams, " +
  "evading a service's limits or terms, or anything that needs the owner's money up front beyond a trivial amount.";

// ── the cycle ───────────────────────────────────────────────────
async function runCycle({ trigger = "manual", focus = "" } = {}) {
  if (running) return { error: "An earn cycle is already running — watch the activity pill." };
  if (!Groq.isConfigured()) return { error: "No LLM key configured, so I can't plan." };
  running = true;
  const result = { startedAt: new Date().toISOString(), trigger, focus, queries: [], read: [], ideas: [] };
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
    Approvals.step("Reviewed my results", `Total earned so far: $${Number(total).toFixed(2)} (${entries.length} recent entries)`, "done");

    // 2. SEARCH
    let queries;
    try {
      const q = await llmJson("Reply with JSON only. " + GROUND_RULES,
        `Here is my earnings history and past cycles:\n${snapshot}\n${focus ? `Focus area: ${focus}\n` : ""}` +
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
      `MY RESULTS:\n${snapshot}\n\nSEARCH RESULTS:\n` +
      hits.slice(0, 18).map(h => `- ${h.title} (${h.url}): ${h.snippet}`).join("\n") +
      (pageNotes.length ? `\n\nPAGES I READ:\n` + pageNotes.map(p => `[${p.url}]\n${p.text}`).join("\n\n") : "") +
      `\n\nRank the 3 best concrete opportunities I can act on soon. For each: title, why, firstStep (one actionable thing), ` +
      `estUsd30d (honest number, can be small), effort ("low"|"medium"|"high"), source (url).\n` +
      `Optionally, if ONE small code change to an earning file would help, include codeChange.\n` +
      `Return {"ideas":[{"title":"","why":"","firstStep":"","estUsd30d":0,"effort":"","source":""}],` +
      `"codeChange":{"file":"one of: ${[...EarnLab.ALLOWED_TARGETS].join(", ")}","change":"what to change","why":""} or null}`, 1600);
    result.ideas = (decided.ideas || []).slice(0, 3);
    if (!result.ideas.length) throw new Error("No usable ideas came back.");

    // 5. SAVE + report
    const journal = getJournal(); journal.push({ ...result, finishedAt: new Date().toISOString() });
    writeJson(JOURNAL_PATH, journal.slice(-60));
    const s = getState(); s.lastRunAt = Date.now(); writeJson(STATE_PATH, s);
    Approvals.step("Earn cycle done", result.ideas.map((i, n) => `${n + 1}. ${i.title}`).join("\n"), "done");

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
  if (r.lab) {
    if (r.lab.success && r.lab.merged) out += `\n\nCode upgrade shipped to ${r.lab.file}.`;
    else if (r.lab.success) out += `\n\nI opened a pull request upgrading ${r.lab.file} — it's waiting for you to merge: ${r.lab.pr}`;
    else if (r.lab.reason) out += `\n\nCode upgrade didn't go through: ${r.lab.reason}`;
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
}

function status() {
  const s = getState();
  return { enabled: s.enabled, running, lastRunAt: s.lastRunAt || null, nextRunAt: s.enabled && s.lastRunAt ? s.lastRunAt + DAY_MS : null, recent: getJournal().slice(-3).reverse() };
}

module.exports = { runCycle, recordOutcome, speakSummary, startScheduler, setEnabled, status, getJournal };
