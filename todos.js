"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Research Todo List
//
// A separate list from reminders.js/habits.js: this one is just topics
// you want JARVIS to go research — not on a schedule you keep, but on
// HIS schedule (the Night Shift Research GitHub Action, 2am Pacific).
//
//   "Jarvis, add <topic> to my research list"
//   "Jarvis, research <topic> overnight"
//   "Jarvis, what's on my research list"
//   "Jarvis, remove <topic> from my research list"
//
// Stored in data/todos.json — same plain-JSON-file pattern as
// boards.js/habits.js, so it rides persistence.js's existing Supabase
// mirror for free. That's the bridge to the Night Shift Action: it
// runs on GitHub's servers (not your PC) and reads/writes this same
// file directly in the Supabase Storage bucket.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "todos.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, "[]", "utf8");
}

function loadAll() {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || []; }
  catch { return []; }
}

function saveAll(todos) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(todos, null, 2), "utf8");
}

function makeId() {
  return "todo_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── CORE CRUD (also used directly by the night-shift script) ────
function add(text) {
  const todos = loadAll();
  const entry = {
    id: makeId(),
    text: String(text || "").trim(),
    status: "pending",       // pending -> researching -> done
    addedAt: new Date().toISOString(),
    researchedAt: null,
  };
  todos.push(entry);
  saveAll(todos);
  return entry;
}

function list({ status } = {}) {
  const todos = loadAll();
  return status ? todos.filter(t => t.status === status) : todos;
}

function removeByFuzzyText(query) {
  const todos = loadAll();
  const q = (query || "").trim().toLowerCase();
  if (!q) return null;
  const idx = todos.findIndex(t => t.text.toLowerCase().includes(q));
  if (idx === -1) return null;
  const [removed] = todos.splice(idx, 1);
  saveAll(todos);
  return removed;
}

function markStatus(id, status, extra = {}) {
  const todos = loadAll();
  const t = todos.find(x => x.id === id);
  if (!t) return null;
  Object.assign(t, { status }, extra);
  saveAll(todos);
  return t;
}

// ── CONVERSATIONAL ROUTER (wire into server.js's dispatch chain) ──
const ADD_RE    = /\b(?:add\s+(.+?)\s+to\s+(?:my\s+)?research\s+list|research\s+(.+?)\s+overnight|look\s+into\s+(.+?)\s+overnight)\b/i;
const LIST_RE   = /\b(?:what'?s\s+on\s+|show\s+(?:me\s+)?)?(?:my\s+)?research\s+list\b/i;
const REMOVE_RE = /\bremove\s+(.+?)\s+from\s+(?:my\s+)?research\s+list\b/i;

function route(message, T) {
  if (!message) return null;

  const removeMatch = message.match(REMOVE_RE);
  if (removeMatch) {
    const removed = removeByFuzzyText(removeMatch[1]);
    return {
      reply: removed
        ? `Removed "${removed.text}" from your research list, ${T}.`
        : `I couldn't find that on your research list, ${T}.`,
      action: "RESEARCH_TODO_REMOVE",
      intent: "research_todo_remove",
    };
  }

  const addMatch = message.match(ADD_RE);
  if (addMatch) {
    const topic = (addMatch[1] || addMatch[2] || addMatch[3] || "").trim();
    if (!topic) return null;
    const entry = add(topic);
    return {
      reply: `Added to your research list, ${T} — I'll dig into "${entry.text}" overnight and have it ready for your morning brief.`,
      action: "RESEARCH_TODO_ADD",
      intent: "research_todo_add",
      meta: { todo: entry },
    };
  }

  if (LIST_RE.test(message)) {
    const pending = list({ status: "pending" });
    if (!pending.length) {
      return {
        reply: `Your research list is empty, ${T}.`,
        action: "RESEARCH_TODO_LIST",
        intent: "research_todo_list",
      };
    }
    const lines = pending.map((t, i) => `${i + 1}. ${t.text}`).join("\n");
    return {
      reply: `Here's what's queued for overnight research, ${T}:\n${lines}`,
      action: "RESEARCH_TODO_LIST",
      intent: "research_todo_list",
      meta: { pending },
    };
  }

  return null;
}

module.exports = {
  add,
  list,
  removeByFuzzyText,
  markStatus,
  route,
  loadAll,
  saveAll,
};
