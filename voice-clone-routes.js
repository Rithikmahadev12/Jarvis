"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Voice Cloning (self-hosted CODE on Jarvis's own E2B
// computer — NOT a third-party API)
//
// Uses Chatterbox TTS (github.com/resemble-ai/chatterbox, Resemble AI,
// MIT license): real open-source code + open model weights, running
// entirely inside Jarvis's own dedicated E2B sandbox (see computer.js).
// Nothing here calls out to a paid cloning service — the only network
// traffic besides the E2B sandbox itself is a one-time Hugging Face
// download of the model weights (~1-2GB) the first time this sandbox
// installs the engine, exactly like `git clone`-ing a model and running
// it yourself would.
//
// Chosen over Coqui XTTS-v2 (this repo's original choice) after
// repeated real dependency-chain breakage on that stack (missing
// torchaudio, transformers 5.0 removing isin_mps_friendly, torchaudio
// 2.9+ requiring the separate torchcodec package, etc.) — Chatterbox
// has fewer moving parts, ships under a permissive MIT license instead
// of XTTS's non-commercial CPML, and needs no interactive
// license-agreement workaround. See voice-server/clone_worker.py for
// the actual model-loading/inference code.
//
// SANDBOX LIFECYCLE: uses computer.js's DEDICATED sandbox machinery
// (createDedicatedSandbox/connectDedicatedSandbox), not the shared
// aggressively-idle-reaped one — so it isn't killed out from under a
// clone job by an unrelated "test this code" request, and (via E2B's
// beta auto-pause) survives a Jarvis restart: the sandbox ID is
// persisted to data/voice-clone-sandbox.json and reconnected to next
// time instead of re-provisioning the whole engine from scratch.
//
// SETUP: needs E2B_API_KEY in .env (free at https://e2b.dev) — the
// same key any other "Jarvis computer" feature in this repo uses.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const Computer = require("./computer");

const DATA_DIR         = path.join(__dirname, "data");
const CLONES_DIR        = path.join(DATA_DIR, "voice-clones");       // local copy of each user's reference clip
const JOBS_FILE          = path.join(CLONES_DIR, "jobs.json");
const SANDBOX_ID_FILE    = path.join(DATA_DIR, "voice-clone-sandbox.json");
const WORKER_SCRIPT_PATH = path.join(__dirname, "voice-server", "clone_worker.py");
// Same file server.js's own loadProfiles/saveProfiles read/write — used
// ONLY by processPendingClones() below (the scheduled sweep in
// server.js, which runs outside any request and has no access to the
// loadProfiles/saveProfiles passed into register()). The HTTP routes
// still use the passed-in versions, so there is exactly one source of
// truth for the file path either way.
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");

function loadProfilesDirect() {
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")); } catch { return {}; }
}
function saveProfilesDirect(p) {
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2), "utf8");
}

// Paths INSIDE the sandbox (must match voice-server/clone_worker.py's
// own VOICE_DIR constant).
const SANDBOX_ROOT   = "/tmp/voice-clones";
const SANDBOX_WORKER = "/tmp/clone_worker.py";

const PIP_FLAGS = "--retries 5 --timeout 120";

// If HF_TOKEN is set in Jarvis's own .env, pass it through into the
// sandbox's environment so huggingface_hub picks it up automatically
// (it reads HF_TOKEN itself — no code change needed on the Python
// side beyond it being present in the process env). Gets you a much
// higher/personal rate limit on the model download instead of the
// shared unauthenticated one, and is what removes the "unauthenticated
// requests" notice for real rather than just silencing it. Optional —
// undefined here just means the sandbox runs with no extra env vars,
// exactly like before.
function hfEnvs() {
  const token = (process.env.HF_TOKEN || "").trim();
  return token ? { HF_TOKEN: token } : undefined;
}

