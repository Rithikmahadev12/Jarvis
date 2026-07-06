"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Daily Schedule / Healthy Routine / Contextual Opens
//
// This gives JARVIS its own lightweight "day planner" on top of the
// reminders/timers engine in reminders.js, plus a bit of situational
// awareness:
//   - a default healthy daily routine ("give me a healthy schedule")
//   - "what's on the agenda" opens an actual calendar UI (not just
//     spoken text) combining today's routine + reminders/events
//   - contextual auto-opens: things like "I'm tired" or "pull up
//     instagram" open sites immediately, the same way the link bank
//     does — as a direct reply to something you just said, which is
//     why it doesn't need the Chrome extension or get blocked by the
//     browser's popup blocker (it's a real user-triggered action, not
//     a background timer sneaking a window open).
//   - a work-session nudge: after you've been at it for an hour, JARVIS
//     ASKS if you want a break rather than assuming — only opens
//     something once you say yes, again via that same direct-reply path.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const Reminders = require("./reminders");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "schedule.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify(defaultState(), null, 2), "utf8");
}

function defaultState() {
  return {
    installed:     false,
    blocks:        [],
    workStartedAt: Date.now(), // rolling "how long have I been at it" clock
    nudgeSent:     false,      // have we already asked about the current stretch?
  };
}

function load() {
  ensureStore();
  try {
    return { ...defaultState(), ...JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) };
  } catch {
    return defaultState();
  }
}

function save(state) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(state, null, 2), "utf8");
}

// ── TIMEZONE HELPERS (same trick as reminders.js) ───────────────
function nowPartsInTZ(tz) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz || undefined,
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  });
  const parts = dtf.formatToParts(new Date()).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return { hour: parseInt(parts.hour, 10), minute: parseInt(parts.minute, 10) };
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(n => parseInt(n, 10));
  return h * 60 + m;
}

function fmt(hhmm) {
  const [h, m] = hhmm.split(":").map(n => parseInt(n, 10));
  const period = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}

// ── DEFAULT HEALTHY ROUTINE ─────────────────────────────────────
// Times are wall-clock, in the user's own timezone. Feel free to edit
// this list — "give me a healthy schedule" re-installs it, and the
// individual times aren't sacred, just a sane starting point.
function buildDefaultBlocks() {
  return [
    { id: "wake",      start: "06:30", end: "06:45", type: "routine", label: "Wake up + glass of water" },
    { id: "move1",     start: "06:45", end: "07:15", type: "routine", label: "Morning movement / workout" },
    { id: "breakfast", start: "07:15", end: "07:45", type: "meal",    label: "Breakfast" },
    { id: "focus1",    start: "07:45", end: "09:00", type: "focus",   label: "Focus block 1" },
    { id: "break1",    start: "09:00", end: "09:15", type: "break",   label: "Short break — stretch / breathe" },
    { id: "focus2",    start: "09:15", end: "11:00", type: "focus",   label: "Focus block 2" },
    { id: "break2",    start: "11:00", end: "11:15", type: "break",   label: "Short break" },
    { id: "focus3",    start: "11:15", end: "12:30", type: "focus",   label: "Focus block 3" },
    { id: "lunch",     start: "12:30", end: "13:15", type: "meal",    label: "Lunch — away from the screen" },
    { id: "focus4",    start: "13:15", end: "15:00", type: "focus",   label: "Focus block 4" },
    { id: "break3",    start: "15:00", end: "15:15", type: "break",   label: "Afternoon slump break" },
    { id: "focus5",    start: "15:15", end: "17:00", type: "focus",   label: "Focus block 5" },
    { id: "walk",      start: "17:00", end: "17:30", type: "routine", label: "Wind-down walk / movement" },
    { id: "dinner",    start: "17:30", end: "19:00", type: "meal",    label: "Dinner + personal time" },
    { id: "evening",   start: "19:00", end: "21:30", type: "free",    label: "Evening / hobbies" },
    { id: "winddown",  start: "21:30", end: "22:00", type: "routine", label: "Wind-down, screens off" },
    { id: "sleep",     start: "22:00", end: "06:30", type: "sleep",   label: "Sleep" },
  ];
}

