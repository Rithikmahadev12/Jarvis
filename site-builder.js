"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WEBSITE BUILDER
// "hey jarvis build me a site for a coffee place" → Jarvis asks for
// a name → generates a real, self-contained single-page site (HTML
// + CSS + a little vanilla JS, no external deps) with Groq → saves
// it to disk → server.js hands the caller a same-origin preview URL
// to show in a window. "hey jarvis download <name>" later zips that
// same folder back up for the user.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const archiver = require("archiver");

let Hermes = null;
try { Hermes = require("./hermes-engine"); } catch { Hermes = null; }

const SITES_DIR    = path.join(__dirname, "data", "sites");
const REGISTRY_FILE = path.join(SITES_DIR, "registry.json");
if (!fs.existsSync(SITES_DIR)) fs.mkdirSync(SITES_DIR, { recursive: true });

// ── REGISTRY ──────────────────────────────────────────────────
// Maps every site Jarvis has built this run (and across restarts)
// so a later "download <name>" can find it by name alone.
function loadRegistry() {
  try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")); }
  catch { return []; }
}
function saveRegistry(list) {
  try { fs.writeFileSync(REGISTRY_FILE, JSON.stringify(list, null, 2)); } catch { /* non-fatal */ }
}

function slugify(name) {
  const base = (name || "site")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "site";
  return `${base}-${Date.now().toString(36)}`;
}

// ── PROMPT ────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You are the web design brain behind J.A.R.V.I.S. Given a business type and name, output ONE complete, self-contained website as raw HTML.