// ── Auto-retry for TRANSIENT (network-class) pip failures ──────────
// pip's own --retries only covers a single request; a connection that
// drops mid-download (like the urllib3 _raw_read error this repo has
// hit) surfaces as a hard failure to pip itself, no different from a
// real dependency conflict, unless something outside pip retries the
// whole install. This wrapper does that: it re-runs the install command
// a few times with backoff, but ONLY when the failure text looks
// network-related — a genuine dependency/conflict error is surfaced
// immediately instead of being retried pointlessly.
const TRANSIENT_ERROR_PATTERNS = [
  /_raw_read/i,
  /connection (reset|aborted|broken)/i,
  /connectionerror/i,
  /chunkedencodingerror/i,
  /incompleteread/i,
  /read timed? ?out/i,
  /timeout/i,
  /econnreset/i,
  /etimedout/i,
  /temporary failure in name resolution/i,
  /name or service not known/i,
  /ssl.*(eof|wrong_version|handshake)/i,
  /remote end closed connection/i,
  /max retries exceeded/i,
  /could not fetch url/i,
  /new connection.*failed/i,
  /network is unreachable/i,
];

function isTransientPipError(output) {
  return TRANSIENT_ERROR_PATTERNS.some((re) => re.test(output));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Runs a pip install command, auto-retrying with backoff on its own
// whenever the failure looks like a dropped/flaky connection rather
// than a real package problem. Only throws (surfacing to the caller,
// which fails the job and shows the user a "retry" button) once it's
// exhausted its attempts on a transient error, or immediately on a
// non-transient one.
async function runPipInstallWithRetry(sbx, cmd, label, { timeoutMs = 20 * 60 * 1000, maxAttempts = 4 } = {}) {
  let lastOutput = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    // Escalate, don't just repeat: a download that timed out once is
    // more likely to time out again at the same limit, so each retry
    // gets more time, not just another identical shot at the same
    // window. Attempt 1 = base timeout, attempt 2 = 1.5x, attempt 3 =
    // 2x, attempt 4 = 2.5x.
    const attemptTimeoutMs = Math.round(timeoutMs * (1 + 0.5 * (attempt - 1)));
    // Reset the SANDBOX's own lifetime clock before every attempt, not
    // just once at the top of the whole clone job. Several escalating
    // retries back to back on a slow connection can otherwise eat past
    // the sandbox's own 1-hour ceiling even though each individual
    // command's timeoutMs is well under it — that ends the job with a
    // generic "sandbox not found"/timeout error that has nothing to do
    // with the actual pip failure being retried.
    try { await Computer.extendDedicatedSandbox(sbx, 60 * 60 * 1000); } catch { /* best-effort */ }
    const result = await Computer.runOnSandbox(sbx, cmd, { timeoutMs: attemptTimeoutMs });
    if (result.ok) return result;

    lastOutput = (result.stderr || result.stdout || "").trim();

    if (!isTransientPipError(lastOutput)) {
      // Not a network-class error — retrying won't help, so surface it now.
      throw new Error(`Engine install failed on Jarvis's computer (${label}): ${lastOutput.slice(0, 500)}`);
    }

    if (attempt < maxAttempts) {
      const backoffMs = 8000 * attempt; // 8s, 16s, 24s...
      console.warn(`[VOICE-CLONE] ${label} install hit a transient network error (attempt ${attempt}/${maxAttempts}, timeout was ${Math.round(attemptTimeoutMs / 1000)}s) — auto-retrying in ${backoffMs / 1000}s with a longer timeout...`);
      await sleep(backoffMs);
    }
  }
  throw new Error(`Engine install failed on Jarvis's computer (${label}) after ${maxAttempts} automatic retries with increasing timeouts, still network-related: ${lastOutput.slice(0, 500)}`);
}

function ensureDirs() {
  fs.mkdirSync(CLONES_DIR, { recursive: true });
}

function safeKey(user) {
  return String(user || "").toLowerCase().trim().replace(/[^a-z0-9_-]/g, "");
}

function loadJobs() {
  ensureDirs();
  try { return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8")); } catch { return {}; }
}

function saveJobs(jobs) {
  ensureDirs();
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2), "utf8");
}

function setJob(user, patch) {
  const jobs = loadJobs();
  const key = safeKey(user);
  jobs[key] = { ...(jobs[key] || {}), ...patch, updatedAt: new Date().toISOString() };
  saveJobs(jobs);
  return jobs[key];
}

function jobStatus(user) {
  const jobs = loadJobs();
  return jobs[safeKey(user)] || { status: "none" };
}

function isReady(user) {
  return jobStatus(user).status === "ready";
}

