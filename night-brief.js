"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Night Research Brief
//
// The Night Shift Research GitHub Action (scripts/night-shift-research.js)
// runs on GitHub's servers at ~2am Pacific, researches whatever's on your
// research list (todos.js), and uploads the results straight to your
// Supabase Storage bucket as data/night-research.json.
//
// Your existing persistence.js already pulls the ENTIRE data/ directory
// down from Supabase on every boot — so by the time you talk to JARVIS
// in the morning, data/night-research.json is already sitting on disk
// with zero extra wiring needed on the sync side. This module just
// knows how to read and format it, and to avoid repeating the same
// findings on every future "brief me" once they've been delivered once.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR   = path.join(__dirname, "data");
const STORE_FILE = path.join(DATA_DIR, "night-research.json");

function load() {
  try {
    if (!fs.existsSync(STORE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch { return null; }
}

function save(data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2), "utf8");
}

// Returns { text, count } for any items not yet delivered, or null if
// there's nothing new. Does NOT mark them delivered — call
// markDelivered() once you've actually shown the text to the user.
function getUndelivered(T = "Sir") {
  const data = load();
  if (!data || !Array.isArray(data.items)) return null;

  const fresh = data.items.filter(i => !i.delivered);
  if (!fresh.length) return null;

  const lines = fresh.map((item, i) => {
    const sources = (item.sources || [])
      .slice(0, 3)
      .map(s => `   - ${s.title}: ${s.url}`)
      .join("\n");
    return `${i + 1}. ${item.topic}\n   ${item.summary}${sources ? "\n" + sources : ""}`;
  }).join("\n\n");

  const heading = fresh.length === 1
    ? `While you were out, ${T}, I looked into that overnight research item —`
    : `While you were out, ${T}, I got through ${fresh.length} items on your research list —`;

  return { text: `${heading}\n\n${lines}`, count: fresh.length, topics: fresh.map(i => i.topic) };
}

function markDelivered() {
  const data = load();
  if (!data || !Array.isArray(data.items)) return;
  data.items.forEach(i => { i.delivered = true; });
  save(data);
}

module.exports = { load, save, getUndelivered, markDelivered };
