"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — MESH GENERATOR (Tripo3D API)
//
// Turns a text prompt ("a futuristic robotic helmet with glowing
// blue eyes") into an actual downloadable 3D mesh (.glb) using the
// Tripo3D generation API (https://platform.tripo3d.ai).
//
// This replaced an earlier two-hop free-Space pipeline (FLUX ->
// TripoSG over ZeroGPU Hugging Face Spaces). That approach worked
// but ZeroGPU's shared anonymous/free quota got exhausted constantly
// under any real usage, with no reliable way to know in advance how
// much headroom was left. Tripo3D's own API has a real (if small)
// monthly credit allowance tied to your account instead of a shared
// public pool, so quota exhaustion is predictable and self-inflicted
// rather than random.
//
// Pipeline (one hop — Tripo3D generates directly from text):
//   text -> 3D mesh   (POST /task {type: "text_to_model"}, then
//                       poll GET /task/:id until status "success")
//
// Requires TRIPO_API_KEY in the environment (.env). Get one at
// https://platform.tripo3d.ai -> API keys. Free tier credits refresh
// monthly; this is NOT unlimited — startJob() below still fails soft
// with a clear { kind: "error" } if the key is missing, invalid, or
// out of credits, same contract as before.
//
// Tripo3D's download URLs are short-lived (expire within a couple
// hours), so we download the .glb to local disk immediately once the
// task succeeds rather than ever handing the remote URL back to the
// client.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

const CACHE_DIR = path.join(__dirname, "data", "build-cache", "generated");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const TRIPO_API_KEY = process.env.TRIPO_API_KEY || null;
const TRIPO_BASE = "https://api.tripo3d.ai/v2/openapi";

// How often to poll the task status endpoint while a generation is
// running. Tripo tasks are usually done in well under a minute, but
// the free tier can queue behind other users.
const POLL_INTERVAL_MS = 2500;
const GEN_TIMEOUT_MS = 3 * 60 * 1000; // generous — covers queueing time

console.log(TRIPO_API_KEY
  ? "[mesh-generator] TRIPO_API_KEY detected — using Tripo3D API for mesh generation"
  : "[mesh-generator] No TRIPO_API_KEY set — mesh generation will fail until you set it in .env (get a key at https://platform.tripo3d.ai)");

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function downloadTo(url, destPath) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadTo(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`download failed (${res.statusCode}) for mesh asset`));
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
      file.on("error", reject);
    }).on("error", reject);
  });
}

