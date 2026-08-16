"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Phone Provider v1.0 (AgentPhone primary, Twilio fallback)
//
// The single entry point phone-agent.js calls to place/poll outbound
// PSTN calls. AgentPhone (agentphone.js) is tried first — it already
// has its own multi-account failover internally (see that file). If
// AgentPhone isn't configured at all, OR every AgentPhone account it
// has is exhausted/dead, this falls back to Twilio (twilio-call.js)
// instead of failing the call outright. Same idea as AgentPhone's own
// account failover, one level up, across providers instead of across
// accounts on one provider.
//
// Both backends export the same shape (placeOutboundCall/getCall/
// waitForCallCompletion), so this file is mostly "try AgentPhone,
// catch, try Twilio" plus routing getCall/waitForCallCompletion to
// whichever backend actually placed a given call — done by prefixing
// the call id this file hands back to phone-agent.js, so that still
// works correctly even hours later / after a restart.
//
// Swap phone-agent.js's `require("./textnow-call")` for
// `require("./phone-provider")` to switch back to real, legitimate
// phone calling instead of the TextNow browser-automation path.
// ═══════════════════════════════════════════════════════════════

const AgentPhone = require("./agentphone");
const Twilio = require("./twilio-call");

const AGENTPHONE_PREFIX = "ap_";
const TWILIO_PREFIX = "tw_";

function backendFor(callId) {
  return String(callId || "").startsWith(TWILIO_PREFIX) ? Twilio : AgentPhone;
}
function stripPrefix(callId) {
  return String(callId || "").replace(/^(ap_|tw_)/, "");
}

function isConfigured() {
  return AgentPhone.isConfigured() || Twilio.isConfigured();
}

// Which backend is actually usable right now, for status displays
// (not used for routing existing calls — see backendFor()).
function activeBackendName() {
  if (AgentPhone.isConfigured()) return "agentphone";
  if (Twilio.isConfigured()) return "twilio";
  return null;
}

async function placeOutboundCall(opts) {
  if (AgentPhone.isConfigured()) {
    try {
      const call = await AgentPhone.placeOutboundCall(opts);
      return { ...call, id: `${AGENTPHONE_PREFIX}${call.id}` };
    } catch (e) {
      console.error(`[PHONE-PROVIDER] AgentPhone couldn't place the call (${e.message})` +
        (Twilio.isConfigured() ? " — falling back to Twilio." : " — and no Twilio fallback is configured, so this call is failing."));
      if (!Twilio.isConfigured()) throw e;
    }
  } else if (!Twilio.isConfigured()) {
    throw new Error(
      "No calling backend configured — set AGENTPHONE_API_KEY (agentphone.ai) or TWILIO_ACCOUNT_SID/" +
      "TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER (twilio.com) in .env."
    );
  }

  const call = await Twilio.placeOutboundCall(opts);
  return { ...call, id: `${TWILIO_PREFIX}${call.id}` };
}

async function getCall(callId) {
  const backend = backendFor(callId);
  const call = await backend.getCall(stripPrefix(callId));
  return { ...call, id: callId };
}

async function waitForCallCompletion(callId, opts) {
  const backend = backendFor(callId);
  const call = await backend.waitForCallCompletion(stripPrefix(callId), opts);
  return { ...call, id: callId };
}

// Only AgentPhone has an intra-provider account-switch notice today
// (see agentphone.js) — Twilio fallback is a single account, nothing
// to announce a switch between.
function consumeSwitchNotice() {
  return AgentPhone.consumeSwitchNotice ? AgentPhone.consumeSwitchNotice() : null;
}

module.exports = {
  isConfigured,
  activeBackendName,
  placeOutboundCall,
  getCall,
  waitForCallCompletion,
  consumeSwitchNotice,
};
