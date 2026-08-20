"use strict";

// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Voice Cloning (own engine, runs on Jarvis's E2B computer)
//
// Replaces Camb.ai's Marketplace/voice-sharing feature with self-serve
// cloning: upload a sample, we clone it, done. No capability checks, no
// "maybe your desktop app can do it later" queueing — every account's
// clone and every synthesized reply is produced on ONE dedicated E2B
// cloud sandbox (see computer.js — this is the same "Jarvis's computer"
// used elsewhere for running code/commands), so it's always available
// and always the same machine.
//
// Why a DEDICATED sandbox (Computer.createDedicatedSandbox), not the
// shared one Computer.runCommand() uses: the shared sandbox is
// aggressively idle-reaped (killed after ~15 min — see computer.js) and
// used for unrelated one-off "run this code" tasks. Voice cloning needs
// the XTTS-v2 engine (torch + TTS, ~2GB of installs/weights) to survive
// between requests — reinstalling that on every single reply would be
// unusably slow. A dedicated sandbox (same pattern postiz-agent.js uses
// for its own long-lived Docker state) is provisioned once, its id is
// saved to disk so it survives a Jarvis restart, and it's reconnected
// to (and kept alive via extendDedicatedSandbox) on every use instead
// of being recreated.
//
// Flow:
//   1. User uploads a short reference clip in AI Settings.
//   2. We push it to the sandbox, run clone_worker.py's "clone" step
//      (a smoke-test synthesis — XTTS-v2 is zero-shot, so cloning IS
//      just keeping a good reference clip; no training/waiting).
//   3. Marks the account's voice mode "clone". Every future reply for
//      that account runs clone_worker.py's "synth" step on the same
//      sandbox and streams the WAV back.
//
// This is a parallel option alongside the existing Camb.ai
// default/preset/custom modes in tts.js — nothing there is touched.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const Computer = require("./computer");

const DATA_DIR       = path.join(__dirname, "data");
const CLONES_DIR     = path.join(DATA_DIR, "voice-clones");
const JOBS_FILE       = path.join(CLONES_DIR, "jobs.json");
const SANDBOX_FILE    = path.join(DATA_DIR, "voice-clone-sandbox.json");
const WORKER_SCRIPT_LOCAL = path.join(__dirname, "voice-server", "clone_worker.py");
const SANDBOX_ROOT    = "/tmp/voice-clones";
const SANDBOX_WORKER  = "/tmp/clone_worker.py";

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

// ── SANDBOX LIFECYCLE ────────────────────────────────────────────────
// One dedicated sandbox for ALL accounts' voice cloning — the reference
// clips and the engine install live at fixed paths inside it
// (SANDBOX_ROOT / SANDBOX_WORKER), keyed by username underneath, same
// idea as data/voice-clones/<user>/ on the Node side.
let _sbxPromise = null;   // in-flight connect/create, so concurrent
                           // requests don't race to provision two sandboxes
let _engineReady = false; // has THIS process already confirmed the
                           // engine is installed on the current sandbox?

function loadSandboxId() {
  try { return JSON.parse(fs.readFileSync(SANDBOX_FILE, "utf8")).sandboxId || ""; } catch { return ""; }
}

function saveSandboxId(id) {
  ensureDirs();
  fs.writeFileSync(SANDBOX_FILE, JSON.stringify({ sandboxId: id }, null, 2), "utf8");
}

async function getWorkerSandbox() {
  if (_sbxPromise) return _sbxPromise;
  _sbxPromise = (async () => {
    if (!Computer.isConfigured()) {
      throw new Error("Jarvis's cloud computer isn't configured yet — add E2B_API_KEY to .env (free at https://e2b.dev).");
    }
    const existingId = loadSandboxId();
    let sbx = null;
    if (existingId) {
      try {
        sbx = await Computer.connectDedicatedSandbox(existingId);
        await Computer.extendDedicatedSandbox(sbx, 60 * 60 * 1000);
      } catch (e) {
        console.warn(`[VOICE-CLONE] Couldn't reconnect to sandbox ${existingId} (${e.message}) — provisioning a fresh one.`);
        sbx = null;
      }
    }
    if (!sbx) {
      sbx = await Computer.createDedicatedSandbox({ metadata: { source: "jarvis-voice-clone" } });
      saveSandboxId(sbx.sandboxId);
      _engineReady = false; // fresh sandbox — engine needs (re)installing
    }
    return sbx;
  })();
  try {
    return await _sbxPromise;
  } catch (e) {
    _sbxPromise = null; // don't cache a failed provision — let the next call retry
    throw e;
  }
}

