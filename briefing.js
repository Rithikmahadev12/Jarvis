"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Daily Briefing engine
//
// Ask the user, once per day, "what is going to be your task?" and turn
// their free-text answer into a short, numbered briefing spoken back to
// them in JARVIS's voice — "First you need to... second you need to...".
//
// Persisted to data/briefing.json, keyed by user + calendar date (server
// local time), so refreshing or reopening the app the same day replays
// the same briefing instead of asking again.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

let Groq = null;
try { Groq = require("./hermes-engine"); } catch { Groq = null; }

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "briefing.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, "{}", "utf8");
}

function loadAll() {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || {}; }
  catch { return {}; }
}

function saveAll(data) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Calendar day key in the server's local time, e.g. "2026-07-06"
function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function userKey(user) {
  return String(user || "guest").toLowerCase().trim() || "guest";
}

// ── Fallback splitter (used if no Groq key is configured, or the call fails) ──
function fallbackSteps(task) {
  const cleaned = task.replace(/\s+/g, " ").trim();
  // Split on "and", "then", commas, or semicolons into rough sub-steps
  let parts = cleaned
    .split(/\b(?:and then|then|and|,|;)\b/i)
    .map(s => s.trim())
    .filter(s => s.length > 2);

  if (parts.length === 0) parts = [cleaned];
  if (parts.length === 1) {
    // Single-clause task — still give it a clean start/finish framing
    parts = [`Start on: ${parts[0]}`, `Review and wrap up once that's done`];
  }
  // Cap at 5 steps so the briefing stays tight
  parts = parts.slice(0, 5).map(s => s.charAt(0).toUpperCase() + s.slice(1));
  return parts;
}

function fallbackHeadline(task) {
  const short = task.length > 70 ? task.slice(0, 67).trim() + "…" : task;
  return short;
}

// ── AI-generated briefing ──────────────────────────────────────
async function generateBriefing(task, userTitle = "Sir") {
  const task_trimmed = String(task || "").trim();
  if (!task_trimmed) {
    return { headline: "No task set", steps: [], source: "empty" };
  }

  if (Groq && typeof Groq.isConfigured === "function" && Groq.isConfigured()) {
    try {
      const sys = `You are J.A.R.V.I.S, a crisp, confident AI assistant modeled after the Iron Man film character.
The user just told you what they're working on today. Turn it into a short spoken daily briefing.

Rules:
- Address the user as "${userTitle}" once, naturally, near the start.
- Break the task into 2 to 5 clear, ordered steps — the concrete things they need to do.
- Steps must be short (under 16 words each), action-first, no fluff.
- Return ONLY compact JSON, nothing else, in this exact shape:
{"headline":"<one short sentence naming the overall objective>","steps":["step one","step two", "..."]}
- Do not wrap in markdown or code fences. Do not add commentary.`;

      const messages = [
        { role: "system", content: sys },
        { role: "user", content: `Today's task: ${task_trimmed}` },
      ];

      const raw = await Groq.groqFetch(messages, (Groq.MODELS && Groq.MODELS.smart) || undefined, 0.6, 400);
      const cleaned = String(raw || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (parsed && Array.isArray(parsed.steps) && parsed.steps.length) {
        return {
          headline: String(parsed.headline || fallbackHeadline(task_trimmed)).trim(),
          steps: parsed.steps.map(s => String(s).trim()).filter(Boolean).slice(0, 6),
          source: "ai",
        };
      }
    } catch (e) {
      // fall through to offline fallback
    }
  }

  return {
    headline: fallbackHeadline(task_trimmed),
    steps: fallbackSteps(task_trimmed),
    source: "fallback",
  };
}

// ── Public API ──────────────────────────────────────────────────

// Returns today's stored briefing for this user, or null if none set yet.
function getToday(user) {
  const all = loadAll();
  const key = userKey(user);
  const entry = all[key];
  if (!entry || entry.date !== todayKey()) return null;
  return entry;
}

// Generates (via AI, or offline fallback) + persists today's briefing.
async function setToday(user, task, userTitle) {
  const briefing = await generateBriefing(task, userTitle);
  const all = loadAll();
  const key = userKey(user);
  const entry = {
    date: todayKey(),
    task: String(task || "").trim(),
    headline: briefing.headline,
    steps: briefing.steps,
    source: briefing.source,
    createdAt: new Date().toISOString(),
  };
  all[key] = entry;
  saveAll(all);
  return entry;
}

// Clears today's entry so the user gets asked again (e.g. "new task" command).
function clearToday(user) {
  const all = loadAll();
  const key = userKey(user);
  if (all[key]) delete all[key];
  saveAll(all);
  return true;
}

module.exports = {
  getToday,
  setToday,
  clearToday,
  generateBriefing,
  todayKey,
};
