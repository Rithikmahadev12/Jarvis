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
const Settings    = require("./settings");
const Focus       = require("./focus");
const MeetingPrep = require("./meeting-prep");
const Instagram   = require("./instagram");

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
  const today = todayKey(tz);
  const all = loadAll();
  // Merge rather than overwrite — checkNudges() may have already written
  // nudgedEventIds for today onto this same entry before the briefing ran
  // (server just started, nobody's opened the daily briefing yet). Losing
  // that would mean re-nudging about an event JARVIS already mentioned.
  const prior = all[key] && all[key].date === today ? all[key] : {};
  const entry = { ...prior, date: today, ...built };
  all[key] = entry;
  saveAll(all);
  return entry;
}

// ═══════════════════════════════════════════════════════════════
// ── NUDGE ENGINE ───────────────────────────────────────────────
// The daily briefing above answers "what's going on today" once.
// This answers a different question, checked far more often (the
// client polls this every ~60s, same pattern as schedule.js's break
// nudges): "has anything just become worth interrupting for?"
//
// v1 covers one concrete, high-value correlation: an upcoming
// calendar event JARVIS hasn't mentioned yet, cross-referenced with
// today's weather. That's the actual "connects the dots" behavior —
// not two separate features bolted together, but one noticing what
// the other already knows. Extend checkNudges() with more
// correlations over time; the dedupe/quiet-hours/settings scaffolding
// here is built to hold more than one.
// ═══════════════════════════════════════════════════════════════

const NUDGE_WINDOW_MIN = 15; // "starts soon" = within this many minutes

function isQuietHours(tz) {
  const settings = Settings.load();
  if (settings.proactiveNudges === false) return true; // treat "off" as always-quiet
  const start = settings.quietHoursStart;
  const end   = settings.quietHoursEnd;
  if (start == null || end == null) return false;
  let hour;
  try {
    hour = tz
      ? parseInt(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(new Date()), 10) % 24
      : new Date().getHours();
  } catch { hour = new Date().getHours(); }
  if (Number.isNaN(hour)) return false;
  return start <= end
    ? (hour >= start && hour < end)   // e.g. 13 -> 18, doesn't wrap midnight
    : (hour >= start || hour < end);  // e.g. 22 -> 7, wraps midnight
}

// Loose keyword check against whatever description string weather.js
// returns — deliberately simple; false negatives just skip a nice-to-have
// line, false positives just add one, neither is harmful.
function soundsLikeBadWeather(description) {
  if (!description) return false;
  return /rain|shower|storm|thunder|snow|sleet|hail|drizzle/i.test(description);
}

function minutesUntil(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(ms)) return null;
  return Math.round(ms / 60000);
}

// Reads whatever weather JARVIS already fetched for today's briefing
// (cached on the stored entry) rather than firing a fresh API call on
// every 60s poll — cheap, and consistent with what the user was already
// told this morning.
function cachedWeatherFor(key, tz) {
  const entry = getToday(key, tz);
  return entry?.meta?.weather || null;
}

async function checkNudges(user, userTitle, tz) {
  const key = userKey(user);
  if (isQuietHours(tz)) return null;

  const settings = Settings.load();
  if (settings.proactiveNudges === false) return null;

  // Heads-down session in progress — hold this nudge back and count it
  // instead, so the user gets an accurate "N held back" report on resurface.
  if (Focus.isActive(key)) {
    Focus.recordSuppressed(key);
    return null;
  }

  if (!Google.isConfigured() || !Google.hasTokenForUser(key)) return null;

  let events = [];
  try {
    const cal = await Google.getCalendarEvents("today", key);
    if (cal.needsAuth || cal.error) return null;
    events = cal.events || [];
  } catch { return null; }

  const all = loadAll();
  const today = todayKey(tz);
  const prior = all[key] && all[key].date === today ? all[key] : { date: today };
  const alreadyNudged = new Set(prior.nudgedEventIds || []);

  // Find the soonest upcoming event that's inside the nudge window and
  // hasn't been mentioned yet. Only ever surface one at a time — a wall
  // of nudges defeats the point.
  const candidate = events
    .filter(e => e.startISO && !alreadyNudged.has(e.id))
    .map(e => ({ ...e, minsUntil: minutesUntil(e.startISO) }))
    .filter(e => e.minsUntil !== null && e.minsUntil >= 0 && e.minsUntil <= NUDGE_WINDOW_MIN)
    .sort((a, b) => a.minsUntil - b.minsUntil)[0];

  if (!candidate) return null;

  const T = userTitle || "Sir";
  const when = candidate.minsUntil <= 1 ? "in a minute" : `in about ${candidate.minsUntil} minutes`;
  let text = `${T}, "${candidate.title}" starts ${when}.`;

  const weather = cachedWeatherFor(key, tz);
  if (weather && soundsLikeBadWeather(weather.description)) {
    text += candidate.location
      ? ` It's ${weather.description} out there — worth leaving a few minutes early and grabbing an umbrella.`
      : ` Also worth knowing: it's ${weather.description} out there right now.`;
  }

  prior.nudgedEventIds = [...alreadyNudged, candidate.id];
  all[key] = prior;
  saveAll(all);

  return { text, event: candidate, generatedAt: new Date().toISOString() };
}

