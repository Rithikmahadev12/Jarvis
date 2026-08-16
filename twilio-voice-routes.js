"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Twilio Voice Webhooks v1.0
//
// The other half of twilio-call.js. Twilio hits these three routes
// as a real call happens; this file is what actually holds the
// conversation, turn by turn:
//
//   POST /twilio/voice/:token   — call just connected. Say the
//     opening line (initialGreeting, or ask Groq for one from the
//     systemPrompt if none was given), then <Gather> the other
//     person's reply using Twilio's own speech-to-text.
//   POST /twilio/gather/:token  — Twilio POSTs SpeechResult here
//     after each thing the other person says. Ask Groq for the next
//     line (systemPrompt + running history), speak it back, and
//     <Gather> again — unless Groq's reply signals the call is done
//     (see WRAP_UP_MARKER below), in which case say it and hang up.
//   POST /twilio/status/:token  — Twilio's call-status callback.
//     Marks the shared call record completed/failed and builds the
//     final transcript string, which is what getCall()/
//     waitForCallCompletion() in twilio-call.js hand back to
//     phone-agent.js.
//
// All three read/write the exact same `calls` Map exported from
// twilio-call.js — nothing here talks to Twilio's REST API directly,
// only responds with TwiML (plain XML Twilio's phone-call runtime
// interprets, not a data API response).
//
// NOTE ON AUDIO QUALITY: this uses Twilio's own <Gather input="speech">
// and <Say> — real speech recognition and text-to-speech, but Twilio's
// built-in voices/recognition, not Jarvis's own tts.js/stt.js (Camb.ai
// / Deepgram) which are tuned for a browser mic, not a phone line's
// 8kHz audio. That's a deliberate tradeoff: it needs no audio-format
// bridging or extra infra to work, at the cost of sounding like a
// standard phone-tree voice rather than Jarvis's normal one.
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const { calls } = require("./twilio-call");
const GroqKeys = require("./groq-keys");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_AGENT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

// Groq is told to put this exact token at the very end of its reply
// once (and only once) the call should wrap up, so this file knows
// to hang up after speaking that line instead of listening again.
const WRAP_UP_MARKER = "[[END_CALL]]";

const MAX_TURNS = 12; // hard stop so a stuck/looping conversation can't run forever on a paid per-minute line

function xmlEscape(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function twiml(body) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${body}</Response>`;
}

function sayAndGather(rec, text, gatherActionUrl) {
  const say = `<Say voice="${xmlEscape(rec.voice)}">${xmlEscape(text)}</Say>`;
  const gather =
    `<Gather input="speech" action="${gatherActionUrl}" method="POST" speechTimeout="auto" timeout="6">` +
    `</Gather>`;
  // If Gather times out with nobody saying anything, Twilio just
  // moves to the next verb — repeat the prompt once, then hang up,
  // rather than looping silently forever.
  const fallbackHangup = `<Say voice="${xmlEscape(rec.voice)}">I didn't catch that — I'll follow up another way. Goodbye.</Say><Hangup/>`;
  return twiml(say + gather + fallbackHangup);
}

async function askGroqForNextLine(rec) {
  if (!GroqKeys.hasGroqKey()) {
    return { text: "Sorry, I'm having trouble right now — I'll have someone follow up. Goodbye.", done: true };
  }

  const messages = [
    {
      role: "system",
      content:
        `${rec.systemPrompt}\n\n` +
        `You are speaking on a live phone call on behalf of ${rec.ownerName}, over a real phone line. ` +
        `Keep every reply short (1-3 sentences) and natural to SAY out loud, not read. ` +
        `When the call's purpose is fully accomplished (or the other person clearly wants to end it), ` +
        `say a brief goodbye and end your reply with the exact text ${WRAP_UP_MARKER} on its own, with nothing after it.`,
    },
    ...rec.history.map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: h.text })),
  ];

  const doFetch = (key) =>
    fetch(GROQ_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.4, messages }),
      signal: AbortSignal.timeout(20000),
    });

  const totalKeys = GroqKeys.groqKeyCount();
  let res, lastError = null;
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = GroqKeys.currentGroqKey();
    const isLastKey = attempt === totalKeys - 1;
    try {
      res = await doFetch(key);
    } catch (e) {
      lastError = e;
      if (isLastKey) break;
      GroqKeys.rotateGroqKey();
      continue;
    }
    if (!res.ok && (res.status === 429 || res.status >= 500) && !isLastKey) {
      GroqKeys.rotateGroqKey();
      continue;
    }
    break;
  }

  if (!res || !res.ok) {
    console.error(`[TWILIO-VOICE] Groq request failed${lastError ? `: ${lastError.message}` : ""} — ending call gracefully.`);
    return { text: "Sorry, I'm having trouble right now — I'll have someone follow up. Goodbye.", done: true };
  }

  const data = await res.json();
  let raw = (data.choices?.[0]?.message?.content || "").trim();
  const done = raw.includes(WRAP_UP_MARKER);
  if (done) raw = raw.replace(WRAP_UP_MARKER, "").trim();
  return { text: raw || "Thanks for your time — goodbye.", done };
}

