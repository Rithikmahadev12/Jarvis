"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Speech-to-text (server side)
//
// Why this exists: the browser mic engine (public/jarvis.js) uses the
// Web Speech API (webkitSpeechRecognition). That works great on the
// Render deployment and in a normal Chrome tab, because official
// Chrome builds ship with a Google API key baked in that the
// recognizer needs to reach Google's servers.
//
// The Electron desktop app (electron/main.js) runs on stock, open-
// source Chromium — which does NOT have that key — so
// webkitSpeechRecognition silently fails there (usually a "network"
// error loop) no matter what permissions are granted. There's no
// client-side fix for that; it has to go through a real STT backend
// instead. This module is that backend: it takes a short recorded
// audio clip from the browser and transcribes it with Groq's hosted
// Whisper endpoint (same GROQ_API_KEY / failover pool already used
// by hermes-engine.js, so no new keys to set up).
//
// Only used by the desktop app's mic fallback (see
// public/mic-cloud.js) — the Render/browser flow never calls this.
// ═══════════════════════════════════════════════════════════════
const GroqKeys = require("./groq-keys");

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
// Fast + cheap + good enough for command-style utterances. Override
// with GROQ_STT_MODEL in .env if you'd rather use whisper-large-v3.
const STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3-turbo";

// buffer: raw audio bytes (webm/opus from the browser's MediaRecorder)
// filename: just needs a sensible extension so Groq can sniff the format
async function transcribe(buffer, filename = "clip.webm", mimeType = "audio/webm") {
  if (!GroqKeys.hasGroqKey()) throw new Error("GROQ_API_KEY not set in .env — desktop mic needs it for speech-to-text.");
  if (!buffer || !buffer.length) return { text: "" };

  const totalKeys = GroqKeys.groqKeyCount();
  let lastError = null;

  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = GroqKeys.currentGroqKey();
    const keyLabel = totalKeys > 1 ? ` (key ${attempt + 1}/${totalKeys})` : "";
    const isLastKey = attempt === totalKeys - 1;

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    form.append("model", STT_MODEL);
    // verbose_json gives per-segment no_speech_prob / avg_logprob / compression_ratio,
    // which is what lets us tell "real speech" apart from Whisper hallucinating a
    // generic phrase ("thank you", "okay", ".") on near-silent/noisy audio — the
    // exact junk that was showing up in the mic-status log. Plain "json" gives no
    // signal to filter on at all, so this used to just trust whatever came back.
    form.append("response_format", "verbose_json");
    form.append("language", "en");
    form.append("temperature", "0");

    let res;
    try {
      res = await fetch(GROQ_TRANSCRIBE_URL, {
        method: "POST",
        headers: { "Authorization": `Bearer ${key}` },
        body: form,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      lastError = new Error(`Could not reach Groq STT${keyLabel}: ${e.message}`);
      if (isLastKey) throw lastError;
      console.warn(`[STT]${keyLabel} network failure: ${e.message} — rotating to next key...`);
      GroqKeys.rotateGroqKey();
      continue;
    }

    if ((res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) && !isLastKey) {
      const errBody = await res.json().catch(() => ({}));
      lastError = new Error(`Groq STT error ${res.status}${keyLabel}: ${errBody.error?.message || res.statusText}`);
      console.warn(`[STT]${keyLabel} failed with ${res.status} — rotating to next key...`);
      GroqKeys.rotateGroqKey();
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Groq STT error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return { text: extractRealSpeech(data) };
  }

  throw lastError || new Error("All configured Groq API keys failed for speech-to-text.");
}

// ── Hallucination filtering ──
// Whisper (all sizes, Groq's included) is well known to "hear" stock phrases
// like "Thank you.", "Okay.", "Thanks for watching.", "So," or just "." when
// fed silence, room tone, or a keyboard/breath sound — because those phrases
// are extremely common at the end of its training clips. The VAD upstream
// (public/jarvis.js _cloudVadTick) will always let a few of these slip
// through no matter how it's tuned, so the filtering has to happen here too,
// using signals Whisper itself gives us per segment:
//   • no_speech_prob  — Whisper's own confidence that this segment is NOT speech
//   • avg_logprob     — how confident it was about the words it chose (low = guessing)
//   • compression_ratio — very repetitive/degenerate output has a high ratio
const NO_SPEECH_PROB_MAX   = 0.5;   // above this, Whisper itself thinks it's silence
const AVG_LOGPROB_MIN      = -1.0;  // below this, it was basically guessing
const COMPRESSION_RATIO_MAX = 2.4;  // above this, output is repetitive garbage

// Stock phrases Whisper defaults to on silence/noise. Only used as a
// *tie-breaker* on short, low-confidence segments — never used to reject
// something the person actually clearly said with good confidence.
const HALLUCINATION_PHRASES = new Set([
  "thank you", "thanks", "thanks for watching", "okay", "ok", "yes", "so",
  "bye", "you", "i'm not", "all right", "alright", ".", "",
]);

function extractRealSpeech(data) {
  const segments = Array.isArray(data.segments) ? data.segments : null;
  if (!segments || !segments.length) {
    // No segment info came back (shouldn't happen with verbose_json, but
    // don't crash if Groq changes the shape) — fall back to plain text.
    return (data.text || "").trim();
  }

  const kept = segments.filter((seg) => {
    const text = (seg.text || "").trim();
    if (!text) return false;
    const noSpeech = typeof seg.no_speech_prob === "number" ? seg.no_speech_prob : 0;
    const logprob  = typeof seg.avg_logprob === "number" ? seg.avg_logprob : 0;
    const compRatio = typeof seg.compression_ratio === "number" ? seg.compression_ratio : 1;

    if (noSpeech > NO_SPEECH_PROB_MAX) return false;
    if (compRatio > COMPRESSION_RATIO_MAX) return false;

    const bare = text.toLowerCase().replace(/[.,!?]+$/g, "").trim();
    const looksLikeHallucination = HALLUCINATION_PHRASES.has(bare) && bare.split(/\s+/).length <= 3;
    if (looksLikeHallucination && (logprob < AVG_LOGPROB_MIN || noSpeech > 0.3)) return false;

    return true;
  });

  return kept.map((s) => (s.text || "").trim()).join(" ").trim();
}

module.exports = { transcribe };
