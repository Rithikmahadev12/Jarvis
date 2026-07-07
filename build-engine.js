"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — BUILD MODE ENGINE
// Server-side half of the CAD-style Build Mode. Searches Sketchfab
// for real 3D models, downloads + unpacks the glTF the browser can
// actually load, and caches the result on disk so repeat pulls are
// instant. If no Sketchfab token is configured it still works —
// callers get a small built-in library of procedural placeholder
// parts (block / cylinder / plate / bracket / gear) so Build Mode
// is never a dead end.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const https = require("https");

let AdmZip = null;
try { AdmZip = require("adm-zip"); } catch { /* optional dep — see package.json */ }

const CACHE_DIR = path.join(__dirname, "data", "build-cache");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const TOKEN = process.env.SKETCHFAB_API_TOKEN || "";
const SEARCH_CACHE = new Map();
const SEARCH_TTL   = 10 * 60 * 1000;

// Built-in fallback catalog — always available, no key required.
// The client renders these as real three.js primitives (not images),
// so grabbing / spinning / screwing them together works identically
// to a downloaded model.
const PLACEHOLDER_PARTS = [
  { uid: "prim:block",    name: "Steel Block",      shape: "box",      color: "#8fa3b0" },
  { uid: "prim:plate",    name: "Mounting Plate",   shape: "plate",    color: "#9aa7ad" },
  { uid: "prim:cylinder", name: "Pipe Section",     shape: "cylinder", color: "#7d8b93" },
  { uid: "prim:bracket",  name: "L-Bracket",        shape: "bracket",  color: "#a68a5b" },
  { uid: "prim:gear",     name: "Gear",             shape: "gear",     color: "#c9a227" },
  { uid: "prim:sphere",   name: "Ball Joint",       shape: "sphere",   color: "#6f7f8c" },
  { uid: "prim:panel",    name: "Body Panel",       shape: "panel",    color: "#b23b3b" },
  { uid: "prim:beam",     name: "Support Beam",     shape: "beam",     color: "#556270" },
];

function hasToken() { return !!TOKEN; }

function fetchJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchJson(res.headers.location, headers));
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close(); fs.unlink(destPath, () => {});
        return reject(new Error(`Download failed (${res.statusCode})`));
      }
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", (e) => { fs.unlink(destPath, () => {}); reject(e); });
  });
}

// ── SEARCH ──────────────────────────────────────────────────────
// Sketchfab's basic search endpoint is public (no token required);
// the token only gates actually *downloading* a model. So search
// always tries the real API first, and only falls back to the
// placeholder catalog if that request fails outright (offline, rate
// limited, etc).
async function searchModels(query, count = 12) {
  const q = (query || "").trim();
  if (!q) return { source: "placeholder", results: PLACEHOLDER_PARTS };

  const cacheKey = `${q}:${count}`;
  const cached = SEARCH_CACHE.get(cacheKey);
  if (cached && Date.now() - cached.ts < SEARCH_TTL) return cached.data;

  try {
    const url = `https://api.sketchfab.com/v3/search?type=models&downloadable=true&sort_by=-relevance&count=${count}&q=${encodeURIComponent(q)}`;
    const headers = hasToken() ? { Authorization: `Token ${TOKEN}` } : {};
    const { status, body } = await fetchJson(url, headers);
    if (status !== 200 || !body?.results?.length) throw new Error("no results");

    const results = body.results.map((m) => ({
      uid: m.uid,
      name: m.name,
      author: m.user?.username || "unknown",
      thumbnail: m.thumbnails?.images?.[0]?.url || null,
      viewerUrl: m.viewerUrl,
      faceCount: m.faceCount,
      downloadable: !!m.isDownloadable,
      real: true,
    })).filter((m) => m.downloadable);

    const data = { source: "sketchfab", results: results.length ? results : PLACEHOLDER_PARTS };
    SEARCH_CACHE.set(cacheKey, { ts: Date.now(), data });
    return data;
  } catch (e) {
    // Offline / rate-limited / no network — never leave the user with nothing to place.
    return { source: "placeholder", results: PLACEHOLDER_PARTS, note: e.message };
  }
}

// ── FETCH A LOADABLE MODEL ───────────────────────────────────────
// Returns { kind: "placeholder", part } or { kind: "gltf", url } where
// `url` is a same-origin static path the client's GLTFLoader can hit.
async function getLoadableModel(uid) {
  if (uid.startsWith("prim:")) {
    const part = PLACEHOLDER_PARTS.find((p) => p.uid === uid) || PLACEHOLDER_PARTS[0];
    return { kind: "placeholder", part };
  }

  if (!hasToken()) {
    return {
      kind: "error",
      error: "SKETCHFAB_API_TOKEN is not set — add it to .env to pull real downloadable models. Using a placeholder part instead.",
      fallback: { kind: "placeholder", part: PLACEHOLDER_PARTS[Math.floor(Math.random() * PLACEHOLDER_PARTS.length)] },
    };
  }

  const destDir = path.join(CACHE_DIR, uid);
  const gltfEntry = findCachedGltf(destDir);
  if (gltfEntry) return { kind: "gltf", url: `/build-cache/${uid}/${gltfEntry}` };

  try {
    const { status, body } = await fetchJson(`https://api.sketchfab.com/v3/models/${uid}/download`, {
      Authorization: `Token ${TOKEN}`,
    });
    if (status !== 200) throw new Error(`Sketchfab download API returned ${status}`);

    const gltf = body.gltf || body.glb;
    if (!gltf?.url) throw new Error("model has no downloadable glTF package");

    fs.mkdirSync(destDir, { recursive: true });
    const archivePath = path.join(destDir, "archive.zip");
    await downloadFile(gltf.url, archivePath);

    if (AdmZip) {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(destDir, true);
      fs.unlinkSync(archivePath);
      const entry = findCachedGltf(destDir);
      if (!entry) throw new Error("archive did not contain a .gltf/.glb file");
      return { kind: "gltf", url: `/build-cache/${uid}/${entry}` };
    }

    // No unzip library available — if Sketchfab happened to hand back a
    // raw .glb (single binary, no archive) we can still serve it directly.
    const isGlb = gltf.url.split("?")[0].toLowerCase().endsWith(".glb");
    if (isGlb) {
      const glbPath = path.join(destDir, "model.glb");
      fs.renameSync(archivePath, glbPath);
      return { kind: "gltf", url: `/build-cache/${uid}/model.glb` };
    }
    throw new Error("adm-zip is not installed (run: npm install adm-zip) so the downloaded archive can't be unpacked");
  } catch (e) {
    return {
      kind: "error",
      error: e.message,
      fallback: { kind: "placeholder", part: PLACEHOLDER_PARTS[Math.floor(Math.random() * PLACEHOLDER_PARTS.length)] },
    };
  }
}

function findCachedGltf(dir) {
  if (!fs.existsSync(dir)) return null;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const entry of fs.readdirSync(cur, { withFileTypes: true })) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (/\.(gltf|glb)$/i.test(entry.name)) return path.relative(dir, full).split(path.sep).join("/");
    }
  }
  return null;
}

module.exports = { searchModels, getLoadableModel, hasToken, PLACEHOLDER_PARTS, CACHE_DIR };
