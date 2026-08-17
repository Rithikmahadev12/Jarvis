"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — AgentPhone Webhook Voice Routes v1.0
//
// The webhook half of agentphone.js's webhook mode. When
// placeOutboundCall() there places a call WITHOUT a systemPrompt
// (see that file's isWebhookModeAvailable()), AgentPhone stops
// running its own hosted LLM for that call and instead POSTs every
// turn to the route below, waiting for us to say what Jarvis says
// next. That's the actual fix for the original bug: instead of
// hoping AgentPhone's hosted model keeps following a system prompt
// for an entire live call (it didn't — see phone-agent.js's
// buildSystemPrompt header for the full story), Jarvis's own Groq
// call decides every single line, using those exact same tightened
// instructions ("ask the question immediately, don't treat 'okay'
// as an answer, don't hang up early"). Same idea the Twilio fallback
// already used (twilio-voice-routes.js) — this brings the AgentPhone
// path up to the same standard.
//
// Falls back to AgentPhone's hosted mode automatically when Jarvis
// has no public URL to receive this webhook at (see agentphone.js) —
// this route just never gets hit in that case, nothing to configure.
//
// INBOUND CALLS TOO: registering this webhook flips the agent's
// voiceMode to "webhook" account-wide (see agentphone.js's
// ensureWebhookForAccount) — a real test call proved that omitting
// systemPrompt on the outbound call alone wasn't enough to actually
// route to this endpoint, it just silently fell back to hosted mode.
// Since voiceMode is agent-wide, not per-call, INBOUND calls (someone
// dialing Jarvis's number) land here too now, not just the outbound
// calls phone-agent.js places. Any call with no pre-registered record
// below is treated as inbound and driven using the exact same
// name-matching conversation inbound-agent.js used to hand to
// AgentPhone's hosted LLM (buildInboundSystemPrompt()) — same fix,
// same reasoning, just for the other call direction.
//
// ── SECURITY ───────────────────────────────────────────────────
// Every delivery is HMAC-signed (X-Webhook-Signature / X-Webhook-
// Timestamp) with the secret AgentPhone handed back when
// agentphone.js registered this webhook. Verified below BEFORE the
// body is parsed as JSON. That requires the raw, exact request
// bytes AgentPhone signed — so this route MUST be mounted in
// server.js before the global app.use(express.json()) call, with
// its own express.raw() parser scoped to just this path. See the
// comment at the mount site in server.js. Mounting it after that
// line will make every signature check fail (the raw body will
// already have been consumed by the global JSON parser).
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");
const express = require("express");
const AgentPhone = require("./agentphone");
const GroqKeys = require("./groq-keys");
const InboundAgent = require("./inbound-agent");
const Settings = require("./settings");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_AGENT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

// Groq puts this exact token at the end of its reply once (and only
// once) the call should wrap up — mirrors twilio-voice-routes.js.
const WRAP_UP_MARKER = "[[END_CALL]]";

const MAX_TURNS = 12; // hard stop so a stuck/looping conversation can't run forever on a paid per-minute line

// ── SIGNATURE VERIFICATION ────────────────────────────────────────
function verifySignature(rawBody, signature, timestamp, secret) {
  // No secret on file yet (e.g. webhook was never successfully
  // registered) — don't hard-block AgentPhone's delivery over it,
  // but this gets logged loudly at the call site below so it's not
  // silently insecure forever.
  if (!secret) return true;
  if (!signature || !timestamp) return false;
  if (Math.abs(Date.now() / 1000 - parseInt(timestamp, 10)) > 300) return false; // reject >5min old (replay protection)

  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedHeader = `sha256=${expected}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expectedHeader), Buffer.from(String(signature)));
  } catch {
    return false; // length mismatch etc. — definitely not a match
  }
}

// ── ASK GROQ FOR THE NEXT LINE ────────────────────────────────────
// Same shape as twilio-voice-routes.js's askGroqForNextLine — kept as
// its own copy here rather than shared, since the two files answer to
// different transport shapes (TwiML vs JSON) and have no other reason
// to depend on each other.
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
    console.error(`[AGENTPHONE-WEBHOOK] Groq request failed${lastError ? `: ${lastError.message}` : ""} — ending call gracefully.`);
    return { text: "Sorry, I'm having trouble right now — I'll have someone follow up. Goodbye.", done: true };
  }

  const data = await res.json().catch((e) => {
    console.error(`[AGENTPHONE-WEBHOOK] Groq returned a response that wasn't valid JSON: ${e.message}`);
    return null;
  });
  if (!data) return { text: "Sorry, I'm having trouble right now — I'll have someone follow up. Goodbye.", done: true };
  let raw = (data.choices?.[0]?.message?.content || "").trim();
  const done = raw.includes(WRAP_UP_MARKER);
  if (done) raw = raw.replace(WRAP_UP_MARKER, "").trim();
  return { text: raw || "Thanks for your time — goodbye.", done };
}

