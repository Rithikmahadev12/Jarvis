"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Twilio Call Client v1.0 (fallback PSTN backend)
//
// Used by phone-provider.js ONLY when AgentPhone (agentphone.js)
// isn't configured, or every configured AgentPhone account has
// failed. Same exported shape as agentphone.js (placeOutboundCall/
// getCall/waitForCallCompletion) so phone-provider.js can treat the
// two backends interchangeably.
//
// ── WHY THIS ISN'T JUST "AGENTPHONE BUT TWILIO" ──────────────────
// AgentPhone's "hosted" mode hands their own LLM a systemPrompt and
// gets a finished conversation back with nothing else required.
// Twilio has no equivalent — it only gives you raw call control
// (TwiML) plus its own speech-to-text/text-to-speech at the edge.
// So THIS file only places the call and polls its outcome; the
// actual turn-by-turn conversation (what Twilio hears -> what Groq
// decides to say back) is driven by twilio-voice-routes.js, which
// Twilio calls into over plain HTTPS webhooks as the call happens.
// The two files share the same in-memory `calls` Map (exported
// below) so they're always looking at the same call record.
//
// ── COST, HONESTLY ────────────────────────────────────────────
// Same story as AgentPhone: Twilio is a paid, metered PSTN provider
// (number rental + per-minute usage + a small speech-recognition fee
// on every turn). Free trial credit is enough to test this; there is
// no free-forever way to place a real outbound phone call to a real
// number. See TWILIO_ACCOUNT_SID's .env comment for setup.
//
// ── REQUIRES A PUBLIC HTTPS URL ───────────────────────────────────
// Twilio calls INTO Jarvis twice per call — once for the TwiML script
// and once per turn for the transcript — so this only works when
// Jarvis is reachable from the internet. Defaults to STORE_BASE_URL
// (already set for the deployed Render instance); set PUBLIC_BASE_URL
// explicitly if you want Twilio calling to point somewhere else. This
// will NOT work if Jarvis is only running locally with no public URL
// — placeOutboundCall() throws a clear error instead of silently
// failing if neither is set.
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");

const API_BASE = "https://api.twilio.com/2010-04-01";

function accountSid()   { return String(process.env.TWILIO_ACCOUNT_SID || "").trim(); }
function authToken()    { return String(process.env.TWILIO_AUTH_TOKEN || "").trim(); }
function fromNumber()   { return String(process.env.TWILIO_PHONE_NUMBER || "").trim(); }
function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.STORE_BASE_URL || "").trim().replace(/\/+$/, "");
}

function isConfigured() {
  return !!(accountSid() && authToken() && fromNumber());
}

function authHeader() {
  return "Basic " + Buffer.from(`${accountSid()}:${authToken()}`).toString("base64");
}

// ── SHARED IN-MEMORY CALL STATE ───────────────────────────────────
// Keyed by our own random token, not the Twilio Call SID (we don't
// have that yet when the call record is first created). Exported so
// twilio-voice-routes.js reads/writes the exact same records as the
// call progresses. In-memory only — lost on restart, same tradeoff
// AgentPhone accepts for in-flight polling; this isn't meant as
// permanent call history.
const calls = new Map();

function newToken() {
  return crypto.randomBytes(12).toString("hex");
}

async function twilioRequest(pathSuffix, params) {
  const body = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/Accounts/${accountSid()}${pathSuffix}`, {
    method: "POST",
    headers: {
      "Authorization": authHeader(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }
  if (!res.ok) {
    const msg = (json && (json.message || json.detail)) || text || `HTTP ${res.status}`;
    throw new Error(`Twilio request failed (${res.status}): ${msg}`);
  }
  return json;
}

// ── PLACE AN OUTBOUND CALL ────────────────────────────────────────
// Creates our own call record first (so the webhook has something to
// read the instant Twilio hits it, which can happen within a second
// of this call returning), then tells Twilio to dial and to fetch
// its script from OUR /twilio/voice/:token endpoint.
async function placeOutboundCall({ toNumber, systemPrompt, initialGreeting, voice, ownerName }) {
  if (!isConfigured()) {
    throw new Error(
      "Twilio not configured — set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER in .env " +
      "(console.twilio.com after signing up)."
    );
  }
  if (!toNumber) throw new Error("placeOutboundCall requires toNumber");
  if (!systemPrompt) throw new Error("placeOutboundCall requires systemPrompt");
  if (!publicBaseUrl()) {
    throw new Error(
      "Twilio calling needs a public HTTPS URL to call back into — set PUBLIC_BASE_URL (or STORE_BASE_URL) in " +
      ".env. It can't reach a Jarvis that's only running on your own PC with no public address."
    );
  }

  const token = newToken();
  calls.set(token, {
    token,
    toNumber,
    systemPrompt,
    initialGreeting: initialGreeting || null,
    voice: voice || "Polly.Matthew",
    ownerName: ownerName || "my owner",
    history: [],           // [{role:"assistant"|"user", text}]
    status: "queued",
    transcript: "",
    twilioSid: null,
    turns: 0,
    createdAt: Date.now(),
  });

  let twilioCall;
  try {
    twilioCall = await twilioRequest("/Calls.json", {
      To: toNumber,
      From: fromNumber(),
      Url: `${publicBaseUrl()}/twilio/voice/${token}`,
      Method: "POST",
      StatusCallback: `${publicBaseUrl()}/twilio/status/${token}`,
      StatusCallbackEvent: "completed",
      StatusCallbackMethod: "POST",
    });
  } catch (e) {
    calls.delete(token);
    throw e;
  }

  const rec = calls.get(token);
  rec.twilioSid = twilioCall.sid;
  rec.status = twilioCall.status || "queued";

  return { id: token, status: rec.status, twilioSid: twilioCall.sid };
}

async function getCall(token) {
  const rec = calls.get(token);
  if (!rec) throw new Error(`Unknown Twilio call token: ${token}`);

  // Best-effort cross-check against Twilio directly, in case our own
  // /twilio/status webhook got missed (e.g. a deploy restarted the
  // server mid-call, or the callback simply didn't arrive).
  if (rec.twilioSid && rec.status !== "completed" && rec.status !== "failed") {
    try {
      const res = await fetch(`${API_BASE}/Accounts/${accountSid()}/Calls/${rec.twilioSid}.json`, {
        headers: { "Authorization": authHeader() },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const json = await res.json();
        if (["completed"].includes(json.status)) rec.status = "completed";
        else if (["busy", "failed", "no-answer", "canceled"].includes(json.status)) rec.status = "failed";
      }
    } catch {
      // Best-effort only — the in-memory status still stands.
    }
  }

  return {
    id: token,
    status: rec.status,
    toNumber: rec.toNumber,
    transcript: rec.transcript,
  };
}

async function waitForCallCompletion(token, { pollMs = 4000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const call = await getCall(token);
    if (call.status === "completed" || call.status === "failed") return call;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for Twilio call ${token} to finish (still ${(await getCall(token)).status} after ${timeoutMs / 1000}s)`);
}

module.exports = {
  isConfigured,
  placeOutboundCall,
  getCall,
  waitForCallCompletion,
  calls, // shared with twilio-voice-routes.js — same records, both files
};
