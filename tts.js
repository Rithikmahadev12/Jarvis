"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Piper TTS Engine
// Uses spawn() with stdin pipe so text is correctly passed to Piper
// LD_LIBRARY_PATH ensures bundled libespeak-ng.so.1 is found
// ═══════════════════════════════════════════════════════════════

const { spawn }  = require("child_process");
const path        = require("path");
const fs          = require("fs");
const os          = require("os");

const PIPER_DIR   = path.join(__dirname, "bin/piper_dir");
const PIPER_BIN   = path.join(PIPER_DIR, "piper");
const VOICE_MODEL = path.join(__dirname, "voices/jarvis/en_GB-jarvis-medium.onnx");

function isReady() {
  return fs.existsSync(VOICE_MODEL) && fs.existsSync(PIPER_BIN);
}

function cleanText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g,   "$1")
    .replace(/[`#*_~]/g,     "")
    .replace(/→|⬡|●|◈|▲|◌|◯|⚡|🎙|📱|💻|🖥|📺|🖨|📡|🎮|🔊|📹|💾|🔌|💡/g, "")
    .replace(/\s+/g,         " ")
    .trim()
    .slice(0, 500);
}

function synthesize(text) {
  return new Promise((resolve) => {
    if (!isReady()) {
      console.warn("[TTS] Voice model or Piper binary not ready yet");
      return resolve(null);
    }

    const clean = cleanText(text);
    if (!clean || clean.length < 2) return resolve(null);

    const tmpOutput = path.join(os.tmpdir(), `jarvis_out_${Date.now()}.wav`);

    const piper = spawn(PIPER_BIN, [
      "--model",        VOICE_MODEL,
      "--output_file",  tmpOutput,
      "--length_scale", "1.0",
      "--noise_scale",  "0.667",
      "--noise_w",      "0.8",
    ], {
      env: {
        ...process.env,
        LD_LIBRARY_PATH: PIPER_DIR +
          (process.env.LD_LIBRARY_PATH ? ":" + process.env.LD_LIBRARY_PATH : ""),
      },
    });

    let stderr = "";
    piper.stderr.on("data", (d) => { stderr += d.toString(); });

    // Write the text to Piper's stdin, then close it
    piper.stdin.write(clean, "utf8");
    piper.stdin.end();

    const timeout = setTimeout(() => {
      piper.kill();
      console.error("[TTS] Piper timed out");
      try { fs.unlinkSync(tmpOutput); } catch {}
      resolve(null);
    }, 15000);

    piper.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        console.error(`[TTS] Piper exited ${code}: ${stderr.trim()}`);
        try { fs.unlinkSync(tmpOutput); } catch {}
        return resolve(null);
      }
      try {
        const audio = fs.readFileSync(tmpOutput);
        resolve(audio);
      } catch (e) {
        console.error("[TTS] Could not read output wav:", e.message);
        resolve(null);
      } finally {
        try { fs.unlinkSync(tmpOutput); } catch {}
      }
    });

    piper.on("error", (e) => {
      clearTimeout(timeout);
      console.error("[TTS] Piper spawn error:", e.message);
      try { fs.unlinkSync(tmpOutput); } catch {}
      resolve(null);
    });
  });
}

module.exports = { synthesize, isReady, cleanText };
