"use strict";

// ── ElevenLabs TTS ────────────────────────────────────────────
// Jarvis's voice. If it's not configured (no API key) or a request
// fails, synthesize() returns null and the frontend falls back to the
// normal built-in browser voice — no local Piper server involved.
const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY  || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "Gubgw9l4dtIoQA9YZHgx"; // Jarvis voice
const ELEVEN_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const ELEVEN_URL       = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

function isReady() {
  return !!ELEVEN_API_KEY;
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

  if (!ELEVEN_API_KEY) {
    console.warn("[TTS] ELEVENLABS_API_KEY not set — using browser voice");
    return null;
  }

  try {
    const res = await fetch(ELEVEN_URL, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key":   ELEVEN_API_KEY,
        "Accept":       "audio/mpeg",
      },
      body: JSON.stringify({
        text:     clean,
        model_id: ELEVEN_MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[TTS] ElevenLabs returned ${res.status}: ${body.slice(0, 300)}`);
      return null; // client falls back to browser voice
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf); // MP3
  } catch (e) {
    console.error("[TTS] ElevenLabs error:", e.message);
    return null; // client falls back to browser voice
  }
}

module.exports = { synthesize, isReady, cleanText };
