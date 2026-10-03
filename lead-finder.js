"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Lead Finder (automatic business discovery)
//
// Finds local businesses that have a phone number (or email) but NO
// website, using OpenStreetMap's free public APIs (no API key):
//   - Nominatim  -> turns "Austin, TX" into a search area
//   - Overpass   -> lists named businesses in that area with a phone
//                   and no website/url tag, skipping chains/brands
// Optionally double-checks each candidate with Firecrawl (if
// FIRECRAWL_API_KEY is set) so a business that has a site OSM doesn't
// know about isn't pitched "you don't have a website".
//
// Settings (env vars, or data/outreach-settings.json which is synced
// to Supabase and editable from chat/API):
//   OUTREACH_AREAS       "Austin, TX; Dallas, TX"   (required)
//   OUTREACH_CATEGORIES  "restaurant,cafe,hairdresser,..." (optional)
//   OUTREACH_COUNTRY_CODE "1"  (dial prefix for numbers lacking +, default 1)
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR      = path.join(__dirname, "data");
const SETTINGS_PATH = path.join(DATA_DIR, "outreach-settings.json");

const UA = "JarvisOutreach/1.0 (small-business website outreach)";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

// Small, local, service-type businesses that commonly lack a website.
const DEFAULT_CATEGORIES = [
  "restaurant", "cafe", "fast_food", "bakery", "hairdresser", "barber",
  "beauty", "car_repair", "florist", "laundry", "tailor", "butcher",
];

// OSM tag keys a category might live under.
const TAG_KEYS = ["amenity", "shop", "craft"];

// Sites that don't count as "the business's own website".
const NOT_OWN_SITE = [
  "facebook.com", "instagram.com", "yelp.com", "tripadvisor.com", "yellowpages.com",
  "mapquest.com", "google.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com",
  "doordash.com", "ubereats.com", "grubhub.com", "foursquare.com", "bbb.org",
  "wikipedia.org", "opentable.com", "nextdoor.com", "pinterest.com", "youtube.com",
];

// ── settings ─────────────────────────────────────────────────────
function loadSettings() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8") || "{}"); } catch { /* none yet */ }
  const split = (v) => String(v || "").split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
  const areas = Array.isArray(file.areas) && file.areas.length
    ? file.areas
    : split(process.env.OUTREACH_AREAS);
  const categories = Array.isArray(file.categories) && file.categories.length
    ? file.categories
    : String(process.env.OUTREACH_CATEGORIES || "").split(",").map(s => s.trim()).filter(Boolean);
  return {
    areas,
    categories: categories.length ? categories : DEFAULT_CATEGORIES,
    countryCode: String(file.countryCode || process.env.OUTREACH_COUNTRY_CODE || "1").replace(/\D/g, "") || "1",
    nextAreaIndex: Number(file.nextAreaIndex) || 0,
    autoEnabled: file.autoEnabled !== false, // on by default once an area exists
  };
}
function saveSettings(patch) {
  const cur = loadSettings();
  const next = { ...cur, ...patch };
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
  return next;
}

// ── helpers ──────────────────────────────────────────────────────
// Best-effort E.164. Returns null if it can't make a plausible number.
function toE164(raw, countryCode = "1") {
  if (!raw) return null;
  // OSM sometimes lists several numbers separated by ; — take the first.
  const first = String(raw).split(/[;,/]/)[0].trim();
  let digits = first.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) {
    digits = digits.slice(1);
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (countryCode === "1" && digits.length === 10) {
    digits = "1" + digits;
  } else if (countryCode === "1" && digits.length === 11 && digits.startsWith("1")) {
    /* already has the 1 */
  } else if (!digits.startsWith(countryCode)) {
    digits = countryCode + digits.replace(/^0+/, "");
  }
  if (digits.length < 8 || digits.length > 15) return null;
  if (digits.startsWith("1") && digits.length !== 11) return null; // NANP must be 11
  return "+" + digits;
}

function isChain(tags) {
  return !!(tags.brand || tags["brand:wikidata"] || tags.operator && /inc|llc|corp|ltd|group/i.test(tags.operator) || tags["name:etymology:wikidata"]);
}

function hasWebsite(tags) {
  return !!(tags.website || tags["contact:website"] || tags.url || tags["contact:url"]);
}

