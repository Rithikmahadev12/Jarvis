"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Brain Router v1.0
//
// THE POINT OF THIS FILE:
//   ai-engine.js is the actual mind. It answers first, always.
//   Groq is not the brain — Groq is the TUTOR. It only gets called
//   when the local brain comes up empty. Whatever Groq says gets
//   distilled into a lesson (keywords + answer) and written into
//   the local brain's long-term memory (via Groq's learned-intents
//   store, which ai-engine.js now checks on every turn before it
//   gives up). Next time something similar comes up, the local
//   brain answers it itself — instantly, for free, no tutor call.
//
//   "Getting smarter" here means one concrete, trackable thing:
//   selfSufficiencyRate climbing over time. Don't trust vibes —
//   watch the number. GET /api/brain/stats.
// ═══════════════════════════════════════════════════════════════

const AI       = require("./ai-engine");
const Groq     = require("./hermes-engine");
const Research = require("./research");

// ── GROWTH STATS (in-memory; wire to a JSON file if you want it
//    to survive restarts — same pattern as data/learned_intents.json) ──
const stats = {
  localAnswers:  0,  // answered straight from the rule engine / knowledge graph
  taughtAnswers: 0,  // answered from a lesson Groq taught it previously
  tutorCalls:    0,  // had to actually phone the tutor just now
  tutorFailures: 0,  // tutor call itself errored
  freeResearch:  0,  // no Groq configured — fell back to free wiki/ddg lookup
  startedAt:     Date.now(),
};

function getGrowthStats() {
  const total = stats.localAnswers + stats.taughtAnswers + stats.tutorCalls + stats.freeResearch;
  const selfSufficient = stats.localAnswers + stats.taughtAnswers;
  return {
    ...stats,
    totalAnswered: total,
    selfSufficiencyRate: total ? parseFloat((selfSufficient / total * 100).toFixed(1)) : 0,
    learnedIntents: Groq.getLearnedIntentsStats(),
    uptimeMin: Math.floor((Date.now() - stats.startedAt) / 60000),
  };
}

// Turn a raw message into a reusable lesson: generalizable keywords +
// a short topic label, so near-variants of the same question get
// recognised later even if phrased differently.
function distillLesson(message) {
  const keywords = Groq.extractKeywords(message);
  const topic = message
    .replace(/^(what is|what's|how do|can you|please|jarvis|hey)\s*/gi, "")
    .trim()
    .slice(0, 60);
  return { keywords, topic };
}

// ── MAIN ENTRY POINT ──────────────────────────────────────────
// Drop-in replacement for the old "Groq is primary brain" branch
// in server.js's /api/chat route.
async function respond({ message, sessionId, userName, userTitle, memories, moodContext, serverData, conversationHistory = [] }) {
  const T = userTitle || "Sir";

  // 1. Ask the local brain. ai-engine.js's process() already checks
  //    Groq's learned-intents store internally before it gives up,
  //    so "local" here includes everything it's been taught so far.
  let local;
  try {
    local = AI.process({ message, sessionId, userName, userTitle, memories, moodContext, serverData });
  } catch (e) {
    console.error("[BRAIN] Local engine threw:", e.message);
    local = { reply: "", action: "FALLBACK", intent: "fallback" };
  }

  // FALLBACK = genuinely didn't know. RESEARCH = flagged for lookup but
  // hasn't actually answered yet (placeholder reply). Neither counts as
  // "knew it already."
  const knewItAlready = local.action !== "FALLBACK" && local.action !== "RESEARCH";

  if (local.action === "TAUGHT") {
    stats.taughtAnswers++;
    return { ...local, source: "memory", needsTutor: false };
  }

  if (knewItAlready) {
    stats.localAnswers++;
    return { ...local, source: "local", needsTutor: false };
  }

  // 2. Local brain came up empty. No tutor configured? Try a free
  //    knowledge lookup (Wikipedia/DDG) before giving the honest
  //    "I don't know" answer.
  if (!Groq.isConfigured()) {
    if (Research.shouldResearch(message)) {
      try {
        const researched = await Research.research(message, userTitle);
        if (researched?.reply) {
          stats.freeResearch++;
          return {
            reply: researched.reply, action: "RESEARCH", intent: "research",
            topic: researched.query, source: "free_research", needsTutor: false,
          };
        }
      } catch {}
    }
    return { ...local, source: "local", needsTutor: false, tutorUnavailable: true };
  }

  // 3. Consult the tutor, live.
  stats.tutorCalls++;
  try {
    const memoryFacts = (memories || []).slice(0, 8).map(m => (typeof m === "string" ? m : m.fact));
    const taught = await Groq.chat(message, {
      userTitle,
      memories: memoryFacts,
      context: `mood: ${moodContext || "neutral"}`,
      conversationHistory,   // ← pass full turn history so JARVIS remembers what it asked
      autoLearn: false, // we distill + store the lesson ourselves, below
    });

    // 4. Write the lesson into long-term memory so the tutor isn't
    //    needed for this (or close variants) again.
    const { keywords, topic } = distillLesson(message);
    if (keywords.length >= 2 && taught.reply && taught.reply.length > 20) {
      Groq.learnIntent(message, taught.reply, "TAUGHT", topic, keywords);
    }

    return {
      reply: taught.reply,
      action: "TUTORED",   // answered just now via the tutor; it's learned for next time
      intent: "tutored",
      source: "tutor",
      needsTutor: true,
      meta: { model: taught.model },
    };
  } catch (e) {
    console.error("[BRAIN] Tutor call failed:", e.message);
    stats.tutorFailures++;
    return { ...local, source: "local", needsTutor: true, tutorUnavailable: true };
  }
}

module.exports = { respond, getGrowthStats };