function buildTranscript(rec) {
  return rec.history.map((h) => `${h.role === "assistant" ? rec.ownerName + "'s assistant" : "Them"}: ${h.text}`).join("\n");
}

function mount(app) {
  const urlencoded = express.urlencoded({ extended: false });

  // ── Call just connected ─────────────────────────────────────────
  app.post("/twilio/voice/:token", urlencoded, async (req, res) => {
    const rec = calls.get(req.params.token);
    if (!rec) {
      res.type("text/xml").send(twiml(`<Say>Sorry, this call session has expired.</Say><Hangup/>`));
      return;
    }
    rec.status = "in-progress";

    let opening = rec.initialGreeting;
    if (!opening) {
      const first = await askGroqForNextLine(rec);
      opening = first.text;
    }
    rec.history.push({ role: "assistant", text: opening });
    rec.turns += 1;

    res.type("text/xml").send(sayAndGather(rec, opening, `/twilio/gather/${req.params.token}`));
  });

  // ── Other person just said something ────────────────────────────
  app.post("/twilio/gather/:token", urlencoded, async (req, res) => {
    const rec = calls.get(req.params.token);
    if (!rec) {
      res.type("text/xml").send(twiml(`<Say>Sorry, this call session has expired.</Say><Hangup/>`));
      return;
    }

    const said = String(req.body.SpeechResult || "").trim();
    if (said) rec.history.push({ role: "user", text: said });

    if (rec.turns >= MAX_TURNS) {
      const bye = "I've taken up enough of your time — thank you, goodbye.";
      rec.history.push({ role: "assistant", text: bye });
      rec.transcript = buildTranscript(rec);
      res.type("text/xml").send(twiml(`<Say voice="${xmlEscape(rec.voice)}">${xmlEscape(bye)}</Say><Hangup/>`));
      return;
    }

    const next = await askGroqForNextLine(rec);
    rec.history.push({ role: "assistant", text: next.text });
    rec.turns += 1;
    rec.transcript = buildTranscript(rec);

    if (next.done) {
      res.type("text/xml").send(twiml(`<Say voice="${xmlEscape(rec.voice)}">${xmlEscape(next.text)}</Say><Hangup/>`));
      return;
    }

    res.type("text/xml").send(sayAndGather(rec, next.text, `/twilio/gather/${req.params.token}`));
  });

  // ── Twilio's final call-status callback ─────────────────────────
  app.post("/twilio/status/:token", urlencoded, (req, res) => {
    const rec = calls.get(req.params.token);
    if (rec) {
      const callStatus = String(req.body.CallStatus || "");
      rec.status = callStatus === "completed" ? "completed" : (callStatus ? "failed" : rec.status);
      rec.transcript = buildTranscript(rec);
    }
    res.sendStatus(200);
  });
}

module.exports = { mount };