// Installs the cloning engine (torch + Coqui TTS) and uploads
// clone_worker.py, once per sandbox lifetime. A marker file on the
// sandbox itself (not just the in-memory _engineReady flag) means a
// Jarvis restart that reconnects to the SAME still-warm sandbox skips
// the multi-minute reinstall too.
async function ensureEngineInstalled(sbx) {
  if (_engineReady) return;
  // Actually import the packages rather than trusting a touch-file marker —
  // a prior run could have "succeeded" at the pip step while still missing
  // a dependency (e.g. torchaudio wasn't pulled in automatically), which
  // would leave a stale marker and skip reinstalling forever. This is
  // cheap (a few seconds) and self-heals from that case with no manual
  // cleanup needed.
  const check = await Computer.runOnSandbox(
    sbx,
    `python3 -c "import torch, torchaudio, torchcodec; from TTS.api import TTS" >/dev/null 2>&1 && echo yes || echo no`,
    { timeoutMs: 30000 }
  );
  if (check.stdout.trim() === "yes") {
    _engineReady = true;
    return;
  }
  console.log("[VOICE-CLONE] Installing cloning engine on Jarvis's computer (first time on this sandbox — a few minutes)...");
  // NOTE: the original "TTS" package on PyPI is Coqui's abandoned upstream —
  // last released in 2023 and pinned to Python <3.9, so it can't install on
  // E2B's modern Python image. "coqui-tts" is the actively-maintained fork
  // (same code, same `from TTS.api import TTS` import) that supports current
  // Python — that's what actually installs here.
  //
  // Every package below is version-PINNED, not left to "latest compatible" —
  // three rounds of fixing this one dependency at a time (torchaudio missing,
  // transformers 5.0 removing isin_mps_friendly, torchaudio 2.9+ needing
  // torchcodec) all came from letting pip pick whatever was newest at
  // install time. Pinning the whole chain to one known-working combination
  // means a new release of any single package can't silently break this
  // again — the trade-off is that bumping any of these later has to be
  // done deliberately, by testing a new combination and updating the pins
  // together, not by dropping one version number.
  //   torch/torchaudio: from the CPU-only wheel index — the default
  //     `pip install torch` pulls the full CUDA build (1.5-2GB+), and this
  //     sandbox has no GPU (see clone_worker.py's cuda.is_available() check,
  //     it always falls through to CPU) — so that's a pure wasted download
  //     (and the likely cause of the earlier "urllib3 ... _raw_read"
  //     connection-drop failures on the large CUDA wheel).
  //   torchcodec: torchaudio 2.9+ dropped its built-in audio-decoding
  //     backends in favor of this separate package; version must match the
  //     torch line exactly (0.9.x pairs with torch/torchaudio 2.9.x).
  //   transformers: coqui-tts imports `isin_mps_friendly` from
  //     transformers.pytorch_utils, which was deleted in transformers 5.0
  //     (github.com/idiap/coqui-ai-TTS issue #558) — 4.57.x is the last
  //     line before that removal.
  const PIP_FLAGS = "--retries 5 --timeout 120";
  const installTorch = await Computer.runOnSandbox(
    sbx,
    `pip install --quiet ${PIP_FLAGS} torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cpu --break-system-packages || ` +
    `pip install --quiet ${PIP_FLAGS} torch==2.9.1 torchaudio==2.9.1 --index-url https://download.pytorch.org/whl/cpu`,
    { timeoutMs: 20 * 60 * 1000 }
  );
  if (!installTorch.ok) {
    throw new Error(`Engine install failed on Jarvis's computer (torch/torchaudio): ${installTorch.stderr.slice(0, 500) || installTorch.stdout.slice(0, 500)}`);
  }
  const installCodec = await Computer.runOnSandbox(
    sbx,
    `pip install --quiet ${PIP_FLAGS} "torchcodec>=0.9,<0.10" --break-system-packages || pip install --quiet ${PIP_FLAGS} "torchcodec>=0.9,<0.10"`,
    { timeoutMs: 10 * 60 * 1000 }
  );
  if (!installCodec.ok) {
    throw new Error(`Engine install failed on Jarvis's computer (torchcodec): ${installCodec.stderr.slice(0, 500) || installCodec.stdout.slice(0, 500)}`);
  }
  const install = await Computer.runOnSandbox(
    sbx,
    `pip install --quiet ${PIP_FLAGS} coqui-tts "transformers>=4.57,<5" soundfile --break-system-packages || pip install --quiet ${PIP_FLAGS} coqui-tts "transformers>=4.57,<5" soundfile`,
    { timeoutMs: 20 * 60 * 1000 }
  );
  if (!install.ok) {
    throw new Error(`Engine install failed on Jarvis's computer: ${install.stderr.slice(0, 500) || install.stdout.slice(0, 500)}`);
  }
  await Computer.runOnSandbox(sbx, `mkdir -p ${SANDBOX_ROOT}`, { timeoutMs: 15000 });
  await Computer.runOnSandbox(sbx, "touch /tmp/.voice-engine-ready", { timeoutMs: 15000 });
  _engineReady = true;
}

