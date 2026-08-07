"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — AgentPhone Client v1.0
//
// Thin wrapper around the AgentPhone API (https://agentphone.ai —
// YC-backed, api.agentphone.ai/v1). This is what gives Jarvis an
// actual real phone number that can dial real businesses over the
// real phone network (PSTN) — completely separate from call-voice.js
// / teams-control.js, which only ever talked to Microsoft Teams.
//
// ── COST, HONESTLY ────────────────────────────────────────────
// This is a paid, metered API (number rental + per-minute usage).
// There is no such thing as free-forever real telephone calling —
// see the .env comment above AGENTPHONE_API_KEY for the numbers.
// You already have credits, so this just spends down your balance
// per call; check usage any time at agentphone.ai (Usage & Billing).
//
// ── WHY "HOSTED" VOICE MODE ───────────────────────────────────
// AgentPhone supports two voice modes:
//   - "webhook": AgentPhone POSTs the live transcript to a public
//     URL on YOUR server for every turn, and you return what to say.
//   - "hosted": you give AgentPhone a systemPrompt once, and their
//     own built-in LLM runs the entire live conversation itself.
// Jarvis normally runs on your own PC, which usually has no public
// HTTPS endpoint the internet can reach — so "webhook" mode would
// require you to stand up and expose a server just for this. Hosted
// mode needs nothing exposed: we place the call with instructions,
// then poll for the finished transcript afterward. That's the mode
// this file uses everywhere. (If you later run Jarvis somewhere
// with a public URL, webhook mode would let phone-agent.js react
// mid-call instead of only after — worth revisiting then.)
//
// ── STATE ──────────────────────────────────────────────────────
// The very first call auto-creates one AgentPhone "agent" + buys it
// one phone number, then caches both ids in data/agentphone-state.json
// so Jarvis doesn't buy a new number every time it restarts. Delete
// that file (or the ids inside it) if you ever want a fresh number.
// ═══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const API_BASE = process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.ai/v1";
const STATE_PATH = path.join(__dirname, "data", "agentphone-state.json");

function apiKey() {
  const key = String(process.env.AGENTPHONE_API_KEY || "").trim();
  if (!key) throw new Error("AGENTPHONE_API_KEY not set in .env — get one at agentphone.ai/settings after signing up.");
  return key;
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[AGENTPHONE] Could not persist state:", e.message);
  }
}

// ── LOW-LEVEL REQUEST ──────────────────────────────────────────
async function request(method, urlPath, body) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      "Authorization": `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }

  if (!res.ok) {
    const msg = json?.error || json?.message || text || `HTTP ${res.status}`;
    throw new Error(`AgentPhone ${method} ${urlPath} failed (${res.status}): ${msg}`);
  }
  return json;
}

// ── ONE-TIME SETUP: agent + number, cached after the first run ──
async function ensureAgentAndNumber(ownerName) {
  const state = loadState();
  if (state.agentId && state.numberId) return state;

  let agentId = process.env.AGENTPHONE_AGENT_ID || state.agentId;
  let numberId = process.env.AGENTPHONE_NUMBER_ID || state.numberId;

  if (!agentId) {
    console.log("[AGENTPHONE] No agent on file yet — creating one...");
    const agent = await request("POST", "/agents", {
      name: `${ownerName || "Jarvis"}'s Assistant`,
    });
    agentId = agent.id;
  }

  if (!numberId) {
    // Before buying anything new, check whether this agent already
    // has a number attached (e.g. one you provisioned by hand in the
    // dashboard) — only buy a new one if it genuinely has none.
    console.log("[AGENTPHONE] No number ID on file — checking whether the agent already has one attached...");
    const existing = await request("GET", `/agents/${agentId}/numbers`);
    const list = Array.isArray(existing) ? existing : (existing?.data || []);

    if (list.length > 0) {
      numberId = list[0].id;
      console.log(`[AGENTPHONE] Found existing number already attached (${list[0].phoneNumber || numberId}) — using it, nothing purchased.`);
    } else {
      console.log("[AGENTPHONE] Agent has no number attached — buying one (this spends a small amount of your balance)...");
      const number = await request("POST", "/numbers", {});
      numberId = number.id;
      await request("POST", `/agents/${agentId}/numbers`, { numberId });
    }
  }

  const newState = { agentId, numberId, phoneNumber: state.phoneNumber || null };
  saveState(newState);
  return newState;
}

// ── PLACE AN OUTBOUND CALL (hosted mode) ────────────────────────
// systemPrompt fully controls what AgentPhone's own LLM says and
// does on this call — see phone-agent.js for how that's built.
async function placeOutboundCall({ toNumber, systemPrompt, initialGreeting, voice, ownerName }) {
  if (!toNumber) throw new Error("placeOutboundCall requires toNumber");
  if (!systemPrompt) throw new Error("placeOutboundCall requires systemPrompt");

  const { agentId } = await ensureAgentAndNumber(ownerName);

  const call = await request("POST", "/calls", {
    agentId,
    toNumber,
    initialGreeting: initialGreeting || undefined,
    systemPrompt,
    voice: voice || undefined,
  });
  return call; // { id, status, ... }
}

// ── PUSH A DEFAULT SYSTEM PROMPT TO THE AGENT RECORD ─────────────
// This is what an INBOUND call falls back to (someone dials your
// Jarvis number directly) since there's no per-call systemPrompt to
// inject the way there is for outbound calls. Updates the agent's
// default so you don't have to hand-paste it into the dashboard
// every time the prompt logic changes (e.g. when you add/remove a
// user in config.json's "users" list) — see inbound-agent.js.
async function setAgentDefaultSystemPrompt(systemPrompt, ownerName) {
  if (!systemPrompt) throw new Error("setAgentDefaultSystemPrompt requires systemPrompt");
  const { agentId } = await ensureAgentAndNumber(ownerName);
  await request("PATCH", `/agents/${agentId}`, { systemPrompt });
  return { agentId };
}

// ── LIST RECENT CALLS (used to find inbound calls after the fact) ─
// Hosted mode has no live webhook, so Jarvis can't react mid-call —
// this is how inbound-agent.js finds out an inbound call happened at
// all, by polling after the fact instead of during the call.
async function listCalls({ direction, limit = 20 } = {}) {
  const qs = new URLSearchParams();
  if (direction) qs.set("direction", direction);
  if (limit) qs.set("limit", String(limit));
  const res = await request("GET", `/calls?${qs.toString()}`);
  return Array.isArray(res) ? res : (res?.data || []);
}

// ── POLL A CALL UNTIL IT'S OVER ──────────────────────────────────
async function getCall(callId) {
  return request("GET", `/calls/${callId}`);
}

async function waitForCallCompletion(callId, { pollMs = 4000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const call = await getCall(callId);
    if (call.status === "completed" || call.status === "failed") return call;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for call ${callId} to finish (still ${(await getCall(callId)).status} after ${timeoutMs / 1000}s)`);
}

module.exports = {
  ensureAgentAndNumber,
  placeOutboundCall,
  setAgentDefaultSystemPrompt,
  listCalls,
  getCall,
  waitForCallCompletion,
};
