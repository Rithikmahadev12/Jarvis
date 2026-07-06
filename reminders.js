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

// ── ABSOLUTE DATE/TIME PARSING ─────────────────────────────────
// Handles "Monday at 6:30pm", "tomorrow at 3pm", "today at noon", etc.
// All of this is timezone-aware: a date built here always means
// "that wall-clock time in the USER's timezone", not the server's.

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function getDatePartsInTZ(date, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || undefined,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short", hourCycle: "h23",
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    year:    parseInt(parts.year, 10),
    month:   parseInt(parts.month, 10),
    day:     parseInt(parts.day, 10),
    hour:    parseInt(parts.hour, 10),
    minute:  parseInt(parts.minute, 10),
    weekday: weekdayMap[parts.weekday] ?? date.getDay(),
  };
}

// Two-pass timezone offset trick (same approach libraries like Luxon use
// under the hood): figure out the UTC instant whose wall-clock reading in
// `tz` matches the requested Y/M/D/H/M.
function getOffsetMsAt(instant, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || undefined,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });
  const parts = dtf.formatToParts(instant).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUTC = Date.UTC(
    parseInt(parts.year, 10), parseInt(parts.month, 10) - 1, parseInt(parts.day, 10),
    parseInt(parts.hour, 10), parseInt(parts.minute, 10), parseInt(parts.second, 10)
  );
  return asUTC - instant.getTime();
}

function zonedTimeToUtcMs(y, m, d, hh, mm, tz) {
  const targetWallUTC = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset = getOffsetMsAt(new Date(targetWallUTC), tz);
  return targetWallUTC - offset;
}

function findDayWord(lower) {
  const m = lower.match(/\b(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  return m ? m[1] : null;
}

function findTimeOfDay(lower) {
  if (/\bnoon\b/.test(lower)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(lower)) return { hour: 0, minute: 0 };
  const m = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let hour = parseInt(m[1], 10) % 12;
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3] === "pm") hour += 12;
    return { hour, minute };
  }
  // 24-hour style, but only when explicitly preceded by "at" — otherwise
  // bare numbers ("in 2 days") get misread as times.
  const m2 = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (m2) {
    const hour = parseInt(m2[1], 10);
    const minute = m2[2] ? parseInt(m2[2], 10) : 0;
    if (hour >= 0 && hour <= 23) return { hour, minute };
  }
  return null;
}

// Returns { dueAt, dayWord } or null if no day/time could be found.
// `dayWord` is "today" / "tomorrow" / a weekday name / null (time only).
function parseAbsoluteDateTime(text, tz) {
  const lower = text.toLowerCase();
  const dayWord = findDayWord(lower);
  const time = findTimeOfDay(lower);
  if (!dayWord && !time) return null;

  const now = new Date();
  const parts = getDatePartsInTZ(now, tz);

  let dayOffset = 0;
  if (dayWord === "tomorrow") {
    dayOffset = 1;
  } else if (dayWord && dayWord !== "today") {
    const targetWeekday = WEEKDAYS.indexOf(dayWord);
    let diff = (targetWeekday - parts.weekday + 7) % 7;
    if (diff === 0 && time) {
      // Same weekday as today — if that time has already passed, they
      // must mean next week.
      const candidateMinutes = time.hour * 60 + time.minute;
      const nowMinutes = parts.hour * 60 + parts.minute;
      if (candidateMinutes <= nowMinutes) diff = 7;
    }
    dayOffset = diff;
  } else if (!dayWord && time) {
    // Time only, no day — assume today, unless that time already passed,
    // in which case assume tomorrow.
    const candidateMinutes = time.hour * 60 + time.minute;
    const nowMinutes = parts.hour * 60 + parts.minute;
    if (candidateMinutes <= nowMinutes) dayOffset = 1;
  }

  // Apply the day offset in calendar terms (not just +24h*offset, to dodge
  // DST edge cases), then re-derive the resulting Y/M/D.
  const baseUTC  = Date.UTC(parts.year, parts.month - 1, parts.day + dayOffset);
  const baseDate = new Date(baseUTC);
  const finalY = baseDate.getUTCFullYear();
  const finalM = baseDate.getUTCMonth() + 1;
  const finalD = baseDate.getUTCDate();

  const hh = time ? time.hour : 9;   // default to 9 AM if only a day was named
  const mm = time ? time.minute : 0;

  const dueAt = zonedTimeToUtcMs(finalY, finalM, finalD, hh, mm, tz);
  return { dueAt, dayWord: dayWord === "today" ? "today" : (dayOffset === 1 && !dayWord ? "tomorrow" : dayWord) };
}

