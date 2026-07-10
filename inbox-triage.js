"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Proactive Inbox Triage
//
// The point of this module: the user should NOT have to ask "check my
// email" for JARVIS to have already looked. Once a user has signed in
// with Google, this:
//   1. Runs on its own on a timer (true background pass, while the
//      server is up), once per calendar day per user.
//   2. ALSO generates on-demand, lazily, the moment anyone asks for
//      today's summary and none exists yet — so even if the server was
//      asleep overnight (common on free hosting tiers that spin down),
//      the very next time the app is opened it's generated immediately,
//      unprompted, before the user says anything about email.
//
// Persisted to data/inbox-triage.json, keyed by user + calendar date,
// same pattern as briefing.js.
// ═══════════════════════════════════════════════════════════════

const fs    = require("fs");
const path  = require("path");
const Google = require("./google");

let Groq = null;
try { Groq = require("./hermes-engine"); } catch { Groq = null; }

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "inbox-triage.json");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

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

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")) || {}; }
  catch { return {}; }
}

// Calendar day key — optionally in the user's own timezone if we have it,
// otherwise server local time (same convention as briefing.js).
function todayKey(tz) {
  const d = new Date();
  if (tz) {
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
        .formatToParts(d).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
      return `${parts.year}-${parts.month}-${parts.day}`;
    } catch { /* fall through to server time */ }
  }
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function userKey(user) {
  return String(user || "guest").toLowerCase().trim() || "guest";
}

// ── SUMMARIZE ──────────────────────────────────────────────────
// Turns the raw unread-message list into a short, prioritized briefing.
async function summarize(inboxData, userTitle = "Sir") {
  const unread   = inboxData.unread || 0;
  const messages = inboxData.messages || [];

  if (unread === 0) {
    return { headline: "Inbox clear overnight — nothing new.", summary: [], source: "empty" };
  }

  if (Groq && typeof Groq.isConfigured === "function" && Groq.isConfigured() && messages.length) {
    try {
      const sys = `You are J.A.R.V.I.S, a crisp, confident AI assistant modeled after the Iron Man film character.
You are given a list of unread emails (subject, sender, sender type, short snippet). Write a short proactive
morning briefing as if you triaged the inbox overnight while the user was away.

Rules:
- Address the user as "${userTitle}" once, naturally, near the start of the headline.
- Sender type "person" means it's actually from an individual, not a company — call these out distinctly,
  e.g. "X personally emailed you about...". Sender type "company" is a business/automated sender; if it names
  a specific person (e.g. a rep reaching out), mention that person's name, e.g. "Sarah from Acme reached out about...".
- Group or prioritize anything that looks urgent/time-sensitive, or is from a real person, first.
- Each summary line should be under 18 words, plain and direct — no fluff, no "I hope this finds you well" style filler.
- Return ONLY compact JSON, nothing else, in this exact shape:
{"headline":"<one sentence, e.g. 'X new emails came in overnight, Y look important'>","summary":["line about email 1","line about email 2","..."]}
- Do not wrap in markdown or code fences. Do not add commentary. Max 6 summary lines.`;

      const userPayload = messages.map((m, i) =>
        `${i + 1}. From: ${m.from} | Type: ${m.senderType || "unknown"}${m.senderPersonName ? ` (name: ${m.senderPersonName})` : ""} | Subject: ${m.subject} | Snippet: ${m.snippet || ""}`
      ).join("\n");

      const chatMessages = [
        { role: "system", content: sys },
        { role: "user", content: `Total unread: ${unread}\n\n${userPayload}` },
      ];

      const raw = await Groq.groqFetch(chatMessages, (Groq.MODELS && Groq.MODELS.smart) || undefined, 0.5, 400);
      const cleaned = String(raw || "").replace(/```json|```/g, "").trim();
      const parsed = JSON.parse(cleaned);

      if (parsed && parsed.headline) {
        return {
          headline: String(parsed.headline).trim(),
          summary: Array.isArray(parsed.summary) ? parsed.summary.map(s => String(s).trim()).filter(Boolean).slice(0, 6) : [],
          source: "ai",
        };
      }
    } catch (e) {
      // fall through to offline fallback
    }
  }

  // Offline fallback: a plain list, no AI needed
  return {
    headline: `${unread} unread email${unread > 1 ? "s" : ""} came in, ${userTitle}.`,
    summary: messages.slice(0, 5).map(m => {
      const tag = m.senderType === "person" ? " (person)" : m.senderType === "company" ? " (company)" : "";
      return `${m.from}${tag}: ${m.subject}`;
    }),
    source: "fallback",
  };
}

// ── CORE: run triage for one user, store it, return the entry ───
async function runForUser(userKey_, userTitle, tz) {
  const key = userKey(userKey_);
  const inboxData = await Google.handleGmailCommand("check inbox", key);
  if (inboxData.needsAuth || inboxData.error) {
    return { error: inboxData.error || "needs_auth", needsAuth: !!inboxData.needsAuth };
  }

  const result = await summarize(inboxData, userTitle || "Sir");
  const entry = {
    date: todayKey(tz),
    unread: inboxData.unread || 0,
    headline: result.headline,
    summary: result.summary,
    source: result.source,
    generatedAt: new Date().toISOString(),
  };

  const all = loadAll();
  all[key] = entry;
  saveAll(all);
  return entry;
}

// Returns today's stored triage for this user, or null if none generated yet.
function getToday(user, tz) {
  const all = loadAll();
  const key = userKey(user);
  const entry = all[key];
  if (!entry || entry.date !== todayKey(tz)) return null;
  return entry;
}

// Lazy, on-demand version: if today's triage doesn't exist yet, generate it
// right now. This is what makes the feature reliable even if the server
// happened to be asleep overnight (e.g. free-tier hosting) — the moment
// the user opens the app, it's generated fresh, without them asking about
// email at all.
async function getOrGenerateToday(user, userTitle, tz) {
  const existing = getToday(user, tz);
  if (existing) return existing;
  try {
    const fresh = await runForUser(user, userTitle, tz);
    if (fresh.error) return null;
    return fresh;
  } catch {
    return null;
  }
}

// ── BACKGROUND SWEEP: every connected user, once per calendar day ──
// Called on a timer from server.js. Safe to call often — it's a no-op
// for any user whose entry already exists for today.
async function runOvernightSweep() {
  const profiles = loadProfiles();
  const results = [];
  for (const [key, profile] of Object.entries(profiles)) {
    if (!profile?.googleTokens?.access) continue; // not connected
    const existing = getToday(key);
    if (existing) continue; // already done today
    try {
      // Warm the in-memory token cache from the saved profile tokens
      Google.hydrateTokens(key, profile.googleTokens);
      const entry = await runForUser(key, profile.title || "Sir");
      results.push({ user: key, ok: !entry.error });
    } catch (e) {
      results.push({ user: key, ok: false, error: e.message });
    }
  }
  return results;
}

module.exports = {
  getToday,
  getOrGenerateToday,
  runForUser,
  runOvernightSweep,
  todayKey,
};
