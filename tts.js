"use strict";

// ── JARVIS VOICE — cloned voice (Hugging Face Space) only ─────────────
//
// synthesize() calls your voice-clone Space (Chatterbox TTS, cloned from
// your reference clip). If it's not configured or a request fails, it
// returns null and the frontend falls back to the plain browser voice —
// no third-party TTS service involved.
const VOICE_CLONE_URL     = (process.env.VOICE_CLONE_URL || "").replace(/\/+$/, "");
const VOICE_CLONE_API_KEY = process.env.VOICE_CLONE_API_KEY || "";
const VOICE_CLONE_TIMEOUT_MS = Number(process.env.VOICE_CLONE_TIMEOUT_MS || 30000);

function isReady() {
  return !!VOICE_CLONE_URL;
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

async function synthesize(text) {
  const clean = cleanText(text);
  if (!clean || clean.length < 2) return null;

  if (!VOICE_CLONE_URL) {
    console.warn("[TTS] VOICE_CLONE_URL not set — using browser voice");
    return null;
  }

  try {
    const headers = { "Content-Type": "application/json" };
    if (VOICE_CLONE_API_KEY) headers["x-api-key"] = VOICE_CLONE_API_KEY;

    const res = await fetch(`${VOICE_CLONE_URL}/synthesize`, {
      method:  "POST",
      headers,
      body:    JSON.stringify({ text: clean }),
      signal:  AbortSignal.timeout(VOICE_CLONE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[TTS] Voice-clone Space returned ${res.status}: ${body.slice(0, 300)}`);
      return null; // client falls back to browser voice
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return { buffer: buf, mimeType: "audio/wav" };
  } catch (e) {
    // Free HF Spaces sleep after inactivity — a cold boot can take well
    // over a minute the first time, which will show up here as a timeout.
    console.error("[TTS] Voice-clone Space error:", e.message);
    return null; // client falls back to browser voice
  }
}

module.exports = { synthesize, isReady, cleanText };