// ═══════════════════════════════════════════════════════════════
// ── MEETING PREP NUDGE ────────────────────────────────────────
// Sibling of checkNudges above, same polling/dedupe shape, but a
// separate concern: instead of "your meeting is soon", this is
// "here's what you last discussed with them by email" — see
// meeting-prep.js. Kept as its own function/endpoint rather than
// folded into checkNudges so the client can show it as its own card
// and so a slow Gmail search on this path never delays the plain
// "starts soon" nudge above.
// ═══════════════════════════════════════════════════════════════

const PREP_WINDOW_MIN = 20; // look this far ahead for something to prep

async function checkMeetingPrep(user, userTitle, tz) {
  const key = userKey(user);
  if (isQuietHours(tz)) return null;

  const settings = Settings.load();
  if (settings.proactiveNudges === false) return null;
  if (Focus.isActive(key)) return null; // don't interrupt a heads-down session either

  if (!Google.isConfigured() || !Google.hasTokenForUser(key)) return null;

  let events = [];
  try {
    const cal = await Google.getCalendarEvents("today", key);
    if (cal.needsAuth || cal.error) return null;
    events = cal.events || [];
  } catch { return null; }

  const all = loadAll();
  const today = todayKey(tz);
  const prior = all[key] && all[key].date === today ? all[key] : { date: today };
  const alreadyPrepped = new Set(prior.preppedEventIds || []);

  const candidate = events
    .filter(e => e.startISO && e.attendees?.length && !alreadyPrepped.has(e.id))
    .map(e => ({ ...e, minsUntil: minutesUntil(e.startISO) }))
    .filter(e => e.minsUntil !== null && e.minsUntil >= 0 && e.minsUntil <= PREP_WINDOW_MIN)
    .sort((a, b) => a.minsUntil - b.minsUntil)[0];

  if (!candidate) return null;

  let prep = null;
  try { prep = await MeetingPrep.getPrepForEvent(key, candidate, userTitle); }
  catch { return null; }
  if (!prep) return null; // nothing found — don't mark as prepped, might exist by next poll

  prior.preppedEventIds = [...alreadyPrepped, candidate.id];
  all[key] = prior;
  saveAll(all);

  return { text: prep.text, event: candidate, thread: prep.thread, generatedAt: new Date().toISOString() };
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

// ═══════════════════════════════════════════════════════════════
// ── SOCIAL MOMENT NUDGE ───────────────────────────────────────────
// "Sir, you seemed to have a good time at the beach" — Jarvis
// noticing a new Instagram post on its own and commenting on it,
// the same unprompted way it already surfaces calendar/inbox nudges.
//
// Unlike checkNudges/checkMeetingPrep above, this is NOT day-scoped —
// once Jarvis has reacted to a given post it should never repeat that
// reaction later, even after the dedupe store's "date" field has
// moved on to a new day, so this tracks lastSeenInstaId directly
// rather than resetting through the `prior.date === today` pattern
// the other two nudges use.
// ═══════════════════════════════════════════════════════════════
const SOCIAL_FRESHNESS_MS = 6 * 60 * 60 * 1000; // only react to posts from the last 6 hours

async function checkSocialMoment(user, userTitle, tz) {
  const key = userKey(user);
  if (isQuietHours(tz)) return null;

  const settings = Settings.load();
  if (settings.proactiveNudges === false) return null;
  if (Focus.isActive(key)) return null; // don't interrupt a heads-down session

  if (!Instagram.isConfigured() || !Instagram.hasToken()) {
    // No OAuth app set up — fall back to the lightweight "just a
    // username" tracking path (see instagram.js). That path gates
    // its own search+scrape to ~once/day internally, so it's safe to
    // call on the same ~60s poll as everything else here; most calls
    // just return null immediately without hitting the network.
    if (!Instagram.getTrackedUsername()) return null;
    try {
      const result = await Instagram.dailyTrackedCheck(userTitle);
      if (!result) return null;
      return { text: result.reply, url: result.url, generatedAt: new Date().toISOString() };
    } catch { return null; }
  }

  let media = [];
  try {
    const result = await Instagram.fetchRecentMedia(3);
    if (result.needsAuth || result.error) return null;
    media = result.media || [];
  } catch { return null; }
  if (!media.length) return null;

  const all = loadAll();
  const prior = all[key] || {};
  const latest = media[0];

  if (prior.lastSeenInstaId === latest.id) return null; // already reacted to this one

  const ageMs = Date.now() - new Date(latest.timestamp).getTime();
  const isFresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= SOCIAL_FRESHNESS_MS;
  if (!isFresh) {
    // Not new enough to react to (e.g. the very first check right
    // after connecting the account, with a backlog of old posts) —
    // still remember it so it never triggers a nudge once its window
    // has passed, but don't say anything about it now.
    all[key] = { ...prior, lastSeenInstaId: latest.id };
    saveAll(all);
    return null;
  }

  let text;
  try { text = await Instagram.describePost(latest, { userTitle }); }
  catch { return null; }

  all[key] = { ...prior, lastSeenInstaId: latest.id };
  saveAll(all);

  return { text, post: latest, generatedAt: new Date().toISOString() };
}

module.exports = {
  getToday,
  getOrGenerateToday,
  runForUser,
  checkNudges,
  checkMeetingPrep,
  checkSocialMoment,
  todayKey,
};