function describeWhen(dueAt, tz, dayWord) {
  const timeStr = new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, hour: "numeric", minute: "2-digit" }).format(new Date(dueAt));
  if (dayWord === "today")    return `today at ${timeStr}`;
  if (dayWord === "tomorrow") return `tomorrow at ${timeStr}`;
  if (dayWord) {
    const weekdayStr = new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, weekday: "long" }).format(new Date(dueAt));
    return `${weekdayStr} at ${timeStr}`;
  }
  return `at ${timeStr}`;
}

// ── PENDING-QUESTION MEMORY ─────────────────────────────────────
// When we ask "When should I remind you?" we need to remember WHAT
// we asked about so the next message — which might be nothing more
// than "Monday at 6:30pm" — can complete it instead of being treated
// as an unrelated, context-less message.
const _pending = new Map(); // sessionId -> { type, label, expiresAt }
const PENDING_TTL_MS = 5 * 60 * 1000;

function setPending(sessionId, data) {
  if (!sessionId) return;
  _pending.set(sessionId, { ...data, expiresAt: Date.now() + PENDING_TTL_MS });
}
function getPending(sessionId) {
  if (!sessionId) return null;
  const p = _pending.get(sessionId);
  if (!p) return null;
  if (Date.now() > p.expiresAt) { _pending.delete(sessionId); return null; }
  return p;
}
function clearPending(sessionId) {
  if (sessionId) _pending.delete(sessionId);
}
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

// ── CONDITIONAL REMINDERS ────────────────────────────────────────
// Unlike timers/reminders, these don't have a dueAt — they fire the
// next time a named event happens (currently: an agenda check), not
// at a clock time. popConditional() is called from whatever code
// handles that event.
function addConditional(label, trigger) {
  const items = loadAll();
  const item = {
    id:        `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    type:      "conditional",
    label:     label || "Reminder",
    trigger,
    createdAt: Date.now(),
    fired:     false,
  };
  items.push(item);
  saveAll(items);
  return item;
}

function popConditional(trigger) {
  const items = loadAll();
  const hits = items.filter(it => it.type === "conditional" && it.trigger === trigger && !it.fired);
  if (hits.length) {
    hits.forEach(it => { it.fired = true; });
    saveAll(items);
  }
  return hits;
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
function createTimer(dueAt, label, T, whenDesc) {
  const ms = Math.max(0, dueAt - Date.now());
  const finalLabel = label || `${formatDuration(ms)} timer`;
  const item = addItem({ type: "timer", label: finalLabel, dueAt });
  const desc = whenDesc || `for ${formatDuration(ms)}`;
  return {
    reply: `Timer set ${desc}, ${T}. I'll let you know.`,
    action: "TIMER_SET",
    intent: "timer",
    meta: { id: item.id, dueAt },
  };
}

function createReminder(dueAt, label, T, whenDesc) {
  const ms = Math.max(0, dueAt - Date.now());
  const finalLabel = label || "your reminder";
  const item = addItem({ type: "reminder", label: finalLabel, dueAt });
  const desc = whenDesc || `in ${formatDuration(ms)}`;
  return {
    reply: `Got it, ${T}. I'll remind you about "${finalLabel}" ${desc}.`,
    action: "REMINDER_SET",
    intent: "reminder",
    meta: { id: item.id, dueAt },
  };
}

