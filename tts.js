"use strict";

// ── JARVIS VOICE — cloned voice (Hugging Face Space), then Camb.ai ────
//
// synthesize() tries, in order:
//   1. Your voice-clone Space (Chatterbox TTS, cloned from your reference
//      clip) — if VOICE_CLONE_URL is set.
//   2. Camb.ai's MARS TTS API — if at least CAMB_API_KEY is set (more
//      keys can be added as CAMB_API_KEY2, CAMB_API_KEY3, ... for
//      automatic rotation once one runs out of credits).
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
//
// Supports multiple API keys for automatic rotation: CAMB_API_KEY,
// CAMB_API_KEY2, CAMB_API_KEY3, ... (keeps going as long as the numbered
// vars exist — add as many as you want, no code changes needed). When a
// key comes back rejected (out of credits, invalid, rate-limited), the
// next key is tried automatically within the same request. Every request
// re-tries every configured key regardless of what happened last time, so
// a key that looked dead still gets a fair shot again. Rotation "restarts"
// from key #1 on a calendar schedule (the 8th of every month, starting
// Aug 8, 2026) instead of on server restart, since deploys don't line up
// with your monthly credit reset.
function loadCambKeys() {
  const keys = [];
  if (process.env.CAMB_API_KEY) keys.push(process.env.CAMB_API_KEY);
  let i = 2;
  while (process.env[`CAMB_API_KEY${i}`]) {
    keys.push(process.env[`CAMB_API_KEY${i}`]);
    i++;
  }
  return keys;
}

const CAMB_KEYS       = loadCambKeys();
const CAMB_VOICE_ID   = Number(process.env.CAMB_VOICE_ID || 20303);
const CAMB_LANGUAGE   = process.env.CAMB_LANGUAGE || "en-us";
const CAMB_MODEL      = process.env.CAMB_SPEECH_MODEL || "mars-8.1-flash-beta";
const CAMB_TIMEOUT_MS = Number(process.env.CAMB_TIMEOUT_MS || 15000);
const CAMB_URL        = "https://client.camb.ai/apis/tts-stream";

// Index of the key we START with each request. This is just an
// optimization (skip straight to the one that worked last time) — every
// request still tries ALL configured keys before giving up, in case a
// key we think is dead has actually come back (e.g. a rate limit that
// cleared, or a credit top-up). See the full-sweep loop below.
let _cambKeyIndex = 0;

// ── Monthly reset, anchored to a real date instead of server restarts ──
// Deploys don't happen on a predictable schedule, so instead of resetting
// on process boot, we reset on a calendar anchor: the 8th of every month,
// starting Aug 8, 2026. Each request checks whether we've crossed into a
// new monthly cycle and, if so, starts the key rotation back at key #1.
const CAMB_CYCLE_ANCHOR_DAY   = 8;                    // resets on the 8th each month
const CAMB_CYCLE_FIRST_RESET  = new Date(2026, 7, 8); // Aug 8, 2026 (month is 0-indexed)

function cambCycleId(now = new Date()) {
  if (now < CAMB_CYCLE_FIRST_RESET) return "pre-anchor"; // before the first reset date
  let year  = now.getFullYear();
  let month = now.getMonth(); // 0-11
  if (now.getDate() < CAMB_CYCLE_ANCHOR_DAY) {
    month -= 1;
    if (month < 0) { month = 11; year -= 1; }
  }
  return `${year}-${month}`;
}

let _cambCycleId = cambCycleId();

function resetCambCycleIfNeeded() {
  const id = cambCycleId();
  if (id !== _cambCycleId) {
    _cambCycleId  = id;
    _cambKeyIndex = 0;
    console.log(`[TTS] Camb.ai monthly cycle rolled over (resets on the ${CAMB_CYCLE_ANCHOR_DAY}th) — retrying all ${CAMB_KEYS.length} key(s) from #1`);
  }
}

function isReady() {
  return !!VOICE_CLONE_URL || cambIsReady();
}

function cambIsReady() {
  return CAMB_KEYS.length > 0;
}

// HTTP codes that mean "this key is done" rather than "Camb is down" —
// worth moving to the next key instead of giving up on Camb entirely.
const CAMB_KEY_EXHAUSTED_CODES = new Set([401, 402, 403, 429]);

async function synthesizeWithCamb(clean) {
  if (!CAMB_KEYS.length) return null;
  resetCambCycleIfNeeded();

  // Full sweep every request: start at the key we last had success with,
  // then wrap through every other configured key. Nothing is permanently
  // marked dead in memory, so even a key that failed last request still
  // gets tried again this request — it only gets skipped for the rest of
  // THIS request once it fails again.
  for (let attempt = 0; attempt < CAMB_KEYS.length; attempt++) {
    const idx = (_cambKeyIndex + attempt) % CAMB_KEYS.length;
    const key = CAMB_KEYS[idx];

    try {
      const res = await fetch(CAMB_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify({
          text: clean,
          voice_id: CAMB_VOICE_ID,
          language: CAMB_LANGUAGE,
          speech_model: CAMB_MODEL,
        }),
        signal: AbortSignal.timeout(CAMB_TIMEOUT_MS),
      });

      if (CAMB_KEY_EXHAUSTED_CODES.has(res.status)) {
        console.warn(`[TTS] Camb key #${idx + 1} rejected (HTTP ${res.status}, likely out of credits) — rotating to next key`);
        continue; // try the next key
      }

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.error(`[TTS] Camb.ai (key #${idx + 1}) returned ${res.status}: ${body.slice(0, 300)}`);
        continue; // still worth trying another key rather than giving up
      }

      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length) { continue; }

      _cambKeyIndex = idx; // this key works — start here next time
      return { buffer: buf, mimeType: "audio/flac" }; // tts-stream returns audio/flac
    } catch (e) {
      console.error(`[TTS] Camb.ai (key #${idx + 1}) error:`, e.message);
      // network/timeout error — try the next key
    }
  }

  console.error(`[TTS] All ${CAMB_KEYS.length} Camb.ai key(s) failed or are out of credits`);
  return null;
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
    if (cambIsReady()) return synthesizeWithCamb(clean);
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
      return cambIsReady() ? synthesizeWithCamb(clean) : null;
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return cambIsReady() ? synthesizeWithCamb(clean) : null;
    return { buffer: buf, mimeType: "audio/wav" };
  } catch (e) {
    // Most common cause: the Space was asleep and didn't wake up within
    // our short timeout. Kick a background ping so it's ready sooner —
    // this call doesn't wait for it, so the user gets the browser voice
    // right away instead of hanging.
    console.error("[TTS] Voice-clone Space error:", e.message);
    pingSpace();
    return cambIsReady() ? synthesizeWithCamb(clean) : null; // else browser voice
  }
}

module.exports = { synthesize, isReady, cambIsReady, cleanText };
