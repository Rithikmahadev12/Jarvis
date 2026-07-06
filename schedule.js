"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Daily Schedule / Healthy Routine / Auto-Suggest engine
//
// This gives JARVIS its own lightweight "day planner" on top of the
// reminders/timers engine in reminders.js:
//   - a default healthy daily routine the user can install with one
//     line ("give me a healthy schedule") and read back at any time
//   - detection of "I need inspo/ideas" style requests, which return
//     a batch of links (YouTube/Instagram) instead of a single one
//   - a break watcher: every time the poll loop asks "what block am
//     I in right now", if that block is a "break" and we haven't
//     already surfaced something for THIS block today, we return a
//     suggestion (a couple of links) once. The server pushes that
//     same suggestion into the extension queue too, so the Chrome
//     extension can pop real tabs even when nobody is looking at the
//     JARVIS web page.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "schedule.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, JSON.stringify(defaultState(), null, 2), "utf8");
}

function defaultState() {
  return {
    installed:  false,
    blocks:     [],
    lastSuggestedKey: null, // `${blockId}:${yyyy-mm-dd}` — so each block only fires once per day
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

function todayKeyInTZ(tz) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz || undefined, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
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
// Times are wall-clock, in the user's own timezone. "break" blocks
// are the ones the auto-suggest watcher pays attention to. Feel
// free to edit this list — "give me a healthy schedule" re-installs
// it, and individual times aren't sacred, just a sane starting point.
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
  state.lastSuggestedKey = null;
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

// ── "INSPO" REQUEST (open-ended, user-triggered) ────────────────
// Deliberately loose — this is a single-user assistant, so it's fine
// to over-trigger a little rather than make the person phrase it just
// so. Matches things like "I need some inspo", "give me ideas for you",
// "show me other people's jarvis", "ideas to improve yourself".
const INSPO_RE = /\b(inspo|inspiration)\b|\bideas?\b.{0,20}\b(you|u|jarvis|yourself)\b|\b(other|someone else'?s|people'?s)\s+jarvis(es)?\b|\bshow me (some )?jarvis(es)?\b/i;

function buildInspoLinks() {
  return [
    { platform: "youtube",   label: "YouTube — Jarvis AI assistant builds",   url: "https://www.youtube.com/results?search_query=jarvis+ai+assistant+build" },
    { platform: "instagram", label: "Instagram — #jarvisai",                  url: "https://www.instagram.com/explore/tags/jarvisai/" },
    { platform: "youtube",   label: "YouTube — DIY AI assistant projects",    url: "https://www.youtube.com/results?search_query=diy+personal+ai+assistant+project" },
  ];
}

function buildInspoReply(T) {
  const links = buildInspoLinks();
  return {
    reply: `On it, ${T} — pulling up some Jarvis / AI-assistant builds for inspiration.`,
    action: "OPEN_LINKS",
    intent: "inspo",
    meta: { links },
  };
}

// ── BREAK AUTO-SUGGEST (called from the poll endpoint) ──────────
// Rotates between "keep browsing for Jarvis inspo" and plain wellness
// content so the healthy-schedule breaks don't turn into pure
// doom-scroll bait every single time.
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

function checkBreakSuggestion(tz) {
  const state = load();
  if (!state.installed || !state.blocks.length) return null;

  const block = findCurrentBlock(state.blocks, tz);
  if (!block || block.type !== "break") return null;

  const key = `${block.id}:${todayKeyInTZ(tz)}`;
  if (state.lastSuggestedKey === key) return null; // already fired for this block today

  state.lastSuggestedKey = key;
  save(state);

  const setIndex = Math.floor(Math.random() * BREAK_LINK_SETS.length);
  const links = BREAK_LINK_SETS[setIndex];

  return {
    label: block.label,
    text: `Break time, Sir — "${block.label}". Pulling a couple of things up for you.`,
    links,
  };
}

// ── INTENT DETECTION / ROUTING ───────────────────────────────────
const SETUP_RE = /\b(give me|set up|build me|make me|create)\s+(a\s+)?(healthy\s+)?(schedule|routine|daily routine)\b|\bhealthy\s+(schedule|routine)\b/i;
const QUERY_RE = /\b(what'?s|show|what is)\s+(my\s+)?(schedule|routine|daily routine)\b|\bmy (daily )?routine\b/i;

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

function route(message, T, tz) {
  if (!message || typeof message !== "string") return null;

  if (SETUP_RE.test(message)) {
    const blocks = installHealthySchedule();
    return {
      reply: `Done, ${T} — I've set you up with a healthy daily routine: wake, movement, focus blocks with real breaks, meals away from the screen, and a proper wind-down before sleep. Say "show my routine" any time, or "I need inspo" when you want something to look at on a break.`,
      action: "SCHEDULE_NATIVE",
      intent: "schedule",
      meta: { installed: true, blocks },
    };
  }

  if (QUERY_RE.test(message)) {
    return buildScheduleReply(T, tz);
  }

  if (INSPO_RE.test(message)) {
    return buildInspoReply(T);
  }

  return null;
}

module.exports = {
  route,
  installHealthySchedule,
  getBlocks,
  findCurrentBlock,
  buildScheduleReply,
  buildInspoReply,
  checkBreakSuggestion,
};