// The worker script always prints exactly one JSON line at the very
// end (every branch, including its top-level catch-all, uses
// print(json.dumps(...), flush=True)) — but some ML library could in
// principle print a stray line to stdout first (progress bar, a
// warning that didn't go to stderr), so this takes the LAST non-empty
// line rather than assuming the whole stdout is pure JSON.
function safeJson(stdout) {
  const lines = String(stdout || "").trim().split("\n").filter(Boolean);
  if (!lines.length) return null;
  try { return JSON.parse(lines[lines.length - 1]); } catch { return null; }
}

// ── SANDBOX (persisted across restarts) ────────────────────────────
function loadSandboxId() {
  try { return JSON.parse(fs.readFileSync(SANDBOX_ID_FILE, "utf8")).sandboxId || null; }
  catch { return null; }
}

function saveSandboxId(id) {
  ensureDirs();
  fs.writeFileSync(SANDBOX_ID_FILE, JSON.stringify({ sandboxId: id, updatedAt: new Date().toISOString() }, null, 2), "utf8");
}

let cachedSbx = null; // in-process cache — avoids a reconnect round-trip on every call within one Jarvis run

async function getWorkerSandbox() {
  if (!Computer.isConfigured()) {
    throw new Error("E2B isn't configured yet — add E2B_API_KEY to .env (free at https://e2b.dev), then restart Jarvis.");
  }

  if (cachedSbx) {
    try {
      await Computer.extendDedicatedSandbox(cachedSbx, 60 * 60 * 1000);
      return cachedSbx;
    } catch {
      cachedSbx = null; // sandbox object went stale (e.g. process restarted) — fall through and reconnect
    }
  }

  const savedId = loadSandboxId();
  if (savedId) {
    try {
      const sbx = await Computer.connectDedicatedSandbox(savedId);
      await Computer.extendDedicatedSandbox(sbx, 60 * 60 * 1000);
      cachedSbx = sbx;
      return sbx;
    } catch (e) {
      console.warn(`[VOICE-CLONE] Couldn't reconnect to the saved sandbox (${e.message}) — provisioning a new one.`);
    }
  }

  console.log("[VOICE-CLONE] Creating Jarvis's dedicated voice-cloning sandbox for the first time...");
  const sbx = await Computer.createDedicatedSandbox({ metadata: { source: "jarvis-voice-clone" } });
  const id = sbx.sandboxId || sbx.id;
  if (id) saveSandboxId(id);
  cachedSbx = sbx;
  return sbx;
}

// Pushes the local voice-server/clone_worker.py up into the sandbox
// every time, not just once — cheap (a few KB) and guarantees the
// sandbox is always running whatever the code on disk says NOW, even
// after a local bugfix, with no separate "redeploy" step.
async function uploadWorkerScript(sbx) {
  const content = fs.readFileSync(WORKER_SCRIPT_PATH, "utf8");
  await Computer.runOnSandbox(sbx, `mkdir -p ${SANDBOX_ROOT}`, { timeoutMs: 15000 });
  await sbx.files.write(SANDBOX_WORKER, content);
}