function buildAgendaReply(T, tz, lower) {
  const wantsToday = /\btoday\b/.test(lower);
  let upcoming = listUpcoming(20);

  // Firing conditional reminders happens on every agenda check, whether
  // or not there's anything else on the schedule.
  const fired = popConditional("next_agenda_check");
  const firedNote = fired.length
    ? `Also, ${T} — you asked me to bring this up: ${fired.map(f => f.label).join("; ")}. `
    : "";

  if (wantsToday) {
    const todayStr = localDateString(new Date(), tz);
    upcoming = upcoming.filter(it => localDateString(new Date(it.dueAt), tz) === todayStr);
  } else {
    upcoming = upcoming.slice(0, 6);
  }

  if (!upcoming.length) {
    return {
      reply: `${firedNote}Nothing on the books ${wantsToday ? "for today" : "right now"}, ${T}. Clean slate.`,
      action: "CALENDAR_NATIVE",
      intent: "calendar",
      meta: { items: [] },
    };
  }

  const list = upcoming
    .map(it => `${it.label} (${relativeWhen(it.dueAt, tz)})`)
    .join("; ");

  return {
    reply: `${firedNote}Here's what I have ${wantsToday ? "for today" : "coming up"}, ${T}: ${list}.`,
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

function route(message, T, tz, sessionId) {
  if (!message || typeof message !== "string") return null;
  const lower = message.toLowerCase();

  // Let explicit "google calendar" requests fall through to the old path
  if (GOOGLE_GUARD_RE.test(lower)) return null;

  if (CANCEL_RE.test(message)) {
    const typeMatch = lower.match(/\b(timer|reminder|alarm)\b/i);
    const cancelled = cancelMostRecent(typeMatch ? typeMatch[1].toLowerCase() : null);
    if (sessionId) clearPending(sessionId);
    return cancelled
      ? { reply: `Cancelled — "${cancelled.label}", ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" }
      : { reply: `There's nothing active to cancel, ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" };
  }

  if (QUERY_RE.test(lower)) {
    return buildAgendaReply(T, tz, lower);
  }

  const relMs = parseDuration(message);
  const abs   = parseAbsoluteDateTime(message, tz);

  const isTimerWording   = TIMER_WORDING_RE.test(message);
  const isReminderWording = REMINDER_WORDING_RE.test(message);
  const isBareEvent = EVENT_NOUN_RE.test(message) && (
    (relMs != null && /\bin\b/i.test(message)) || abs != null
  );

  if (isTimerWording || isReminderWording || isBareEvent) {
    let dueAt = null, whenDesc = null;
    if (relMs != null) {
      dueAt = Date.now() + relMs;
    } else if (abs) {
      dueAt = abs.dueAt;
      whenDesc = describeWhen(dueAt, tz, abs.dayWord);
    }

    const label = extractLabel(message);

    if (dueAt == null) {
      // Don't lose the thread — remember what we're waiting on so a
      // bare follow-up like "Monday at 6:30pm" can complete it.
      if (sessionId) setPending(sessionId, { type: isTimerWording ? "timer" : "reminder", label });
      return {
        reply: isTimerWording ? `How long should I set it for, ${T}?` : `When should I remind you, ${T}?`,
        action: "REMINDER_NEEDS_INFO",
        intent: isTimerWording ? "timer" : "reminder",
      };
    }

    if (sessionId) clearPending(sessionId);
    return isTimerWording
      ? createTimer(dueAt, label, T, whenDesc)
      : createReminder(dueAt, label, T, whenDesc);
  }

  // ── Continuation of an earlier "when?" / "how long?" question ──
  if (sessionId) {
    const pending = getPending(sessionId);
    if (pending) {
      let dueAt = null, whenDesc = null;
      if (relMs != null) {
        dueAt = Date.now() + relMs;
      } else if (abs) {
        dueAt = abs.dueAt;
        whenDesc = describeWhen(dueAt, tz, abs.dayWord);
      }

      if (dueAt != null) {
        clearPending(sessionId);
        return pending.type === "timer"
          ? createTimer(dueAt, pending.label, T, whenDesc)
          : createReminder(dueAt, pending.label, T, whenDesc);
      }

      // Still nothing parseable — keep waiting, but be clearer about format.
      return {
        reply: `I still didn't catch a time there, ${T}. Try something like "in 30 minutes" or "Monday at 3pm".`,
        action: "REMINDER_NEEDS_INFO",
        intent: pending.type,
      };
    }
  }

  return null;
}

module.exports = {
  route,
  parseDuration,
  formatDuration,
  extractLabel,
  addItem,
  createTimer,
  createReminder,
  addConditional,
  popConditional,
  buildAgendaReply,
  getDue,
  listUpcoming,
  cancelMostRecent,
};
