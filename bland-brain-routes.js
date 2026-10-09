"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Bland "Brain" Webhook v1.0
//
// Bland runs the live voice conversation, but whenever its agent
// needs to decide something real it calls the "Ask Jarvis" tool that
// bland-call.js attaches to every call. That tool POSTs here:
//
//   POST /bland/brain
//   headers: x-jarvis-secret: <shared secret, see bland-call.js>
//   body:    { call_id, goal, owner, phone_number, said, situation }
//
// Jarvis (Groq, same keys/rotation as the other voice routes) decides
// what to say / do next and returns:
//
//   { "reply": "<what to say out loud>", "end_call": false }
//
// Bland puts that response into the conversation and its agent speaks
// the reply (bland-call.js's task prompt tells it to).
//
// STATELESS ON PURPOSE: calls are placed from two places (this server
// AND the GitHub Actions outreach job), so the goal travels with every
// request via Bland's request_data instead of living in an in-memory
// map. The history Map below is only a convenience cache so Jarvis can
// remember earlier turns of the same call; if it's empty (restart,
// cold start) the endpoint still works from `said` + `situation`.
//
// Mounted AFTER express.json() (plain JSON body, no raw-body needed).
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");
const { askGroqForJSON } = require("./groq-json");

const MAX_TURNS = 14;                 // hard stop on paid minutes
const HISTORY_TTL_MS = 30 * 60 * 1000;
const histories = new Map();          // call_id -> { turns, lines:[{role,text}], touched }

// Same derivation bland-call.js uses, so neither side needs extra config
// unless you want to override with BLAND_BRAIN_SECRET.
function brainSecret() {
  const explicit = String(process.env.BLAND_BRAIN_SECRET || "").trim();
  if (explicit) return explicit;
  const key = String(process.env.BLAND_API_KEY || "").trim();
  return key ? crypto.createHash("sha256").update(`jarvis-brain:${key}`).digest("hex") : "";
}

function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function sweep() {
  const now = Date.now();
  for (const [k, v] of histories) if (now - v.touched > HISTORY_TTL_MS) histories.delete(k);
}

const clip = (s, n) => String(s || "").slice(0, n);

function mount(app) {
  app.post("/bland/brain", async (req, res) => {
    const secret = brainSecret();
    if (!secret || !safeEqual(req.get("x-jarvis-secret") || "", secret)) {
      return res.status(401).json({ reply: "", end_call: false, error: "unauthorized" });
    }

    sweep();
    const b = req.body || {};
    const callId = clip(b.call_id, 100) || "unknown";
    const owner = clip(b.owner, 60) || "my owner";
    const goal = clip(b.goal, 3000);
    const said = clip(b.said, 1000).trim();
    const situation = clip(b.situation, 1000).trim();

    const h = histories.get(callId) || { turns: 0, lines: [], touched: 0 };
    h.touched = Date.now();
    histories.set(callId, h);
    h.turns += 1;
    if (said) h.lines.push({ role: "them", text: said });

    if (h.turns > MAX_TURNS) {
      return res.json({ reply: "I've taken up enough of your time — thank you, goodbye.", end_call: true });
    }

    const transcript = h.lines.slice(-20)
      .map((l) => `${l.role === "them" ? "Them" : "Jarvis"}: ${l.text}`).join("\n");

    const systemPrompt =
      `You are Jarvis, ${owner}'s personal AI assistant, on a LIVE phone call on ${owner}'s behalf.\n` +
      `A voice agent is handling the audio and has asked you what to say next.\n\n` +
      `CALL GOAL / INSTRUCTIONS:\n${goal || "(none provided — be polite, brief and helpful)"}\n\n` +
      `Rules: keep "reply" to 1-3 short sentences that sound natural SPOKEN aloud. ` +
      `Never commit ${owner} to money, bookings or personal details unless the goal explicitly allows it. ` +
      `Don't treat "okay"/"uh huh" as an answer to a question. Don't hang up before the goal is met. ` +
      `Set end_call true only when the goal is fully accomplished or they clearly want to end the call; ` +
      `in that case "reply" must be a brief goodbye.\n\n` +
      `Reply with ONLY JSON: {"reply": string, "end_call": boolean}`;

    const userContent =
      (transcript ? `Conversation so far:\n${transcript}\n\n` : "") +
      (said ? `They just said: ${said}\n` : "") +
      (situation ? `Voice agent's note on the situation: ${situation}\n` : "") +
      `What should Jarvis say next?`;

    let out;
    try {
      out = await askGroqForJSON({
        systemPrompt, userContent, temperature: 0.4,
        fallback: { reply: "", end_call: false },
      });
    } catch (e) {
      console.error(`[BLAND-BRAIN] Groq failed: ${e.message}`);
      out = null;
    }

    let reply = clip(out && out.reply, 500).trim();
    let endCall = !!(out && out.end_call);
    if (!reply) {
      reply = "Sorry, I'm having trouble on my end — I'll have someone follow up. Goodbye.";
      endCall = true;
    }
    h.lines.push({ role: "jarvis", text: reply });
    res.json({ reply, end_call: endCall });
  });
}

module.exports = { mount, brainSecret };