// ── STEP 1: create a text_to_model task ──────────────────────────
async function createTask(prompt) {
  const res = await fetch(`${TRIPO_BASE}/task`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${TRIPO_API_KEY}`,
    },
    body: JSON.stringify({
      type: "text_to_model",
      prompt,
      texture: true,
      pbr: true,
    }),
  });
  let json;
  try { json = await res.json(); } catch { throw new Error(`Tripo3D task creation returned a non-JSON response (HTTP ${res.status})`); }

  if (!res.ok || json.code !== 0 || !json.data?.task_id) {
    const reason = json?.message || json?.error || `HTTP ${res.status}`;
    throw new Error(`Tripo3D task creation failed: ${reason}`);
  }
  return json.data.task_id;
}

// ── STEP 2: poll until the task finishes ─────────────────────────
const TERMINAL_FAIL_STATUSES = new Set(["failed", "cancelled", "banned", "expired"]);

async function pollTask(taskId, onProgress) {
  while (true) {
    const res = await fetch(`${TRIPO_BASE}/task/${taskId}`, {
      headers: { "Authorization": `Bearer ${TRIPO_API_KEY}` },
    });
    let json;
    try { json = await res.json(); } catch { throw new Error(`Tripo3D status check returned a non-JSON response (HTTP ${res.status})`); }

    if (!res.ok || json.code !== 0) {
      const reason = json?.message || json?.error || `HTTP ${res.status}`;
      throw new Error(`Tripo3D status check failed: ${reason}`);
    }

    const data = json.data;
    if (onProgress) onProgress(data);

    if (data.status === "success") {
      const output = data.output || {};
      const url = output.pbr_model || output.model || output.base_model;
      if (!url) throw new Error("Tripo3D task succeeded but returned no model URL — output shape may have changed");
      return url;
    }

    if (TERMINAL_FAIL_STATUSES.has(data.status)) {
      throw new Error(`Tripo3D generation ${data.status}${data.error_msg ? `: ${data.error_msg}` : ""}`);
    }

    // still queued/running — wait and check again
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ── PUBLIC: background job system ────────────────────────────────
// Same contract as before: return immediately with a jobId, run the
// pipeline in the background, let the client poll for status. Free/
// slow-tier proxies (Render free plan included) will kill a request
// held open for a 30s-3min generation, so this avoids that entirely.
const jobs = new Map(); // jobId -> { status, kind, url, error, note, startedAt }
let jobCounter = 0;

function startJob(prompt) {
  const clean = (prompt || "").trim();
  const jobId = "gen-" + (++jobCounter) + "-" + Date.now();

  if (!clean) {
    jobs.set(jobId, { status: "done", kind: "error", error: "empty prompt" });
    return jobId;
  }
  if (!TRIPO_API_KEY) {
    jobs.set(jobId, {
      status: "done", kind: "error",
      error: "TRIPO_API_KEY is not set — add it to .env (get a free key at https://platform.tripo3d.ai)",
    });
    return jobId;
  }

  const hash = crypto.createHash("sha1").update(clean).digest("hex").slice(0, 16);
  const destPath = path.join(CACHE_DIR, `${hash}.glb`);
  if (fs.existsSync(destPath)) {
    jobs.set(jobId, { status: "done", kind: "gltf", url: `/build-cache/generated/${hash}.glb`, cached: true });
    return jobId;
  }

  jobs.set(jobId, { status: "pending", stage: "queued", startedAt: Date.now() });

  (async () => {
    try {
      jobs.set(jobId, { status: "pending", stage: "submitting to Tripo3D", startedAt: jobs.get(jobId).startedAt });
      const taskId = await withTimeout(createTask(clean), GEN_TIMEOUT_MS, "task creation");

      jobs.set(jobId, { status: "pending", stage: "generating (0%)", startedAt: jobs.get(jobId).startedAt });
      const meshUrl = await withTimeout(
        pollTask(taskId, (data) => {
          const prev = jobs.get(jobId) || {};
          jobs.set(jobId, { ...prev, stage: `generating (${data.progress ?? 0}%)` });
        }),
        GEN_TIMEOUT_MS,
        "generation"
      );

      jobs.set(jobId, { status: "pending", stage: "downloading mesh", startedAt: jobs.get(jobId).startedAt });
      await downloadTo(meshUrl, destPath);

      jobs.set(jobId, { status: "done", kind: "gltf", url: `/build-cache/generated/${hash}.glb` });
    } catch (e) {
      const failedStage = (jobs.get(jobId) || {}).stage || "unknown stage";
      console.error(`[mesh-generator] job ${jobId} failed at "${failedStage}":`, e);
      jobs.set(jobId, {
        status: "done", kind: "error",
        error: e?.message || String(e) || "unknown error",
        stage: failedStage,
        note: "Check your Tripo3D account for remaining monthly credits if this keeps happening.",
      });
    }
  })();

  return jobId;
}

function getJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { status: "done", kind: "error", error: "unknown job id (server may have restarted — free-tier services can restart at any time)" };
  return job;
}

// Sweep finished/abandoned jobs after 10 minutes so `jobs` doesn't
// grow forever on a long-running process.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.status === "done" && (job.startedAt || 0) < cutoff) jobs.delete(id);
  }
}, 5 * 60 * 1000).unref();

module.exports = { startJob, getJob, CACHE_DIR };
