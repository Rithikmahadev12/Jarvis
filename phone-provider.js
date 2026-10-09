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

const Retell = require("./retell-call");
const Bland = require("./bland-call");
const AgentPhone = require("./agentphone");
const Twilio = require("./twilio-call");

const RETELL_PREFIX = "rt_";
const BLAND_PREFIX = "bl_";
const AGENTPHONE_PREFIX = "ap_";
const TWILIO_PREFIX = "tw_";

function backendFor(callId) {
  const id = String(callId || "");
  if (id.startsWith(RETELL_PREFIX)) return Retell;
  if (id.startsWith(BLAND_PREFIX)) return Bland;
  if (id.startsWith(TWILIO_PREFIX)) return Twilio;
  return AgentPhone;
}
function stripPrefix(callId) {
  return String(callId || "").replace(/^(rt_|bl_|ap_|tw_)/, "");
}

function isConfigured() {
  return Retell.isConfigured() || Bland.isConfigured() || AgentPhone.isConfigured() || Twilio.isConfigured();
}

// Which backend is actually usable right now, for status displays
// (not used for routing existing calls — see backendFor()).
function activeBackendName() {
  if (Retell.isConfigured()) return "retell";
  if (Bland.isConfigured()) return "bland";
  if (AgentPhone.isConfigured()) return "agentphone";
  if (Twilio.isConfigured()) return "twilio";
  return null;
}

async function placeOutboundCall(opts) {
  // Order: Retell -> AgentPhone -> Twilio. Each one that's configured
  // gets a try; the first that works wins. If all fail, the LAST
  // real error is thrown (never a vague "unavailable").
  const backends = [
    { name: "Retell",     mod: Retell,     prefix: RETELL_PREFIX },
    { name: "Bland",      mod: Bland,      prefix: BLAND_PREFIX },
    { name: "AgentPhone", mod: AgentPhone, prefix: AGENTPHONE_PREFIX },
    { name: "Twilio",     mod: Twilio,     prefix: TWILIO_PREFIX },
  ].filter((b) => b.mod.isConfigured());

  if (!backends.length) {
    throw new Error(
      "No calling backend configured — set RETELL_API_KEY/RETELL_AGENT_ID/RETELL_FROM_NUMBER (retellai.com), BLAND_API_KEY (bland.ai), " +
      "AGENTPHONE_API_KEY (agentphone.ai) or TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_PHONE_NUMBER in the environment."
    );
  }

  const errors = [];
  for (let i = 0; i < backends.length; i++) {
    const b = backends[i];
    try {
      const call = await b.mod.placeOutboundCall(opts);
      return { ...call, id: `${b.prefix}${call.id}` };
    } catch (e) {
      errors.push(`${b.name}: ${e.message}`);
      const next = backends[i + 1];
      console.error(`[PHONE-PROVIDER] ${b.name} couldn't place the call (${e.message})` +
        (next ? ` — trying ${next.name}.` : " — no more backends to try."));
    }
  }
  throw new Error(errors.join(" | "));
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
