"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Tool Bridge
//
// Before this file, the WhatsApp poller answered every tool call with
// null, so "set a timer" / "check the weather" / etc. did nothing and
// the user just got "…" back.
//
// What this does:
//   1. Runs the SAME tool executor the web app uses
//      (server.js → executeAssistantTool, registered via setExecutor()).
//   2. Handles timers / reminders itself, delivering them as WhatsApp
//      messages. The web app's reminders only alert inside the web UI,
//      so WhatsApp gets its own store: data/wa-reminders.json
//      (inside data/, so persistence.js syncs it to B2 across deploys).
//   3. Blocks tools that only make sense on a screen (open a tab, show
//      the camera, play YouTube…) with a clear message instead of
//      pretending they worked.
//   4. Safety: the wallet private key is never sent over WhatsApp, and
//      non-owner users only get a small allowlist of tools.
// ═══════════════════════════════════════════════════════════════

const fs      = require("fs");
const path    = require("path");
const Manager = require("./whatsapp-manager");
const Sender  = require("./whatsapp-send");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "wa-reminders.json");

// IANA timezone used for "remind me at 5pm" style requests.
// Set WA_TIMEZONE in the environment to change it.
const TIMEZONE = process.env.WA_TIMEZONE || "America/Los_Angeles";

// ── tool policy ───────────────────────────────────────────────────
// Tools that act on a screen / the user's desktop UI. They can't work
// from a text chat.
const WEB_ONLY = new Set([
  "show_pc", "close_pc", "close_all_pcs",
  "show_camera", "hide_camera",
  "start_recording", "stop_recording", "clip_recording",
  "read_screen", "mute_jarvis", "unmute_jarvis",
  "open_build_mode", "open_research", "open_url",
  "open_on_computer", "control_app", "type_text",
  "play_music",
  "make_board", "show_board", "list_boards", "forget_board",
]);

// Never over WhatsApp, for anyone — these return a private key that
// would be left sitting in chat history.
const NEVER_ON_WHATSAPP = new Set([
  "get_wallet_private_key", "get_wallet_address",
]);

// Non-owner users (registered by the owner) may only use these.
// To give users more, add tool names here.
const NON_OWNER_TOOLS = new Set([
  "set_timer", "set_reminder", "cancel_reminder", "get_agenda",
  "get_weather", "get_news",
  "earn_status", "find_ways_to_earn", "check_wallet_balance",
]);

// ── executor registered by server.js ─────────────────────────────
let _executor = null;
function setExecutor(fn) { _executor = fn; }

// ── reminder store ───────────────────────────────────────────────
function loadStore() {
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || []; }
  catch { return []; }
}
function saveStore(items) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(items, null, 2), "utf8");
}

function formatDuration(ms) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60)    return `${s} second${s === 1 ? "" : "s"}`;
  if (s < 120 && s % 60) return `${Math.floor(s / 60)}m ${s % 60}s`;
  const m = Math.round(s / 60);
  if (m < 60)    return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.floor(m / 60), rem = m % 60;
  if (h < 24)    return rem ? `${h}h ${rem}m` : `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"}`;
}

function formatWhen(dueAt) {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: TIMEZONE, weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit",
    }).format(new Date(dueAt));
  } catch { return new Date(dueAt).toString(); }
}

function addItem({ userKey, type, label, dueAt, replyTo = null }) {
  const items = loadStore();
  const item = {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    userKey, type, replyTo,
    label: label || (type === "timer" ? "Timer" : "Reminder"),
    createdAt: Date.now(), dueAt, fired: false, attempts: 0,
  };
  items.push(item);
  saveStore(items);
  return item;
}

