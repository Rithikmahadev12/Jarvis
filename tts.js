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
  //
  // IMPORTANT: CAMB_API_KEY (bare) and CAMB_API_KEY1 are DIFFERENT env
  // vars and must stay DIFFERENT slots with DIFFERENT voice IDs
  // (CAMB_VOICE_ID and CAMB_VOICE_ID1 respectively). An earlier version
  // of this collapsed both onto "slot #1" by converting the suffix to a
  // number (`m[1] ? Number(m[1]) : 1`), so bare CAMB_API_KEY and
  // CAMB_API_KEY1 both landed on n===1 and BOTH got assigned
  // CAMB_VOICE_ID — CAMB_VOICE_ID1 was never read at all. That's what
  // caused "You are not allowed to use this voice_id" 403s: the
  // CAMB_API_KEY1 account was being sent CAMB_API_KEY's voice ID.
  // Keeping the raw string suffix (instead of coercing to a shared
  // number) keeps every key on its own distinct voice.
  const found = []; // { sortKey: number, suffix: string, key: string, envName: string }
  for (const envName of Object.keys(process.env)) {
    const m = envName.match(/^CAMB_API_KEY(\d*)$/);
    if (!m) continue;
    const raw = process.env[envName];
    if (!raw) continue;
    // Defensive trim: a key pasted with a trailing space/newline (very easy
    // to do from a browser dashboard's "copy" button, or a quoted .env
    // value like CAMB_API_KEY1="abc123 ") produces an x-api-key header
    // that LOOKS right when you eyeball it but doesn't match anything on
    // Camb's side. Some APIs reject that instantly; others just never
    // respond, which looks exactly like a network timeout even though
    // the network is fine. Trimming here removes that whole class of bug.
    const value = raw.trim();
    if (!value) continue;
    if (value !== raw) {
      console.warn(`[TTS] ${envName} had leading/trailing whitespace — trimmed it. Double-check how it was pasted into .env.`);
    }
    const suffix = m[1]; // "" for bare CAMB_API_KEY, "1", "2", ... otherwise — kept as-is, never merged
    const sortKey = suffix === "" ? 0 : Number(suffix); // bare key sorts first, then 1,2,3...
    found.push({ sortKey, suffix, key: value, envName });
  }
  found.sort((a, b) => a.sortKey - b.sortKey);

  return found.map(({ suffix, key, envName }) => {
    const voiceEnvName = suffix === "" ? "CAMB_VOICE_ID" : `CAMB_VOICE_ID${suffix}`;
    const rawVoice = process.env[voiceEnvName];
    const voiceId = rawVoice ? Number(rawVoice.trim()) : baseVoiceId;
    if (rawVoice && Number.isNaN(voiceId)) {
      console.warn(`[TTS] ${voiceEnvName}="${rawVoice}" isn't a valid number — falling back to ${baseVoiceId}.`);
    }
    // Masked preview (first 4 / last 4 chars only) so you can eyeball in
    // the boot log whether a key looks truncated or duplicated without
    // ever printing the real secret.
    const masked = key.length > 10 ? `${key.slice(0, 4)}…${key.slice(-4)} (len ${key.length})` : `(len ${key.length})`;
    return { key, voiceId, label: envName, masked }; // label/masked are just for clearer logging below
  });
}

const CAMB_KEYS       = loadCambKeys();
const CAMB_LANGUAGE   = process.env.CAMB_LANGUAGE || "en-us";
const CAMB_MODEL      = process.env.CAMB_SPEECH_MODEL || "mars-8.1-flash-beta";
// Lowered from 15000 -> 8000. With up to 2 tries per key (see keyTry loop
// below), a single dead/slow key could previously eat ~30s+ of the
// caller's budget (see public/jarvis.js's /api/tts fetch, which aborts
// after 60s) — with several keys timing out back to back, that 60s
// window was gone before later keys in the rotation ever got a real
// chance to run. 8s per try still comfortably covers a healthy Camb.ai
// response, while failing dead/unreachable keys fast enough that all
// configured keys actually get tried within the request's real budget.
const CAMB_TIMEOUT_MS = Number(process.env.CAMB_TIMEOUT_MS || 8000);
const CAMB_URL        = "https://client.camb.ai/apis/tts-stream";

console.log(`[TTS] Loaded ${CAMB_KEYS.length} Camb.ai key(s): ${CAMB_KEYS.map(k => k.label).join(", ") || "(none)"}`);
for (const k of CAMB_KEYS) console.log(`[TTS]   ${k.label} → ${k.masked}, voice_id=${k.voiceId}`);

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
    const { key, voiceId, label } = CAMB_KEYS[idx];

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
          const body = await res.text().catch(() => "");
          console.warn(`[TTS] Camb key ${label} rejected (HTTP ${res.status}) — rotating to next key. Response: ${body.slice(0, 300) || "(empty body)"}`);
          break; // no point retrying this key, it's genuinely done
        }

        if (CAMB_KEY_TRANSIENT_CODES.has(res.status)) {
          if (keyTry === 0) {
            console.warn(`[TTS] Camb key ${label} got a transient HTTP ${res.status} — retrying same key once before rotating`);
            continue; // give this same key one more shot
          }
          console.warn(`[TTS] Camb key ${label} still failing after retry (HTTP ${res.status}) — rotating to next key`);
          break;
        }

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.error(`[TTS] Camb.ai (${label}) returned ${res.status}: ${body.slice(0, 300)}`);
          break; // unrecognized failure — still worth trying another key
        }

        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) { break; }

        _cambKeyIndex = idx; // this key works — start here next time
        return { buffer: buf, mimeType: "audio/flac" }; // tts-stream returns audio/flac
      } catch (e) {
        // network/timeout error — treat as transient, worth one retry
        // on this same key before assuming it's actually dead.
        // e.name tells you WHICH kind of failure this is:
        //   "TimeoutError"   → AbortSignal.timeout fired; Camb never responded
        //                      in time (CAMB_TIMEOUT_MS). If EVERY key does
        //                      this while one key gets a real HTTP response
        //                      (like a 402), it's not a network/DNS problem —
        //                      something about those specific keys/accounts
        //                      is making Camb's server hang instead of
        //                      rejecting them outright (e.g. an unverified
        //                      trial account, or an abuse/rate throttle that
        //                      silently stalls instead of returning 429).
        //   "ENOTFOUND"/"EAI_AGAIN" → DNS can't resolve client.camb.ai.
        //   "ECONNREFUSED"/"ECONNRESET" → something between you and Camb
        //                      (firewall, VPN, antivirus) is dropping the
        //                      connection.
        const kind = e.name || e.code || "Error";
        if (keyTry === 0) {
          console.warn(`[TTS] Camb.ai (${label}) [${kind}] error on first try (${e.message}) — retrying same key once`);
          continue;
        }
        console.error(`[TTS] Camb.ai (${label}) [${kind}] error after retry:`, e.message);
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
