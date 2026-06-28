"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Native Reminders / Timers / Calendar engine
//
// This is JARVIS's own scheduling system — no Google account needed.
// It understands three kinds of items:
//   - "timer"    short countdowns ("set a timer for 5 mins")
//   - "reminder" one-off nudges, usually with a "meeting"/"event" label
//   - "event"    same storage, just semantically "on the calendar"
//
// Items are persisted to data/reminders.json so they survive a
// server restart. A background loop checks every few seconds for
// anything that's come due; the client polls /api/reminders/due
// to find out and speak it.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.join(__dirname, "data");
const STORE_FILE  = path.join(DATA_DIR, "reminders.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, "[]", "utf8");
}

function loadAll() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || [];
  } catch {
    return [];
  }
}

function saveAll(items) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(items, null, 2), "utf8");
}

// ── DURATION PARSING ──────────────────────────────────────────
const UNIT_MS = {
  second: 1000,
  sec:    1000,
  minute: 60000,
  min:    60000,
  hour:   3600000,
  hr:     3600000,
  day:    86400000,
  week:   604800000,
};

const DURATION_RE = /\b(a|an|\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i;

function parseDuration(text) {
  const m = text.match(DURATION_RE);
  if (!m) return null;
  const rawNum = m[1].toLowerCase();
  const n = (rawNum === "a" || rawNum === "an") ? 1 : parseFloat(rawNum);
  const unitKey = m[2].toLowerCase().replace(/s$/, ""); // strip plural
  const ms = UNIT_MS[unitKey];
  if (!ms || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * ms);
}

function formatDuration(ms) {
  if (ms >= 86400000 && ms % 86400000 === 0) {
    const d = ms / 86400000;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (ms >= 3600000) {
    const h = Math.round(ms / 3600000);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (ms >= 60000) {
    const min = Math.round(ms / 60000);
    return `${min} minute${min === 1 ? "" : "s"}`;
  }
  const s = Math.round(ms / 1000);
  return `${s} second${s === 1 ? "" : "s"}`;
}

// ── LABEL EXTRACTION ───────────────────────────────────────────
const DURATION_CLAUSE_RE = /\s*\b(in|for|after)?\s*(a|an|\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b(\s*from now)?/gi;

const LEADING_RE = /^(hey jarvis|jarvis|sir)[,]?\s*/i;
const COMMAND_RE = /^(can you |could you |would you |please )*(set (up |me )?(a |an )?(timer|reminder|alarm)(\s*(for|in|to))?|remind me( to| that| about| for)?|set a reminder( for| about)?|i('ve| have) got|i have|alert me( in)?|alarm( for| in)?|don'?t let me forget( about| to)?)\s*/i;

function extractLabel(text) {
  let t = text.trim().replace(LEADING_RE, "").replace(COMMAND_RE, "");
  t = t.replace(DURATION_CLAUSE_RE, " ");
  t = t.replace(/^(a |an |to |that |about )+/i, "");
  t = t.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── STORAGE HELPERS ────────────────────────────────────────────
function addItem({ type, label, dueAt }) {
  const items = loadAll();
  const item = {
    id:        `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type,                 // "timer" | "reminder" | "event"
    label:     label || (type === "timer" ? "Timer" : "Reminder"),
    createdAt: Date.now(),
    dueAt,
    fired:     false,
  };
  items.push(item);
  saveAll(items);
  return item;
}

function cancelMostRecent(typeFilter) {
  const items = loadAll();
  let candidates = [...items].map((it, i) => ({ it, i })).filter(x => !x.it.fired);
  if (typeFilter === "timer") {
    candidates = candidates.filter(x => x.it.type === "timer");
  } else if (typeFilter === "reminder" || typeFilter === "alarm") {
    candidates = candidates.filter(x => x.it.type !== "timer");
  }
  const top = candidates.sort((a, b) => b.it.createdAt - a.it.createdAt)[0];
  if (!top) return null;
  const [removed] = items.splice(top.i, 1);
  saveAll(items);
  return removed;
}

function getDue() {
  const items = loadAll();
  const now = Date.now();
  const due = items.filter(it => !it.fired && it.dueAt <= now);
  if (due.length) {
    due.forEach(it => { it.fired = true; });
    saveAll(items);
  }
  return due.map(it => ({
    id:   it.id,
    type: it.type,
    label: it.label,
    text: it.type === "timer"
      ? `Time's up, Sir — "${it.label}".`
      : `Reminder, Sir: ${it.label}.`,
  }));
}

function listUpcoming(limit = 8) {
  const items = loadAll();
  const now = Date.now();
  return items
    .filter(it => !it.fired && it.dueAt > now)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, limit);
}

function localDateString(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function relativeWhen(dueAt, tz) {
  const ms = dueAt - Date.now();
  if (ms <= 0) return "any moment now";
  if (ms < 60000) return "in under a minute";
  return `in ${formatDuration(ms)}`;
}

// ── CREATE ACTIONS ─────────────────────────────────────────────
function createTimer(ms, message, T) {
  const dueAt = Date.now() + ms;
  const label = extractLabel(message) || `${formatDuration(ms)} timer`;
  const item = addItem({ type: "timer", label, dueAt });
  return {
    reply: `Timer set for ${formatDuration(ms)}, ${T}. I'll let you know.`,
    action: "TIMER_SET",
    intent: "timer",
    meta: { id: item.id, dueAt },
  };
}

function createReminder(ms, message, T) {
  const dueAt = Date.now() + ms;
  const label = extractLabel(message) || "your reminder";
  const item = addItem({ type: "reminder", label, dueAt });
  return {
    reply: `Got it, ${T}. I'll remind you about "${label}" in ${formatDuration(ms)}.`,
    action: "REMINDER_SET",
    intent: "reminder",
    meta: { id: item.id, dueAt },
  };
}

function buildAgendaReply(T, tz, lower) {
  const wantsToday = /\btoday\b/.test(lower);
  let upcoming = listUpcoming(20);

  if (wantsToday) {
    const todayStr = localDateString(new Date(), tz);
    upcoming = upcoming.filter(it => localDateString(new Date(it.dueAt), tz) === todayStr);
  } else {
    upcoming = upcoming.slice(0, 6);
  }

  if (!upcoming.length) {
    return {
      reply: `Nothing on the books ${wantsToday ? "for today" : "right now"}, ${T}. Clean slate.`,
      action: "CALENDAR_NATIVE",
      intent: "calendar",
      meta: { items: [] },
    };
  }

  const list = upcoming
    .map(it => `${it.label} (${relativeWhen(it.dueAt, tz)})`)
    .join("; ");

  return {
    reply: `Here's what I have ${wantsToday ? "for today" : "coming up"}, ${T}: ${list}.`,
    action: "CALENDAR_NATIVE",
    intent: "calendar",
    meta: { items: upcoming },
  };
}

// ── INTENT DETECTION / ROUTING ──────────────────────────────────
const QUERY_RE = /\b(what(?:'s| is) on my (schedule|calendar|agenda)|what do i have (today|tomorrow|this week|coming up)|my agenda|do i have (any )?(meetings?|events?|reminders?)|upcoming (reminders?|events?|meetings?)|list (my )?(reminders?|timers?|events?)|show (my )?(reminders?|timers?|schedule|calendar|agenda))\b/i;
const CANCEL_RE = /\b(cancel|stop|delete|remove)\b.{0,25}\b(timer|reminder|alarm)\b/i;
const TIMER_WORDING_RE   = /\b(set (up |me )?(a |an )?timer|timer for|set (up |me )?(a |an )?alarm|alarm (for|in))\b/i;
const REMINDER_WORDING_RE = /\b(remind me|set (up |me )?(a |an )?reminder|alert me|i('ve| have) got a|i have a|don'?t let me forget)\b/i;
const EVENT_NOUN_RE = /\b(meeting|appointment|event|call|interview|deadline|appt)\b/i;
const GOOGLE_GUARD_RE = /\bgoogle (calendar|cal)\b/i;

function route(message, T, tz) {
  if (!message || typeof message !== "string") return null;
  const lower = message.toLowerCase();

  // Let explicit "google calendar" requests fall through to the old path
  if (GOOGLE_GUARD_RE.test(lower)) return null;

  if (CANCEL_RE.test(message)) {
    const typeMatch = lower.match(/\b(timer|reminder|alarm)\b/i);
    const cancelled = cancelMostRecent(typeMatch ? typeMatch[1].toLowerCase() : null);
    return cancelled
      ? { reply: `Cancelled — "${cancelled.label}", ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" }
      : { reply: `There's nothing active to cancel, ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" };
  }

  if (QUERY_RE.test(lower)) {
    return buildAgendaReply(T, tz, lower);
  }

  const ms = parseDuration(message);

  if (TIMER_WORDING_RE.test(message)) {
    if (ms == null) {
      return { reply: `How long should I set it for, ${T}?`, action: "REMINDER_NEEDS_INFO", intent: "timer" };
    }
    return createTimer(ms, message, T);
  }

  if (REMINDER_WORDING_RE.test(message)) {
    if (ms == null) {
      return { reply: `When should I remind you, ${T}?`, action: "REMINDER_NEEDS_INFO", intent: "reminder" };
    }
    return createReminder(ms, message, T);
  }

  // Bare statement like "I have a meeting in 2 days" — no "remind me" wording,
  // but it names an event and a duration, so treat it as a reminder anyway.
  if (EVENT_NOUN_RE.test(message) && ms != null && /\bin\b/i.test(message)) {
    return createReminder(ms, message, T);
  }

  return null;
}

module.exports = {
  route,
  parseDuration,
  formatDuration,
  extractLabel,
  addItem,
  getDue,
  listUpcoming,
  cancelMostRecent,
};"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Native Reminders / Timers / Calendar engine
//
// This is JARVIS's own scheduling system — no Google account needed.
// It understands three kinds of items:
//   - "timer"    short countdowns ("set a timer for 5 mins")
//   - "reminder" one-off nudges, usually with a "meeting"/"event" label
//   - "event"    same storage, just semantically "on the calendar"
//
// Items are persisted to data/reminders.json so they survive a
// server restart. A background loop checks every few seconds for
// anything that's come due; the client polls /api/reminders/due
// to find out and speak it.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR    = path.join(__dirname, "data");
const STORE_FILE  = path.join(DATA_DIR, "reminders.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, "[]", "utf8");
}

function loadAll() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || [];
  } catch {
    return [];
  }
}

function saveAll(items) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(items, null, 2), "utf8");
}

// ── DURATION PARSING ──────────────────────────────────────────
const UNIT_MS = {
  second: 1000,
  sec:    1000,
  minute: 60000,
  min:    60000,
  hour:   3600000,
  hr:     3600000,
  day:    86400000,
  week:   604800000,
};

const DURATION_RE = /\b(a|an|\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b/i;

function parseDuration(text) {
  const m = text.match(DURATION_RE);
  if (!m) return null;
  const rawNum = m[1].toLowerCase();
  const n = (rawNum === "a" || rawNum === "an") ? 1 : parseFloat(rawNum);
  const unitKey = m[2].toLowerCase().replace(/s$/, ""); // strip plural
  const ms = UNIT_MS[unitKey];
  if (!ms || !Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * ms);
}

function formatDuration(ms) {
  if (ms >= 86400000 && ms % 86400000 === 0) {
    const d = ms / 86400000;
    return `${d} day${d === 1 ? "" : "s"}`;
  }
  if (ms >= 3600000) {
    const h = Math.round(ms / 3600000);
    return `${h} hour${h === 1 ? "" : "s"}`;
  }
  if (ms >= 60000) {
    const min = Math.round(ms / 60000);
    return `${min} minute${min === 1 ? "" : "s"}`;
  }
  const s = Math.round(ms / 1000);
  return `${s} second${s === 1 ? "" : "s"}`;
}

// ── LABEL EXTRACTION ───────────────────────────────────────────
const DURATION_CLAUSE_RE = /\s*\b(in|for|after)?\s*(a|an|\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?|days?|weeks?)\b(\s*from now)?/gi;

const LEADING_RE = /^(hey jarvis|jarvis|sir)[,]?\s*/i;
const COMMAND_RE = /^(can you |could you |would you |please )*(set (up |me )?(a |an )?(timer|reminder|alarm)(\s*(for|in|to))?|remind me( to| that| about| for)?|set a reminder( for| about)?|i('ve| have) got|i have|alert me( in)?|alarm( for| in)?|don'?t let me forget( about| to)?)\s*/i;

function extractLabel(text) {
  let t = text.trim().replace(LEADING_RE, "").replace(COMMAND_RE, "");
  t = t.replace(DURATION_CLAUSE_RE, " ");
  t = t.replace(/^(a |an |to |that |about )+/i, "");
  t = t.replace(/[.!?]+$/, "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// ── STORAGE HELPERS ────────────────────────────────────────────
function addItem({ type, label, dueAt }) {
  const items = loadAll();
  const item = {
    id:        `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type,                 // "timer" | "reminder" | "event"
    label:     label || (type === "timer" ? "Timer" : "Reminder"),
    createdAt: Date.now(),
    dueAt,
    fired:     false,
  };
  items.push(item);
  saveAll(items);
  return item;
}

function cancelMostRecent(typeFilter) {
  const items = loadAll();
  let candidates = [...items].map((it, i) => ({ it, i })).filter(x => !x.it.fired);
  if (typeFilter === "timer") {
    candidates = candidates.filter(x => x.it.type === "timer");
  } else if (typeFilter === "reminder" || typeFilter === "alarm") {
    candidates = candidates.filter(x => x.it.type !== "timer");
  }
  const top = candidates.sort((a, b) => b.it.createdAt - a.it.createdAt)[0];
  if (!top) return null;
  const [removed] = items.splice(top.i, 1);
  saveAll(items);
  return removed;
}

function getDue() {
  const items = loadAll();
  const now = Date.now();
  const due = items.filter(it => !it.fired && it.dueAt <= now);
  if (due.length) {
    due.forEach(it => { it.fired = true; });
    saveAll(items);
  }
  return due.map(it => ({
    id:   it.id,
    type: it.type,
    label: it.label,
    text: it.type === "timer"
      ? `Time's up, Sir — "${it.label}".`
      : `Reminder, Sir: ${it.label}.`,
  }));
}

function listUpcoming(limit = 8) {
  const items = loadAll();
  const now = Date.now();
  return items
    .filter(it => !it.fired && it.dueAt > now)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, limit);
}

function localDateString(date, tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function relativeWhen(dueAt, tz) {
  const ms = dueAt - Date.now();
  if (ms <= 0) return "any moment now";
  if (ms < 60000) return "in under a minute";
  return `in ${formatDuration(ms)}`;
}

// ── CREATE ACTIONS ─────────────────────────────────────────────
function createTimer(ms, message, T) {
  const dueAt = Date.now() + ms;
  const label = extractLabel(message) || `${formatDuration(ms)} timer`;
  const item = addItem({ type: "timer", label, dueAt });
  return {
    reply: `Timer set for ${formatDuration(ms)}, ${T}. I'll let you know.`,
    action: "TIMER_SET",
    intent: "timer",
    meta: { id: item.id, dueAt },
  };
}

function createReminder(ms, message, T) {
  const dueAt = Date.now() + ms;
  const label = extractLabel(message) || "your reminder";
  const item = addItem({ type: "reminder", label, dueAt });
  return {
    reply: `Got it, ${T}. I'll remind you about "${label}" in ${formatDuration(ms)}.`,
    action: "REMINDER_SET",
    intent: "reminder",
    meta: { id: item.id, dueAt },
  };
}

function buildAgendaReply(T, tz, lower) {
  const wantsToday = /\btoday\b/.test(lower);
  let upcoming = listUpcoming(20);

  if (wantsToday) {
    const todayStr = localDateString(new Date(), tz);
    upcoming = upcoming.filter(it => localDateString(new Date(it.dueAt), tz) === todayStr);
  } else {
    upcoming = upcoming.slice(0, 6);
  }

  if (!upcoming.length) {
    return {
      reply: `Nothing on the books ${wantsToday ? "for today" : "right now"}, ${T}. Clean slate.`,
      action: "CALENDAR_NATIVE",
      intent: "calendar",
      meta: { items: [] },
    };
  }

  const list = upcoming
    .map(it => `${it.label} (${relativeWhen(it.dueAt, tz)})`)
    .join("; ");

  return {
    reply: `Here's what I have ${wantsToday ? "for today" : "coming up"}, ${T}: ${list}.`,
    action: "CALENDAR_NATIVE",
    intent: "calendar",
    meta: { items: upcoming },
  };
}

// ── INTENT DETECTION / ROUTING ──────────────────────────────────
const QUERY_RE = /\b(what(?:'s| is) on my (schedule|calendar|agenda)|what do i have (today|tomorrow|this week|coming up)|my agenda|do i have (any )?(meetings?|events?|reminders?)|upcoming (reminders?|events?|meetings?)|list (my )?(reminders?|timers?|events?)|show (my )?(reminders?|timers?|schedule|calendar|agenda))\b/i;
const CANCEL_RE = /\b(cancel|stop|delete|remove)\b.{0,25}\b(timer|reminder|alarm)\b/i;
const TIMER_WORDING_RE   = /\b(set (up |me )?(a |an )?timer|timer for|set (up |me )?(a |an )?alarm|alarm (for|in))\b/i;
const REMINDER_WORDING_RE = /\b(remind me|set (up |me )?(a |an )?reminder|alert me|i('ve| have) got a|i have a|don'?t let me forget)\b/i;
const EVENT_NOUN_RE = /\b(meeting|appointment|event|call|interview|deadline|appt)\b/i;
const GOOGLE_GUARD_RE = /\bgoogle (calendar|cal)\b/i;

function route(message, T, tz) {
  if (!message || typeof message !== "string") return null;
  const lower = message.toLowerCase();

  // Let explicit "google calendar" requests fall through to the old path
  if (GOOGLE_GUARD_RE.test(lower)) return null;

  if (CANCEL_RE.test(message)) {
    const typeMatch = lower.match(/\b(timer|reminder|alarm)\b/i);
    const cancelled = cancelMostRecent(typeMatch ? typeMatch[1].toLowerCase() : null);
    return cancelled
      ? { reply: `Cancelled — "${cancelled.label}", ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" }
      : { reply: `There's nothing active to cancel, ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" };
  }

  if (QUERY_RE.test(lower)) {
    return buildAgendaReply(T, tz, lower);
  }

  const ms = parseDuration(message);

  if (TIMER_WORDING_RE.test(message)) {
    if (ms == null) {
      return { reply: `How long should I set it for, ${T}?`, action: "REMINDER_NEEDS_INFO", intent: "timer" };
    }
    return createTimer(ms, message, T);
  }

  if (REMINDER_WORDING_RE.test(message)) {
    if (ms == null) {
      return { reply: `When should I remind you, ${T}?`, action: "REMINDER_NEEDS_INFO", intent: "reminder" };
    }
    return createReminder(ms, message, T);
  }

  // Bare statement like "I have a meeting in 2 days" — no "remind me" wording,
  // but it names an event and a duration, so treat it as a reminder anyway.
  if (EVENT_NOUN_RE.test(message) && ms != null && /\bin\b/i.test(message)) {
    return createReminder(ms, message, T);
  }

  return null;
}

module.exports = {
  route,
  parseDuration,
  formatDuration,
  extractLabel,
  addItem,
  getDue,
  listUpcoming,
  cancelMostRecent,
};
