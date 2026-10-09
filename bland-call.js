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

const API_BASE = "https://api.bland.ai";

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

  const body = {
    phone_number: toNumber,
    task:
      `${systemPrompt}\n\n` +
      `You are on a live phone call on behalf of ${ownerName || "my owner"}. ` +
      `Keep every reply short (1-3 sentences) and natural to say out loud. ` +
      `When the call's purpose is fully accomplished, or the other person wants to end it, say a brief goodbye and end the call.`,
    max_duration: 5, // minutes — hard stop on paid minutes
  };
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
