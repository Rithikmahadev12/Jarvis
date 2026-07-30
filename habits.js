"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Habit Tracker (recurring reminders w/ a "normal time")
//
// Different from reminders.js's one-off timers/reminders: a HABIT is
// something you do most days at roughly the same time (workout, gym,
// stretch, meditate, journal...). Once JARVIS knows your normal time
// for one, it can notice when that time has passed today and you
// haven't done it, and proactively ask:
//
//     "Sir, shall I reschedule your workout for later today?"
//
//   - "yes" / "sure"        -> books a fresh one-off reminder later
//                              today (via reminders.js) and stops.
//   - "no, already did it"  -> marks it done for today, stops asking,
//                              no lecture.
//   - "no" (plain refusal)  -> "Understood, Sir — but I'd highly
//                              suggest it." Then leaves it alone for
//                              the rest of the day.
//
// Only asks once per habit per day. Everything is keyed off the
// user's own timezone (tz), same two-pass trick as reminders.js.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const Reminders = require("./reminders");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "habits.json");

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

// ── KNOWN HABIT KEYWORDS ─────────────────────────────────────────
// Maps loose phrasing to one canonical habit id/name. Add more here
// any time — this is the only place a new recurring habit needs to
// be taught to the tracker. Anything not on this list can still be
// tracked manually via "track my <thing> as a daily habit".
const HABIT_ALIASES = [
  { id: "workout", label: "workout", re: /\b(work(ed|ing)?\s?out|gym|exercis(e|ed|ing)|lift(ed|ing)? weights?|leg day|(go(ing)?|went) for a run|jog(ging|ged)?)\b/i },
  { id: "meditation", label: "meditation", re: /\bmeditat(e|ion|ing)\b/i },
  { id: "reading", label: "reading", re: /\breading\b|\bread( for)? \d+\s*(minutes|mins|pages)\b/i },
  { id: "journaling", label: "journaling", re: /\bjournal(ing|l?ed)?\b/i },
  { id: "stretching", label: "stretching", re: /\bstretch(ing)?\b/i },
];

function matchHabitAlias(text) {
  for (const h of HABIT_ALIASES) {
    if (h.re.test(text)) return h;
  }
  return null;
}

// ── TIME PARSING (same conventions as reminders.js) ──────────────
function nowPartsInTZ(tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || undefined,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return {
    year: parseInt(parts.year, 10), month: parseInt(parts.month, 10), day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10), minute: parseInt(parts.minute, 10),
  };
}

function localDateString(tz) {
  const p = nowPartsInTZ(tz);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function parseTimeOfDay(text) {
  const lower = text.toLowerCase();
  if (/\bnoon\b/.test(lower)) return { hour: 12, minute: 0 };
  if (/\bmidnight\b/.test(lower)) return { hour: 0, minute: 0 };
  const m = lower.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) {
    let hour = parseInt(m[1], 10) % 12;
    const minute = m[2] ? parseInt(m[2], 10) : 0;
    if (m[3] === "pm") hour += 12;
    return { hour, minute };
  }
  const m2 = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\b/);
  if (m2) {
    const hour = parseInt(m2[1], 10);
    const minute = m2[2] ? parseInt(m2[2], 10) : 0;
    if (hour >= 0 && hour <= 23) return { hour, minute };
  }
  return null;
}