// Actually imports the packages rather than trusting a touch-file
// marker — a prior run could have "succeeded" at the pip step while
// still missing a piece, which would leave a stale marker and skip
// reinstalling forever. Cheap (a few seconds) and self-heals.
async function ensureEngineInstalled(sbx) {
  const check = await Computer.runOnSandbox(
    sbx,
    `python3 -c "import torch, torchaudio; from chatterbox.tts import ChatterboxTTS" >/dev/null 2>&1 && echo yes || echo no`,
    { timeoutMs: 30000 }
  );
  if (check.stdout.trim() === "yes") return;

  console.log("[VOICE-CLONE] Installing the voice-cloning engine (Chatterbox TTS) on Jarvis's computer (first time on this sandbox — a few minutes)...");

  // torch/torchaudio deliberately pinned BELOW 2.9: 2.9+ requires the
  // separate torchcodec package for audio I/O, one more link in an
  // already long chain. 2.6-2.8.x still ship their own built-in audio
  // backends and are everything Chatterbox needs. Installed from the
  // CPU-only wheel index since this sandbox has no GPU — the default
  // `pip install torch` pulls the full CUDA build (1.5-2GB+) for
  // nothing.
  await runPipInstallWithRetry(
    sbx,
    `pip install --quiet ${PIP_FLAGS} "torch>=2.6,<2.9" "torchaudio>=2.6,<2.9" --index-url https://download.pytorch.org/whl/cpu --break-system-packages || ` +
    `pip install --quiet ${PIP_FLAGS} "torch>=2.6,<2.9" "torchaudio>=2.6,<2.9" --index-url https://download.pytorch.org/whl/cpu`,
    "torch/torchaudio",
    { timeoutMs: 20 * 60 * 1000 }
  );

  // chatterbox-tts's OWN PyPI metadata (verified by pulling the actual
  // wheel) hard-pins torch==2.6.0/torchaudio==2.6.0 EXACTLY, and also
  // requires gradio==6.8.0 and the full CJK tokenizer stack
  // (pykakasi, spacy-pkuseg). Installing it normally makes pip
  // re-resolve torch to that exact pin — redownloading a ~700MB wheel
  // we may already have a compatible version of — on top of gradio's
  // own huge dependency tree (fastapi/pandas/pillow-adjacent packages
  // for a demo UI). None of that is needed: 'import gradio' does not
  // appear anywhere in the package's actual source, and pykakasi /
  // spacy-pkuseg are only imported lazily inside try/except blocks for
  // Japanese/Chinese text — not on the English-only import path this
  // worker uses (`from chatterbox.tts import ChatterboxTTS`).
  //
  // --no-deps skips all of that, keeping the torch/torchaudio we just
  // installed untouched, then a second call installs only the
  // packages chatterbox/tts.py, vc.py, and the s3gen/t3 model modules
  // actually import.
  await runPipInstallWithRetry(
    sbx,
    `pip install --quiet ${PIP_FLAGS} --no-deps chatterbox-tts --break-system-packages || pip install --quiet ${PIP_FLAGS} --no-deps chatterbox-tts`,
    "chatterbox-tts (package itself, no-deps)",
    { timeoutMs: 10 * 60 * 1000 }
  );

  const CHATTERBOX_CORE_DEPS = [
    "numpy", "librosa==0.11.0", "s3tokenizer", "transformers==5.2.0",
    "diffusers==0.29.0", "resemble-perth>=1.0.0", "conformer==0.3.2",
    "safetensors==0.5.3", "omegaconf", "pyloudnorm", "einops",
    "huggingface_hub", "tokenizers", "scipy", "soundfile",
  ];
  await runPipInstallWithRetry(
    sbx,
    `pip install --quiet ${PIP_FLAGS} ${CHATTERBOX_CORE_DEPS.map((d) => `"${d}"`).join(" ")} --break-system-packages || ` +
    `pip install --quiet ${PIP_FLAGS} ${CHATTERBOX_CORE_DEPS.map((d) => `"${d}"`).join(" ")}`,
    "chatterbox-tts (runtime dependencies)",
    { timeoutMs: 20 * 60 * 1000 }
  );
}