// ── WhatsApp-native tools ────────────────────────────────────────
function handleNative(name, args, { account, T, replyTo }) {
  const { userKey } = account;

  if (name === "set_timer") {
    const secs = Number(args.duration_seconds) || 0;
    if (secs <= 0) return { reply: `How long should the timer be, ${T}?` };
    const dueAt = Date.now() + secs * 1000;
    const item = addItem({ userKey, type: "timer", label: args.label || `${formatDuration(secs * 1000)} timer`, dueAt, replyTo });
    return { reply: `Timer set for ${formatDuration(secs * 1000)}, ${T}. I'll text you when it's up.`, action: "TIMER_SET", intent: "timer", meta: { id: item.id, dueAt } };
  }

  if (name === "set_reminder") {
    let dueAt = null;
    if (args.datetime_iso) {
      const parsed = Date.parse(args.datetime_iso);
      if (!Number.isNaN(parsed)) dueAt = parsed;
    }
    if (dueAt == null && args.duration_seconds) dueAt = Date.now() + Number(args.duration_seconds) * 1000;
    if (dueAt == null) return { reply: `When should I remind you, ${T}?` };
    if (dueAt <= Date.now()) return { reply: `That time has already passed, ${T}. When should I remind you?` };
    const item = addItem({ userKey, type: "reminder", label: args.label || "your reminder", dueAt, replyTo });
    return { reply: `Got it, ${T}. I'll text you about "${item.label}" on ${formatWhen(dueAt)}.`, action: "REMINDER_SET", intent: "reminder", meta: { id: item.id, dueAt } };
  }

  if (name === "cancel_reminder") {
    const items = loadStore();
    let cands = items.map((it, i) => ({ it, i })).filter(x => x.it.userKey === userKey && !x.it.fired);
    if (args.type === "timer") cands = cands.filter(x => x.it.type === "timer");
    else if (args.type === "reminder") cands = cands.filter(x => x.it.type !== "timer");
    const top = cands.sort((a, b) => b.it.createdAt - a.it.createdAt)[0];
    if (!top) return { reply: `Nothing active to cancel, ${T}.` };
    const [removed] = items.splice(top.i, 1);
    saveStore(items);
    return { reply: `Cancelled — "${removed.label}", ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" };
  }

  if (name === "get_agenda") {
    const mine = loadStore()
      .filter(it => it.userKey === userKey && !it.fired)
      .sort((a, b) => a.dueAt - b.dueAt)
      .slice(0, 10);
    if (!mine.length) return { reply: `Nothing scheduled on WhatsApp, ${T}.` };
    const lines = mine.map(it => `• ${it.type === "timer" ? "⏱" : "🔔"} ${it.label} — ${formatWhen(it.dueAt)}`);
    return { reply: `Here's what's coming up, ${T}:\n${lines.join("\n")}`, intent: "agenda" };
  }

  return null;
}

// ── public: run one tool for a WhatsApp user ─────────────────────
async function executeTool(name, args, { account, replyTo = null }) {
  const T = account.name || "Sir";
  const isOwner = account.role === "owner";
  args = args && typeof args === "object" ? args : {};
  args._userKey = account.userKey;

  if (NEVER_ON_WHATSAPP.has(name)) {
    return { reply: `I won't send wallet keys over WhatsApp, ${T} — they'd sit in your chat history. Open the Jarvis web app for that.` };
  }
  if (!isOwner && !NON_OWNER_TOOLS.has(name)) {
    return { reply: `That one's owner-only over WhatsApp, ${T}.` };
  }

  const native = handleNative(name, args, { account, T, replyTo });
  if (native) return native;

  if (WEB_ONLY.has(name)) {
    return { reply: `That one acts on a screen, ${T}, so it only works in the Jarvis web app — I can't do it from WhatsApp.` };
  }

  if (!_executor) {
    return { reply: `My tools aren't connected yet, ${T} — give it a moment after a restart and try again.` };
  }

  const result = await _executor(name, args, {
    T,
    userTimezone: TIMEZONE,
    userName:     account.name,
    moodContext:  "",
    sessionId:    `wa:${account.userKey}`,
    fromPhone:    false,
  });
  return result;
}

// ── scheduler: deliver due timers/reminders over WhatsApp ────────
let _timer = null;
let _running = false;
const MAX_ATTEMPTS = 5;

async function deliverDue() {
  if (_running) return;
  _running = true;
  try {
    const items = loadStore();
    const now = Date.now();
    let changed = false;

    for (const it of items) {
      if (it.fired || it.dueAt > now) continue;

      const account = Manager.getAccount(it.userKey);
      if (!account || !account.whatsappApiKey) { it.fired = true; changed = true; continue; }

      const lateMs = now - it.dueAt;
      const lateNote = lateMs > 90_000 ? ` (sent ${formatDuration(lateMs)} late — Jarvis was restarting)` : "";
      const text = it.type === "timer"
        ? `⏰ Time's up, ${account.name} — "${it.label}".${lateNote}`
        : `🔔 Reminder, ${account.name}: ${it.label}.${lateNote}`;

      try {
        await Sender.sendText(account.whatsappApiKey, text, it.replyTo || null);
        it.fired = true;
      } catch (e) {
        it.attempts = (it.attempts || 0) + 1;
        console.warn(`[WA-TOOLS] Couldn't deliver "${it.label}" (try ${it.attempts}/${MAX_ATTEMPTS}): ${e.message}`);
        if (it.attempts >= MAX_ATTEMPTS) it.fired = true;
      }
      changed = true;
    }

    if (changed) {
      // keep the file small: drop items fired more than a day ago
      const cutoff = now - 24 * 3600_000;
      saveStore(items.filter(it => !it.fired || it.dueAt > cutoff));
    }
  } catch (e) {
    console.warn("[WA-TOOLS] scheduler error:", e.message);
  } finally {
    _running = false;
  }
}

function startScheduler() {
  if (_timer) return;
  _timer = setInterval(deliverDue, 15_000);
  if (_timer.unref) _timer.unref();
  console.log("[WA-TOOLS] Reminder scheduler started (WhatsApp timers/reminders).");
  setTimeout(deliverDue, 20_000); // catch anything that came due while we were down
}

module.exports = { executeTool, setExecutor, startScheduler, TIMEZONE };
