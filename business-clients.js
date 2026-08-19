"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Business Clients (intake for the video-ad pipeline)
//
// Stores what a person tells Jarvis about a business they want ads
// made for: name, website, what it's about, niche/vibe, and which
// social platforms to post to. video-script.js reads this to write
// the ad script; video-agent-routes.js reads it to run a campaign.
//
// Lives at data/business_clients.json — the SAME data/ folder
// persistence.js already mirrors to Supabase Storage, so a client's
// info survives a Render redeploy/spin-down exactly like memories,
// reminders, etc. do. No extra wiring needed.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "data");
const FILE     = path.join(DATA_DIR, "business_clients.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadAll() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(FILE, "utf8")); }
  catch { return {}; } // { [id]: client }
}
function saveAll(all) {
  ensureDataDir();
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
}

function slugify(name) {
  const base = (name || "business")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "business";
  return `${base}-${Date.now().toString(36)}`;
}

// KNOWN_PLATFORMS mirrors what Postiz itself can post to (see
// postiz-agent.js) — kept here too so callers/tool schemas can offer a
// clean enum without importing postiz-agent.js just for this list.
const KNOWN_PLATFORMS = ["youtube", "tiktok", "instagram", "x", "facebook", "linkedin", "threads", "pinterest"];

/**
 * Create or update a business client profile.
 * @param {object} info
 * @param {string} [info.id] - existing client id to update; omit to create new
 * @param {string} info.name - business name
 * @param {string} [info.website] - the business's site, e.g. for the script/voiceover to reference
 * @param {string} [info.about] - free-text description of what the business does/sells
 * @param {string} [info.niche] - short vibe/category, e.g. "coffee shop", "SaaS", "nail salon"
 * @param {string} [info.tone] - desired ad tone, e.g. "energetic", "calm/luxury", "funny"
 * @param {string[]} [info.platforms] - subset of KNOWN_PLATFORMS to post to
 */
function upsertClient(info = {}) {
  if (!info.name || !String(info.name).trim()) {
    throw new Error("A business name is required.");
  }
  const all = loadAll();
  const id = info.id && all[info.id] ? info.id : slugify(info.name);
  const existing = all[id] || {};
  const platforms = Array.isArray(info.platforms)
    ? info.platforms.map((p) => String(p).toLowerCase().trim()).filter((p) => KNOWN_PLATFORMS.includes(p))
    : existing.platforms || [];

  all[id] = {
    id,
    name: String(info.name).trim(),
    website: info.website != null ? String(info.website).trim() : (existing.website || ""),
    about: info.about != null ? String(info.about).trim() : (existing.about || ""),
    niche: info.niche != null ? String(info.niche).trim() : (existing.niche || ""),
    tone: info.tone != null ? String(info.tone).trim() : (existing.tone || "energetic"),
    platforms,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveAll(all);
  return all[id];
}

function getClient(id) {
  const all = loadAll();
  return all[id] || null;
}

function findClientByName(name) {
  const all = loadAll();
  const lower = String(name || "").toLowerCase().trim();
  if (!lower) return null;
  return Object.values(all).find((c) => c.name.toLowerCase() === lower)
    || Object.values(all).find((c) => c.name.toLowerCase().includes(lower))
    || null;
}

function listClients() {
  return Object.values(loadAll()).sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

function deleteClient(id) {
  const all = loadAll();
  if (!all[id]) return false;
  delete all[id];
  saveAll(all);
  return true;
}

module.exports = {
  KNOWN_PLATFORMS,
  upsertClient,
  getClient,
  findClientByName,
  listClients,
  deleteClient,
};