async function uploadWorkerScript(sbx) {
  const code = fs.readFileSync(WORKER_SCRIPT_LOCAL, "utf8");
  await sbx.files.write(SANDBOX_WORKER, code);
}

// ── CLONE ──────────────────────────────────────────────────────────
// Saves the reference clip locally (data/ rides the existing Supabase
// mirror, so it's never lost even if the sandbox itself is ever
// recreated) AND on the sandbox, then runs the clone/smoke-test step.
async function attemptClone(user) {
  const key = safeKey(user);
  const localRefPath = path.join(CLONES_DIR, key, "reference.wav");
  if (!fs.existsSync(localRefPath)) {
    return setJob(user, { status: "failed", reason: "No reference audio on file for this account." });
  }

  setJob(user, { status: "processing" });
  try {
    const sbx = await getWorkerSandbox();
    await ensureEngineInstalled(sbx);
    await uploadWorkerScript(sbx);

    const buf = fs.readFileSync(localRefPath);
    await Computer.runOnSandbox(sbx, `mkdir -p ${SANDBOX_ROOT}/${key}`, { timeoutMs: 15000 });
    await sbx.files.write(`${SANDBOX_ROOT}/${key}/reference.wav`, buf);

    const result = await Computer.runOnSandbox(sbx, `python3 ${SANDBOX_WORKER} clone ${key}`, { timeoutMs: 5 * 60 * 1000 });
    const parsed = safeJson(result.stdout);
    if (parsed && parsed.saved) {
      return setJob(user, { status: "ready", reason: "Cloned." });
    }
    return setJob(user, { status: "failed", reason: (parsed && parsed.reason) || result.stderr.slice(0, 500) || "Cloning failed on Jarvis's computer." });
  } catch (e) {
    return setJob(user, { status: "failed", reason: e.message });
  }
}

