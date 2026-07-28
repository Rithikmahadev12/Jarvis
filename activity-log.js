"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Ambient Activity Log
//
// Answers the "what did I even do today?" half of the debrief when
// the user never set a morning task (see briefing.js / debrief.js).
// Polls the foreground window title on an interval, all day, so by
// the time "debrief me" comes in there's already a timeline to
// summarize — no need to ask the user to reconstruct their own day.
//
// COST: zero. This does NOT use screen-vision.js's OCR or vision
// paths — reading a window title is a single PowerShell call
// (same primitive teams-control.js already uses for its incoming-
// call watcher), no screenshot, no Groq/Gemini tokens. The only
// paid call in this whole module is the *optional* one-line AI
// polish of the final recap sentence at debrief time — one request
// per day, not one per poll — and it has a free fallback if no key
// is configured or the call fails.
//
// Windows-only for now (matches this repo's existing Windows-heavy
// local-agent code). On macOS/Linux, tracking is simply a no-op —
// buildActivityRecap() reports hasData:false and callers fall back
// to asking the user directly, same as before this module existed.
// ═══════════════════════════════════════════════════════════════

const { exec } = require("child_process");
const os   = require("os");
const fs   = require("fs");
const path = require("path");

let Groq = null;
try { Groq = require("./hermes-engine"); } catch { Groq = null; }

let Settings = null;
try { Settings = require("./settings"); } catch { Settings = null; }

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "activity-log.json");

// Poll cadence — cheap, local, no reason to run it tighter than this.
// Override with ACTIVITY_POLL_MS in .env if you want finer granularity.
const POLL_MS = Number(process.env.ACTIVITY_POLL_MS) || 90 * 1000; // 90s
// Gaps longer than this (user stepped away, machine slept, etc.) don't
// count toward an app's tracked time — otherwise an overnight gap
// would show up as "8 hours in VS Code."
const MAX_GAP_MS = 20 * 60 * 1000; // 20 minutes
// Bound file growth — plenty for "what did I do today" purposes.
const MAX_ENTRIES_PER_DAY = 2000;
const KEEP_DAYS = 14;

function isWindows() { return os.platform() === "win32"; }

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

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function userKey(user) {
  return String(user || "guest").toLowerCase().trim() || "guest";
}

function trackingEnabled() {
  if (String(process.env.JARVIS_TRACK_ACTIVITY || "").toLowerCase() === "false") return false;
  if (Settings) {
    try {
      const s = Settings.load();
      if (s && s.activityTracking === false) return false;
    } catch { /* fall through to enabled */ }
  }
  return true;
}

