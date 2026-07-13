"use strict";

// ── JARVIS VOICE — Camb.ai (MARS TTS) ───────────────────────────────
//
// synthesize() sends text to Camb.ai's MARS TTS API, if at least
// CAMB_API_KEY is set (more keys can be added as CAMB_API_KEY2,
// CAMB_API_KEY3, ... for automatic rotation once one runs out of
// credits). If Camb isn't configured or every attempt fails, it
// returns null and the frontend falls back to the plain browser voice.
//
// NOTE: this used to also try a self-hosted voice-clone Hugging Face
// Space (Chatterbox TTS) before falling back to Camb.ai. That's been
// removed — Camb.ai is the only provider now, so there's no more
// "Space" to keep warm, ping, or wait 30-60s for on a cold boot.

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
//
// Each key can have its own voice: CAMB_API_KEY uses CAMB_VOICE_ID,
// CAMB_API_KEY2 uses CAMB_VOICE_ID2, and so on. If a numbered voice ID is
// missing for a given key, that key just falls back to the base
// CAMB_VOICE_ID (or the hardcoded default if that's missing too).
function loadCambKeys() {
  const DEFAULT_VOICE_ID = 20303;
  const baseVoiceId = Number(process.env.CAMB_VOICE_ID || DEFAULT_VOICE_ID);

  const keys = [];
  if (process.env.CAMB_API_KEY) {
    keys.push({ key: process.env.CAMB_API_KEY, voiceId: baseVoiceId });
  }
  let i = 2;
  while (process.env[`CAMB_API_KEY${i}`]) {
    const voiceId = process.env[`CAMB_VOICE_ID${i}`]
      ? Number(process.env[`CAMB_VOICE_ID${i}`])
      : baseVoiceId;
    keys.push({ key: process.env[`CAMB_API_KEY${i}`], voiceId });
    i++;
  }
  return keys;
}

const CAMB_KEYS       = loadCambKeys();
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
  return cambIsReady();
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
    const { key, voiceId } = CAMB_KEYS[idx];

    try {
      const res = await fetch(CAMB_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": key,
        },
        body: JSON.stringify({
          text: clean,
          voice_id: voiceId,
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

async function synthesize(text) {
  const clean = cleanText(text);
  if (!clean || clean.length < 2) return null;

  if (!cambIsReady()) {
    console.warn("[TTS] No TTS provider configured (CAMB_API_KEY missing) — using browser voice");
    return null;
  }

  return synthesizeWithCamb(clean);
}

module.exports = { synthesize, isReady, cambIsReady, cleanText };