// ── SYNTHESIZE ────────────────────────────────────────────────────
// Called from server.js's /api/tts. Returns a Buffer of WAV audio, or
// null if anything about the sandbox/engine isn't available right now
// (caller falls back to Camb.ai/browser voice, same as any other TTS
// failure — never leaves the assistant silent).
async function synthesizeCloned(user, text) {
  const key = safeKey(user);
  if (!isReady(user)) return null;
  try {
    const sbx = await getWorkerSandbox();
    await ensureEngineInstalled(sbx);
    await uploadWorkerScript(sbx);

    const textPath = `/tmp/.synth-input-${key}-${Date.now()}.txt`;
    const outPath  = `/tmp/.synth-output-${key}-${Date.now()}.wav`;
    await sbx.files.write(textPath, text);

    const result = await Computer.runOnSandbox(sbx, `python3 ${SANDBOX_WORKER} synth ${key} ${textPath} ${outPath}`, { timeoutMs: 60000 });
    const parsed = safeJson(result.stdout);
    if (!parsed || !parsed.ok) {
      console.warn(`[VOICE-CLONE] Synthesis failed for "${key}": ${(parsed && parsed.reason) || result.stderr.slice(0, 300)}`);
      return null;
    }
    const wav = await sbx.files.read(outPath, { format: "bytes" });
    // Best-effort cleanup — never let a cleanup failure fail the reply.
    Computer.runOnSandbox(sbx, `rm -f ${textPath} ${outPath}`, { timeoutMs: 10000 }).catch(() => {});
    return Buffer.from(wav);
  } catch (e) {
    console.warn(`[VOICE-CLONE] Synthesis error for "${key}": ${e.message}`);
    return null;
  }
}

function safeJson(str) {
  try {
    // clone_worker.py only ever prints ONE line of JSON, but stdout can
    // occasionally pick up warning noise from torch/TTS above it — take
    // the last non-empty line, which is always the actual result.
    const lines = String(str || "").trim().split("\n").filter(Boolean);
    return JSON.parse(lines[lines.length - 1]);
  } catch {
    return null;
  }
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
    await attemptClone(user);
  }
}

function register(app, { loadProfiles, saveProfiles }) {
  ensureDirs();

  // GET /api/voice-clone/capability — mainly "is E2B configured at
  // all", so AI Settings can explain what to do if not, before the
  // user uploads anything.
  app.get("/api/voice-clone/capability", (req, res) => {
    res.json(Computer.isConfigured()
      ? { smooth: true, reason: "Runs on Jarvis's cloud computer." }
      : { smooth: false, reason: "Jarvis's cloud computer isn't configured yet — add E2B_API_KEY to .env (free at https://e2b.dev)." });
  });

  // POST /api/voice-clone/upload  { user, audioBase64 }
  // audioBase64: raw base64 of a wav/webm/m4a clip, no data: prefix.
  // A short (10-30s), single-speaker, low-noise clip clones best.
  app.post("/api/voice-clone/upload", async (req, res) => {
    const { user, audioBase64 } = req.body || {};
    if (!user) return res.status(400).json({ error: "Missing user" });
    if (!audioBase64) return res.status(400).json({ error: "Missing audioBase64" });

    const profiles = loadProfiles();
    const key = String(user).toLowerCase().trim();
    if (!profiles[key]) return res.status(404).json({ error: `No account found for "${user}".` });

    let buf;
    try { buf = Buffer.from(audioBase64, "base64"); } catch { return res.status(400).json({ error: "Invalid base64 audio" }); }
    if (buf.length < 1000) return res.status(400).json({ error: "That clip looks too short/empty — try a 10-30s recording." });
    if (buf.length > 25 * 1024 * 1024) return res.status(400).json({ error: "That clip is too large (25MB max)." });

    ensureDirs();
    const dir = path.join(CLONES_DIR, safeKey(key));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "reference.wav"), buf);

    const job = await attemptClone(key);

    if (job.status === "ready") {
      profiles[key].aiVoiceMode = "clone";
      profiles[key].updatedAt = new Date().toISOString();
      saveProfiles(profiles);
    }

    res.json({ success: job.status === "ready", ...job });
  });

  // GET /api/voice-clone/status/:user
  app.get("/api/voice-clone/status/:user", (req, res) => {
    res.json(jobStatus(req.params.user));
  });

  // POST /api/voice-clone/retry/:user — manual "try again" button.
  app.post("/api/voice-clone/retry/:user", async (req, res) => {
    res.json(await attemptClone(req.params.user));
  });
}

module.exports = { register, processPendingClones, isReady, jobStatus, safeKey, synthesizeCloned };
