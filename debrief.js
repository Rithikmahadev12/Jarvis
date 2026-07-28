"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — End-of-Day Debrief
//
// briefing.js asks "what's your task today?" each morning. This is
// the evening pair: "here's what you said you'd do, here's what the
// calendar shows actually happened today, what got done?" — then
// offers to roll whatever's left into tomorrow's briefing.
//
// Same persisted-JSON-file + conversational pending-question pattern
// as briefing.js (PENDING_GOAL_QUESTION -> PENDING_DEBRIEF here).
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

let Groq = null;
try { Groq = require("./hermes-engine"); } catch { Groq = null; }

const Briefing = require("./briefing");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "debrief.json");

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

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function userKey(user) {
  return String(user || "guest").toLowerCase().trim() || "guest";
}

// ── AI-assisted done/leftover split (falls back to returning the
//    whole report as "done" with no leftover if no AI is configured
//    or the call fails — never blocks the flow) ──────────────────
async function splitReport(task, report) {
  const task_trimmed = String(task || "").trim();
  const report_trimmed = String(report || "").trim();

  if (Groq && typeof Groq.isConfigured === "function" && Groq.isConfigured() && task_trimmed && report_trimmed) {
    try {
      const sys = `You are helping close out a daily task log. The user was planning to: "${task_trimmed}".
They just reported what actually happened today. Split their report into what got DONE and what's LEFT OVER (still not done, worth carrying to tomorrow).
Return ONLY compact JSON, nothing else, in this exact shape:
{"doneSummary":"<one short sentence, past tense, what got done>","leftover":"<one short sentence naming what's left, or empty string if nothing is left>"}
Do not wrap in markdown or code fences. Do not add commentary.`;
      const messages = [
        { role: "system", content: sys },
        { role: "user", content: report_trimmed },
      ];
      const raw = await Groq.groqFetch(messages, (Groq.MODELS && Groq.MODELS.smart) || undefined, 0.4, 250);
      const cleaned = String(raw || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);
      if (parsed && typeof parsed.doneSummary === "string") {
        return {
          doneSummary: parsed.doneSummary.trim() || report_trimmed,
          leftover: String(parsed.leftover || "").trim(),
          source: "ai",
        };
      }
    } catch { /* fall through */ }
  }

  // Offline fallback: treat the whole report as done, nothing detected as leftover.
  return { doneSummary: report_trimmed || "No report given.", leftover: "", source: "fallback" };
}

// ── PUBLIC API ──────────────────────────────────────────────────

function getToday(user) {
  const all = loadAll();
  const entry = all[userKey(user)];
  if (!entry || entry.date !== todayKey()) return null;
  return entry;
}

// Records the finished debrief for today: what was planned, what was
// reported, the AI/fallback split, and whether the leftover got rolled.
function saveToday(user, fields) {
  const all = loadAll();
  const key = userKey(user);
  const entry = { date: todayKey(), createdAt: new Date().toISOString(), ...fields };
  all[key] = entry;
  saveAll(all);
  return entry;
}

// Rollover: a short-lived note ("carry this into tomorrow's briefing")
// consumed once by briefing.js's morning flow, then cleared.
function setRollover(user, text) {
  const all = loadAll();
  const key = userKey(user);
  const entry = all[key] || { date: todayKey() };
  entry.rollover = String(text || "").trim();
  all[key] = entry;
  saveAll(all);
}

// Looks across the whole store for this user (not just today's key,
// since the rollover was written yesterday and needs to survive the
// date rollover) and returns + clears the most recent one, if any.
function consumeRollover(user) {
  const all = loadAll();
  const key = userKey(user);
  const entry = all[key];
  if (!entry || !entry.rollover) return null;
  const text = entry.rollover;
  delete entry.rollover;
  all[key] = entry;
  saveAll(all);
  return text;
}

async function buildSummary(task, report) {
  return splitReport(task, report);
}

// ── PENDING DEBRIEF QUESTION (conversational flow) ───────────────
// sessionId -> { phase: "awaiting_report_text" | "awaiting_rollover_yesno", leftover }
const PENDING_DEBRIEF = new Map();

function proposeDebrief(sessionId) {
  if (!sessionId) return;
  PENDING_DEBRIEF.set(sessionId, { phase: "awaiting_report_text" });
}
function setDebriefState(sessionId, patch) {
  if (!sessionId) return;
  const rec = PENDING_DEBRIEF.get(sessionId) || {};
  PENDING_DEBRIEF.set(sessionId, { ...rec, ...patch });
}
function getPendingDebrief(sessionId) {
  if (!sessionId) return null;
  return PENDING_DEBRIEF.get(sessionId) || null;
}
function clearPendingDebrief(sessionId) {
  PENDING_DEBRIEF.delete(sessionId);
}

module.exports = {
  getToday,
  saveToday,
  setRollover,
  consumeRollover,
  buildSummary,
  todayKey,
  proposeDebrief,
  setDebriefState,
  getPendingDebrief,
  clearPendingDebrief,
};
