"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Hermes Agent Engine v1.0
// Drop-in replacement for groq-engine.js.
// Talks to a self-hosted Hermes Agent instance via its
// OpenAI-compatible API server (hermes config set API_SERVER_ENABLED true).
// Same exported interface as groq-engine.js, so brain.js / server.js
// only need their require() path changed — nothing else.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

// ── CONFIG ─────────────────────────────────────────────────────
// HERMES_API_URL  → defaults to http://127.0.0.1:8642 — Hermes runs as a background
//                   process inside THIS SAME Render service (see startup.sh), so no
//                   separate service/URL is needed. Only override this if you later
//                   move Hermes to its own service.
// HERMES_API_KEY  → must match the API_SERVER_KEY startup.sh configures Hermes with
// HERMES_MODEL    → the model name Hermes advertises (defaults to "hermes-agent",
//                   or your profile name if you're running named profiles)
const HERMES_BASE_URL = (process.env.HERMES_API_URL || "http://127.0.0.1:8642").replace(/\/+$/, "");
const HERMES_API_KEY  = process.env.HERMES_API_KEY || "";
const HERMES_API_URL  = HERMES_BASE_URL ? `${HERMES_BASE_URL}/v1/chat/completions` : "";

const MODELS = {
  fast:  process.env.HERMES_MODEL || "hermes-agent",
  smart: process.env.HERMES_MODEL || "hermes-agent",
  mix:   process.env.HERMES_MODEL || "hermes-agent",
};

// ── LEARNED INTENTS STORE (separate file from Groq's, same shape) ─
const DATA_DIR              = path.join(__dirname, "data");
const LEARNED_INTENTS_FILE  = path.join(DATA_DIR, "hermes_learned_intents.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(LEARNED_INTENTS_FILE)) {
    fs.writeFileSync(LEARNED_INTENTS_FILE, JSON.stringify({ intents: [], stats: { total: 0, hits: 0 } }, null, 2));
  }
}

function loadLearnedIntents() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(LEARNED_INTENTS_FILE, "utf8")); }
  catch { return { intents: [], stats: { total: 0, hits: 0 } }; }
}
function saveLearnedIntents(data) {
  ensureDataDir();
  fs.writeFileSync(LEARNED_INTENTS_FILE, JSON.stringify(data, null, 2));
}

function extractKeywords(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(w => w.length > 2)
  )].slice(0, 8);
}

function learnIntent(userMessage, reply, action, topic, keywords) {
  const data = loadLearnedIntents();
  data.intents.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    exampleInput: userMessage,
    exampleOutput: reply,
    action, topic, keywords,
    hitCount: 1,
    createdAt: new Date().toISOString(),
  });
  data.stats = data.stats || { total: 0, hits: 0 };
  data.stats.total = data.intents.length;
  saveLearnedIntents(data);
}

function matchLearnedIntent(message) {
  const data = loadLearnedIntents();
  const lower = message.toLowerCase();
  let best = null, bestScore = 0;
  for (const intent of data.intents) {
    const score = (intent.keywords || []).filter(k => lower.includes(k)).length;
    if (score > bestScore) { bestScore = score; best = intent; }
  }
  if (best && bestScore >= 2) {
    best.hitCount = (best.hitCount || 1) + 1;
    saveLearnedIntents(data);
    return best;
  }
  return null;
}

// ── SIMPLE IN-MEMORY CACHE ─────────────────────────────────────
const cache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
function getCached(k) {
  const hit = cache.get(k);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { cache.delete(k); return null; }
  return hit.data;
}
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

