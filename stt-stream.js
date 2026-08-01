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
// while you're still speaking, and the end of an utterance is marked
// the same shape the native browser API gives the rest of jarvis.js.
//
// Accuracy notes (this is the part that actually makes it "understand
// what you're saying" instead of just "understand it fast"):
//
//   • Model: nova-3, Deepgram's current flagship — noticeably lower
//     word-error-rate than nova-2, especially on short command-style
//     utterances and in noisy rooms (relevant here since Jarvis is
//     often listening while music is playing).
//   • Keyterm prompting: nova-3 lets you bias recognition toward a
//     list of expected words/names WITHOUT retraining anything. We
//     build that list from this actual install — the wake word, the
//     owner's name, the cast device name (from config.json), plus
//     this app's real command vocabulary — instead of a generic
//     hardcoded few words.
//   • numerals=true so spoken numbers ("set a timer for ten minutes",
//     "volume to thirty") come back as digits, matching how the rest
//     of the app parses commands.
//   • Endpointing + UtteranceEnd together: plain endpointing (VAD-based)
//     is fast but can misfire when there's background noise (e.g.
//     Spotify playing through the same room the mic hears). UtteranceEnd
//     cross-checks using actual word timing gaps instead of raw audio
//     energy, and acts as a safety net so an utterance still finalizes
//     correctly even if endpointing's VAD gets confused by noise.
//   • Segment buffering: Deepgram can emit more than one is_final
//     segment before actually calling the utterance done (speech_final).
//     The old version treated every is_final message as a complete,
//     separate result, which could execute a command on a half-heard
//     fragment or fire a command twice. This version buffers is_final
//     segments and only ever calls a result "done" (and hands it to
//     jarvis.js) once speech_final or UtteranceEnd actually fires —
//     interim updates in the meantime show the accumulated confirmed
//     text plus the live tail, so it still feels instant, but what
//     lands as the final command is the whole thing, correctly joined.
//
// The Deepgram API key never reaches the browser — this proxy is the
// only thing that holds it, same as the batch /api/transcribe route.
// ═══════════════════════════════════════════════════════════════
const WebSocket = require("ws");

const DEEPGRAM_API_KEY = (process.env.DEEPGRAM_API_KEY || "").trim();
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "nova-3";
// How long Deepgram waits after speech stops before calling the
// utterance "done" (speech_final: true). This is the direct
// server-side replacement for the old 900ms client-side SILENCE_HOLD_MS —
// keep it noticeably shorter since Deepgram is watching real VAD/energy
// on a clean stream, not guessing from a coarse client-side RMS meter.
const DEEPGRAM_ENDPOINTING_MS = parseInt(process.env.DEEPGRAM_ENDPOINTING_MS, 10) || 300;
// Safety-net finalizer based on word-timing gaps rather than raw audio
// energy — catches utterances that endpointing's VAD misses (typically
// because of background noise), so a command doesn't get stuck open.
const DEEPGRAM_UTTERANCE_END_MS = parseInt(process.env.DEEPGRAM_UTTERANCE_END_MS, 10) || 1000;
const KEEPALIVE_MS = 8000; // Deepgram closes idle sockets after ~10s with no audio/keepalive

// ── Recognition-boost vocabulary ──────────────────────────────────
// nova-3 (and Flux) support "keyterm" prompting — plain terms, no
// boost-weight suffix. Older models (nova-2 etc, if someone overrides
// DEEPGRAM_MODEL) only support the older "keywords" feature, which
// does take a ":weight" suffix — so we build both shapes from one list
// and pick the right one for whatever model is actually configured.
const BASE_COMMAND_VOCAB = [
  "jarvis", "play", "pause", "resume", "stop", "skip", "next", "previous",
  "shuffle", "repeat", "volume up", "volume down", "mute", "unmute",
  "open", "close", "search", "weather", "set a timer", "set a reminder",
  "turn on the lights", "turn off the lights", "good morning", "good night",
  "cast", "screen share", "call", "message", "dashboard", "build mode",
  "map mode", "hologram", "monitor wall", "comms", "briefing", "schedule",
];