// ── CLONE job ────────────────────────────────────────────────────────
async function attemptClone(user) {
  const key = safeKey(user);
  const localRefPath = path.join(CLONES_DIR, key, "reference.wav");
  if (!fs.existsSync(localRefPath)) {
    return setJob(user, { status: "failed", reason: "No reference audio on file for this account." });
  }

  setJob(user, { status: "processing" });

  try {
    const sbx = await getWorkerSandbox();
    await uploadWorkerScript(sbx);
    await ensureEngineInstalled(sbx);

    const buf = fs.readFileSync(localRefPath);
    await Computer.runOnSandbox(sbx, `mkdir -p ${SANDBOX_ROOT}/${key}`, { timeoutMs: 15000 });
    await sbx.files.write(`${SANDBOX_ROOT}/${key}/reference.wav`, buf);

    // Reset the SANDBOX's own lifetime clock (separate from the
    // per-command timeoutMs below) back to a full hour right before the
    // last, heaviest step. ensureEngineInstalled() above can itself eat
    // most of an hour on a cold sandbox once pip retries/backoff are
    // counted, and getWorkerSandbox() only extended the sandbox once, at
    // the very start of this whole function — without this second
    // extension, a slow first-time install could leave too little of
    // the sandbox's own 1-hour ceiling for the ~1-2GB Hugging Face
    // weights download + smoke-test clone that's about to run, and E2B
    // would kill the sandbox out from under it (surfacing as a generic
    // timeout with no useful reason).
    await Computer.extendDedicatedSandbox(sbx, 60 * 60 * 1000);

    // First clone on a fresh sandbox also triggers Chatterbox's one-time
    // ~1-2GB model-weights download from Hugging Face inside
    // clone_worker.py, on top of the actual clone/smoke-test itself —
    // 25 minutes gives real headroom for that on a slow connection.
    // Subsequent clones on the same warm sandbox (weights already
    // cached) are fast and finish in a fraction of this.
    const result = await Computer.runOnSandbox(sbx, `python3 ${SANDBOX_WORKER} clone ${key}`, { timeoutMs: 25 * 60 * 1000, envs: hfEnvs() });
    const parsed = safeJson(result.stdout);
    if (parsed && parsed.saved) {
      return setJob(user, { status: "ready", reason: "Cloned." });
    }

    // Surface BOTH stdout and stderr tails when parsing fails, and say
    // so explicitly — a silent generic message is exactly what made an
    // earlier failure here hard to diagnose.
    const stdoutTail = String(result.stdout || "").trim().slice(-500);
    const stderrTail = String(result.stderr || "").trim().slice(-500);
    const diagnostic = (parsed && parsed.reason)
      || stderrTail
      || stdoutTail
      || "No output at all from the clone step — likely killed by the timeout before it could finish.";
    return setJob(user, { status: "failed", reason: diagnostic });
  } catch (e) {
    return setJob(user, { status: "failed", reason: `${e.name || "Error"}: ${e.message}` });
  }
}

// Called from server.js's /api/tts. Returns a Buffer of WAV audio, or
// null if the clone isn't ready or synthesis fails right now (caller
// falls back to the browser voice/whatever else, same as any other TTS
// failure — never leaves the assistant silent).
async function synthesizeCloned(user, text) {
  const job = jobStatus(user);
  if (job.status !== "ready") return null;

  const key = safeKey(user);
  try {
    const sbx = await getWorkerSandbox();
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const textPath = `/tmp/.synth-input-${key}-${stamp}.txt`;
    const outPath  = `/tmp/.synth-output-${key}-${stamp}.wav`;

    await sbx.files.write(textPath, text);
    const result = await Computer.runOnSandbox(sbx, `python3 ${SANDBOX_WORKER} synth ${key} ${textPath} ${outPath}`, { timeoutMs: 3 * 60 * 1000, envs: hfEnvs() });
    const parsed = safeJson(result.stdout);
    if (!parsed || !parsed.ok) {
      console.warn(`[VOICE-CLONE] Synthesis failed for "${key}": ${(parsed && parsed.reason) || result.stderr.slice(0, 300) || "no output"} — falling back.`);
      return null;
    }

    const bytes = await sbx.files.read(outPath, { format: "bytes" });
    return Buffer.from(bytes);
  } catch (e) {
    console.warn(`[VOICE-CLONE] Synthesis error for "${key}": ${e.message} — falling back.`);
    return null;
  }
}

// If a clone job just finished "ready", flips the account over to
// voiceMode "clone" so it's actually used — shared by the upload route,
// the retry route, and the scheduled sweep below, so a job that
// finishes in the background always activates itself the same way
// regardless of which path completed it.
function activateCloneIfReady(user, job, loadProfilesFn, saveProfilesFn) {
  if (!job || job.status !== "ready") return;
  const key = safeKey(user);
  const profiles = loadProfilesFn();
  if (!profiles[key]) return;
  profiles[key].aiVoiceMode = "clone";
  profiles[key].updatedAt = new Date().toISOString();
  saveProfilesFn(profiles);
}

// Retries any job that isn't "ready" yet — e.g. E2B_API_KEY was just
// added, or the sandbox had a transient error last time. Safe to call
// on a schedule; a no-op when there's nothing pending.
async function processPendingClones() {
  const jobs = loadJobs();
  const retryable = Object.keys(jobs).filter((u) => jobs[u].status === "failed" || jobs[u].status === "pending");
  if (!retryable.length) return;
  console.log(`[VOICE-CLONE] Retrying ${retryable.length} unfinished clone job(s) on Jarvis's computer...`);
  for (const user of retryable) {
    const job = await attemptClone(user);
    activateCloneIfReady(user, job, loadProfilesDirect, saveProfilesDirect);
  }
}

