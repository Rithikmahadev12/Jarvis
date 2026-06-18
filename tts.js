"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Piper TTS Engine
// Uses the actual JARVIS voice model from jgkawell/jarvis
// Runs locally via Piper binary — zero API cost, zero rate limits
//
// FIX: Uses LD_LIBRARY_PATH so Piper can find its bundled
// libespeak-ng.so.1 without needing system-level installation.
// ═══════════════════════════════════════════════════════════════

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync  = promisify(execFile);
const path           = require("path");
const fs             = require("fs");
const os             = require("os");

// Piper binary and its bundled lib folder (both inside piper_dir/)
const PIPER_DIR  = path.join(__dirname, "bin/piper_dir");
const PIPER_BIN  = path.join(PIPER_DIR, "piper");
const VOICE_MODEL = path.join(__dirname, "voices/jarvis/en_GB-jarvis-medium.onnx");

function isReady() {
  return fs.existsSync(VOICE_MODEL) && fs.existsSync(PIPER_BIN);
}

function cleanText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")   // strip bold markdown
    .replace(/\*(.+?)\*/g,   "$1")     // strip italic markdown
    .replace(/[`#*_~]/g,     "")       // strip remaining markdown
    .replace(/→|⬡|●|◈|▲|◌|◯|⚡|🎙|📱|💻|🖥|📺|🖨|📡|🎮|🔊|📹|💾|⚡|🔌|💡/g, "")
    .replace(/\s+/g,         " ")      // collapse whitespace
    .trim()
    .slice(0, 500);
}

async function synthesize(text) {
  if (!isReady()) {
    console.warn("[TTS] Voice model or Piper binary not ready yet");
    return null;
  }

  const clean = cleanText(text);
  if (!clean || clean.length < 2) return null;

  const tmpOutput = path.join(os.tmpdir(), `jarvis_out_${Date.now()}.wav`);

  try {
    // Pass text via stdin — avoids temp file and shell injection
    // LD_LIBRARY_PATH tells the OS where to find libespeak-ng.so.1
    // which ships bundled inside the piper_dir folder
    await execFileAsync(PIPER_BIN, [
      "--model",        VOICE_MODEL,
      "--output_file",  tmpOutput,
      "--length_scale", "1.0",
      "--noise_scale",  "0.667",
      "--noise_w",      "0.8",
    ], {
      input:   clean,
      timeout: 15000,
      env: {
        ...process.env,
        LD_LIBRARY_PATH: PIPER_DIR + (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : ""),
      },
    });

    if (!fs.existsSync(tmpOutput)) {
      console.error("[TTS] Output file was not created");
      return null;
    }

    const audio = fs.readFileSync(tmpOutput);
    return audio;

  } catch (e) {
    console.error("[TTS] Piper synthesis failed:", e.message);
    return null;
  } finally {
    try { fs.unlinkSync(tmpOutput); } catch {}
  }
}

module.exports = { synthesize, isReady, cleanText };
