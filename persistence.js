"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Persistent Memory Sync (Backblaze B2 / S3)
//
// Drop-in replacement for the Supabase-backed persistence.js.
// Same public API, same boot sequence, same data/ mirror logic —
// only the storage backend changed. Backblaze B2 exposes an
// S3-compatible endpoint so we use @aws-sdk/client-s3 directly;
// no Backblaze-specific SDK needed.
//
// Free tier: 10 GB storage, never pauses, no inactivity policy.
//
// ── ENV VARS (replace the three SUPABASE_* vars in Render) ────
//   B2_ENDPOINT          e.g. https://s3.us-east-005.backblazeb2.com
//   B2_BUCKET            e.g. jarvis-data
//   B2_KEY_ID            your applicationKeyId
//   B2_APP_KEY           your applicationKey
//   WALLET_ENCRYPTION_SECRET  (unchanged — same as before)
//
// ── INSTALL ───────────────────────────────────────────────────
//   npm install @aws-sdk/client-s3
//   (then remove @supabase/supabase-js from package.json if desired)
// ═══════════════════════════════════════════════════════════════

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const {
  S3Client,
  ListObjectsV2Command,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
} = require("@aws-sdk/client-s3");

// ── CONFIG ────────────────────────────────────────────────────
const DATA_DIR   = path.join(__dirname, "data");
const ENDPOINT   = process.env.B2_ENDPOINT   || "";
const BUCKET     = process.env.B2_BUCKET     || "";
const KEY_ID     = process.env.B2_KEY_ID     || "";
const APP_KEY    = process.env.B2_APP_KEY    || "";
const FLUSH_INTERVAL_MS = 20 * 1000;
const KEYS_PREFIX = "wallet-keys";

function isConfigured() {
  return !!(ENDPOINT && BUCKET && KEY_ID && APP_KEY);
}

// ── S3 CLIENT (lazy) ──────────────────────────────────────────
let _client = null;
function client() {
  if (_client) return _client;
  _client = new S3Client({
    endpoint: ENDPOINT,
    region: "us-east-005",           // B2 ignores region but SDK requires one
    credentials: { accessKeyId: KEY_ID, secretAccessKey: APP_KEY },
    forcePathStyle: true,            // required for B2
  });
  return _client;
}

// ── HELPERS ───────────────────────────────────────────────────
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

// Collect a readable stream into a Buffer
async function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end",  () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// List ALL keys in the bucket (handles B2's 1000-item pagination)
async function listRemoteFiles(prefix = "") {
  let out = [];
  let continuationToken;
  do {
    const cmd = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix || undefined,
      ContinuationToken: continuationToken,
    });
    const res = await client().send(cmd);
    for (const obj of res.Contents || []) {
      // skip the wallet-keys folder during the normal data mirror
      if (!prefix && obj.Key.startsWith(KEYS_PREFIX + "/")) continue;
      out.push(obj.Key);
    }
    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
  return out;
}

// ── SYNC STATE ────────────────────────────────────────────────
const _lastSynced = new Map();
let _pullOk = false;

// ── PULL: B2 → local disk ─────────────────────────────────────
async function pullAll() {
  if (!isConfigured()) {
    console.log(
      "[MEMORY-SYNC] B2_ENDPOINT / B2_BUCKET / B2_KEY_ID / B2_APP_KEY " +
      "not set — running LOCAL-ONLY. Memory will be lost on restart/redeploy."
    );
    return;
  }

  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      console.log(`[MEMORY-SYNC] Connecting to Backblaze B2 — restoring saved memory (try ${attempt}/${MAX_ATTEMPTS})...`);
      const keys = await listRemoteFiles();
      let restored = 0, failed = 0;

      for (const key of keys) {
        try {
          const res = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
          const buffer = await streamToBuffer(res.Body);
          const fullPath = path.join(DATA_DIR, key);
          fs.mkdirSync(path.dirname(fullPath), { recursive: true });
          fs.writeFileSync(fullPath, buffer);
          _lastSynced.set(key, hashOf(buffer));
          restored++;
        } catch (e) {
          console.warn(`[MEMORY-SYNC] Failed to restore ${key}: ${e.message}`);
          failed++;
        }
      }

      if (failed) throw new Error(`${failed} file(s) failed to download`);
      _pullOk = true;
      console.log(`[MEMORY-SYNC] Restored ${restored} file(s) from B2. Memory intact.`);
      return;
    } catch (e) {
      console.warn(`[MEMORY-SYNC] Pull failed (try ${attempt}/${MAX_ATTEMPTS}): ${e.message}`);
      if (attempt < MAX_ATTEMPTS) await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }

  console.error(
    "[MEMORY-SYNC] Could NOT restore from B2. Pushing is DISABLED this run so your saved " +
    "data in B2 can't be overwritten by an empty local copy. Check B2_* env vars and redeploy."
  );
}

