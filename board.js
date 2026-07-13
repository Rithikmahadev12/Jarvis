"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Floating Board Store
//
// "Boards" are the small floating on-screen cards JARVIS can create
// on request ("Jarvis, make a board on how you work") and pull back
// up later by topic ("pull up the board we made on how you work"),
// even after a page refresh — because they live here, in
// data/boards.json, not in the browser tab.
//
// Same read/write-a-JSON-file pattern as reminders.js/schedule.js,
// so it also rides persistence.js's existing data/ mirror to
// Supabase for free, no extra wiring needed.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "boards.json");

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) fs.writeFileSync(STORE_FILE, "[]", "utf8");
}

function loadAll() {
  ensureStore();
  try { return JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) || []; }
  catch { return []; }
}

function saveAll(boards) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(boards, null, 2), "utf8");
}

function words(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

function makeId() {
  return "board_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── CREATE / UPDATE ─────────────────────────────────────────────
function createBoard(title, content) {
  const boards = loadAll();
  const board = {
    id:        makeId(),
    title:     (title || "Untitled").trim().slice(0, 80),
    content:   (content || "").trim(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  boards.push(board);
  saveAll(boards);
  return board;
}

function updateBoard(id, patch) {
  const boards = loadAll();
  const b = boards.find(x => x.id === id);
  if (!b) return null;
  Object.assign(b, patch, { updatedAt: Date.now() });
  saveAll(boards);
  return b;
}

// ── LIST ─────────────────────────────────────────────────────────
function listBoards() {
  return loadAll().sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── FUZZY FIND BY TOPIC/TITLE ─────────────────────────────────────
// "the board on how you work" -> matches a board titled
// "How I Work" via word overlap; falls back to the most recent
// board if the query is empty/generic ("pull up the board").
function findBoard(query) {
  const boards = loadAll();
  if (!boards.length) return null;

  const q = (query || "").trim().toLowerCase();
  const qWords = new Set(words(query));

  if (!qWords.size) return boards[boards.length - 1];

  let best = null;
  let bestScore = 0;
  for (const b of boards) {
    const title = b.title.toLowerCase();
    let score = 0;
    if (title === q) score += 10;
    else if (title.includes(q) || q.includes(title)) score += 4;

    const tWords = new Set(words(b.title));
    for (const w of qWords) if (tWords.has(w)) score += 1;

    if (score > bestScore) { bestScore = score; best = b; }
  }
  return bestScore > 0 ? best : null;
}

function deleteBoard(id) {
  const boards = loadAll();
  const idx = boards.findIndex(b => b.id === id);
  if (idx === -1) return false;
  boards.splice(idx, 1);
  saveAll(boards);
  return true;
}

module.exports = { createBoard, updateBoard, listBoards, findBoard, deleteBoard, loadAll };
