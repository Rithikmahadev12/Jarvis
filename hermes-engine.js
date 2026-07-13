"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Hermes Agent (REAL LOCAL LLM, LOCAL-ONLY)
//
// Not to be confused with hermes-engine.js (that one talks to
// Groq's cloud API for the main chat brain — it runs fine anywhere,
// including on Render).
//
// THIS file runs an actual Hermes model — NousResearch's Hermes 3
// — locally via Ollama (https://ollama.com), and uses it to reason
// about "open X" style requests: what app/file/folder/URL the user
// means, and what to do with it. Ollama has to be installed once;
// after that this module pulls the model itself (`ollama pull`),
// starts a chat completion against Ollama's local REST API, and
// then actually executes the result on the machine.
//
// That local-execution step only makes sense when Jarvis is running
// ON your own computer. If Jarvis is deployed to Render (or any
// other cloud host), there's no "your PC" for it to reach — so this
// whole agent (model pull, Ollama calls, execution) auto-disables
// the moment it detects a cloud/Render environment. Nothing
// downstream needs to remember to check that; isEnabled() is
// checked internally on every call.
// ═══════════════════════════════════════════════════════════════

const { exec, spawn } = require("child_process");
const os              = require("os");

// ── CONFIG ──────────────────────────────────────────────────────
// OLLAMA_URL   → where Ollama's local API is listening (default install)
// HERMES_MODEL → which Hermes tag to pull/run. "hermes3" is Ollama's
//                library name for NousResearch's Hermes 3 (defaults to
//                the 8B quant, which runs on most modern laptops).
//                Override to e.g. "hermes3:3b" on lower-spec machines,
//                or "hermes3:70b" if you've got the hardware for it.
const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://127.0.0.1:11434";
const HERMES_MODEL = process.env.HERMES_MODEL || "hermes3";

// ── ENVIRONMENT DETECTION ──────────────────────────────────────
// Render sets RENDER=true (and other RENDER_* vars) on every
// instance automatically — no config needed on our end.
function isRenderEnv() {
  return !!(
    process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.RENDER_INSTANCE_ID
  );
}

function isEnabled() {
  return !isRenderEnv();
}

// ── OLLAMA PLUMBING ──────────────────────────────────────────────
function hasOllamaBinary() {
  return new Promise((resolve) => {
    exec("ollama --version", (err) => resolve(!err));
  });
}

async function isOllamaServing() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

// Has the Hermes model actually been pulled already?
async function isModelPulled(model = HERMES_MODEL) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    const base = model.split(":")[0];
    return (data.models || []).some(m => m.name === model || m.name.startsWith(base + ":") || m.model === model);
  } catch {
    return false;
  }
}

// Actually downloads the model ("ollama pull hermes3"). Streams
// progress to the console. Resolves once the pull finishes (or the
// model was already present).
function pullModel(model = HERMES_MODEL, onProgress) {
  return new Promise((resolve, reject) => {
    const child = spawn("ollama", ["pull", model]);
    child.stdout.on("data", (d) => onProgress && onProgress(d.toString()));
    child.stderr.on("data", (d) => onProgress && onProgress(d.toString()));
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ollama pull exited with code ${code}`)));
  });
}

// Makes sure Ollama is installed, running, and has the Hermes model
// pulled. Safe to call repeatedly — it's a no-op once everything is
// already in place. Used by startup.sh and lazily by openOnComputer().
async function ensureReady({ onLog = () => {} } = {}) {
  if (!isEnabled()) return { ready: false, reason: "disabled-on-render" };

  const hasBinary = await hasOllamaBinary();
  if (!hasBinary) {
    return { ready: false, reason: "ollama-not-installed" };
  }

  const serving = await isOllamaServing();
  if (!serving) {
    return { ready: false, reason: "ollama-not-running" };
  }

  const pulled = await isModelPulled();
  if (!pulled) {
    onLog(`Downloading ${HERMES_MODEL} (first run only, several GB)...`);
    await pullModel(HERMES_MODEL, (line) => onLog(line.trim()));
  }

  return { ready: true };
}

// ── REASONING: ask the local Hermes model what "open X" means ───
const SYSTEM_PROMPT =
  "You are the local-control reasoning module for a voice assistant called J.A.R.V.I.S. " +
  "The user will describe something they want opened on their own computer — an application, " +
  "a file, a folder, or a URL. Reply with ONLY a JSON object, no prose, no markdown fences, in " +
  'the exact shape {"target": "<string>"}. The target should be the shortest thing an OS-level ' +
  '"open" command would understand: an app name ("notepad", "Google Chrome"), a file/folder path ' +
  'exactly as given, or a full URL. If you truly cannot tell what they want opened, reply ' +
  '{"target": null}.';

async function askHermes(userMessage) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: HERMES_MODEL,
      stream: false,
      format: "json",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Ollama/Hermes request failed (${res.status})`);
  const data = await res.json();
  const raw = data?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  return parsed.target || null;
}

// ── OS EXECUTION ──────────────────────────────────────────────
// Once Hermes has told us WHAT to open, this is HOW: the actual OS
// command that opens it, per-platform.
function buildCommand(target) {
  const platform = os.platform(); // 'win32' | 'darwin' | 'linux'
  const clean = String(target || "").trim();
  if (!clean) return null;

  if (platform === "win32")  return `start "" "${clean}"`;
  if (platform === "darwin") return `open "${clean}"`;
  return `xdg-open "${clean}"`; // linux + any other *nix
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (err) => err ? reject(err) : resolve());
  });
}

// ── MAIN ENTRY POINT ────────────────────────────────────────────
// Takes the user's raw instruction (e.g. "open my resume on my
// computer" or "launch chrome"), asks the local Hermes model what
// that actually means, then executes it. Resolves with
// { target, command }. Rejects with a clear reason otherwise.
async function openOnComputer(userMessage) {
  if (!isEnabled()) {
    throw new Error(
      "Hermes agent is disabled here — this instance is running on Render, " +
      "not on your own computer, so there's nothing local for it to open."
    );
  }

  const status = await ensureReady();
  if (!status.ready) {
    const hints = {
      "ollama-not-installed": "Ollama isn't installed. Install it from https://ollama.com/download, then try again.",
      "ollama-not-running":   "Ollama is installed but not running. Start it (`ollama serve`), then try again.",
    };
    throw new Error(hints[status.reason] || "Hermes agent isn't ready yet.");
  }

  const target = await askHermes(userMessage);
  if (!target) throw new Error("Couldn't figure out what you want opened.");

  const command = buildCommand(target);
  await runCommand(command);
  return { target, command };
}

module.exports = {
  isRenderEnv,
  isEnabled,
  ensureReady,
  hasOllamaBinary,
  isOllamaServing,
  isModelPulled,
  pullModel,
  askHermes,
  buildCommand,
  openOnComputer,
  OLLAMA_URL,
  HERMES_MODEL,
};