// ── PUSH: local disk → B2 ────────────────────────────────────
async function flush() {
  if (!isConfigured()) return 0;
  if (!_pullOk) return 0;

  const files = listLocalFiles(DATA_DIR);
  let pushed = 0;

  for (const fullPath of files) {
    const relPath = path.relative(DATA_DIR, fullPath).split(path.sep).join("/");
    let buffer;
    try { buffer = fs.readFileSync(fullPath); } catch { continue; }

    const hash = hashOf(buffer);
    if (_lastSynced.get(relPath) === hash) continue;

    try {
      await client().send(new PutObjectCommand({
        Bucket: BUCKET,
        Key: relPath,
        Body: buffer,
        ContentType: guessContentType(relPath),
      }));
      _lastSynced.set(relPath, hash);
      pushed++;
    } catch (e) {
      console.warn(`[MEMORY-SYNC] Failed to push ${relPath}: ${e.message}`);
    }
  }

  if (pushed) console.log(`[MEMORY-SYNC] Pushed ${pushed} changed file(s) to B2.`);
  return pushed;
}

// ── BACKGROUND LOOP + GRACEFUL SHUTDOWN ──────────────────────
let _interval = null;
let _shutdownHooked = false;

function startAutoSync() {
  if (!isConfigured() || _interval) return;

  _interval = setInterval(() => { flush().catch(() => {}); }, FLUSH_INTERVAL_MS);
  if (_interval.unref) _interval.unref();

  if (!_shutdownHooked) {
    _shutdownHooked = true;
    const shutdown = (signal) => {
      console.log(`[MEMORY-SYNC] ${signal} received — flushing memory to B2 before exit...`);
      flush()
        .catch((e) => console.warn("[MEMORY-SYNC] Final flush failed:", e.message))
        .finally(() => process.exit(0));
    };
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT",  () => shutdown("SIGINT"));
  }

  console.log(`[MEMORY-SYNC] Auto-sync running — pushing changes to B2 every ${FLUSH_INTERVAL_MS / 1000}s.`);
}

// ── DIRECT READ/WRITE (live state, no local cache) ────────────
async function getJSON(relPath) {
  if (!isConfigured()) return null;
  try {
    const res = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: relPath }));
    const buffer = await streamToBuffer(res.Body);
    return JSON.parse(buffer.toString("utf8"));
  } catch {
    return null;
  }
}

async function putJSON(relPath, obj) {
  if (!isConfigured()) return false;
  try {
    await client().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: relPath,
      Body: Buffer.from(JSON.stringify(obj, null, 2)),
      ContentType: "application/json",
    }));
    return true;
  } catch (e) {
    console.warn(`[MEMORY-SYNC] Direct write of ${relPath} failed: ${e.message}`);
    return false;
  }
}

async function deleteRemote(relPath) {
  if (!isConfigured()) return false;
  try {
    await client().send(new DeleteObjectCommand({ Bucket: BUCKET, Key: relPath }));
    return true;
  } catch (e) {
    console.warn(`[MEMORY-SYNC] Direct delete of ${relPath} failed: ${e.message}`);
    return false;
  }
}

// ── ENCRYPTED SECRET BACKUP (wallet private keys) ─────────────
function encryptionReady() {
  return isConfigured() && !!process.env.WALLET_ENCRYPTION_SECRET;
}
function _aesKey() {
  return crypto.scryptSync(process.env.WALLET_ENCRYPTION_SECRET, "jarvis-wallet-keys-v1", 32);
}
function _encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c  = crypto.createCipheriv("aes-256-gcm", _aesKey(), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from("JK1"), iv, c.getAuthTag(), ct]);
}
function _decrypt(buf) {
  if (buf.slice(0, 3).toString() !== "JK1") throw new Error("unknown backup format");
  const iv = buf.slice(3, 15), tag = buf.slice(15, 31), ct = buf.slice(31);
  const d = crypto.createDecipheriv("aes-256-gcm", _aesKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}

async function putSecret(name, plainBuffer) {
  if (!encryptionReady()) return false;
  try {
    await client().send(new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${KEYS_PREFIX}/${name}.enc`,
      Body: _encrypt(plainBuffer),
      ContentType: "application/octet-stream",
    }));
    return true;
  } catch (e) {
    console.warn(`[KEY-BACKUP] Failed to back up ${name}: ${e.message}`);
    return false;
  }
}

async function restoreSecrets(destDir) {
  if (!encryptionReady()) return 0;
  let n = 0;
  try {
    const keys = await listRemoteFiles(KEYS_PREFIX + "/");
    for (const key of keys) {
      if (!key.endsWith(".enc")) continue;
      const name = path.basename(key, ".enc");
      const out  = path.join(destDir, name);
      if (fs.existsSync(out)) continue;
      try {
        const res    = await client().send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
        const buf    = await streamToBuffer(res.Body);
        const plain  = _decrypt(buf);
        fs.mkdirSync(destDir, { recursive: true });
        fs.writeFileSync(out, plain, { mode: 0o600 });
        n++;
      } catch (e) {
        console.warn(`[KEY-BACKUP] Could not decrypt ${key}: ${e.message}`);
      }
    }
  } catch (e) {
    console.warn("[KEY-BACKUP] Restore failed:", e.message);
  }
  return n;
}

module.exports = {
  pullAll, flush, startAutoSync, isConfigured,
  getJSON, putJSON, deleteRemote,
  putSecret, restoreSecrets, encryptionReady,
};
