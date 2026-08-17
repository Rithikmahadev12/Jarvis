"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Persistent Memory Sync (Supabase Storage)
//
// Render's free tier gives the app an EPHEMERAL filesystem: every
// redeploy, and every spin-down after ~15 minutes of inactivity,
// wipes the container and rebuilds it fresh. Everything JARVIS keeps
// in data/ — memories, profiles, reminders, schedule, training data,
// learned intents, self-improvement knowledge, and (eventually) any
// research cache — would vanish with it.
//
// This module mirrors the ENTIRE data/ directory to a Supabase
// Storage bucket. Supabase's free tier gives 1GB of file storage,
// needs NO credit card to sign up, and never auto-deletes your data
// (only fully-inactive free *database* projects pause after 7 days —
// Storage isn't affected the same way, and our periodic sync/boot
// pull keeps the project active anyway).
//
//   - on boot:      pull anything already saved in Supabase down
//                    into data/ BEFORE the rest of the app touches
//                    those files (see server.js boot sequence)
//   - while running: every FLUSH_INTERVAL_MS, push any data/ files
//                    that changed since the last push up to Supabase
//   - on shutdown:  SIGTERM/SIGINT (what Render sends before killing
//                    the process, whether from a redeploy or an idle
//                    spin-down) triggers one last flush so nothing
//                    written in the final seconds is lost
//
// Every other module (trainer.js, reminders.js, schedule.js,
// briefing.js, hermes-engine.js, self-improve.js, server.js's own
// profiles/memories helpers, ...) is UNTOUCHED — they keep reading
// and writing plain files under data/ exactly as they did before.
// This module is just a mirror running underneath them. Files are
// read/written as raw buffers, so this works for text (JSON, .js
// handlers) AND binary content (images, PDFs, etc.) alike — handy
// if a future research/caching feature starts saving non-text files.
//
// ── SETUP (no credit card needed) ─────────────────────────────
// 1. https://supabase.com → sign up (email or GitHub) → New project.
// 2. In that project: Storage (left sidebar) → Create a new bucket.
//    Name it anything (e.g. "jarvis-memory"); Private is fine.
// 3. Project Settings → API. Copy:
//      Project URL              → SUPABASE_URL
//      service_role secret key  → SUPABASE_SERVICE_ROLE_KEY
//    (Use the service_role key, NOT the anon/public key — this runs
//    on the server and needs full read/write access to the bucket.)
// 4. Set these three in Render (Environment tab):
//      SUPABASE_URL
//      SUPABASE_SERVICE_ROLE_KEY
//      SUPABASE_BUCKET   (the bucket name from step 2)
// 5. Redeploy. Look for "[MEMORY-SYNC]" lines in the Render logs to
//    confirm it's pulling/pushing. Without those env vars set, JARVIS
//    runs exactly as before — local-only, lost on restart — so this
//    is safe to add without breaking anything.
// ═══════════════════════════════════════════════════════════════

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const DATA_DIR    = path.join(__dirname, "data");
const SUPABASE_URL = process.env.SUPABASE_URL              || "";
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET        = process.env.SUPABASE_BUCKET           || "";
const FLUSH_INTERVAL_MS = 20 * 1000; // push changed files every 20s

function isConfigured() {
  return !!(SUPABASE_URL && SERVICE_KEY && BUCKET);
}

let _client = null;
function client() {
  if (_client) return _client;

  // Supabase's client sets up a Realtime/WebSocket layer internally even
  // though this module only ever uses Storage (upload/download/list) —
  // and on Node < 22 (no native global WebSocket) that setup throws,
  // which was silently killing every push/pull ("Failed to push X:
  // Node.js 20 detected without native WebSocket support"). Node 22+
  // (what Render runs) has native WebSocket so it never hit this.
  // Fix: hand it the "ws" package as its transport when the native
  // global isn't there, exactly as Supabase's own error suggests.
  let wsTransport;
  if (typeof WebSocket === "undefined") {
    try { wsTransport = require("ws"); }
    catch {
      console.warn(
        '[MEMORY-SYNC] Node < 22 detected and the "ws" package isn\'t installed — ' +
        'Supabase sync will fail. Run `npm install ws` (already in package.json) or ' +
        "upgrade to Node 22+."
      );
    }
  }

  _client = createClient(SUPABASE_URL, SERVICE_KEY, {
    auth: { persistSession: false },
    ...(wsTransport ? { realtime: { transport: wsTransport } } : {}),
  });
  return _client;
}

function hashOf(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function listLocalFiles(dir) {
  let out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out = out.concat(listLocalFiles(full));
    else out.push(full);
  }
  return out;
}

function guessContentType(relPath) {
  if (relPath.endsWith(".json")) return "application/json";
  if (relPath.endsWith(".js"))   return "application/javascript";
  return "application/octet-stream";
}

// Supabase Storage's list() isn't recursive — folders come back as
// entries with id === null, so this walks down into them by hand.
async function listRemoteFiles(prefix = "") {
  const { data, error } = await client().storage.from(BUCKET).list(prefix, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) throw error;

  let out = [];
  for (const item of data || []) {
    const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id === null) {
      out = out.concat(await listRemoteFiles(itemPath)); // it's a folder — recurse
    } else {
      out.push(itemPath);
    }
  }
  return out;
}

