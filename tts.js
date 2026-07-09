"use strict";

// ── JARVIS VOICE — cloned voice (Hugging Face Space) only ─────────────
//
// synthesize() calls your voice-clone Space (Chatterbox TTS, cloned from
// your reference clip). If it's not configured or a request fails, it
// returns null and the frontend falls back to the plain browser voice —
// no third-party TTS service involved.
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
      pingSpace(); // it's awake-but-erroring or still booting — nudge it
      return null; // client falls back to browser voice
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;
    return { buffer: buf, mimeType: "audio/wav" };
  } catch (e) {
    // Most common cause: the Space was asleep and didn't wake up within
    // our short timeout. Kick a background ping so it's ready sooner —
    // this call doesn't wait for it, so the user gets the browser voice
    // right away instead of hanging.
    console.error("[TTS] Voice-clone Space error:", e.message);
    pingSpace();
    return null; // client falls back to browser voice
  }
}

module.exports = { synthesize, isReady, cleanText };