Hard rules:
- Output ONLY the raw HTML document, starting with <!DOCTYPE html> and nothing else — no markdown fences, no commentary before or after.
- Everything must be in that one file: put CSS in a <style> tag in <head>, and any interactivity in a <script> tag before </body>. No external stylesheets, fonts, or scripts, no build tools, no frameworks.
- Do NOT reference any external image URLs (no unsplash/placeholder.com/etc — they won't load offline). Build visuals with pure CSS instead: gradients, shapes, emoji, CSS patterns, typography. Make it still look rich and considered, not blank.
- Real, specific, on-brand copy for the given business — a hero section with the business name and a tagline, an about/story section, a menu/services section with a handful of specific plausible items and prices, a hours/location section, and a simple contact section with a form (form doesn't need to actually submit anywhere — prevent default in JS and show a friendly inline confirmation).
- Fully responsive (works from ~360px mobile width up), clean modern typography (system font stack), a cohesive color palette that fits the business, smooth-scrolling nav to each section, subtle hover/scroll animations via CSS only.
- Semantic HTML, accessible (alt text, labels, sensible contrast).
- No lorem ipsum. Every sentence should read like it was written for this specific business.`;

function extractHtml(raw) {
  let text = (raw || "").trim();
  text = text.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = text.search(/<!DOCTYPE html>|<html/i);
  if (start === -1) throw new Error("Model did not return an HTML document");
  return text.slice(start);
}

// Minimal fallback used only if Groq isn't configured or generation
// fails outright — keeps the feature from being a dead end.
function fallbackHtml(businessType, name) {
  const safeName = escapeHtml(name);
  const safeType = escapeHtml(businessType || "business");
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeName}</title>
<style>
  body{margin:0;font-family:system-ui,sans-serif;background:#2b1d16;color:#f3e7d8;}
  header{padding:6rem 2rem;text-align:center;background:linear-gradient(135deg,#3b2418,#6b3f22);}
  h1{font-size:3rem;margin:0 0 .5rem;}
  section{padding:3rem 2rem;max-width:800px;margin:0 auto;}
</style></head>
<body>
  <header><h1>${safeName}</h1><p>A ${safeType} built for you by J.A.R.V.I.S.</p></header>
  <section><h2>About</h2><p>Details about ${safeName} coming soon.</p></section>
  <section><h2>Contact</h2><p>Get in touch to learn more.</p></section>
</body></html>`;
}
function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ── STREAMING BUILD ───────────────────────────────────────────
// The chat tool call registers the build (instant, no network wait)
// and hands the caller a buildId; the browser then opens the OS-style
// build window and connects to /api/sites/stream/:buildId, which
// drives streamBuild() below and forwards each token to the client as
// it's generated — the window shows the actual HTML materializing
// instead of a blank screen while Groq thinks.
const pendingBuilds = new Map(); // buildId -> { businessType, name }

function startBuild(businessType, name) {
  const cleanName = (name || "").trim();
  if (!cleanName) throw new Error("A business name is required");
  const buildId = `b_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  pendingBuilds.set(buildId, { businessType: (businessType || "business").trim(), name: cleanName });
  return buildId;
}

async function streamBuild(buildId, onDelta) {
  const job = pendingBuilds.get(buildId);
  if (!job) throw new Error("Unknown or already-completed build");
  pendingBuilds.delete(buildId);
  return buildSite(job.businessType, job.name, onDelta);
}

// ── BUILD ─────────────────────────────────────────────────────
async function buildSite(businessType, name, onDelta) {
  const cleanName = (name || "").trim();
  const cleanType = (businessType || "business").trim();
  if (!cleanName) throw new Error("A business name is required");

  let html;
  let streamedAny = false;
  try {
    if (!Hermes || !Hermes.isConfigured()) throw new Error("Build AI isn't configured — set GROQ_API_KEY in .env");
    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Business type: ${cleanType}\nBusiness name: ${cleanName}\nBuild the full single-file website now.` },
    ];
    const raw = typeof onDelta === "function"
      ? await Hermes.groqFetchStream(messages, {
          model: Hermes.MODELS.code, temperature: 0.7, maxTokens: 8000,
          onDelta: (d) => { streamedAny = true; onDelta(d); },
        })
      : await Hermes.groqFetch(messages, Hermes.MODELS.code, 0.7, 8000);
    html = extractHtml(raw);
  } catch (e) {
    // Only substitute the fallback template if nothing had streamed yet —
    // once real tokens are already in the window, restarting mid-stream
    // would just garble what's on screen instead of recovering it.
    if (streamedAny) throw e;
    html = fallbackHtml(cleanType, cleanName);
    if (typeof onDelta === "function") onDelta(html, { fallback: true });
  }

  const slug = slugify(cleanName);
  const dir = path.join(SITES_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), html, "utf8");

  const entry = { slug, name: cleanName, businessType: cleanType, createdAt: Date.now(), url: `/sites/${slug}/index.html` };
  const registry = loadRegistry();
  registry.unshift(entry);
  saveRegistry(registry.slice(0, 200)); // keep it bounded

  return entry;
}

// ── LOOKUP ────────────────────────────────────────────────────
// Fuzzy-ish: exact name match wins, then case-insensitive substring
// either direction, most recent first.
function findSiteByName(name) {
  const q = (name || "").trim().toLowerCase();
  if (!q) return null;
  const registry = loadRegistry();
  let hit = registry.find((s) => s.name.toLowerCase() === q);
  if (!hit) hit = registry.find((s) => s.name.toLowerCase().includes(q) || q.includes(s.name.toLowerCase()));
  return hit || null;
}

function listSites() { return loadRegistry(); }

// ── ZIP ───────────────────────────────────────────────────────
function zipSite(slug, destStream) {
  return new Promise((resolve, reject) => {
    const dir = path.join(SITES_DIR, slug);
    if (!fs.existsSync(dir)) return reject(new Error("No such site on disk"));
    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", reject);
    archive.on("end", resolve);
    archive.pipe(destStream);
    archive.directory(dir, false);
    archive.finalize();
  });
}

module.exports = { buildSite, startBuild, streamBuild, findSiteByName, listSites, zipSite, SITES_DIR };
