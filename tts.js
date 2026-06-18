"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Piper TTS Engine
// Uses the actual JARVIS voice model from jgkawell/jarvis
// Runs locally via Piper binary — zero API cost, zero rate limits
// ═══════════════════════════════════════════════════════════════

const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync  = promisify(execFile);
const path           = require("path");
const fs             = require("fs");
const os             = require("os");

const VOICE_MODEL = path.join(__dirname, "voices/jarvis/en_GB-jarvis-medium.onnx");
const PIPER_BIN   = "piper"; // on PATH after startup.sh

function isReady() {
  return fs.existsSync(VOICE_MODEL);
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
    console.warn("[TTS] Voice model not ready yet");
    return null;
  }

  const clean = cleanText(text);
  if (!clean || clean.length < 2) return null;

  // Write text to a temp file to avoid shell injection issues
  const tmpInput  = path.join(os.tmpdir(), `jarvis_in_${Date.now()}.txt`);
  const tmpOutput = path.join(os.tmpdir(), `jarvis_out_${Date.now()}.wav`);

  try {
    fs.writeFileSync(tmpInput, clean, "utf8");

    await execFileAsync(PIPER_BIN, [
      "--model",        VOICE_MODEL,
      "--output_file",  tmpOutput,
      "--length_scale", "1.0",  // 1.0 = normal speed, 0.9 = slightly faster
      "--noise_scale",  "0.667",
      "--noise_w",      "0.8",
    ], {
      stdin:   fs.createReadStream(tmpInput),
      timeout: 15000,
    });

    const audio = fs.readFileSync(tmpOutput);
    return audio;

  } catch (e) {
    console.error("[TTS] Piper synthesis failed:", e.message);
    return null;
  } finally {
    // Always clean up temp files
    try { fs.unlinkSync(tmpInput);  } catch {}
    try { fs.unlinkSync(tmpOutput); } catch {}
  }
}

module.exports = { synthesize, isReady, cleanText };