function installHealthySchedule() {
  const state = load();
  state.installed = true;
  state.blocks = buildDefaultBlocks();
  save(state);
  return state.blocks;
}

function getBlocks() {
  return load().blocks;
}

// Handles the sleep block, which wraps past midnight (22:00 → 06:30).
function findCurrentBlock(blocks, tz) {
  const { hour, minute } = nowPartsInTZ(tz);
  const nowMin = hour * 60 + minute;
  for (const b of blocks) {
    const s = toMinutes(b.start);
    const e = toMinutes(b.end);
    if (s < e) {
      if (nowMin >= s && nowMin < e) return b;
    } else {
      // wraps midnight
      if (nowMin >= s || nowMin < e) return b;
    }
  }
  return null;
}

function describeBlocks(blocks) {
  return blocks.map(b => `${fmt(b.start)}–${fmt(b.end)} ${b.label}`).join("; ");
}

// ── LINK SETS ─────────────────────────────────────────────────────
function inspoLinks() {
  return [
    { platform: "youtube",   label: "YouTube — Jarvis AI assistant builds",   url: "https://www.youtube.com/results?search_query=jarvis+ai+assistant+build" },
    { platform: "instagram", label: "Instagram — #jarvisai",                  url: "https://www.instagram.com/explore/tags/jarvisai/" },
    { platform: "youtube",   label: "YouTube — DIY AI assistant projects",    url: "https://www.youtube.com/results?search_query=diy+personal+ai+assistant+project" },
  ];
}

const BREAK_LINK_SETS = [
  [
    { platform: "youtube",   label: "YouTube — 5 minute stretch break",   url: "https://www.youtube.com/results?search_query=5+minute+stretch+break" },
    { platform: "instagram", label: "Instagram — #deskbreak",             url: "https://www.instagram.com/explore/tags/deskbreak/" },
  ],
  [
    { platform: "youtube",   label: "YouTube — Jarvis AI assistant builds", url: "https://www.youtube.com/results?search_query=jarvis+ai+assistant+build" },
    { platform: "instagram", label: "Instagram — #jarvisai",                url: "https://www.instagram.com/explore/tags/jarvisai/" },
  ],
  [
    { platform: "youtube",   label: "YouTube — quick walk / breathing exercise", url: "https://www.youtube.com/results?search_query=quick+breathing+exercise" },
  ],
];

function randomBreakLinks() {
  return BREAK_LINK_SETS[Math.floor(Math.random() * BREAK_LINK_SETS.length)];
}

const PLATFORM_HOME = {
  instagram: "https://www.instagram.com/",
  insta:     "https://www.instagram.com/",
  youtube:   "https://www.youtube.com/",
  yt:        "https://www.youtube.com/",
};

// ── PENDING BREAK-CONFIRMATION MEMORY ───────────────────────────
// After JARVIS asks "want to take a break?" it needs to remember that
// it asked, so a bare "yes"/"no" reply can complete the exchange
// instead of being treated as an unrelated message.
const _pendingBreakConfirm = new Map(); // sessionId -> expiresAt
const CONFIRM_TTL_MS = 10 * 60 * 1000;

function setPendingConfirm(sessionId) {
  if (sessionId) _pendingBreakConfirm.set(sessionId, Date.now() + CONFIRM_TTL_MS);
}
function hasPendingConfirm(sessionId) {
  if (!sessionId) return false;
  const exp = _pendingBreakConfirm.get(sessionId);
  if (!exp) return false;
  if (Date.now() > exp) { _pendingBreakConfirm.delete(sessionId); return false; }
  return true;
}
function clearPendingConfirm(sessionId) {
  if (sessionId) _pendingBreakConfirm.delete(sessionId);
}