// ── CORE HERMES FETCH (OpenAI-compatible /v1/chat/completions) ──
async function hermesFetch(messages, model = MODELS.smart, temperature = 0.75, maxTokens = 1024) {
  if (!HERMES_API_URL) throw new Error("HERMES_API_URL not set in .env");
  if (!HERMES_API_KEY) throw new Error("HERMES_API_KEY not set in .env");

  const res = await fetch(HERMES_API_URL, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${HERMES_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(60000), // Hermes can be slower than Groq — it may run tools mid-turn
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Hermes API error ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || "";
}

// ── JARVIS SYSTEM PROMPT ──────────────────────────────────────
function getSystemPrompt(userTitle, memories, context, learnedExamples) {
  const T = userTitle || "Sir";

  let examplesBlock = "";
  if (learnedExamples && learnedExamples.length > 0) {
    examplesBlock = `\n\nPreviously learned responses (use these as style/format reference):\n${
      learnedExamples.map(e => `User: ${e.exampleInput}\nJARVIS: ${e.exampleOutput}`).join("\n\n---\n\n")
    }`;
  }

  return `You are J.A.R.V.I.S (Just A Rather Very Intelligent System), Tony Stark's AI. You are the PRIMARY BRAIN of this assistant system, running on top of Hermes Agent.

Address the user as "${T}". Speak with dry wit, precision, and warmth. Never robotic. Never start with "I".

CRITICAL RULES:
- You CAN handle ANY request — system commands, questions, coding, math, advice, creative tasks, analysis, anything
- If asked to do something like change a setting, explain timezone, write code, explain concepts — DO IT directly and helpfully
- For commands the system can't actually execute (like "change my timezone"), explain HOW to do it and what the user needs to do
- Give concrete, useful answers. Never just say "I can't do that"
- Keep responses under 3 sentences unless complexity demands more
- Reference specifics from the conversation

${memories && memories.length > 0 ? `\nUser facts on file: ${memories.join(", ")}` : ""}
${context ? `\nContext: ${context}` : ""}
${examplesBlock}

You handle EVERYTHING. If it's a known system command (timer, clip, weather, spotify, etc) the server will route it — but for anything else, YOU give the answer directly.`;
}

// ── DETECT WHAT ACTION THE RESPONSE IMPLIES ──────────────────
async function detectActionFromResponse(userMessage, reply) {
  const lower = userMessage.toLowerCase();
  const r     = reply.toLowerCase();

  if (r.includes("```") || /write|create|build|generate|code|script|function/i.test(lower)) return "CODE";
  if (/\d+[\+\-\*\/]\d+|calculate|compute|solve|percent|equals/i.test(lower)) return "MATH";
  if (/what is|what are|explain|how does|why does|define|describe/i.test(lower)) return "KNOWLEDGE";
  if (/timezone|setting|config|preference|change my|set my|update my/i.test(lower)) return "SYSTEM_HELP";
  if (/convert|to \w+|in \w+|from \w+ to/i.test(lower)) return "CONVERSION";
  if (/should i|advice|recommend|suggest|help me decide/i.test(lower)) return "ADVICE";
  return "HERMES_LEARNED";
}

// ── MAIN CHAT FUNCTION ────────────────────────────────────────
async function chat(message, options = {}) {
  const {
    userTitle          = "Sir",
    memories           = [],
    context            = "",
    conversationHistory = [],
    skipCache          = false,
    autoLearn          = true,
  } = options;

  if (autoLearn) {
    const learned = matchLearnedIntent(message);
    if (learned) {
      return {
        reply:   learned.exampleOutput,
        model:   "learned_intent",
        source:  "learned",
        action:  learned.action,
        topic:   learned.topic,
        learned: true,
      };
    }
  }

  const cacheKey = skipCache ? null : `chat:${message.toLowerCase().trim()}:${userTitle}`;
  if (cacheKey) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const learnedData = loadLearnedIntents();
  const relevantLearned = learnedData.intents
    .filter(i => {
      const lower = message.toLowerCase();
      return (i.keywords || []).some(k => lower.includes(k));
    })
    .sort((a, b) => (b.hitCount || 1) - (a.hitCount || 1))
    .slice(0, 2);

  const systemPrompt = getSystemPrompt(userTitle, memories, context, relevantLearned);
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-8),
    { role: "user", content: message },
  ];

  const reply = await hermesFetch(messages, MODELS.smart, 0.75, 768);
  const trimmedReply = reply.trim();

  if (!trimmedReply) throw new Error("Empty response from Hermes");

  if (autoLearn && trimmedReply.length > 20) {
    const keywords       = extractKeywords(message);
    const detectedAction = await detectActionFromResponse(message, trimmedReply);
    const detectedTopic  = message
      .replace(/^(what is|how do|can you|please|jarvis|hey)/gi, "")
      .trim()
      .slice(0, 60);

    const isUsefulResponse = trimmedReply.length > 30 &&
      !trimmedReply.toLowerCase().includes("i cannot") &&
      !trimmedReply.toLowerCase().includes("i'm unable") &&
      !trimmedReply.toLowerCase().includes("i can't");

    if (isUsefulResponse && keywords.length >= 2) {
      learnIntent(message, trimmedReply, detectedAction, detectedTopic, keywords);
    }
  }

  const result = { reply: trimmedReply, model: MODELS.smart, source: "hermes", learned: false };
  if (cacheKey) setCache(cacheKey, result);
  return result;
}

