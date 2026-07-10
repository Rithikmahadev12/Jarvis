"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Proactive Engine
//
// This is the "do it, don't ask" layer. It's the difference between:
//   User: "what's the weather / any news / what's on my calendar?"
//   ...and JARVIS just having already looked, and telling you.
//
// Ground rule enforced throughout this file: everything here is
// read-only or fully reversible (checking weather/news/calendar/inbox,
// suggesting a break). Nothing that spends money or sends something
// on the user's behalf lives here — those still ask first. See the
// module-level comment block below for the exact boundary.
//
// ── WHAT'S AUTONOMOUS vs WHAT STILL ASKS ─────────────────────────
//   Autonomous (acts + reports back):
//     - Morning briefing: weather + top headlines + today's calendar
//       + inbox headline, combined into one proactive message.
//     - Work-session break nudges: after being "at it" for an hour,
//       JARVIS picks a break suggestion and tells you, instead of
//       asking permission first.
//     - Inbox/calendar triage: reading + summarizing + flagging
//       urgent-looking mail (see inbox-triage.js) — never replies.
//   Still asks first, every time:
//     - Anything that spends money (purchases, subscriptions, etc.)
//     - Sending or replying to an email, or any outbound message,
//       on the user's behalf.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const Weather     = require("./weather");
const News        = require("./news");
const Google      = require("./google");
const InboxTriage = require("./inbox-triage");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "proactive-briefing.json");

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

function todayKey(tz) {
  const d = new Date();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch { /* fall through */ }
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function userKey(user) {
  return String(user || "guest").toLowerCase().trim() || "guest";
}

// ── BUILD ONE COMBINED BRIEFING ───────────────────────────────────
// Pulls whatever sources are actually configured/connected for this
// user and stitches them into a single "here's what I've got for you"
// message. Anything unconfigured (missing API key, Google not
// connected) is silently skipped rather than treated as an error —
// the point is to report what JARVIS *could* check, not nag about
// what it can't.
async function buildBriefing(userKey_, userTitle, tz) {
  const T = userTitle || "Sir";
  const parts = [];
  const meta  = {};

  // Weather — uses DEFAULT_CITY unless a per-user city is wired up later.
  try {
    const w = await Weather.fetchWeather(process.env.DEFAULT_CITY || "London");
    if (!w.error) {
      parts.push(`${w.city} is ${w.temp}°C and ${w.description}, high of ${w.high}° / low of ${w.low}°.`);
      meta.weather = w;
    }
  } catch { /* skip — not configured */ }

  // Top headlines — one line, not a full feed dump.
  try {
    const n = await News.fetchTopHeadlines({ category: "general" });
    if (!n.error && n.articles?.length) {
      const top = n.articles[0];
      parts.push(`Top story right now: "${top.title}" (${top.source}).`);
      meta.news = n.articles.slice(0, 5);
    }
  } catch { /* skip — not configured */ }

  // Today's calendar — only if Google is connected for this user.
  try {
    if (Google.isConfigured() && Google.hasTokenForUser(userKey_)) {
      const cal = await Google.getCalendarEvents("today", userKey_);
      if (!cal.needsAuth && !cal.error) {
        const events = cal.events || [];
        if (events.length) {
          const first = events[0];
          const rest  = events.length - 1;
          parts.push(
            `${events.length} thing${events.length > 1 ? "s" : ""} on the calendar today` +
            ` — first up, ${first.title} at ${first.time}${rest > 0 ? `, plus ${rest} more` : ""}.`
          );
        } else {
          parts.push(`Calendar's clear today.`);
        }
        meta.calendar = events;
      }
    }
  } catch { /* skip — not connected */ }

  // Inbox — reuses inbox-triage.js, which already only reads/summarizes.
  try {
    const inbox = await InboxTriage.getOrGenerateToday(userKey_, T, tz);
    if (inbox) {
      parts.push(inbox.headline);
      meta.inbox = inbox;
    }
  } catch { /* skip — not connected */ }

  if (!parts.length) return null; // nothing configured — nothing to report

  const headline = `Morning, ${T}. Here's where things stand: ${parts.join(" ")}`;
  return { headline, parts, meta, generatedAt: new Date().toISOString() };
}

// ── PUBLIC API — same "generate once per calendar day" pattern as
//    briefing.js / inbox-triage.js ──────────────────────────────
function getToday(user, tz) {
  const all = loadAll();
  const key = userKey(user);
  const entry = all[key];
  if (!entry || entry.date !== todayKey(tz)) return null;
  return entry;
}

async function runForUser(user, userTitle, tz) {
  const key = userKey(user);
  const built = await buildBriefing(key, userTitle, tz);
  if (!built) return null;
  const entry = { date: todayKey(tz), ...built };
  const all = loadAll();
  all[key] = entry;
  saveAll(all);
  return entry;
}

// Lazy generation, same rationale as inbox-triage.getOrGenerateToday:
// if the server was asleep overnight, the first request of the day
// generates it on the spot instead of the user having to ask.
async function getOrGenerateToday(user, userTitle, tz) {
  const existing = getToday(user, tz);
  if (existing) return existing;
  try { return await runForUser(user, userTitle, tz); }
  catch { return null; }
}

module.exports = {
  getToday,
  getOrGenerateToday,
  runForUser,
  todayKey,
};