const YES_RE = /^\s*(y|yes|yeah|yep|yup|sure|ok(ay)?|please|go for it|do it|sounds good)\s*[.!]?\s*$/i;
const NO_RE  = /^\s*(n|no|nah|nope|not now|later|i'?m (good|fine)|maybe later)\s*[.!]?\s*$/i;

// ── WORK-SESSION NUDGE (polled every ~20-30s from the client) ───
// Asks — never opens anything on its own. Resets automatically
// whenever the healthy-schedule says you're currently in a
// break/meal/free/sleep block, since you're clearly not "at it" then.
const WORK_THRESHOLD_MS = 60 * 60 * 1000; // 1 hour

function checkWorkNudge(tz) {
  const state = load();
  const current = state.installed && state.blocks.length ? findCurrentBlock(state.blocks, tz) : null;

  if (current && ["break", "meal", "free", "sleep"].includes(current.type)) {
    // Already resting — reset the clock and forget any pending nudge.
    state.workStartedAt = Date.now();
    state.nudgeSent = false;
    save(state);
    return null;
  }

  if (state.nudgeSent) return null; // already asked, waiting on an answer

  if (Date.now() - state.workStartedAt >= WORK_THRESHOLD_MS) {
    state.nudgeSent = true;
    save(state);
    return {
      text: `Sir — you've been at it for over an hour. Want to take a break?`,
    };
  }
  return null;
}

// ── CALENDAR / AGENDA UI ─────────────────────────────────────────
const AGENDA_RE = /\b(what'?s (on (the |my )?)?(agenda|calendar)|show (me )?(the |my )?(agenda|calendar|day)|open (the |my )?(agenda|calendar)|my (agenda|calendar))\b/i;
const ROUTINE_QUERY_RE = /\b(what'?s|show|what is)\s+(my\s+)?(schedule|routine|daily routine)\b|\bmy (daily )?routine\b/i;

function buildCalendarReply(T, tz) {
  const state = load();
  const current = state.installed && state.blocks.length ? findCurrentBlock(state.blocks, tz) : null;
  const remindersAgenda = Reminders.buildAgendaReply(T, tz, "");
  const routineNote = current ? `Right now on your routine: ${current.label}. ` : "";

  return {
    reply: `${routineNote}${remindersAgenda.reply}`,
    action: "SHOW_CALENDAR",
    intent: "calendar",
    meta: {
      installed: state.installed,
      current,
      blocks: state.blocks,
      reminders: remindersAgenda.meta?.items || [],
    },
  };
}

function buildScheduleReply(T, tz) {
  const state = load();
  if (!state.installed || !state.blocks.length) {
    return {
      reply: `You don't have a routine set up yet, ${T}. Say "give me a healthy schedule" and I'll build one.`,
      action: "SCHEDULE_NATIVE",
      intent: "schedule",
      meta: { installed: false },
    };
  }
  const current = findCurrentBlock(state.blocks, tz);
  const currentNote = current ? `Right now: ${current.label}. ` : "";
  return {
    reply: `${currentNote}Here's the full day, ${T}: ${describeBlocks(state.blocks)}.`,
    action: "SCHEDULE_NATIVE",
    intent: "schedule",
    meta: { installed: true, blocks: state.blocks, current },
  };
}

// ── INTENT DETECTION / ROUTING ───────────────────────────────────
const SETUP_RE = /\b(give me|set up|build me|make me|create)\s+(a\s+)?(healthy\s+)?(schedule|routine|daily routine)\b|\bhealthy\s+(schedule|routine)\b/i;
const INSPO_RE = /\b(inspo|inspiration)\b|\bideas?\b.{0,20}\b(you|u|jarvis|yourself)\b|\b(other|someone else'?s|people'?s)\s+jarvis(es)?\b|\bshow me (some )?jarvis(es)?\b/i;

// Explicit "pull up X" / "open X" for a named platform — the most
// direct case, so it wins over the softer mood-based matching below.
const PLATFORM_OPEN_RE = /\b(pull up|open( up)?|go to|show me)\s+(instagram|insta|youtube|yt)\b/i;

// Softer, mood/state based triggers — "I'm tired", "I'm bored", etc.
// Deliberately generous since this is a single-user assistant.
const MOOD_TRIGGERS = [
  {
    re: /\b(i'?m|feeling|so|really|pretty)\s*(so |really |pretty )?(tired|exhausted|worn out|sleepy|drained)\b/i,
    reply: (T) => `You sound tired, ${T} — here's something easy to watch.`,
    links: () => [
      { platform: "instagram", label: "Instagram",                     url: "https://www.instagram.com/" },
      { platform: "youtube",   label: "YouTube — relaxing / chill mix", url: "https://www.youtube.com/results?search_query=relaxing+chill+mix" },
    ],
  },
  {
    re: /\b(i'?m|so|really)\s*(so |really )?bored\b|\bnothing to do\b/i,
    reply: (T) => `Let's fix that, ${T} — pulling something up.`,
    links: () => [
      { platform: "youtube",   label: "YouTube",   url: "https://www.youtube.com/" },
      { platform: "instagram", label: "Instagram", url: "https://www.instagram.com/" },
    ],
  },
  {
    re: /\b(i need (a |to )?(break|relax|unwind)|i'?m stressed|feeling overwhelmed|need to unwind)\b/i,
    reply: (T) => `Fair enough, ${T} — here, take a minute.`,
    links: () => randomBreakLinks(),
  },
];

function route(message, T, tz, sessionId) {
  if (!message || typeof message !== "string") return null;

  // ── Continuation of "want to take a break?" ──
  if (hasPendingConfirm(sessionId)) {
    if (YES_RE.test(message)) {
      clearPendingConfirm(sessionId);
      const state = load();
      state.workStartedAt = Date.now();
      state.nudgeSent = false;
      save(state);
      return {
        reply: `Good call, ${T}. Pulling something up.`,
        action: "OPEN_LINKS",
        intent: "break",
        meta: { links: randomBreakLinks() },
      };
    }
    if (NO_RE.test(message)) {
      clearPendingConfirm(sessionId);
      const state = load();
      state.workStartedAt = Date.now(); // don't ask again immediately
      state.nudgeSent = false;
      save(state);
      return {
        reply: `Understood, ${T}. I'll leave you to it.`,
        action: "SCHEDULE_NATIVE",
        intent: "break",
        meta: {},
      };
    }
    // Anything else — let it fall through to normal handling, but
    // stop waiting on this particular question so it doesn't linger.
    clearPendingConfirm(sessionId);
  }

  if (SETUP_RE.test(message)) {
    const blocks = installHealthySchedule();
    return {
      reply: `Done, ${T} — I've set you up with a healthy daily routine: wake, movement, focus blocks with real breaks, meals away from the screen, and a proper wind-down before sleep. Say "what's on the agenda" any time, or "I need inspo" when you want something to look at.`,
      action: "SCHEDULE_NATIVE",
      intent: "schedule",
      meta: { installed: true, blocks },
    };
  }

  if (AGENDA_RE.test(message)) {
    return buildCalendarReply(T, tz);
  }

  if (ROUTINE_QUERY_RE.test(message)) {
    return buildScheduleReply(T, tz);
  }

  if (INSPO_RE.test(message)) {
    return {
      reply: `On it, ${T} — pulling up some Jarvis / AI-assistant builds for inspiration.`,
      action: "OPEN_LINKS",
      intent: "inspo",
      meta: { links: inspoLinks() },
    };
  }

  const platformMatch = message.match(PLATFORM_OPEN_RE);
  if (platformMatch) {
    const key = platformMatch[3].toLowerCase();
    const url = PLATFORM_HOME[key] || PLATFORM_HOME.youtube;
    const niceName = { instagram: "Instagram", insta: "Instagram", youtube: "YouTube", yt: "YouTube" }[key] || key;
    return {
      reply: `Pulling up ${niceName}, ${T}.`,
      action: "OPEN_LINKS",
      intent: "platform_open",
      meta: { links: [{ platform: key, label: niceName, url }] },
    };
  }

  for (const trigger of MOOD_TRIGGERS) {
    if (trigger.re.test(message)) {
      return {
        reply: trigger.reply(T),
        action: "OPEN_LINKS",
        intent: "mood",
        meta: { links: trigger.links() },
      };
    }
  }

  return null;
}

module.exports = {
  route,
  installHealthySchedule,
  getBlocks,
  findCurrentBlock,
  buildScheduleReply,
  buildCalendarReply,
  checkWorkNudge,
  setPendingConfirm,
};
