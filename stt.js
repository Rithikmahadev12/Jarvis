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
// audio clip from the browser and transcribes it.
//
// Primary engine: Deepgram (Nova-2). Free account gives $200 in
// credit with no card required and no expiration — plenty for
// personal use — and it's noticeably more accurate on short,
// quiet, command-style clips than Groq's Whisper was. Get a key at
// https://console.deepgram.com/signup, then set DEEPGRAM_API_KEY in
// .env. Falls back to Gemini (if GEMINI_API_KEY is set) and then
// Groq (if GROQ_API_KEY is set) only if Deepgram isn't configured
// or fails, so nothing breaks for setups that had those working.
//
// Only used by the desktop app's mic fallback (see
// public/mic-cloud.js) — the Render/browser flow never calls this.
// ═══════════════════════════════════════════════════════════════
const GroqKeys = require("./groq-keys");

// ── Deepgram ────────────────────────────────────────────────────
const DEEPGRAM_API_KEY = (process.env.DEEPGRAM_API_KEY || "").trim();
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-2";
const DEEPGRAM_MIME_MAP = { "audio/webm": "audio/webm", "audio/wav": "audio/wav", "audio/mp4": "audio/mp4", "audio/mpeg": "audio/mpeg", "audio/ogg": "audio/ogg" };

async function deepgramTranscribe(buffer, mimeType) {
  const contentType = DEEPGRAM_MIME_MAP[mimeType] || "audio/webm";
  // keywords boosts recognition odds for this project's actual command
  // vocabulary and the wake word itself — Deepgram's docs recommend
  // this for short command-style utterances just like Groq's "prompt"
  // field was doing before.
  const keywords = ["jarvis:2", "shuffle:1", "resume:1"].map(k => `keywords=${encodeURIComponent(k)}`).join("&");
  const url = `https://api.deepgram.com/v1/listen?model=${DEEPGRAM_MODEL}&language=en&smart_format=true&punctuate=true&${keywords}`;

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Authorization": `Token ${DEEPGRAM_API_KEY}`, "Content-Type": contentType },
      body: buffer,
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    throw new Error(`Could not reach Deepgram STT: ${e.message}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Deepgram STT error ${res.status}: ${err.err_msg || err.reason || res.statusText}`);
  }

  const data = await res.json();
  const transcript = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
  return { text: transcript.trim() };
}

// buffer: raw audio bytes (webm/opus from the browser's MediaRecorder)
// filename: kept for signature compatibility with the fallback engines
// mimeType: passed through to whichever engine handles the request
async function transcribe(buffer, filename = "clip.webm", mimeType = "audio/webm") {
  if (!buffer || !buffer.length) return { text: "" };

  if (DEEPGRAM_API_KEY) {
    try {
      return await deepgramTranscribe(buffer, mimeType);
    } catch (e) {
      console.warn(`[STT] Deepgram failed: ${e.message} — falling back...`);
      if (!USE_GEMINI && !GroqKeys.hasGroqKey()) throw e;
    }
  }

  if (USE_GEMINI) {
    try {
      return await geminiTranscribe(buffer, mimeType);
    } catch (e) {
      console.warn(`[STT] Gemini failed: ${e.message} — falling back...`);
      if (!GroqKeys.hasGroqKey()) throw e;
    }
  }

  return groqTranscribe(buffer, filename, mimeType);
}

// ── Gemini fallback ─────────────────────────────────────────────
function loadGeminiKeys() {
  const keys = [];
  const primary = process.env.GEMINI_API_KEY || "";
  for (const k of primary.split(",")) {
    const trimmed = k.trim();
    if (trimmed) keys.push(trimmed);
  }
  for (let i = 2; ; i++) {
    const k = process.env[`GEMINI_API_KEY${i}`];
    if (!k) break;
    const trimmed = k.trim();
    if (trimmed) keys.push(trimmed);
  }
  return keys;
}
const GEMINI_API_KEYS = loadGeminiKeys();
let geminiKeyIndex = 0;
function currentGeminiKey() {
  return GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length];
}
function rotateGeminiKey() {
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length;
}
const GEMINI_STT_MODEL = process.env.GEMINI_STT_MODEL || "gemini-flash-latest";
function geminiUrlFor(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}
const USE_GEMINI = GEMINI_API_KEYS.length > 0;

