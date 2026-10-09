"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Bland Call Client v1.0
//
// Bland places the call AND runs the conversation on its own AI,
// using the systemPrompt Jarvis hands it as the call's "task".
// (Unlike Retell/AgentPhone-webhook, Jarvis does not decide each
// line live — Bland's agent follows the prompt.) Jarvis then reads
// the finished call back by polling GET /v1/calls/{id}.
//
// Same exported shape as the other backends, so phone-provider.js
// treats it like any other.
//
// ── ENV VARS (Render → Environment) ───────────────────────────
//   BLAND_API_KEY      Bland dashboard → Settings → API key
//   BLAND_FROM_NUMBER  (optional) a number you own in Bland to call
//                      from; leave unset to use Bland's default.
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");

const API_BASE = "https://api.bland.ai";

// ── JARVIS-AS-BRAIN (webhook tool) ─────────────────────────────
// If Jarvis has a public URL, every call gets an "Ask Jarvis" tool.
// Bland's agent calls it mid-call -> POST {PUBLIC}/bland/brain
// (bland-brain-routes.js) -> Jarvis decides -> JSON back -> Bland
// speaks it. Set JARVIS_PUBLIC_URL (or it falls back to Render's
// RENDER_EXTERNAL_URL). No public URL = old behavior, Bland alone.
function publicUrl() {
  return String(process.env.JARVIS_PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "")
    .trim().replace(/\/+$/, "");
}
function brainSecret() {
  const explicit = String(process.env.BLAND_BRAIN_SECRET || "").trim();
  if (explicit) return explicit;
  return crypto.createHash("sha256").update(`jarvis-brain:${apiKey()}`).digest("hex");
}
// Bland treats {{ }} as prompt variables — strip them from free text.
const noVars = (s) => String(s || "").replace(/\{\{|\}\}/g, "");

function brainTool() {
  return {
    name: "Ask Jarvis",
    description:
      "Ask Jarvis, your decision-making brain, what to say or do next. Call this every time the other " +
      "person says something substantive (an answer, a question, an objection, a time/price/name) " +
      "and you need to decide your next move. Pass what they just said.",
    speech: "One moment.",
    url: `${publicUrl()}/bland/brain`,
    method: "POST",
    headers: { "Content-Type": "application/json", "x-jarvis-secret": brainSecret() },
    input_schema: {
      example: { said: "We have 3pm open tomorrow.", situation: "They offered a time slot." },
      type: "object",
      properties: {
        said: { type: "string", description: "The other person's latest words, as close to verbatim as possible" },
        situation: { type: "string", description: "One short sentence on where the call stands" },
      },
      required: ["said"],
    },
    body: {
      call_id: "{{call_id}}",
      phone_number: "{{phone_number}}",
      goal: "{{jarvis_goal}}",
      owner: "{{jarvis_owner}}",
      said: "{{input.said}}",
      situation: "{{input.situation}}",
    },
    response: { reply: "$.reply", end_call: "$.end_call" },
    timeout: 15000,
  };
}

function apiKey()     { return String(process.env.BLAND_API_KEY || "").trim(); }
function fromNumber() { return String(process.env.BLAND_FROM_NUMBER || "").trim(); }

function isConfigured() { return !!apiKey(); }

async function blandRequest(method, urlPath, body) {
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
  if (!res.ok || (json && json.status === "error")) {
    const msg = (json && (json.message || json.error || json.errors)) || text || `HTTP ${res.status}`;
    throw new Error(`Bland ${method} ${urlPath} failed (${res.status}): ${typeof msg === "string" ? msg : JSON.stringify(msg)}`);
  }
  return json;
}

async function placeOutboundCall({ toNumber, systemPrompt, initialGreeting, ownerName }) {
  if (!isConfigured()) throw new Error("Bland not configured — set BLAND_API_KEY in the environment.");
  if (!toNumber) throw new Error("placeOutboundCall requires toNumber");
  if (!systemPrompt) throw new Error("placeOutboundCall requires systemPrompt");

  const brain = !!publicUrl();
  const body = {
    phone_number: toNumber,
    task:
      `${systemPrompt}\n\n` +
      (brain
        ? `You have a tool called "Ask Jarvis". Use it whenever the other person says something that needs a real decision or answer. ` +
          `After it returns, say the returned reply naturally (you may lightly rephrase, but keep its meaning). ` +
          `If end_call is true, say that goodbye and end the call. ` +
          `Don't invent facts, times or commitments yourself — ask Jarvis.\n\n`
        : "") +
      `You are on a live phone call on behalf of ${ownerName || "my owner"}. ` +
      `Keep every reply short (1-3 sentences) and natural to say out loud. ` +
      `When the call's purpose is fully accomplished, or the other person wants to end it, say a brief goodbye and end the call.`,
    max_duration: 5, // minutes — hard stop on paid minutes
  };
  if (brain) {
    body.tools = [brainTool()];
    body.request_data = {
      jarvis_goal: noVars(systemPrompt).slice(0, 3000),
      jarvis_owner: noVars(ownerName || "my owner").slice(0, 60),
    };
  }
  if (initialGreeting) body.first_sentence = initialGreeting;
  if (fromNumber()) body.from = fromNumber();

  const res = await blandRequest("POST", "/v1/calls", body);
  const id = res && (res.call_id || res.id);
  if (!id) throw new Error(`Bland didn't return a call_id: ${JSON.stringify(res).slice(0, 300)}`);
  return { id, status: "queued" };
}

async function getCall(callId) {
  const c = await blandRequest("GET", `/v1/calls/${encodeURIComponent(callId)}`);

  let status;
  const s = String(c.status || "").toLowerCase();
  if (s === "completed") status = "completed";
  else if (s === "failed") status = "failed";
  else if (s === "new" || s === "queued") status = "queued";
  else status = "in-progress";

  // Pair Bland's turns into {transcript: what they said, response: what Jarvis said}
  // — the shape phone-agent.js's summarizer already understands.
  const turns = [];
  let cur = null;
  for (const t of Array.isArray(c.transcripts) ? c.transcripts : []) {
    const text = String(t.text || "").trim();
    if (!text) continue;
    if (t.user === "assistant") {
      if (cur && !cur.response) cur.response = text;
      else { cur = { transcript: "", response: text }; turns.push(cur); }
    } else if (t.user === "user") {
      if (cur && !cur.response) { cur.transcript += (cur.transcript ? " " : "") + text; continue; }
      cur = { transcript: text, response: "" };
      turns.push(cur);
    }
  }

  return {
    id: callId,
    status,
    toNumber: c.to || null,
    transcript: c.concatenated_transcript || c.concat_transcript || "",
    transcripts: turns,
    recordingUrl: c.recording_url || null,
    errorMessage: c.error_message || null,
  };
}

async function waitForCallCompletion(callId, { pollMs = 4000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const call = await getCall(callId);
    if (call.status === "completed" || call.status === "failed") return call;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for Bland call ${callId} to finish`);
}

module.exports = { isConfigured, placeOutboundCall, getCall, waitForCallCompletion };
