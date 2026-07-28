"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Local Brain: the tutor pipeline
//
// What this does, in order, for genuine knowledge/conversation
// questions (NOT commands — see the gate below):
//
//   1. Ask OwnBrain (own-brain.js) — JARVIS's own from-scratch,
//      locally-trained model. If it already knows (from memory)
//      or is confident enough in a free generation, answer
//      straight from it. Nothing leaves the machine.
//   2. If OwnBrain doesn't know: ask Groq as a TUTOR — a plain
//      text completion, not the full tool-calling brain. Groq's
//      answer goes back to the user immediately, AND gets taught
//      to OwnBrain (memory + a real training step) so next time
//      the same/similar question is answered locally.
//   3. If Groq is unavailable or says it doesn't know: fall back
//      to research.js, which actually searches the web (DuckDuckGo
//      / Wikipedia). That answer also gets taught to OwnBrain.
//   4. If literally none of that works: return null so the caller
//      falls through to the existing Groq tool-calling pipeline in
//      server.js exactly as before — nothing regresses.
//
// GATING: this module only ever intercepts genuine knowledge/info
// questions. Commands and actions (open an app, set a timer,
// control lights, place a call, write code, etc.) are explicitly
// NOT this module's job — OwnBrain has no idea how to call real
// tools, and pretending otherwise would break actual functionality.
// Those keep going straight to Groq.chatWithTools in server.js,
// completely unchanged. We reuse research.js's own
// shouldResearch() heuristic as that gate, since it already
// distinguishes "genuine question" from "command" carefully.
// ═══════════════════════════════════════════════════════════════

const OwnBrain = require("./own-brain");
const Research = require("./research");
const Groq     = require("./hermes-engine");
const Trainer  = require("./trainer");

const OWN_BRAIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.OWNBRAIN_CONFIDENCE_THRESHOLD || "") || 0.5;

// Phrases that mean "I genuinely don't know" from a tutor completion
// — used to decide whether to trust Groq's tutor answer or fall
// further through to research.
const UNSURE_PATTERN = /\b(i don'?t know|i'?m not sure|i am not sure|no idea|not certain|can'?t say for sure|unable to determine|i don'?t have (that|enough) information)\b/i;

async function askGroqTutor(message) {
  if (!Groq.isConfigured()) return null;
  try {
    const reply = await Groq.groqFetch([
      {
        role: "system",
        content:
          "You are a tutor teaching a small local AI model a fact or explanation. " +
          "Answer the user's question plainly, accurately, and concisely (2-4 sentences). " +
          "If you genuinely don't know or the question has no factual answer, say exactly " +
          "\"I don't know\" and nothing else — do not guess.",
      },
      { role: "user", content: message },
    ], undefined, 0.4, 400);

    if (!reply || UNSURE_PATTERN.test(reply)) return null;
    return reply.trim();
  } catch (e) {
    console.warn("[LOCAL-BRAIN] Groq tutor call failed:", e.message);
    return null;
  }
}

async function askResearch(message) {
  try {
    const result = await Research.research(message);
    if (result && result.reply) return result.reply;
  } catch (e) {
    console.warn("[LOCAL-BRAIN] Research fallback failed:", e.message);
  }
  return null;
}

// Returns a server.js-shaped response object, or null to signal
// "not my job, let the normal Groq tool-calling pipeline handle it."
async function answer(message, { userTitle = "Sir" } = {}) {
  if (!message || typeof message !== "string") return null;
  if (!Research.shouldResearch(message)) return null; // not a knowledge question — defer entirely

  // ── 1. Our own model, first ──
  const own = OwnBrain.answer(message);
  if (own.text && own.confidence >= OWN_BRAIN_CONFIDENCE_THRESHOLD) {
    Trainer.addExample(message, own.text, "knowledge", null, own.confidence, "own-brain");
    return {
      reply: own.text,
      action: "OWN_BRAIN",
      intent: "knowledge",
      meta: { source: "own-brain", via: own.via, confidence: own.confidence },
    };
  }

  // ── 2. Groq as tutor ──
  const tutorReply = await askGroqTutor(message);
  if (tutorReply) {
    OwnBrain.learnFromExchange(message, tutorReply, "groq-tutor");
    Trainer.addExample(message, tutorReply, "knowledge", null, 0.75, "groq-tutor");
    return {
      reply: tutorReply,
      action: "GROQ_TUTOR",
      intent: "knowledge",
      meta: { source: "groq", taughtToOwnBrain: true },
    };
  }

  // ── 3. Live web research ──
  const researched = await askResearch(message);
  if (researched) {
    OwnBrain.learnFromExchange(message, researched, "research");
    Trainer.addExample(message, researched, "knowledge", null, 0.7, "research");
    return {
      reply: researched,
      action: "RESEARCH",
      intent: "knowledge",
      meta: { source: "research", taughtToOwnBrain: true },
    };
  }

  // ── 4. Honest failure — let it fall through to the normal pipeline ──
  return null;
}

module.exports = { answer };