function mount(app) {
  app.post(
    "/agentphone/webhook",
    express.raw({ type: "*/*", limit: "2mb" }), // raw bytes, not parsed JSON — needed for signature verification
    async (req, res) => {
      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      let payload;
      try {
        payload = rawBody ? JSON.parse(rawBody) : {};
      } catch {
        res.sendStatus(400);
        return;
      }

      const secret = AgentPhone.getWebhookSecretByAgentId(payload.agentId);
      if (!secret) console.warn(`[AGENTPHONE-WEBHOOK] No webhook secret on file for agentId ${payload.agentId} yet — accepting unverified (this should self-resolve after the next call places).`);
      const signed = verifySignature(rawBody, req.headers["x-webhook-signature"], req.headers["x-webhook-timestamp"], secret);
      if (!signed) {
        console.error("[AGENTPHONE-WEBHOOK] Rejected a delivery with an invalid or missing signature.");
        res.sendStatus(401);
        return;
      }

      // Fire-and-forget per AgentPhone's docs — no response body
      // expected. _runCall() in phone-agent.js still gets the
      // authoritative transcript/outcome by polling GET /calls, not
      // from this event — this is just cleanup of our turn-state Map.
      if (payload.event === "agent.call_ended") {
        if (payload.data && payload.data.callId) AgentPhone.deleteWebhookCall(payload.data.callId);
        res.sendStatus(200);
        return;
      }

      if (payload.event === "agent.message" && payload.channel === "voice") {
        const data = payload.data || {};
        let rec = AgentPhone.getWebhookCall(data.callId);

        if (!rec) {
          // No pre-registered record used to mean "assume INBOUND"
          // unconditionally and run the name-matching script — which
          // can end in "sorry, wrong number" being said to whoever
          // Jarvis itself just called. That's exactly the bug being
          // chased: a real test call proved a registration/sync gap
          // (not an actual wrong number) can make an OUTBOUND call
          // fall through here too, and the old code had no way to
          // tell the two situations apart, so it guessed wrong.
          //
          // Ask AgentPhone directly which direction this call really
          // was before saying anything. This costs one extra API call
          // only on the rare path where a lookup already missed —
          // normal calls with a working registration never hit it.
          console.warn(`[AGENTPHONE-WEBHOOK] No registered turn-state for callId ${data.callId} — checking AgentPhone directly for this call's real direction before assuming inbound.`);
          const direction = await AgentPhone.getCallDirectionSafe(data.callId).catch(() => null);

          if (direction === "outbound") {
            // Confirmed: this is a call Jarvis placed itself, and the
            // registration lookup is failing for a real reason
            // (older deployed code, a Persistence/Supabase sync gap,
            // a mid-call restart, or a genuine callId mismatch) — not
            // a wrong number. Never let it say "wrong number" to the
            // actual intended recipient. Log this loudly (it always
            // means a real bug worth investigating) and end the call
            // gracefully instead of guessing at a script we don't
            // have the real context for.
            console.error(`[AGENTPHONE-WEBHOOK] ⚠ CONFIRMED BUG: callId ${data.callId} is a real OUTBOUND call with no registered turn-state. Check Render logs around this call's start time for a "Process (re)started" line (mid-call restart) or a Supabase push failure — this is NOT a wrong number.`);
            res.json({
              text: "Sorry, I'm having a technical issue on my end — I'll have someone follow up. Thank you, goodbye.",
              hangup: true,
            });
            return;
          }

          if (direction !== "inbound") {
            // Couldn't confirm either way (API call failed, unknown
            // account, etc.) — safest is still not to accuse a real
            // person of being a wrong number on a guess. Give a
            // neutral, non-committal line and end politely rather
            // than run the inbound script against possibly-outbound
            // context.
            console.error(`[AGENTPHONE-WEBHOOK] ⚠ Could not confirm direction for callId ${data.callId} (AgentPhone lookup failed too) — treating cautiously instead of guessing inbound.`);
            res.json({
              text: "Sorry, I'm having a technical issue on my end — I'll have someone follow up. Thank you, goodbye.",
              hangup: true,
            });
            return;
          }

          // Confirmed genuinely inbound (someone dialing Jarvis's
          // number) — this is the correct, expected path for a call
          // with no pre-registered record, since inbound calls are
          // never registered ahead of time. Build the same
          // name-matching inbound conversation inbound-agent.js used
          // to hand to AgentPhone's hosted LLM, and drive it with our
          // own Groq call instead — same fix, same reasoning, just
          // for this call direction.
          try {
            const users = InboundAgent.loadUsers();
            const ownerName = InboundAgent.defaultOwnerName();
            const numberCode = (Settings.load().numberCode || "").toString().trim() || null;
            rec = {
              ownerName,
              systemPrompt: InboundAgent.buildInboundSystemPrompt(users, numberCode),
              history: [],
              turns: 0,
              createdAt: Date.now(),
            };
            AgentPhone.registerWebhookCall(data.callId, rec);
          } catch (e) {
            console.error(`[AGENTPHONE-WEBHOOK] Could not build an inbound prompt for callId ${data.callId}: ${e.message}`);
            res.json({ text: "Hi, this is Jarvis — one moment please." });
            return;
          }
        }

        const said = String(data.transcript || "").trim();
        if (said) rec.history.push({ role: "user", text: said });

        if (rec.turns >= MAX_TURNS) {
          const bye = "I've taken up enough of your time — thank you, goodbye.";
          rec.history.push({ role: "assistant", text: bye });
          AgentPhone.updateWebhookCall(data.callId, rec);
          res.json({ text: bye, hangup: true });
          return;
        }

        const next = await askGroqForNextLine(rec);
        rec.history.push({ role: "assistant", text: next.text });
        rec.turns += 1;
        AgentPhone.updateWebhookCall(data.callId, rec);

        res.json({ text: next.text, hangup: !!next.done });
        return;
      }

      // Any other event (sms/imessage/reaction on the same per-agent
      // webhook, etc.) — acknowledge, nothing for this file to do.
      res.sendStatus(200);
    }
  );
}

module.exports = { mount };