function fmtTime(hour, minute) {
  const period = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}${minute ? ":" + String(minute).padStart(2, "0") : ""} ${period}`;
}

// ── STORAGE HELPERS ──────────────────────────────────────────────
function getHabit(id) {
  return loadAll().find(h => h.id === id) || null;
}

function upsertHabit(id, label, patch) {
  const items = loadAll();
  let h = items.find(x => x.id === id);
  if (!h) {
    h = {
      id,
      label,
      normalHour: null,
      normalMinute: null,
      lastCompletedDate: null, // YYYY-MM-DD in user tz
      lastPromptedDate: null,  // YYYY-MM-DD — only ask once per day
      lastDeclinedDate: null,
      createdAt: Date.now(),
    };
    items.push(h);
  }
  Object.assign(h, patch);
  saveAll(items);
  return h;
}

// ── PENDING QUESTION MEMORY (per session) ─────────────────────────
// Two kinds of thing we might be waiting on: the reschedule yes/no,
// or a first-time "what time do you usually do this?" follow-up.
const _pending = new Map(); // sessionId -> { habitId, awaiting, expiresAt }
const PENDING_TTL_MS = 10 * 60 * 1000;

function setPending(sessionId, data) {
  if (sessionId) _pending.set(sessionId, { ...data, expiresAt: Date.now() + PENDING_TTL_MS });
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

const ALREADY_DONE_RE = /\b(already (did|done|had|finished)|i did (it|that|(my )?\w+ )?(already|earlier|this morning)|did it earlier|finished (it|that) already|i('ve| have) already)\b/i;
const NEGATION_WORD_RE = /\b(no|nah|nope|not\s+(today|gonna|going to)|skip(ping)? it|maybe later)\b/i;
const AFFIRM_WORD_RE = /\b(yes|yeah|yep|yup|sure|ok(ay)?|please|go for it|do it|sounds good|reschedule)\b/i;

// Short replies like "yes please" or "no thanks" combine two of the
// above tokens — a strict anchored regex misses those, so instead we
// check for a negation word first (which wins if both somehow appear)
// and fall back to an affirmation word for anything short.
function isPlainNo(message) {
  const trimmed = message.trim();
  if (trimmed.split(/\s+/).length > 6) return false; // let long free-text fall through
  return NEGATION_WORD_RE.test(trimmed) && !AFFIRM_WORD_RE.test(trimmed);
}
function isYes(message) {
  const trimmed = message.trim();
  if (trimmed.split(/\s+/).length > 6) return false;
  return AFFIRM_WORD_RE.test(trimmed) && !NEGATION_WORD_RE.test(trimmed);
}

// ── STANDALONE "I DID IT" DECLARATION ─────────────────────────────
// Works any time, not just as a reply to a prompt — "I worked out
// today", "just finished my workout", etc. Marks it done and cancels
// any pending prompt for that habit so it won't nag later.
const COMPLETION_SIGNAL_RE = /\b(already|earlier|this morning|just now|a (little )?while ago|a bit ago|finally)\b|\bi (did|finished|completed|crushed|knocked out|went)\b|\b(done|finished|completed)\b/i;
const FUTURE_TENSE_RE = /\b(remind me|will|going to|gonna|tomorrow|later|need to|have to|should|plan to|about to)\b/i;

function tryMarkDoneFromStatement(message, T, tz, sessionId) {
  if (!COMPLETION_SIGNAL_RE.test(message) || FUTURE_TENSE_RE.test(message)) return null;
  const alias = matchHabitAlias(message);
  if (!alias) return null;

  const h = upsertHabit(alias.id, alias.label, { lastCompletedDate: localDateString(tz) });
  const pending = getPending(sessionId);
  if (pending && pending.habitId === alias.id) clearPending(sessionId);

  const lines = [
    `Good man, ${T}. Marking your ${h.label} as done for today.`,
    `Noted, ${T} — ${h.label} logged as complete. Well done.`,
    `On record, ${T}: ${h.label} done for today. I'll leave you be about it.`,
  ];
  return {
    reply: lines[Math.floor(Math.random() * lines.length)],
    action: "HABIT_DONE",
    intent: "habit",
    meta: { habitId: h.id },
  };
}

// ── SETTING / LEARNING THE "NORMAL TIME" ──────────────────────────
// "I usually work out at 7am" / "my normal workout time is 6:30" /
// bare "7am" while we're waiting on exactly that question.
const NORMAL_TIME_STATEMENT_RE = /\b(i usually|i normally|normal(ly)?|my (usual|normal))\b.{0,25}\b(time is|at)\b|\busually\b.{0,20}\bat\b/i;

function setNormalTime(habitId, label, time, T) {
  const h = upsertHabit(habitId, label, { normalHour: time.hour, normalMinute: time.minute });
  return {
    reply: `Got it, ${T}. I'll treat ${fmtTime(time.hour, time.minute)} as your normal ${h.label} time and check in if it slips.`,
    action: "HABIT_TIME_SET",
    intent: "habit",
    meta: { habitId: h.id, normalHour: h.normalHour, normalMinute: h.normalMinute },
  };
}

// ── REGISTER A HABIT FROM A REMINDER-STYLE MESSAGE ────────────────
// Called alongside (not instead of) the normal reminders.js routing.
// "remind me tomorrow to work out" -> Reminders.route handles the
// actual one-off nudge; this just also teaches the tracker that
// "workout" is a recurring thing worth watching for.
function maybeRegisterFromReminder(message, tz) {
  if (!/\bremind me\b/i.test(message)) return;
  registerHabitFromText(message, tz);
}

// Same idea, but callable with just a reminder label (no "remind me"
// prefix needed) — used when the AI tool-calling path has already
// extracted a clean label like "work out" or "meditate for 10 mins".
function registerHabitFromText(text, tz) {
  if (!text) return;
  const alias = matchHabitAlias(text);
  if (!alias) return;
  const time = parseTimeOfDay(text);
  const existing = getHabit(alias.id);
  if (time && (!existing || existing.normalHour == null)) {
    upsertHabit(alias.id, alias.label, { normalHour: time.hour, normalMinute: time.minute });
  } else if (!existing) {
    upsertHabit(alias.id, alias.label, {});
  }
}

