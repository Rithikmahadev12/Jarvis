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
    form.append("response_format", "json");
    form.append("language", "en");

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
    return { text: (data.text || "").trim() };
  }

  throw lastError || new Error("All configured Groq API keys failed for speech-to-text.");
}

module.exports = { transcribe };