function normName(n) {
  return String(n || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

async function fetchJson(url, opts = {}, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { "User-Agent": UA, ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// "Austin, TX" -> OSM relation/way id -> Overpass area id
async function geocodeArea(areaName) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&q=${encodeURIComponent(areaName)}`;
  const results = await fetchJson(url);
  const hit = (results || []).find(r => r.osm_type === "relation") || (results || []).find(r => r.osm_type === "way");
  if (!hit) throw new Error(`Couldn't find "${areaName}" on the map`);
  const base = hit.osm_type === "relation" ? 3600000000 : 2400000000;
  return { areaId: base + Number(hit.osm_id), displayName: hit.display_name };
}

function buildOverpassQuery(areaId, categories, limit) {
  const wanted = categories.map(c => c.replace(/[^a-z_]/g, "")).filter(Boolean);
  const re = wanted.join("|");
  // For every tag key, match values in our category list; need a name,
  // need a phone, must not have any website-ish tag.
  const clauses = TAG_KEYS.map(k =>
    ["phone", "contact:phone"].map(p =>
      `nwr["${k}"~"^(${re})$"]["name"]["${p}"][!"website"][!"contact:website"][!"url"][!"contact:url"](area.a);`
    ).join("\n  ")
  ).join("\n  ");
  return `[out:json][timeout:60];\narea(${areaId})->.a;\n(\n  ${clauses}\n);\nout tags center ${Math.max(limit * 6, 60)};`;
}

async function overpass(query) {
  let lastErr;
  for (const url of OVERPASS_URLS) {
    try {
      return await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
      }, 70000);
    } catch (e) { lastErr = e; }
  }
  throw new Error(`Overpass unavailable: ${lastErr && lastErr.message}`);
}

// Optional second opinion: does a web search turn up the business's OWN site?
async function appearsToHaveWebsite(name, area) {
  let Research;
  try { Research = require("./research"); } catch { return false; }
  if (!process.env.FIRECRAWL_API_KEY || typeof Research.firecrawlSearch !== "function") return false;
  try {
    const results = await Research.firecrawlSearch(`${name} ${area}`, { limit: 5 });
    const tokens = normName(name).split(" ").filter(t => t.length > 2);
    for (const r of results || []) {
      let host = "";
      try { host = new URL(r.url).hostname.replace(/^www\./, ""); } catch { continue; }
      if (NOT_OWN_SITE.some(d => host === d || host.endsWith("." + d))) continue;
      const hostFlat = host.replace(/[^a-z0-9]/g, "");
      if (tokens.length && tokens.some(t => hostFlat.includes(t))) return true; // domain looks like the business
    }
  } catch { /* if the check fails, don't block on it */ }
  return false;
}

// ── main entry ───────────────────────────────────────────────────
// Returns up to `limit` candidate businesses: { name, phone, email, address, category, source }
// `exclude(candidate) -> true` lets the caller drop anyone already known/contacted.
async function findBusinessesWithoutWebsite({ area, categories, limit = 10, exclude = () => false, countryCode } = {}) {
  const settings = loadSettings();
  const cats = categories && categories.length ? categories : settings.categories;
  const cc = countryCode || settings.countryCode;

  const { areaId, displayName } = await geocodeArea(area);
  const data = await overpass(buildOverpassQuery(areaId, cats, limit));

  const seen = new Set();
  const candidates = [];
  for (const el of data.elements || []) {
    const t = el.tags || {};
    if (!t.name || hasWebsite(t) || isChain(t)) continue;
    const phone = toE164(t.phone || t["contact:phone"], cc);
    const email = t.email || t["contact:email"] || null;
    if (!phone && !email) continue;
    const key = normName(t.name) + "|" + (phone || email);
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = {
      name: t.name,
      phone,
      email,
      address: [t["addr:housenumber"], t["addr:street"], t["addr:city"]].filter(Boolean).join(" ") || null,
      category: TAG_KEYS.map(k => t[k]).find(Boolean) || null,
      area: displayName,
      source: `osm:${el.type}/${el.id}`,
    };
    if (exclude(cand)) continue;
    candidates.push(cand);
  }

  // Shuffle so repeat runs don't always pick the same alphabetical few.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  const out = [];
  for (const c of candidates) {
    if (out.length >= limit) break;
    if (await appearsToHaveWebsite(c.name, area)) continue;
    out.push(c);
  }
  return { area: displayName, found: out, scanned: (data.elements || []).length };
}

module.exports = {
  findBusinessesWithoutWebsite,
  loadSettings,
  saveSettings,
  toE164,
  // exported for tests
  _internal: { isChain, hasWebsite, buildOverpassQuery, normName },
};