// ── MISSED-TIME CHECK (called on app open / periodic poll) ───────
// Returns a prompt object if some habit's normal time has passed
// today (with a grace window), it hasn't been completed or declined
// today, and we haven't already asked today — otherwise null.
const GRACE_MINUTES = 45;

function checkMissed(T, tz, sessionId) {
  const items = loadAll().filter(h => h.normalHour != null);
  if (!items.length) return null;

  const today = localDateString(tz);
  const now = nowPartsInTZ(tz);
  const nowMin = now.hour * 60 + now.minute;

  for (const h of items) {
    if (h.lastCompletedDate === today) continue;
    if (h.lastPromptedDate === today) continue;
    if (h.lastDeclinedDate === today) continue;

    const normalMin = h.normalHour * 60 + (h.normalMinute || 0);
    if (nowMin < normalMin + GRACE_MINUTES) continue;

    // Due, missed, and not yet asked about today.
    upsertHabit(h.id, h.label, { lastPromptedDate: today });
    setPending(sessionId, { habitId: h.id, awaiting: "reschedule" });
    return {
      reply: `${T}, I notice you haven't done your ${h.label} yet — your normal time is ${fmtTime(h.normalHour, h.normalMinute)}. Shall I reschedule it for later today?`,
      action: "HABIT_MISSED_PROMPT",
      intent: "habit",
      meta: { habitId: h.id },
    };
  }
  return null;
}

// ── MAIN ROUTER ────────────────────────────────────────────────
function route(message, T, tz, sessionId) {
  if (!message || typeof message !== "string") return null;

  // 1. Continuation of a pending question takes priority over
  //    everything else — "no" here means something very specific.
  const pending = getPending(sessionId);
  if (pending) {
    const h = getHabit(pending.habitId);
    const label = h ? h.label : "that";

    if (pending.awaiting === "normal_time") {
      const time = parseTimeOfDay(message);
      if (time) {
        clearPending(sessionId);
        return setNormalTime(pending.habitId, label, time, T);
      }
      return {
        reply: `Just the time will do, ${T} — something like "7am" or "6:30".`,
        action: "HABIT_NEEDS_INFO",
        intent: "habit",
      };
    }

    if (pending.awaiting === "reschedule") {
      if (ALREADY_DONE_RE.test(message)) {
        clearPending(sessionId);
        upsertHabit(pending.habitId, label, { lastCompletedDate: localDateString(tz) });
        return {
          reply: `Good man, ${T}. Stricken from the worry list — done for today.`,
          action: "HABIT_DONE",
          intent: "habit",
          meta: { habitId: pending.habitId },
        };
      }
      if (isYes(message)) {
        clearPending(sessionId);
        const dueAt = Date.now() + 3 * 60 * 60 * 1000; // 3 hours out, a sane default
        const created = Reminders.createReminder(dueAt, label.charAt(0).toUpperCase() + label.slice(1), T, "in about 3 hours");
        return {
          reply: `${created.reply} I'll check in again if it slips a second time.`,
          action: "HABIT_RESCHEDULED",
          intent: "habit",
          meta: { habitId: pending.habitId, dueAt },
        };
      }
      if (isPlainNo(message)) {
        clearPending(sessionId);
        upsertHabit(pending.habitId, label, { lastDeclinedDate: localDateString(tz) });
        return {
          reply: `Understood, ${T} — but I'd highly suggest it.`,
          action: "HABIT_DECLINED",
          intent: "habit",
          meta: { habitId: pending.habitId },
        };
      }
      // Unclear reply — don't nag forever, but give one clean re-ask.
      clearPending(sessionId);
      return {
        reply: `I'll take that as a no for now, ${T} — say the word if you want it rescheduled later.`,
        action: "HABIT_DECLINED",
        intent: "habit",
        meta: { habitId: pending.habitId },
      };
    }
  }

  // 2. Standalone "I did it" declarations, any time.
  const doneResult = tryMarkDoneFromStatement(message, T, tz, sessionId);
  if (doneResult) return doneResult;

  // 3. Explicit "I usually work out at 7am" style statements.
  if (NORMAL_TIME_STATEMENT_RE.test(message)) {
    const alias = matchHabitAlias(message);
    const time = parseTimeOfDay(message);
    if (alias && time) {
      return setNormalTime(alias.id, alias.label, time, T);
    }
  }

  return null;
}

module.exports = {
  route,
  checkMissed,
  maybeRegisterFromReminder,
  registerHabitFromText,
  matchHabitAlias,
  getHabit,
  upsertHabit,
};
