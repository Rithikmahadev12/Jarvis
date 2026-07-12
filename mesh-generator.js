"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — FREE MESH GENERATOR
//
// Turns a text prompt ("a futuristic robotic helmet with glowing
// blue eyes") into an actual downloadable 3D mesh (.glb) — no API
// key, no payment, no local GPU required. Not a primitive/box
// composer: this calls real generative models hosted as free public
// Hugging Face Spaces and downloads their real output.
//
// Pipeline (two hops, because there's no free *text*-to-3D model
// that's currently both live and good — see chat notes):
//   1. text  -> image   (black-forest-labs/FLUX.1-schnell, official
//                         Space, ZeroGPU, ~seconds)
//   2. image -> 3D mesh (VAST-AI/TripoSG, official Space, ZeroGPU,
//                         textured GLB output)
//
// Both Spaces are run by their model's own org (Black Forest Labs,
// VAST-AI/Tripo), not random community mirrors — much less likely
// to randomly disappear than the individual duplicate Spaces we
// tried earlier. Still: they're free community infra, not an SLA'd
// product. If either is down/paused/rate-limited, this fails soft
// and the caller gets a clear { kind: "error" } with a placeholder
// fallback, same contract as build-engine.js's getLoadableModel.
//
// NOTE: the exact Gradio api_name for each Space's queue endpoint
// can change when the Space owner updates their code. This was
// written from Hugging Face's documented Gradio-client conventions
// without live network access to confirm the endpoint names against
// the running Spaces — GENERATE_ENDPOINTS below is the first place
// to check (open the Space, click "Use via API" at the bottom of
// the page) if generation starts failing.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");

let GradioClient = null;
try { GradioClient = require("@gradio/client").Client; }
catch { /* optional dep — see package.json; falls back to error below */ }

const CACHE_DIR = path.join(__dirname, "data", "build-cache", "generated");
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// Space ids + the api_name each queue endpoint is expected to be
// registered under. If generation starts failing with "endpoint not
// found", open the Space's "Use via API" page and update the
// apiName here — that's almost certainly all that broke.
const IMAGE_SPACE = { id: "black-forest-labs/FLUX.1-schnell", apiName: "/infer" };
const MESH_SPACE  = { id: "VAST-AI/TripoSG",                  apiName: "/infer" };

const GEN_TIMEOUT_MS = 3 * 60 * 1000; // free shared GPU queue — generous timeout

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms (free GPU queue was probably busy)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Pulls the first file-like result (url or blob) out of a Gradio
// predict() result — different Spaces wrap their output slightly
// differently (straight url string vs {url}/{path} object), so this
// checks the common shapes rather than assuming one.
function extractFileUrl(result) {
  const data = result?.data;
  if (!data || !data.length) return null;
  for (const item of data) {
    if (!item) continue;
    if (typeof item === "string" && /^https?:\/\//.test(item)) return item;
    if (typeof item === "object") {
      if (item.url) return item.url;
      if (item.path && item.orig_name) return item.url || item.path;
    }
  }
  return null;
}

function downloadTo(url, destPath) {
  return new Promise((resolve, reject) => {
    const https = require("https");
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadTo(res.headers.location, destPath).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`download failed (${res.statusCode}) for ${url}`));
      const file = fs.createWriteStream(destPath);
      res.pipe(file);
      file.on("finish", () => file.close(resolve));
    }).on("error", reject);
  });
}

// ── STEP 1: text -> image ────────────────────────────────────────
async function textToImage(prompt) {
  const client = await GradioClient.connect(IMAGE_SPACE.id);
  const result = await client.predict(IMAGE_SPACE.apiName, {
    prompt,
    seed: Math.floor(Math.random() * 1e9),
    randomize_seed: true,
    width: 768,
    height: 768,
    num_inference_steps: 4,
  });
  const url = extractFileUrl(result);
  if (!url) throw new Error("FLUX.1-schnell returned no image — Space output shape may have changed");
  return url;
}

// ── STEP 2: image -> 3D mesh ─────────────────────────────────────
async function imageToMesh(imageUrl) {
  const { handle_file } = require("@gradio/client");
  const client = await GradioClient.connect(MESH_SPACE.id);
  const result = await client.predict(MESH_SPACE.apiName, {
    image: handle_file(imageUrl),
  });
  const url = extractFileUrl(result);
  if (!url) throw new Error("TripoSG returned no mesh — Space output shape may have changed");
  return url;
}

// ── PUBLIC: background job system ────────────────────────────────
// The old version awaited the whole text->image->mesh pipeline
// inside a single HTTP request. That's 30s-3min+ on free shared GPU
// queues, and Render's free-tier proxy (like most free-tier proxies)
// kills long-idle requests before that finishes — which is what
// produced the "Unexpected end of JSON input" error: the connection
// got cut mid-response, so the client received a truncated/empty
// body. Fix: return immediately with a jobId, run the pipeline in
// the background, and let the client poll for status instead of
// holding one request open.
const jobs = new Map(); // jobId -> { status, kind, url, error, note, startedAt }
let jobCounter = 0;

function startJob(prompt) {
  const clean = (prompt || "").trim();
  const jobId = "gen-" + (++jobCounter) + "-" + Date.now();

  if (!clean) {
    jobs.set(jobId, { status: "done", kind: "error", error: "empty prompt" });
    return jobId;
  }
  if (!GradioClient) {
    jobs.set(jobId, {
      status: "done", kind: "error",
      error: "@gradio/client is not installed — run: npm install @gradio/client",
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
      jobs.set(jobId, { status: "pending", stage: "generating image", startedAt: jobs.get(jobId).startedAt });
      const imageUrl = await withTimeout(textToImage(clean), GEN_TIMEOUT_MS, "text-to-image step");

      jobs.set(jobId, { status: "pending", stage: "generating mesh", startedAt: jobs.get(jobId).startedAt });
      const meshUrl = await withTimeout(imageToMesh(imageUrl), GEN_TIMEOUT_MS, "image-to-mesh step");

      jobs.set(jobId, { status: "pending", stage: "downloading mesh", startedAt: jobs.get(jobId).startedAt });
      await downloadTo(meshUrl, destPath);

      jobs.set(jobId, { status: "done", kind: "gltf", url: `/build-cache/generated/${hash}.glb` });
    } catch (e) {
      jobs.set(jobId, {
        status: "done", kind: "error", error: e.message,
        note: "Free generation Spaces can be slow, queued, or temporarily down — this isn't a paid API with an uptime guarantee.",
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
