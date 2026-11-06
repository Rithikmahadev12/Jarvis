#!/usr/bin/env node
"use strict";
// ═══════════════════════════════════════════════════════════════
// migrate-supabase-to-b2.js
//
// One-time migration script.
// Pulls every file out of your Supabase bucket and pushes it
// straight into Backblaze B2. Run it once locally, then delete it.
//
// ── USAGE ─────────────────────────────────────────────────────
//   node migrate-supabase-to-b2.js
//
// ── REQUIRES ──────────────────────────────────────────────────
//   npm install @supabase/supabase-js @aws-sdk/client-s3
//
// ── ENV VARS NEEDED (can be in .env or exported in shell) ─────
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_BUCKET
//   B2_ENDPOINT
//   B2_BUCKET
//   B2_KEY_ID
//   B2_APP_KEY
// ═══════════════════════════════════════════════════════════════

require("dotenv").config();

const { createClient }          = require("@supabase/supabase-js");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

// ── Supabase ──────────────────────────────────────────────────
const SUPA_URL    = process.env.SUPABASE_URL              || "";
const SUPA_KEY    = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPA_BUCKET = process.env.SUPABASE_BUCKET           || "";

// ── Backblaze B2 ──────────────────────────────────────────────
const B2_ENDPOINT = process.env.B2_ENDPOINT || "";
const B2_BUCKET   = process.env.B2_BUCKET   || "";
const B2_KEY_ID   = process.env.B2_KEY_ID   || "";
const B2_APP_KEY  = process.env.B2_APP_KEY  || "";

function checkConfig() {
  const missing = [];
  if (!SUPA_URL)    missing.push("SUPABASE_URL");
  if (!SUPA_KEY)    missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPA_BUCKET) missing.push("SUPABASE_BUCKET");
  if (!B2_ENDPOINT) missing.push("B2_ENDPOINT");
  if (!B2_BUCKET)   missing.push("B2_BUCKET");
  if (!B2_KEY_ID)   missing.push("B2_KEY_ID");
  if (!B2_APP_KEY)  missing.push("B2_APP_KEY");
  if (missing.length) {
    console.error("❌  Missing env vars:", missing.join(", "));
    process.exit(1);
  }
}

// ── Supabase client ───────────────────────────────────────────
function supabase() {
  const ws = require("ws");
  return createClient(SUPA_URL, SUPA_KEY, {
    auth: { persistSession: false },
    realtime: { transport: ws },
  });
}

// ── B2 / S3 client ────────────────────────────────────────────
function b2() {
  return new S3Client({
    endpoint: B2_ENDPOINT,
    region: "us-east-005",
    credentials: { accessKeyId: B2_KEY_ID, secretAccessKey: B2_APP_KEY },
    forcePathStyle: true,
  });
}

// ── Recursively list all files in Supabase bucket ─────────────
async function listSupabaseFiles(sb, prefix = "") {
  const { data, error } = await sb.storage.from(SUPA_BUCKET).list(prefix, {
    limit: 1000,
    sortBy: { column: "name", order: "asc" },
  });
  if (error) throw error;

  let out = [];
  for (const item of data || []) {
    const itemPath = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id === null) {
      // it's a folder — recurse
      out = out.concat(await listSupabaseFiles(sb, itemPath));
    } else {
      out.push(itemPath);
    }
  }
  return out;
}

function guessContentType(key) {
  if (key.endsWith(".json")) return "application/json";
  if (key.endsWith(".js"))   return "application/javascript";
  return "application/octet-stream";
}

// ── MAIN ──────────────────────────────────────────────────────
async function main() {
  checkConfig();

  const sb  = supabase();
  const s3  = b2();

  console.log("🔍  Listing files in Supabase bucket:", SUPA_BUCKET);
  const files = await listSupabaseFiles(sb);
  console.log(`📦  Found ${files.length} file(s) to migrate.\n`);

  if (files.length === 0) {
    console.log("⚠️   Supabase bucket is empty — nothing to migrate.");
    return;
  }

  let ok = 0, fail = 0;

  for (const key of files) {
    process.stdout.write(`  → ${key} ... `);
    try {
      // Download from Supabase
      const { data, error } = await sb.storage.from(SUPA_BUCKET).download(key);
      if (error || !data) throw new Error(error?.message || "no data returned");
      const buffer = Buffer.from(await data.arrayBuffer());

      // Upload to B2
      await s3.send(new PutObjectCommand({
        Bucket: B2_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: guessContentType(key),
      }));

      console.log(`✅  ${buffer.length} bytes`);
      ok++;
    } catch (e) {
      console.log(`❌  FAILED — ${e.message}`);
      fail++;
    }
  }

  console.log("\n════════════════════════════════");
  console.log(`✅  Migrated:  ${ok} file(s)`);
  if (fail) {
    console.log(`❌  Failed:    ${fail} file(s)`);
    console.log("Re-run the script to retry failed files — it won't duplicate successful ones.");
  } else {
    console.log("🎉  Migration complete — all files are in B2.");
    console.log("    You can now swap persistence.js and update your env vars.");
  }
}

main().catch((e) => {
  console.error("Fatal error:", e.message);
  process.exit(1);
});