// ── FOREGROUND WINDOW TITLE (free, local, Windows-only) ──────────
function getForegroundWindowTitle() {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve("");
    const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class JarvisFg {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}
"@
$h = [JarvisFg]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[JarvisFg]::GetWindowText($h, $sb, 512) | Out-Null
Write-Output $sb.ToString()
`.trim();
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      resolve(err ? "" : String(stdout || "").trim());
    });
  });
}

// Splits a window title like "debrief.js - Jarvis-main - Visual Studio Code"
// into { app: "Visual Studio Code", detail: "debrief.js - Jarvis-main" }.
// Titles that don't follow the "detail - app" convention (single-segment
// titles like "Slack" or "Calculator") just come back as { app: title, detail: "" }.
function splitTitle(title) {
  const t = String(title || "").trim();
  if (!t) return { app: "", detail: "" };
  const parts = t.split(/\s+[-–—]\s+/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 1) return { app: parts[0], detail: "" };
  const app = parts[parts.length - 1];
  const detail = parts.slice(0, -1).join(" - ");
  return { app, detail };
}

// ── LOGGING ────────────────────────────────────────────────────
function appendEntry(user, title) {
  if (!title) return;
  const all = loadAll();
  const key = userKey(user);
  const day = todayKey();
  const entry = all[key] && all[key].date === day ? all[key] : { date: day, entries: [] };

  const last = entry.entries[entry.entries.length - 1];
  if (last && last.title === title) return; // dedupe consecutive identical titles

  entry.entries.push({ t: new Date().toISOString(), title });
  if (entry.entries.length > MAX_ENTRIES_PER_DAY) {
    entry.entries = entry.entries.slice(entry.entries.length - MAX_ENTRIES_PER_DAY);
  }
  all[key] = entry;
  pruneOldDays(all);
  saveAll(all);
}

// activity-log.json isn't keyed by day at the top level (unlike
// briefing/debrief) — it's one entry per user holding just today's
// list, mirroring those files' shape. Old days are pruned here by
// simply not carrying forward stale `entries` past KEEP_DAYS worth
// of staleness on the *date* field itself, so the file never grows
// past "today" per user. Kept as a helper for a future multi-day
// view if that's ever wanted.
function pruneOldDays(all) {
  const cutoff = Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const key of Object.keys(all)) {
    const rec = all[key];
    if (rec && rec.date) {
      const t = Date.parse(rec.date);
      if (!Number.isNaN(t) && t < cutoff) delete all[key];
    }
  }
}

// ── TRACKING LOOP ──────────────────────────────────────────────
let pollTimer = null;
let trackedUserGetter = () => "guest";

// Starts polling the foreground window title. getUserFn (optional) lets
// the caller supply "who's currently signed in" if that varies; defaults
// to a single-user "guest" bucket, which is fine for a single desktop.
function startTracking(getUserFn) {
  if (pollTimer) return; // already running
  if (!isWindows()) {
    console.log("[activity-log] Not on Windows — foreground-window tracking is unavailable here. Debrief will fall back to asking directly.");
    return;
  }
  if (typeof getUserFn === "function") trackedUserGetter = getUserFn;

  const tick = async () => {
    if (!trackingEnabled()) return;
    try {
      const title = await getForegroundWindowTitle();
      appendEntry(trackedUserGetter(), title);
    } catch { /* best-effort — never let tracking crash the server */ }
  };

  tick(); // once immediately so a same-minute debrief still has a data point
  pollTimer = setInterval(tick, POLL_MS);
  console.log(`[activity-log] Tracking foreground window every ${Math.round(POLL_MS / 1000)}s (zero API cost — local only).`);
}

function stopTracking() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

function isTracking() { return !!pollTimer; }

// ── READ / SUMMARIZE ───────────────────────────────────────────
function getTodayEntries(user) {
  const all = loadAll();
  const rec = all[userKey(user)];
  if (!rec || rec.date !== todayKey()) return [];
  return rec.entries || [];
}

// Groups the raw title timeline into per-app buckets with an estimated
// minutes-spent (gap-capped, see MAX_GAP_MS) and up to 4 example detail
// lines (file/doc/tab names) per app — purely local, no AI needed.
function groupByApp(entries) {
  const buckets = new Map(); // app -> { minutes, details: Set }
  for (let i = 0; i < entries.length; i++) {
    const { app, detail } = splitTitle(entries[i].title);
    if (!app) continue;
    if (!buckets.has(app)) buckets.set(app, { minutes: 0, details: new Set() });
    const b = buckets.get(app);
    if (detail) b.details.add(detail);

    const next = entries[i + 1];
    if (next) {
      const gap = Date.parse(next.t) - Date.parse(entries[i].t);
      if (gap > 0 && gap <= MAX_GAP_MS) b.minutes += gap / 60000;
    }
  }
  return [...buckets.entries()]
    .map(([app, b]) => ({ app, minutes: Math.round(b.minutes), details: [...b.details].slice(0, 4) }))
    .sort((a, b) => b.minutes - a.minutes);
}

function fallbackRecapText(appBreakdown) {
  if (!appBreakdown.length) return "";
  const top = appBreakdown.slice(0, 4).map(a => {
    const time = a.minutes >= 1 ? ` (~${a.minutes}m)` : "";
    const detail = a.details.length ? ` — ${a.details.slice(0, 2).join(", ")}` : "";
    return `${a.app}${time}${detail}`;
  });
  return `Here's what I picked up from your screen today: ${top.join("; ")}.`;
}

// AI-polished version of the same data — one call, not one per poll.
// Falls back to the plain templated line above if no key is configured
// or the call fails; never blocks the debrief flow.
async function aiRecapText(appBreakdown) {
  if (!(Groq && typeof Groq.isConfigured === "function" && Groq.isConfigured())) return null;
  try {
    const compact = appBreakdown.slice(0, 6).map(a =>
      `${a.app}${a.minutes ? ` (~${a.minutes} min)` : ""}${a.details.length ? `: ${a.details.slice(0, 3).join(", ")}` : ""}`
    ).join("\n");
    const sys = `You are J.A.R.V.I.S. Below is a rough log of apps/windows a user had open today, with a time estimate and example file/tab names for each. The user did NOT set a task this morning, so this log is the only record of their day. Write ONE short, natural spoken sentence (max ~30 words) summarizing what they appear to have worked on — specific, not generic. No preamble, no quotes, just the sentence.`;
    const messages = [
      { role: "system", content: sys },
      { role: "user", content: compact },
    ];
    const raw = await Groq.groqFetch(messages, (Groq.MODELS && Groq.MODELS.smart) || undefined, 0.4, 120);
    const text = String(raw || "").replace(/^["']|["']$/g, "").trim();
    return text || null;
  } catch { return null; }
}

// Public entry point for debrief.js / server.js: builds today's recap.
// Returns { hasData, text, appBreakdown, source }. hasData:false means
// there's nothing tracked yet (tracking off, non-Windows, or a fresh
// day with no samples) — callers should fall back to asking the user.
async function buildActivityRecap(user) {
  const entries = getTodayEntries(user);
  const appBreakdown = groupByApp(entries);

  if (!appBreakdown.length) {
    return { hasData: false, text: "", appBreakdown: [], source: "none" };
  }

  const ai = await aiRecapText(appBreakdown);
  if (ai) return { hasData: true, text: ai, appBreakdown, source: "ai" };

  return { hasData: true, text: fallbackRecapText(appBreakdown), appBreakdown, source: "fallback" };
}

module.exports = {
  startTracking,
  stopTracking,
  isTracking,
  getTodayEntries,
  buildActivityRecap,
  todayKey,
};a
