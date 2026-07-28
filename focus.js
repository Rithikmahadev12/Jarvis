"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Focus Mode
//
// "Jarvis, I'm heads down" starts a session. While active, the
// proactive nudge engine (proactive.js checkNudges) is suppressed —
// every nudge it would have fired instead gets counted here. When
// the user resurfaces ("I'm back" / "focus mode off"), they get a
// short report: how long they were heads-down, and how many nudges
// got held back for them.
//
// Scope, honestly stated: this mutes JARVIS's own proactive calendar
// nudges. It does not intercept OS-level notifications from Slack,
// Teams, etc. — that would need its own integration. Wiring a real
// system-notification mute (e.g. via electron/main.js) is a natural
// next step, not covered here.
//
// Same persisted-JSON-file pattern as proactive.js / briefing.js.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "focus.json");

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

function userKey(user) {
  return String(user || "guest").toLowerCase().trim() || "guest";
}

// entry shape while active: { active: true, startedAt: ISOString, suppressed: number }
// entry shape once stopped:  { active: false, lastSession: { startedAt, endedAt, durationMin, suppressed } }

function isActive(user) {
  const all = loadAll();
  const entry = all[userKey(user)];
  return !!(entry && entry.active);
}

function start(user) {
  const all = loadAll();
  const key = userKey(user);
  all[key] = { active: true, startedAt: new Date().toISOString(), suppressed: 0 };
  saveAll(all);
  return all[key];
}

// Called by proactive.js every time a nudge would have fired but the
// user is heads-down — cheap counter bump, no-op if no active session.
function recordSuppressed(user) {
  const all = loadAll();
  const key = userKey(user);
  const entry = all[key];
  if (!entry || !entry.active) return;
  entry.suppressed = (entry.suppressed || 0) + 1;
  saveAll(all);
}

// Ends the session and returns a summary for the "welcome back" reply.
// Returns null if there was no active session to stop.
function stop(user) {
  const all = loadAll();
  const key = userKey(user);
  const entry = all[key];
  if (!entry || !entry.active) return null;

  const startedAt = entry.startedAt;
  const endedAt = new Date().toISOString();
  const durationMin = Math.max(1, Math.round((new Date(endedAt) - new Date(startedAt)) / 60000));
  const suppressed = entry.suppressed || 0;

  const lastSession = { startedAt, endedAt, durationMin, suppressed };
  all[key] = { active: false, lastSession };
  saveAll(all);
  return lastSession;
}

function getStatus(user) {
  const all = loadAll();
  const entry = all[userKey(user)] || null;
  if (!entry) return { active: false };
  if (entry.active) {
    const durationMin = Math.max(0, Math.round((Date.now() - new Date(entry.startedAt)) / 60000));
    return { active: true, startedAt: entry.startedAt, durationMin, suppressed: entry.suppressed || 0 };
  }
  return { active: false, lastSession: entry.lastSession || null };
}

module.exports = {
  isActive,
  start,
  stop,
  recordSuppressed,
  getStatus,
};
