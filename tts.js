"use strict";

// ── JARVIS VOICE — cloned voice (Hugging Face Space) + fallbacks ──────
//
// Priority order:
//   1. Voice-clone Space on Hugging Face (your own 17s Jarvis clip,
//      cloned with Chatterbox TTS). Configure with VOICE_CLONE_URL.
//   2. ElevenLabs, if an API key is set (kept as an optional fallback —
//      useful while your Space is still building/waking up).
//   3. null → caller falls back to the browser's built-in voice.
//
// synthesize() always resolves to either:
//   { buffer: Buffer, mimeType: string }   on success
//   null                                   if every backend failed
const VOICE_CLONE_URL     = (process.env.VOICE_CLONE_URL || "").replace(/\/+$/, "");
const VOICE_CLONE_API_KEY = process.env.VOICE_CLONE_API_KEY || "";
const VOICE_CLONE_TIMEOUT_MS = Number(process.env.VOICE_CLONE_TIMEOUT_MS || 30000);

const ELEVEN_API_KEY  = process.env.ELEVENLABS_API_KEY  || "";
const ELEVEN_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "Gubgw9l4dtIoQA9YZHgx"; // Jarvis voice
const ELEVEN_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_turbo_v2_5";
const ELEVEN_URL      = `https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE_ID}`;

function isReady() {
  return !!VOICE_CLONE_URL || !!ELEVEN_API_KEY;
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

// ── 1. Voice-clone Space (Chatterbox TTS, hosted on Hugging Face) ─────
async function synthesizeVoiceClone(text) {
  if (!VOICE_CLONE_URL) return null;

  try {
    const headers = { "Content-Type": "application/json" };
    if (VOICE_CLONE_API_KEY) headers["x-api-key"] = VOICE_CLONE_API_KEY;

    const res = await fetch(`${VOICE_CLONE_URL}/synthesize`, {
      method:  "POST",
      headers,
      body:    JSON.stringify({ text }),
      signal:  AbortSignal.timeout(VOICE_CLONE_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[TTS] Voice-clone Space returned ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return { buffer: buf, mimeType: "audio/wav" };
  } catch (e) {
    // Free HF Spaces sleep after inactivity — a cold boot can take well
    // over a minute the first time, which will show up here as a timeout.
    console.error("[TTS] Voice-clone Space error:", e.message);
    return null;
  }
}

// ── 2. ElevenLabs fallback ─────────────────────────────────────────────
async function synthesizeElevenLabs(text) {
  if (!ELEVEN_API_KEY) return null;

  try {
    const res = await fetch(ELEVEN_URL, {
      method:  "POST",
      headers: {
        "Content-Type": "application/json",
        "xi-api-key":   ELEVEN_API_KEY,
        "Accept":       "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: ELEVEN_MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[TTS] ElevenLabs returned ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, mimeType: "audio/mpeg" };
  } catch (e) {
    console.error("[TTS] ElevenLabs error:", e.message);
    return null;
  }
}

async function synthesize(text) {
  const clean = cleanText(text);
  if (!clean || clean.length < 2) return null;

  const cloned = await synthesizeVoiceClone(clean);
  if (cloned) return cloned;

  if (VOICE_CLONE_URL) {
    console.warn("[TTS] Voice-clone Space failed — falling back to ElevenLabs/browser voice");
  }

  const eleven = await synthesizeElevenLabs(clean);
  if (eleven) return eleven;

  return null; // caller falls back to browser voice
}

module.exports = { synthesize, isReady, cleanText };
