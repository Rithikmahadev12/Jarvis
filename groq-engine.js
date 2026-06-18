"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Groq AI Engine v3.0
// PRIMARY BRAIN: Groq handles everything not caught by hard commands
// AUTO-LEARNING: Unknown commands get saved as learned intents
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

const MODELS = {
  fast:  "llama-3.1-8b-instant",
  smart: "llama-3.3-70b-versatile",
  mix:   "llama-3.1-8b-instant",
};

// ── LEARNED INTENTS STORE ─────────────────────────────────────
const DATA_DIR            = path.join(__dirname, "data");
const LEARNED_INTENTS_FILE = path.join(DATA_DIR, "learned_intents.json");

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

// Save a new learned intent so next time it's instant (no Groq call needed)
function learnIntent(userMessage, groqReply, detectedAction, detectedTopic, keywords) {
  const data = loadLearnedIntents();

  // Don't duplicate — check if we already have a very similar intent
  const alreadyKnown = data.intents.some(i =>
    i.keywords.some(k => keywords.includes(k)) && i.action === detectedAction
  );
  if (alreadyKnown) {
    // Just bump hit count on existing
    const existing = data.intents.find(i =>
      i.keywords.some(k => keywords.includes(k)) && i.action === detectedAction
    );
    if (existing) {
      existing.hitCount = (existing.hitCount || 0) + 1;
      existing.lastSeen = new Date().toISOString();
      saveLearnedIntents(data);
    }
    return false;
  }

  const newIntent = {
    id:           `li-${Date.now()}`,
    exampleInput: userMessage.slice(0, 300),
    exampleOutput: groqReply.slice(0, 800),
    action:       detectedAction || "GROQ_LEARNED",
    topic:        detectedTopic  || null,
    keywords:     keywords.slice(0, 12),
    hitCount:     1,
    learnedAt:    new Date().toISOString(),
    lastSeen:     new Date().toISOString(),
    source:       "groq_auto_learn",
  };

  data.intents.push(newIntent);
  data.stats.total = (data.stats.total || 0) + 1;

  // Keep max 500 learned intents
  if (data.intents.length > 500) {
    // Remove least-used ones
    data.intents.sort((a, b) => (b.hitCount || 1) - (a.hitCount || 1));
    data.intents = data.intents.slice(0, 500);
  }

  saveLearnedIntents(data);
  console.log(`[GROQ] ✓ Learned new intent: "${detectedAction}" — keywords: ${keywords.slice(0, 4).join(", ")}`);
  return true;
}

// Try to match message against learned intents (instant — no API call)
function matchLearnedIntent(message) {
  const data    = loadLearnedIntents();
  const lower   = message.toLowerCase();
  const words   = new Set(lower.split(/\s+/).filter(w => w.length > 2));

  let best      = null;
  let bestScore = 0;

  for (const intent of data.intents) {
    const matchedKeywords = intent.keywords.filter(k =>
      lower.includes(k.toLowerCase()) || words.has(k.toLowerCase())
    );
    const score = matchedKeywords.length / Math.max(intent.keywords.length, 1);

    if (score > bestScore && score >= 0.5) {
      bestScore = best;
      bestScore = score;
      best      = intent;
    }
  }

  if (best && bestScore >= 0.5) {
    // Bump hit count
    const data2 = loadLearnedIntents();
    const found  = data2.intents.find(i => i.id === best.id);
    if (found) {
      found.hitCount = (found.hitCount || 1) + 1;
      found.lastSeen = new Date().toISOString();
      data2.stats.hits = (data2.stats.hits || 0) + 1;
      saveLearnedIntents(data2);
    }
    console.log(`[GROQ] ⚡ Instant hit on learned intent: "${best.action}" (score: ${bestScore.toFixed(2)})`);
    return best;
  }
  return null;
}

// Extract keywords from a message for storage
function extractKeywords(text) {
  const STOPWORDS = new Set([
    "a","an","the","is","it","its","in","on","at","to","of","and","or","but","for",
    "with","by","from","as","be","was","were","are","am","been","being","have","has",
    "had","do","does","did","will","would","could","should","may","might","shall",
    "can","that","this","these","those","i","me","my","you","your","we","our","they",
    "their","he","she","him","her","what","which","who","how","when","where","why",
    "so","just","up","out","if","about","than","then","there","here","also","only",
    "very","really","like","get","got","make","know","think","want","need","say","see",
    "us","no","not","into","over","after","before","more","much","some","any","all",
    "one","two","three","tell","give","please","jarvis","okay","ok","yes","yeah",
    "hey","uh","um","right","well","now","actually","basically","literally","going",
  ]);
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOPWORDS.has(w))
    .slice(0, 15);
}

// ── CACHE ─────────────────────────────────────────────────────
const cache    = new Map();
const CACHE_TTL = 3 * 60 * 1000;

function getCached(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(k); return null; }
  return e.data;
}
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

