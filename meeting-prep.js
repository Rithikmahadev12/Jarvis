"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Meeting Prep
//
// proactive.js knows your calendar (getCalendarEvents). inbox-triage.js
// knows your email. Neither connects the two per-event. This does:
// for an upcoming calendar event, find the last email thread with the
// same attendees and hand back a 2-line "here's what you last discussed
// with them" note — the thing you'd want a real assistant to have ready
// before you walk into a meeting.
//
// Read-only, same ground rule as proactive.js: this only looks things
// up, it never sends or replies to anything.
//
// Persisted to data/meeting-prep.json, keyed by user + event id, so a
// prep note is generated once per event (not re-fetched/re-summarized
// on every ~60s nudge poll) — same caching rationale as inbox-triage.js.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const Google = require("./google");

let Groq = null;
try { Groq = require("./hermes-engine"); } catch { Groq = null; }

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "meeting-prep.json");

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

// Condense a raw email (subject/from/date/snippet) into a short spoken
// line. Falls back to a plain, un-AI'd sentence if Groq isn't configured
// or the call fails — same fallback shape as inbox-triage.js's summarize().
async function condense(event, thread, userTitle) {
  const T = userTitle || "Sir";
  const fallback = `${T}, before "${event.title}" — the last thread with them was "${thread.subject}" from ${thread.from}: ${thread.snippet}`.trim();

  if (!Groq || typeof Groq.isConfigured !== "function" || !Groq.isConfigured()) return fallback;

  try {
    const sys = `You are J.A.R.V.I.S, a crisp, confident AI assistant modeled after the Iron Man film character.
You are given one upcoming calendar event and the most recent email thread with its attendees. Write a short
spoken prep note as if you looked this up unprompted, right before the meeting.

Rules:
- Address the user as "${T}" once, naturally, near the start.
- Two sentences max. Under 40 words total.
- Sentence 1: name the meeting and when it starts.
- Sentence 2: what was last discussed with these people by email, in plain language — not a quote, a paraphrase.
- No filler like "I hope this finds you well". Return ONLY the plain text, no JSON, no quotes, no markdown.`;

    const userPayload = `Meeting: "${event.title}" at ${event.time}\nLast email — Subject: ${thread.subject} | From: ${thread.from} | Date: ${thread.date} | Snippet: ${thread.snippet}`;

    const chatMessages = [
      { role: "system", content: sys },
      { role: "user", content: userPayload },
    ];

    const raw = await Groq.groqFetch(chatMessages, (Groq.MODELS && Groq.MODELS.fast) || undefined, 0.5, 150);
    const cleaned = String(raw || "").replace(/```/g, "").trim();
    return cleaned || fallback;
  } catch {
    return fallback; // offline / call failed — plain sentence still ships
  }
}

// Build (and cache) a prep note for one event. Returns null if there's
// nothing to say — no Google connection, no attendees, or no prior
// thread found (silently skipped, same "nothing configured, nothing to
// report" pattern as proactive.js's buildBriefing).
async function getPrepForEvent(user, event, userTitle) {
  const key = userKey(user);
  if (!event?.id) return null;
  if (!Google.isConfigured() || !Google.hasTokenForUser(key)) return null;
  if (!event.attendees?.length) return null;

  const all = loadAll();
  const cached = all[key]?.[event.id];
  if (cached) return cached;

  let thread = null;
  try { thread = await Google.findRecentThreadWithPeople(key, event.attendees); }
  catch { return null; }
  if (!thread) return null;

  const text = await condense(event, thread, userTitle);
  const entry = { text, event: { id: event.id, title: event.title, time: event.time, startISO: event.startISO }, thread, generatedAt: new Date().toISOString() };

  all[key] = all[key] || {};
  all[key][event.id] = entry;
  saveAll(all);

  return entry;
}

module.exports = {
  getPrepForEvent,
};