// Tracks a hash of the last content we successfully pushed/pulled for
// each file (not the content itself — keeps this cheap even if a
// future research cache puts bigger files through here), so flush()
// only spends calls on files that actually changed.
const _lastSynced = new Map();

// ── PULL: Supabase → local disk (call once, at boot, before
// anything else reads data/) ───────────────────────────────────────
async function pullAll() {
  if (!isConfigured()) {
    console.log(
      "[MEMORY-SYNC] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET " +
      "not set — running LOCAL-ONLY. Memory will be lost on restart/redeploy. " +
      "See persistence.js header for setup."
    );
    return;
  }
  try {
    console.log("[MEMORY-SYNC] Connecting to Supabase — restoring saved memory...");
    const relPaths = await listRemoteFiles();
    let restored = 0;
    for (const relPath of relPaths) {
      const { data, error } = await client().storage.from(BUCKET).download(relPath);
      if (error || !data) continue;
      const buffer = Buffer.from(await data.arrayBuffer());
      const fullPath = path.join(DATA_DIR, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, buffer);
      _lastSynced.set(relPath, hashOf(buffer));
      restored++;
    }
    console.log(`[MEMORY-SYNC] Restored ${restored} file(s) from Supabase. Memory intact.`);
  } catch (e) {
    console.warn("[MEMORY-SYNC] Pull failed — continuing with whatever's on local disk:", e.message);
  }
}

// ── PUSH: local disk → Supabase (whatever changed since the last call) ──
async function flush() {
  if (!isConfigured()) return 0;
  const files = listLocalFiles(DATA_DIR);
  let pushed = 0;
  for (const fullPath of files) {
    const relPath = path.relative(DATA_DIR, fullPath).split(path.sep).join("/");
    let buffer;
    try { buffer = fs.readFileSync(fullPath); } catch { continue; }
    const hash = hashOf(buffer);
    if (_lastSynced.get(relPath) === hash) continue; // unchanged since last sync
    try {
      const { error } = await client().storage.from(BUCKET).upload(relPath, buffer, {
        contentType: guessContentType(relPath),
        upsert: true,
      });
      if (error) throw error;
      _lastSynced.set(relPath, hash);
      pushed++;
    } catch (e) {
      console.warn(`[MEMORY-SYNC] Failed to push ${relPath}:`, e.message);
    }
  }
  if (pushed) console.log(`[MEMORY-SYNC] Pushed ${pushed} changed file(s) to Supabase.`);
  return pushed;
}

// ── BACKGROUND LOOP + GRACEFUL SHUTDOWN FLUSH ─────────────────────
let _interval = null;
let _shutdownHooked = false;

function startAutoSync() {
  if (!isConfigured() || _interval) return;

  _interval = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
  if (_interval.unref) _interval.unref(); // don't keep the process alive just for this

  if (!_shutdownHooked) {
    _shutdownHooked = true;
    const shutdown = (signal) => {
      console.log(`[MEMORY-SYNC] ${signal} received — flushing memory to Supabase before exit...`);
      flush()
        .catch((e) => console.warn("[MEMORY-SYNC] Final flush failed:", e.message))
        .finally(() => process.exit(0));
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));
  }

  console.log(`[MEMORY-SYNC] Auto-sync running — pushing changes to Supabase every ${FLUSH_INTERVAL_MS / 1000}s.`);
}

// ── DIRECT READ/WRITE (no local disk, no periodic mirror) ─────────
// For data where correctness depends on EVERY reader/writer seeing
// the same live state immediately, no matter which process instance
// handles the request — e.g. a webhook-mode phone call registered
// by whichever instance placed it, then looked up moments later by
// whichever instance Render happens to route the webhook delivery
// to. Those can be different processes/disks during a rolling
// deploy, and the regular pullAll()-once-at-boot + flush()-every-20s
// mirror can't guarantee they ever converge in time — an instance
// that booted before a write happened elsewhere simply never sees
// it until its next restart. These three go straight to Supabase on
// every call instead, so there's no local cache to go stale.
async function getJSON(relPath) {
  if (!isConfigured()) return null;
  try {
    const { data, error } = await client().storage.from(BUCKET).download(relPath);
    if (error || !data) return null;
    const buffer = Buffer.from(await data.arrayBuffer());
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

async function putJSON(relPath, obj) {
  if (!isConfigured()) return false;
  try {
    const buffer = Buffer.from(JSON.stringify(obj, null, 2));
    const { error } = await client().storage.from(BUCKET).upload(relPath, buffer, {
      contentType: "application/json",
      upsert: true,
    });
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn(`[MEMORY-SYNC] Direct write of ${relPath} failed: ${e.message}`);
    return false;
  }
}

async function deleteRemote(relPath) {
  if (!isConfigured()) return false;
  try {
    const { error } = await client().storage.from(BUCKET).remove([relPath]);
    if (error) throw error;
    return true;
  } catch (e) {
    console.warn(`[MEMORY-SYNC] Direct delete of ${relPath} failed: ${e.message}`);
    return false;
  }
}

module.exports = { pullAll, flush, startAutoSync, isConfigured, getJSON, putJSON, deleteRemote };