// ── CORE GROQ FETCH ───────────────────────────────────────────
async function groqFetch(messages, model = MODELS.smart, temperature = 0.75, maxTokens = 1024) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set in .env");

  const res = await fetch(GROQ_API_URL, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({ model, messages, temperature, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq API error ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  return data.choices[0]?.message?.content || "";
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

  return `You are J.A.R.V.I.S (Just A Rather Very Intelligent System), Tony Stark's AI. You are the PRIMARY BRAIN of this assistant system.

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

// ── DETECT WHAT ACTION GROQ'S RESPONSE IMPLIES ───────────────
// This lets us tag learned intents with the right action type
async function detectActionFromResponse(userMessage, groqReply) {
  const lower = userMessage.toLowerCase();
  const reply  = groqReply.toLowerCase();

  // Code generation
  if (reply.includes("```") || /write|create|build|generate|code|script|function/i.test(lower)) {
    return "CODE";
  }
  // Math/calculation
  if (/\d+[\+\-\*\/]\d+|calculate|compute|solve|percent|equals/i.test(lower)) {
    return "MATH";
  }
  // Explanation/knowledge
  if (/what is|what are|explain|how does|why does|define|describe/i.test(lower)) {
    return "KNOWLEDGE";
  }
  // System/settings
  if (/timezone|setting|config|preference|change my|set my|update my/i.test(lower)) {
    return "SYSTEM_HELP";
  }
  // Conversion
  if (/convert|to \w+|in \w+|from \w+ to/i.test(lower)) {
    return "CONVERSION";
  }
  // General advice
  if (/should i|advice|recommend|suggest|help me decide/i.test(lower)) {
    return "ADVICE";
  }

  return "GROQ_LEARNED";
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

  // 1. Check learned intents first (instant, no API call)
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

  // 2. Cache check
  const cacheKey = skipCache ? null : `chat:${message.toLowerCase().trim()}:${userTitle}`;
  if (cacheKey) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  // 3. Pull a few relevant learned examples to use as context
  const learnedData = loadLearnedIntents();
  const relevantLearned = learnedData.intents
    .filter(i => {
      const lower = message.toLowerCase();
      return i.keywords.some(k => lower.includes(k));
    })
    .sort((a, b) => (b.hitCount || 1) - (a.hitCount || 1))
    .slice(0, 2);

  // 4. Build messages array
  const systemPrompt = getSystemPrompt(userTitle, memories, context, relevantLearned);
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-8), // last 4 exchanges for context
    { role: "user", content: message },
  ];

  // 5. Call Groq
  const reply = await groqFetch(messages, MODELS.smart, 0.75, 768);
  const trimmedReply = reply.trim();

  if (!trimmedReply) throw new Error("Empty response from Groq");

  // 6. Auto-learn this interaction
  if (autoLearn && trimmedReply.length > 20) {
    const keywords        = extractKeywords(message);
    const detectedAction  = await detectActionFromResponse(message, trimmedReply);
    const detectedTopic   = message
      .replace(/^(what is|how do|can you|please|jarvis|hey)/gi, "")
      .trim()
      .slice(0, 60);

    // Only learn if it's a real useful response (not just "I can't" type)
    const isUsefulResponse = trimmedReply.length > 30 &&
      !trimmedReply.toLowerCase().includes("i cannot") &&
      !trimmedReply.toLowerCase().includes("i'm unable") &&
      !trimmedReply.toLowerCase().includes("i can't");

    if (isUsefulResponse && keywords.length >= 2) {
      learnIntent(message, trimmedReply, detectedAction, detectedTopic, keywords);
    }
  }

  const result = { reply: trimmedReply, model: MODELS.smart, source: "groq", learned: false };

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
  const code = await groqFetch(messages, MODELS.smart, 0.3, 2048);
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
    const raw     = await groqFetch(messages, MODELS.fast, 0.2, 256);
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
    const raw     = await groqFetch(messages, MODELS.fast, 0.2, 512);
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
    const raw     = await groqFetch(messages, MODELS.fast, 0.8, 1024);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch { return []; }
}

// ── LEARNED INTENTS MANAGEMENT ────────────────────────────────
function getLearnedIntentsStats() {
  const data = loadLearnedIntents();
  return {
    total:    data.intents.length,
    hits:     data.stats?.hits || 0,
    topIntents: data.intents
      .sort((a, b) => (b.hitCount || 0) - (a.hitCount || 0))
      .slice(0, 10)
      .map(i => ({ action: i.action, topic: i.topic, hits: i.hitCount, keywords: i.keywords.slice(0, 3) })),
  };
}

function getAllLearnedIntents() {
  return loadLearnedIntents().intents;
}

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

function isConfigured() { return !!GROQ_API_KEY; }

module.exports = {
  chat,
  generateCode,
  analyzeIntent,
  extractKnowledge,
  generateTrainingExamples,
  groqFetch,
  MODELS,
  isConfigured,
  // Learning functions
  learnIntent,
  matchLearnedIntent,
  extractKeywords,
  getLearnedIntentsStats,
  getAllLearnedIntents,
  deleteLearnedIntent,
  clearLearnedIntents,
};
