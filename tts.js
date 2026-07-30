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

  // Scan ALL env vars for CAMB_API_KEY / CAMB_API_KEY<N>, instead of
  // walking i=2,3,4... and stopping at the first missing number. That
  // old approach silently truncated the whole list the moment there
  // was a single gap or out-of-order key (e.g. CAMB_API_KEY26 defined
  // but CAMB_API_KEY25 missing/renamed) — everything after the gap was
  // never loaded at all, which looks exactly like "stops checking
  // after N keys" and "skips keys that still have credits" even though
  // those keys were never read in the first place. This has no upper
  // limit and no gap sensitivity: however many CAMB_API_KEY* vars exist,
  // all of them get picked up.
  const found = []; // { n: number, key: string }
  for (const envName of Object.keys(process.env)) {
    const m = envName.match(/^CAMB_API_KEY(\d*)$/);
    if (!m) continue;
    const value = process.env[envName];
    if (!value) continue;
    const n = m[1] ? Number(m[1]) : 1; // bare CAMB_API_KEY counts as #1
    found.push({ n, key: value });
  }
  found.sort((a, b) => a.n - b.n);

  return found.map(({ n, key }) => {
    const voiceEnvName = n === 1 ? "CAMB_VOICE_ID" : `CAMB_VOICE_ID${n}`;
    const voiceId = process.env[voiceEnvName] ? Number(process.env[voiceEnvName]) : baseVoiceId;
    return { key, voiceId };
  });
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

// Status codes that mean this specific key is genuinely done — invalid,
// revoked, or actually out of credits. Safe to skip immediately.
const CAMB_KEY_DEAD_CODES = new Set([401, 402, 403]);
// Status codes that are usually transient (a momentary rate limit or a
// server-side hiccup) and do NOT mean the key is out of credits. A key
// that has real credits left can still get one of these once — so we
// give it one quick retry before rotating away from it, instead of
// writing it off on a single bad response.
const CAMB_KEY_TRANSIENT_CODES = new Set([429, 500, 502, 503, 504]);

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

    // Up to 2 tries for THIS key: the first try, plus one retry if that
    // first try looked like a transient blip rather than a dead key.
    for (let keyTry = 0; keyTry < 2; keyTry++) {
      if (keyTry === 1) {
        // brief pause before retrying the same key
        await new Promise((r) => setTimeout(r, 400));
      }
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

        if (CAMB_KEY_DEAD_CODES.has(res.status)) {
          console.warn(`[TTS] Camb key #${idx + 1} rejected (HTTP ${res.status} — invalid key or out of credits) — rotating to next key`);
          break; // no point retrying this key, it's genuinely done
        }

        if (CAMB_KEY_TRANSIENT_CODES.has(res.status)) {
          if (keyTry === 0) {
            console.warn(`[TTS] Camb key #${idx + 1} got a transient HTTP ${res.status} — retrying same key once before rotating`);
            continue; // give this same key one more shot
          }
          console.warn(`[TTS] Camb key #${idx + 1} still failing after retry (HTTP ${res.status}) — rotating to next key`);
          break;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`[TTS] Camb.ai (key #${idx + 1}) returned ${res.status}: ${body.slice(0, 300)}`);
          break; // unrecognized failure — still worth trying another key
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) { break; }

        _cambKeyIndex = idx; // this key works — start here next time
        return { buffer: buf, mimeType: "audio/flac" }; // tts-stream returns audio/flac
      } catch (e) {
        // network/timeout error — treat as transient, worth one retry
        // on this same key before assuming it's actually dead
        if (keyTry === 0) {
          console.warn(`[TTS] Camb.ai (key #${idx + 1}) error on first try (${e.message}) — retrying same key once`);
          continue;
        }
        console.error(`[TTS] Camb.ai (key #${idx + 1}) error after retry:`, e.message);
      }
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
