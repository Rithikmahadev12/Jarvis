"use strict";

// ── JARVIS VOICE — cloned voice (Hugging Face Space), then Camb.ai ────
//
// synthesize() tries, in order:
//   1. Your voice-clone Space (Chatterbox TTS, cloned from your reference
//      clip) — if VOICE_CLONE_URL is set.
//   2. Camb.ai's MARS TTS API — if CAMB_API_KEY is set.
// If neither is configured or every attempt fails, it returns null and
// the frontend falls back to the plain browser voice.
//
// Free HF Spaces sleep after inactivity, so a cold one can take 30-60s+
// to wake up. Rather than making every reply wait that long before
// falling back, we use a short per-request timeout and separately ping
// the Space in the background to keep it (or wake it) up, so most real
// requests land on an already-warm Space.
const VOICE_CLONE_URL     = (process.env.VOICE_CLONE_URL || "").replace(/\/+$/, "");
const VOICE_CLONE_API_KEY = process.env.VOICE_CLONE_API_KEY || "";
const VOICE_CLONE_TIMEOUT_MS = Number(process.env.VOICE_CLONE_TIMEOUT_MS || 12000);
const WARMUP_INTERVAL_MS     = Number(process.env.VOICE_CLONE_WARMUP_MS || 4 * 60 * 1000);

// ── Camb.ai (MARS TTS) ─────────────────────────────────────────────
// Docs: https://docs.camb.ai/api-reference/endpoint/create-tts-stream
// Simple request/response endpoint — send text, get audio back directly
// (no polling like the async /tts + /tts-result flow needs).
const CAMB_API_KEY    = process.env.CAMB_API_KEY || "";
const CAMB_VOICE_ID   = Number(process.env.CAMB_VOICE_ID || 20303);
const CAMB_LANGUAGE   = process.env.CAMB_LANGUAGE || "en-us";
const CAMB_MODEL      = process.env.CAMB_SPEECH_MODEL || "mars-8.1-flash-beta";
const CAMB_TIMEOUT_MS = Number(process.env.CAMB_TIMEOUT_MS || 15000);
const CAMB_URL        = "https://client.camb.ai/apis/tts-stream";

function isReady() {
  return !!VOICE_CLONE_URL || !!CAMB_API_KEY;
}

function cambIsReady() {
  return !!CAMB_API_KEY;
}

async function synthesizeWithCamb(clean) {
  if (!CAMB_API_KEY) return null;

  try {
    const res = await fetch(CAMB_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": CAMB_API_KEY,
      },
      body: JSON.stringify({
        text: clean,
        voice_id: CAMB_VOICE_ID,
        language: CAMB_LANGUAGE,
        speech_model: CAMB_MODEL,
      }),
      signal: AbortSignal.timeout(CAMB_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.error(`[TTS] Camb.ai returned ${res.status}: ${body.slice(0, 300)}`);
      return null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    // tts-stream returns audio/flac
    return { buffer: buf, mimeType: "audio/flac" };
  } catch (e) {
    console.error("[TTS] Camb.ai error:", e.message);
    return null;
  }
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

// ── Background keep-warm ────────────────────────────────────────────
// Fire-and-forget GET /health on a timer. Never blocks a real request —
// its only job is to stop the Space from falling asleep (or to nudge it
// awake) between actual TTS calls.
let _warming = false;
async function pingSpace() {
  if (!VOICE_CLONE_URL || _warming) return;
  _warming = true;
  try {
    await fetch(`${VOICE_CLONE_URL}/health`, { signal: AbortSignal.timeout(60000) });
  } catch (e) {
    // Expected while the Space is cold-booting — nothing to log here.
  } finally {
    _warming = false;
  }
}
function startWarmup() {
  if (!VOICE_CLONE_URL) return;
  pingSpace(); // kick one off immediately at boot
  setInterval(pingSpace, WARMUP_INTERVAL_MS);
}
startWarmup();

async function synthesize(text) {
  const clean = cleanText(text);
  if (!clean || clean.length < 2) return null;

  if (!VOICE_CLONE_URL) {
    if (CAMB_API_KEY) return synthesizeWithCamb(clean);
    console.warn("[TTS] No TTS provider configured — using browser voice");
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
      pingSpace(); // it's awake-but-erroring or still booting — nudge it
      return CAMB_API_KEY ? synthesizeWithCamb(clean) : null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return CAMB_API_KEY ? synthesizeWithCamb(clean) : null;
    return { buffer: buf, mimeType: "audio/wav" };
  } catch (e) {
    // Most common cause: the Space was asleep and didn't wake up within
    // our short timeout. Kick a background ping so it's ready sooner —
    // this call doesn't wait for it, so the user gets the browser voice
    // right away instead of hanging.
    console.error("[TTS] Voice-clone Space error:", e.message);
    pingSpace();
    return CAMB_API_KEY ? synthesizeWithCamb(clean) : null; // else browser voice
  }
}

module.exports = { synthesize, isReady, cambIsReady, cleanText };