function projectKeyterms() {
  const terms = [...BASE_COMMAND_VOCAB];
  try {
    const cfg = require("./config.json");
    if (cfg?.owner?.username) terms.push(cfg.owner.username);
    if (cfg?.behaviour?.wakeWord) terms.push(cfg.behaviour.wakeWord);
    if (cfg?.castDevice) terms.push(cfg.castDevice);
  } catch (_) { /* config.json optional */ }
  // Let a deployment add more without touching code, e.g. family names,
  // custom skill/board names: DEEPGRAM_KEYTERMS="Aria,Cortex,poker night"
  const extra = (process.env.DEEPGRAM_KEYTERMS || "").split(",").map(s => s.trim()).filter(Boolean);
  return [...new Set([...terms, ...extra])];
}
const PROJECT_KEYTERMS = projectKeyterms();

function supportsKeyterm(model) {
  return /^nova-3/i.test(model) || /^flux/i.test(model);
}

function deepgramLiveUrl(sampleRate) {
  const boostParam = supportsKeyterm(DEEPGRAM_MODEL)
    ? PROJECT_KEYTERMS.map(k => `keyterm=${encodeURIComponent(k)}`).join("&")
    : PROJECT_KEYTERMS.map(k => `keywords=${encodeURIComponent(k)}`).join("&");
  const params = [
    `model=${DEEPGRAM_MODEL}`,
    "language=en",
    "punctuate=true",
    "smart_format=true",
    "numerals=true",
    "interim_results=true",
    "vad_events=true",
    `endpointing=${DEEPGRAM_ENDPOINTING_MS}`,
    `utterance_end_ms=${DEEPGRAM_UTTERANCE_END_MS}`,
    "encoding=linear16",
    `sample_rate=${sampleRate}`,
    "channels=1",
    boostParam,
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

    // Segment buffering for one in-progress utterance — see the big
    // comment at the top of this file for why this exists.
    let confirmedSegments = [];
    const confirmedSoFar = () => confirmedSegments.join(" ").trim();

    function flushUtterance() {
      const text = confirmedSoFar();
      confirmedSegments = [];
      if (text && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "final", text }));
      }
    }

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

      // Instant barge-in signal — fires the moment Deepgram's VAD sees
      // speech start, before any words have actually been recognized.
      // Faster than waiting on the first interim transcript.
      if (msg.type === "SpeechStarted") {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ type: "speech_started" }));
        return;
      }

      // Word-timing-based safety net: fires when Deepgram notices a long
      // gap since the last word even if raw-audio endpointing (which can
      // get confused by background noise) never triggered speech_final.
      if (msg.type === "UtteranceEnd") {
        flushUtterance();
        return;
      }

      if (msg.type !== "Results") return;
      const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
      const text = ((alt && alt.transcript) || "").trim();

      if (msg.is_final) {
        if (text) confirmedSegments.push(text);
        if (msg.speech_final) {
          flushUtterance();
        } else {
          // Segment finalized, but the speaker hasn't paused yet — show
          // the growing, stabilized transcript so far as an interim.
          const soFar = confirmedSoFar();
          if (soFar && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ type: "interim", text: soFar }));
          }
        }
        return;
      }

      // Plain interim (is_final: false): confirmed prefix + live tail.
      if (!text) return;
      const combined = [confirmedSoFar(), text].filter(Boolean).join(" ");
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: "interim", text: combined }));
      }
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
      flushUtterance();
      teardown();
    });

    clientWs.on("error", teardown);
  });

  console.log(`[STT-STREAM] Deepgram live-streaming proxy attached at /ws/stt (model=${DEEPGRAM_MODEL}, ${PROJECT_KEYTERMS.length} boost terms)${DEEPGRAM_API_KEY ? "" : " — no DEEPGRAM_API_KEY set, clients will fall back to batch mode"}`);
  return wss;
};
