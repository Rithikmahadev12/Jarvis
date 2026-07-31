"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Speech-to-text (LIVE STREAMING, server side)
//
// Why this exists: stt.js's /api/transcribe route is a "batch" flow —
// record a clip, wait for silence, upload the whole thing, wait for
// the reply. That's what made the desktop app feel slow next to the
// website's native webkitSpeechRecognition, which streams words back
// live while you're still talking.
//
// This module closes that gap using Deepgram's live (WebSocket)
// endpoint instead of its REST one. The browser opens a WebSocket to
// US at /ws/stt and streams raw PCM continuously; for every client we
// open a second WebSocket upstream to Deepgram and pipe audio one way
// and transcripts the other. Deepgram does its own endpointing
// (silence detection) server-side, so the 900ms client-side VAD hold
// that used to gate every utterance is gone — interim words come back
// while you're still speaking, and a "speech_final" event marks the
// end of an utterance, the same shape the native browser API gives
// the rest of jarvis.js.
//
// The Deepgram API key never reaches the browser — this proxy is the
// only thing that holds it, same as the batch /api/transcribe route.
// ═══════════════════════════════════════════════════════════════
const WebSocket = require("ws");

const DEEPGRAM_API_KEY = (process.env.DEEPGRAM_API_KEY || "").trim();
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-2";
// How long Deepgram waits after speech stops before calling the
// utterance "done" (speech_final: true). This is the direct
// server-side replacement for the old 900ms client-side SILENCE_HOLD_MS —
// keep it noticeably shorter since Deepgram is watching real VAD/energy
// on a clean stream, not guessing from a coarse client-side RMS meter.
const DEEPGRAM_ENDPOINTING_MS = parseInt(process.env.DEEPGRAM_ENDPOINTING_MS, 10) || 300;
const KEEPALIVE_MS = 8000; // Deepgram closes idle sockets after ~10s with no audio/keepalive

function deepgramLiveUrl(sampleRate) {
  // keywords: same recognition boost the batch endpoint uses for this
  // project's command vocabulary and wake word.
  const keywords = ["jarvis:2", "shuffle:1", "resume:1"].map(k => `keywords=${encodeURIComponent(k)}`).join("&");
  const params = [
    `model=${DEEPGRAM_MODEL}`,
    "language=en",
    "punctuate=true",
    "smart_format=true",
    "interim_results=true",
    `endpointing=${DEEPGRAM_ENDPOINTING_MS}`,
    "encoding=linear16",
    `sample_rate=${sampleRate}`,
    "channels=1",
    keywords,
  ];
  return `wss://api.deepgram.com/v1/listen?${params.join("&")}`;
}

function safeSampleRate(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 8000 || n > 48000) return 16000;
  return n;
}

module.exports = function attachSttStream(server) {
  const wss = new WebSocket.Server({ server, path: "/ws/stt" });

  wss.on("connection", (clientWs, req) => {
    if (!DEEPGRAM_API_KEY) {
      // No streaming provider configured — tell the client to fall back
      // to the batch /api/transcribe pipeline instead of hanging.
      clientWs.close(4001, "no-streaming-provider-configured");
      return;
    }

    let sampleRate = 16000;
    try {
      const url = new URL(req.url, "http://localhost");
      sampleRate = safeSampleRate(url.searchParams.get("sampleRate"));
    } catch (_) { /* keep default */ }

    let dgWs;
    try {
      dgWs = new WebSocket(deepgramLiveUrl(sampleRate), { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
    } catch (e) {
      console.warn("[stt-stream] Could not open Deepgram live socket:", e.message);
      clientWs.close(4002, "upstream-connect-failed");
      return;
    }

    let dgOpen = false;
    let closed = false;
    // Audio that arrives from the browser before the upstream Deepgram
    // socket has finished opening — buffer it briefly rather than drop it,
    // so the very first word of an utterance doesn't get clipped.
    const pending = [];

    const keepAliveTimer = setInterval(() => {
      if (dgOpen && dgWs.readyState === WebSocket.OPEN) {
        try { dgWs.send(JSON.stringify({ type: "KeepAlive" })); } catch (_) {}
      }
    }, KEEPALIVE_MS);

    function teardown() {
      if (closed) return;
      closed = true;
      clearInterval(keepAliveTimer);
      try { if (dgWs.readyState === WebSocket.OPEN || dgWs.readyState === WebSocket.CONNECTING) dgWs.close(); } catch (_) {}
      try { if (clientWs.readyState === WebSocket.OPEN) clientWs.close(); } catch (_) {}
    }

    dgWs.on("open", () => {
      dgOpen = true;
      for (const frame of pending) { try { dgWs.send(frame); } catch (_) {} }
      pending.length = 0;
    });

    dgWs.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type !== "Results") return;
      const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
      const text = ((alt && alt.transcript) || "").trim();
      if (!text) return;
      const payload = JSON.stringify({ type: msg.speech_final ? "final" : "interim", text });
      if (clientWs.readyState === WebSocket.OPEN) clientWs.send(payload);
    });

    dgWs.on("error", (e) => {
      console.warn("[stt-stream] Deepgram socket error:", e.message);
      teardown();
    });

    dgWs.on("close", teardown);

    clientWs.on("message", (data, isBinary) => {
      if (!isBinary || closed) return; // ignore stray JSON/text frames
      if (dgOpen && dgWs.readyState === WebSocket.OPEN) dgWs.send(data);
      else pending.push(data);
    });

    clientWs.on("close", () => {
      if (closed) return;
      // Tell Deepgram the stream is done so it flushes a final result
      // instead of just dying mid-utterance.
      try { if (dgWs.readyState === WebSocket.OPEN) dgWs.send(JSON.stringify({ type: "CloseStream" })); } catch (_) {}
      teardown();
    });

    clientWs.on("error", teardown);
  });

  console.log(`[STT-STREAM] Deepgram live-streaming proxy attached at /ws/stt${DEEPGRAM_API_KEY ? "" : " (no DEEPGRAM_API_KEY set — clients will fall back to batch mode)"}`);
  return wss;
};