// ── CODE GENERATION ───────────────────────────────────────────
async function generateCode(prompt, context = "") {
  const messages = [
    {
      role: "system",
      content: `You are an expert developer working on J.A.R.V.I.S.
Generate clean, production-quality code. Return ONLY the code — no markdown backticks, no explanation.
${context}`,
    },
    { role: "user", content: prompt },
  ];
  const code = await hermesFetch(messages, MODELS.smart, 0.3, 2048);
  return code.replace(/^```[\w]*\n?/gm, "").replace(/```$/gm, "").trim();
}

// ── INTENT ANALYSIS ───────────────────────────────────────────
async function analyzeIntent(message, failedResponse, userTitle = "Sir") {
  const messages = [
    {
      role: "system",
      content: `Analyze this failed AI assistant response. Return ONLY valid JSON:
{"intent":"short description","category":"question|command|creative|calculation|lookup|conversation|unknown","keywords":["array","of","keywords"],"suggestedHandler":"what should handle this","confidence":0.0}`,
    },
    {
      role: "user",
      content: `User said: "${message}"\nAssistant responded: "${failedResponse}"\nWhat did the user actually want?`,
    },
  ];
  try {
    const raw     = await hermesFetch(messages, MODELS.fast, 0.2, 256);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { intent: "unknown", category: "unknown", keywords: [], suggestedHandler: "general fallback", confidence: 0 };
  }
}

// ── KNOWLEDGE EXTRACTION ──────────────────────────────────────
async function extractKnowledge(text, topic) {
  const messages = [
    {
      role: "system",
      content: `Extract key facts. Return ONLY valid JSON:
{"facts":["array of facts"],"definition":"one sentence definition","relatedTopics":["topics"],"applications":["applications"]}`,
    },
    { role: "user", content: `Topic: "${topic}"\nText: "${text.slice(0, 2000)}"` },
  ];
  try {
    const raw     = await hermesFetch(messages, MODELS.fast, 0.2, 512);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { facts: [], definition: "", relatedTopics: [], applications: [] };
  }
}

// ── TRAINING EXAMPLE GENERATION ───────────────────────────────
async function generateTrainingExamples(topic, count = 5) {
  const messages = [
    {
      role: "system",
      content: `Generate training examples for J.A.R.V.I.S AI assistant.
Return ONLY valid JSON array: [{"input":"user message","output":"JARVIS response"}]
JARVIS speaks with dry wit, precision. Addresses user as "Sir".`,
    },
    { role: "user", content: `Generate ${count} examples for topic: "${topic}"` },
  ];
  try {
    const raw     = await hermesFetch(messages, MODELS.fast, 0.8, 1024);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch { return []; }
}

// ── LEARNED INTENTS MANAGEMENT ────────────────────────────────
function getLearnedIntentsStats() {
  const data = loadLearnedIntents();
  return {
    total: data.intents.length,
    hits:  data.stats?.hits || 0,
    topIntents: data.intents
      .sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0))
      .slice(0, 10)
      .map(i => ({ action: i.action, topic: i.topic, hits: i.hitCount, keywords: (i.keywords || []).slice(0, 3) })),
  };
}
function getAllLearnedIntents() { return loadLearnedIntents().intents; }
function deleteLearnedIntent(id) {
  const data = loadLearnedIntents();
  data.intents = data.intents.filter(i => i.id !== id);
  saveLearnedIntents(data);
  return true;
}
function clearLearnedIntents() {
  saveLearnedIntents({ intents: [], stats: { total: 0, hits: 0 } });
  return true;
}

function isConfigured() { return !!(HERMES_API_URL && HERMES_API_KEY); }

module.exports = {
  chat,
  generateCode,
  analyzeIntent,
  extractKnowledge,
  generateTrainingExamples,
  groqFetch: hermesFetch, // alias kept so any code calling .groqFetch() by name still works
  hermesFetch,
  MODELS,
  isConfigured,
  learnIntent,
  matchLearnedIntent,
  extractKeywords,
  getLearnedIntentsStats,
  getAllLearnedIntents,
  deleteLearnedIntent,
  clearLearnedIntents,
};