const GEMINI_STT_PROMPT = `Transcribe the exact words spoken in this audio clip. It is a short voice command spoken to a personal assistant named Jarvis — things like "play", "pause", "skip", "stop", "resume", "shuffle", "volume up", "volume down", "open", "close", "search", "what's the weather", "set a timer", "set a reminder", "turn off the lights", "good morning Jarvis", or a short yes/no reply.

Rules:
- Output ONLY the transcribed words, nothing else — no quotes, no labels, no punctuation commentary.
- If the clip is silence, noise, breathing, or otherwise contains no actual speech, output exactly: [EMPTY]
- Do not guess or hallucinate a generic phrase (like "thank you" or "okay") if you are not confident real words were spoken — output [EMPTY] instead.
- Transcribe in English.`;

const GEMINI_MIME_MAP = { "audio/webm": "audio/webm", "audio/wav": "audio/wav", "audio/mp4": "audio/mp4", "audio/mpeg": "audio/mpeg", "audio/ogg": "audio/ogg" };

async function geminiTranscribe(buffer, mimeType) {
  const geminiMime = GEMINI_MIME_MAP[mimeType] || "audio/webm";
  const base64Audio = buffer.toString("base64");
  const body = JSON.stringify({
    contents: [{ parts: [{ text: GEMINI_STT_PROMPT }, { inline_data: { mime_type: geminiMime, data: base64Audio } }] }],
    generationConfig: { temperature: 0 },
  });

  const attempts = GEMINI_API_KEYS.length;
  let lastError = null;

  for (let i = 0; i < attempts; i++) {
    const key = currentGeminiKey();
    let res;
    try {
      res = await fetch(`${geminiUrlFor(GEMINI_STT_MODEL)}?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e) {
      lastError = new Error(`Could not reach Gemini STT: ${e.message}`);
      rotateGeminiKey();
      continue;
    }

    if ((res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) && i < attempts - 1) {
      const errBody = await res.json().catch(() => ({}));
      lastError = new Error(`Gemini STT error ${res.status}: ${errBody.error?.message || res.statusText}`);
      rotateGeminiKey();
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Gemini STT error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    const raw = (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
    if (!raw || raw === "[EMPTY]" || raw.replace(/[.,!?]+$/g, "").trim() === "[EMPTY]") return { text: "" };
    return { text: raw };
  }

  throw lastError || new Error("All configured Gemini API keys failed for speech-to-text.");
}

// ── Groq fallback (last resort) ────────────────────────────────
const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const STT_MODEL = process.env.GROQ_STT_MODEL || "whisper-large-v3";

async function groqTranscribe(buffer, filename, mimeType) {
  if (!GroqKeys.hasGroqKey()) throw new Error("No STT provider configured — set DEEPGRAM_API_KEY (recommended), GEMINI_API_KEY, or GROQ_API_KEY in .env.");

  const totalKeys = GroqKeys.groqKeyCount();
  let lastError = null;

  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = GroqKeys.currentGroqKey();
    const keyLabel = totalKeys > 1 ? ` (key ${attempt + 1}/${totalKeys})` : "";
    const isLastKey = attempt === totalKeys - 1;

    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    form.append("model", STT_MODEL);
    form.append("response_format", "verbose_json");
    form.append("language", "en");
    form.append("temperature", "0");
    form.append("prompt", "Voice commands spoken to a personal assistant named Jarvis: play, pause, skip, stop, resume, shuffle, volume up, volume down, play the song, open, close, search, what's the weather, set a timer, set a reminder, turn off the lights, good morning Jarvis.");

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
      GroqKeys.rotateGroqKey();
      continue;
    }

    if ((res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) && !isLastKey) {
      const errBody = await res.json().catch(() => ({}));
      lastError = new Error(`Groq STT error ${res.status}${keyLabel}: ${errBody.error?.message || res.statusText}`);
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

const NO_SPEECH_PROB_MAX   = 0.5;
const AVG_LOGPROB_MIN      = -1.0;
const COMPRESSION_RATIO_MAX = 2.4;

const HALLUCINATION_PHRASES = new Set([
  "thank you", "thanks", "thanks for watching", "so",
  "bye", "you", "i'm not", "all right", "alright", ".", "",
]);

function extractRealSpeech(data) {
  const segments = Array.isArray(data.segments) ? data.segments : null;
  if (!segments || !segments.length) {
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