function register(app, { loadProfiles, saveProfiles }) {
  ensureDirs();

  // GET /api/voice-clone/capability — is E2B configured at all, so AI
  // Settings can explain what to do if not, before the user uploads.
  app.get("/api/voice-clone/capability", (req, res) => {
    res.json(Computer.isConfigured()
      ? { smooth: true, reason: "Runs on Jarvis's own computer using open-source Chatterbox TTS — no third-party API." }
      : { smooth: false, reason: "Jarvis's computer isn't configured yet — add E2B_API_KEY to .env (free at https://e2b.dev)." });
  });

  // POST /api/voice-clone/upload  { user, audioBase64 }
  // audioBase64: raw base64 of an audio clip, no data: prefix.
  // A short (5-30s), single-speaker, low-noise clip clones best.
  //
  // Responds IMMEDIATELY once the clip is saved, then runs the actual
  // clone in the background instead of awaiting it here. A cold
  // sandbox (first clone ever, engine not installed yet) can
  // legitimately take 15-40+ minutes: installing Chatterbox + deps,
  // then the one-time ~1-2GB Hugging Face weights download, then the
  // smoke-test clone itself. Holding this HTTP request open the whole
  // time was the actual bug behind "it works for a while then times
  // out" — the browser/host connection has nowhere near that much
  // patience, so the request was getting killed out from under a clone
  // job that was often still working fine in the background. The
  // frontend now polls GET /api/voice-clone/status/:user instead, which
  // has no such time limit since each poll is its own quick request.
  app.post("/api/voice-clone/upload", async (req, res) => {
    const { user, audioBase64 } = req.body || {};
    if (!user) return res.status(400).json({ error: "Missing user" });
    if (!audioBase64) return res.status(400).json({ error: "Missing audioBase64" });

    const profiles = loadProfiles();
    const key = String(user).toLowerCase().trim();
    if (!profiles[key]) return res.status(404).json({ error: `No account found for "${user}".` });

    let buf;
    try { buf = Buffer.from(audioBase64, "base64"); } catch { return res.status(400).json({ error: "Invalid base64 audio" }); }
    if (buf.length < 1000) return res.status(400).json({ error: "That clip looks too short/empty — try a 5-30s recording." });
    if (buf.length > 25 * 1024 * 1024) return res.status(400).json({ error: "That clip is too large (25MB max)." });

    ensureDirs();
    const dir = path.join(CLONES_DIR, safeKey(key));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "reference.wav"), buf);

    setJob(key, { status: "pending", reason: "Starting — this can take a while on the very first clone." });
    res.json({
      success: false,
      status: "pending",
      reason: "Cloning started on Jarvis's computer. This can take 15-40 minutes the very first time (installing the engine + a one-time model download) — check back or leave this open, it'll update on its own.",
    });

    attemptClone(key)
      .then((job) => activateCloneIfReady(key, job, loadProfiles, saveProfiles))
      .catch((e) => {
        console.error(`[VOICE-CLONE] Background clone for "${key}" crashed: ${e.message}`);
        setJob(key, { status: "failed", reason: e.message || "Unknown error." });
      });
  });

  // GET /api/voice-clone/status/:user — the frontend polls this.
  app.get("/api/voice-clone/status/:user", (req, res) => {
    res.json(jobStatus(req.params.user));
  });

  // POST /api/voice-clone/retry/:user — manual "try again" button. Same
  // immediate-response-then-background pattern as upload, for the same
  // reason (a retry can be just as slow as the original attempt).
  app.post("/api/voice-clone/retry/:user", async (req, res) => {
    const user = req.params.user;
    const key = safeKey(user);
    setJob(key, { status: "pending", reason: "Retrying on Jarvis's computer…" });
    res.json({ success: false, status: "pending", reason: "Retrying — this can take a while, check back shortly." });

    attemptClone(user)
      .then((job) => activateCloneIfReady(user, job, loadProfiles, saveProfiles))
      .catch((e) => {
        console.error(`[VOICE-CLONE] Background retry for "${key}" crashed: ${e.message}`);
        setJob(key, { status: "failed", reason: e.message || "Unknown error." });
      });
  });
}

module.exports = { register, processPendingClones, isReady, jobStatus, safeKey, synthesizeCloned };
