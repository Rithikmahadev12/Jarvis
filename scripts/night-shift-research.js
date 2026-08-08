"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Night Shift Research (runs inside GitHub Actions)
//
// This does NOT run on your PC. It runs on GitHub's own servers, on a
// schedule, so it works whether your machine is on, off, or asleep.
//
// What it does, in order:
//   1. Connect directly to your Supabase Storage bucket (same one
//      persistence.js already mirrors data/ to) and download
//      data/todos.json.
//   2. Take up to MAX_ITEMS_PER_NIGHT pending items.
//   3. For each: run research.js's deepResearch() (it's fully
//      self-contained — no Express/server.js needed), then, if a Groq
//      key is available, ask it to condense the raw results into a
//      short spoken-style summary. Falls back to the raw research
//      reply if no Groq key is set.
//   4. Mark those todos "done" in todos.json and re-upload it.
//   5. Upload data/night-research.json with the findings. Your app's
//      existing persistence.js pulls this down automatically the next
//      time it boots — no new sync code needed on that end.
//
// Required GitHub Actions secrets (Settings -> Secrets and variables
// -> Actions -> New repository secret): SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET, and (optional but
// recommended) GROQ_API_KEY. These are the exact same values already
// in your local .env — copy them over once.
// ═══════════════════════════════════════════════════════════════

const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const REPO_ROOT = path.join(__dirname, "..");
const Research  = require(path.join(REPO_ROOT, "research.js"));
// hermes-engine.js is fully standalone (only requires fs/path/groq-keys/
// local-llm — nothing server.js-specific), so it works fine here too, and
// gets us Groq -> Ollama Cloud fallback for free (see groqFetchRawWithFallback
// inside hermes-engine.js) instead of hand-rolling a raw Groq-only fetch.
const Groq = require(path.join(REPO_ROOT, "hermes-engine.js"));

const SUPABASE_URL  = process.env.SUPABASE_URL || "";
const SERVICE_KEY   = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const BUCKET         = process.env.SUPABASE_BUCKET || "";

const MAX_ITEMS_PER_NIGHT = 5;

function requireEnv() {
  const missing = [];
  if (!SUPABASE_URL) missing.push("SUPABASE_URL");
  if (!SERVICE_KEY)  missing.push("SUPABASE_SERVICE_ROLE_KEY");
  if (!BUCKET)        missing.push("SUPABASE_BUCKET");
  if (missing.length) {
    console.error(`[NIGHT-SHIFT] Missing required secrets: ${missing.join(", ")}`);
    process.exit(1);
  }
}

function client() {
  return createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
}

async function downloadJSON(sb, relPath, fallback) {
  const { data, error } = await sb.storage.from(BUCKET).download(relPath);
  if (error || !data) return fallback;
  try {
    const text = await data.text();
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function uploadJSON(sb, relPath, obj) {
  const buffer = Buffer.from(JSON.stringify(obj, null, 2), "utf8");
  const { error } = await sb.storage.from(BUCKET).upload(relPath, buffer, {
    contentType: "application/json",
    upsert: true,
  });
  if (error) throw error;
}

// Optional: condense deepResearch's raw multi-source dump into 2-4
// tight sentences. Uses hermes-engine.js's groqFetch(), which already
// tries Groq first and — only if Groq fails, and only if OLLAMA_API_KEY
// is set — automatically retries through Ollama Cloud before giving up.
// That matters more here than in normal chat use: this runs unattended
// at 2am, so if Groq has a bad night there's nobody around to notice
// or retry by hand. Falls back to a trimmed raw reply if neither is
// configured or both fail.
async function summarize(topic, researchResult) {
  const rawSummary = researchResult.reply || `No solid results found for "${topic}".`;

  if (!Groq.isConfigured()) return rawSummary.slice(0, 600);

  try {
    const messages = [
      { role: "system", content: "Condense these research findings into 2-4 tight, spoken-style sentences. No headers, no bullet points, no markdown. Just the key takeaway a person would want on waking up." },
      { role: "user", content: `Topic: ${topic}\n\nRaw findings:\n${rawSummary}` },
    ];
    const text = await Groq.groqFetch(messages, undefined, 0.4, 220);
    return (text && text.trim()) || rawSummary.slice(0, 600);
  } catch (e) {
    console.warn(`[NIGHT-SHIFT] Summarize failed for "${topic}" (Groq + Ollama fallback both unavailable): ${e.message}`);
    return rawSummary.slice(0, 600);
  }
}

async function main() {
  requireEnv();
  const sb = client();

  console.log("[NIGHT-SHIFT] Downloading todos.json from Supabase...");
  const todos = await downloadJSON(sb, "todos.json", []);
  const pending = todos.filter(t => t.status === "pending").slice(0, MAX_ITEMS_PER_NIGHT);

  if (!pending.length) {
    console.log("[NIGHT-SHIFT] Nothing pending on the research list. Nothing to do tonight.");
    return;
  }

  console.log(`[NIGHT-SHIFT] Researching ${pending.length} item(s): ${pending.map(t => t.text).join(" | ")}`);

  const items = [];
  for (const todo of pending) {
    try {
      const result = await Research.deepResearch(todo.text, "Sir");
      const summary = await summarize(todo.text, result);
      items.push({
        topic: todo.text,
        summary,
        sources: (result.results || []).slice(0, 4).map(r => ({ title: r.title, url: r.url })),
        delivered: false,
      });
      todo.status = "done";
      todo.researchedAt = new Date().toISOString();
      console.log(`[NIGHT-SHIFT] ✓ ${todo.text}`);
    } catch (e) {
      console.warn(`[NIGHT-SHIFT] ✗ Failed on "${todo.text}": ${e.message}`);
      // Leave status "pending" so it gets retried tomorrow night instead
      // of silently disappearing.
    }
    // Be polite to the search backends between items.
    await new Promise(r => setTimeout(r, 1500));
  }

  // Merge with any existing (undelivered) items so a partial night, or
  // a user still not having gotten this morning's brief yet, doesn't
  // lose anything.
  const existing = await downloadJSON(sb, "night-research.json", { items: [] });
  const stillUndelivered = (existing.items || []).filter(i => !i.delivered);
  const merged = {
    date: new Date().toISOString().slice(0, 10),
    generatedAt: new Date().toISOString(),
    items: [...stillUndelivered, ...items],
  };

  console.log("[NIGHT-SHIFT] Uploading results + updated todos to Supabase...");
  await uploadJSON(sb, "night-research.json", merged);
  await uploadJSON(sb, "todos.json", todos);

  console.log(`[NIGHT-SHIFT] Done. ${items.length} item(s) researched, ${todos.filter(t => t.status === "pending").length} still pending.`);
}

main().catch(e => {
  console.error("[NIGHT-SHIFT] Fatal error:", e.message);
  process.exit(1);
});
