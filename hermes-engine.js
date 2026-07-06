"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Hermes Engine v3.0
// Talks to Nous Research's Hermes models via OpenRouter's OpenAI-
// compatible endpoint. Exports the same interface the rest of the
// app expects (brain.js / server.js / ai-engine.js all
// require("./hermes-engine")), so nothing else needs to change.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

// ── CONFIG ─────────────────────────────────────────────────────
// HERMES_API_KEY → your key from openrouter.ai/keys
const GROQ_API_KEY = process.env.HERMES_API_KEY || process.env.OPENROUTER_API_KEY || "";
const GROQ_API_URL = (process.env.HERMES_BASE_URL || "https://openrouter.ai/api/v1").replace(/\/$/, "") + "/chat/completions";

// Defaults to Nous Research's Hermes 3 405B on OpenRouter's free tier
// ($0, no credit card, capped at 20 req/min / 200 req/day).
// To upgrade later (paid), set in .env:
//   HERMES_MODEL=nousresearch/hermes-4-70b       (~$0.13/$0.40 per 1M tokens)
//   HERMES_MODEL=nousresearch/hermes-4-405b      (~$1/$3 per 1M tokens)
const MODELS = {
  fast:  process.env.HERMES_MODEL_FAST || "nousresearch/hermes-3-llama-3.1-405b:free",
  smart: process.env.HERMES_MODEL      || "nousresearch/hermes-3-llama-3.1-405b:free",
  mix:   process.env.HERMES_MODEL      || "nousresearch/hermes-3-llama-3.1-405b:free",
};

// ── LEARNED INTENTS STORE ──────────────────────────────────────
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

// ── CORE GROQ FETCH (OpenAI-compatible /v1/chat/completions) ──
async function groqFetch(messages, model = MODELS.smart, temperature = 0.75, maxTokens = 1024) {
  const msg = await groqFetchRaw(messages, { model, temperature, maxTokens });
  return msg.content || "";
}

// Like groqFetch, but returns the full assistant message object (so callers
// can see tool_calls) and accepts an optional `tools` array for function
// calling.
async function groqFetchRaw(messages, options = {}) {
  const {
    model       = MODELS.smart,
    temperature = 0.75,
    maxTokens   = 1024,
    tools       = null,
    tool_choice = "auto",
  } = options;

  if (!GROQ_API_KEY) throw new Error("HERMES_API_KEY not set in .env");

  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }

  let res;
  try {
    res = await fetch(GROQ_API_URL, {
      method:  "POST",
      headers: {
        "Authorization":  `Bearer ${GROQ_API_KEY}`,
        "Content-Type":   "application/json",
        "HTTP-Referer":   process.env.HERMES_APP_URL || "https://jarvis.local",
        "X-Title":        "J.A.R.V.I.S",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Could not reach Hermes API: ${e.message}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Hermes API error ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  if (!data || !data.choices || !data.choices.length) {
    throw new Error("Empty response from Hermes");
  }

  return data.choices?.[0]?.message || {};
}

// ── TOOL DEFINITIONS ───────────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "set_timer",
      description: "Start a short countdown timer, e.g. 'set a timer for 10 minutes' or 'ping me in 90 seconds'. Use for short countdowns — not for a reminder tied to a specific clock time or day.",
      parameters: {
        type: "object",
        properties: {
          label:            { type: "string", description: "Short label for what the timer is for." },
          duration_seconds: { type: "number", description: "How many seconds from now the timer should go off." },
        },
        required: ["duration_seconds"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_reminder",
      description: "Schedule a one-off reminder. Provide EXACTLY ONE of datetime_iso (for a specific clock time/day, e.g. 'Monday at 6pm') or duration_seconds (for a relative time, e.g. 'in 2 hours').",
      parameters: {
        type: "object",
        properties: {
          label:            { type: "string", description: "What to remind the user about." },
          datetime_iso:     { type: "string", description: "ISO 8601 datetime in the user's local timezone, e.g. 2026-07-07T18:00:00." },
          duration_seconds: { type: "number", description: "Seconds from now, if a relative time was given instead of a clock time." },
        },
        required: ["label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_conditional_reminder",
      description: "Schedule a reminder that fires the NEXT TIME a specific event happens, instead of at a clock time — e.g. 'remind me about X whenever I ask for my agenda'. Use this instead of set_reminder whenever the user's trigger is an event, not a time.",
      parameters: {
        type: "object",
        properties: {
          label:   { type: "string", description: "What to remind the user about." },
          trigger: { type: "string", enum: ["next_agenda_check"], description: "The event that fires this reminder. Currently supported: 'next_agenda_check' — the next time the user asks for their agenda/schedule/upcoming items." },
        },
        required: ["label", "trigger"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_reminder",
      description: "Cancel the most recently created timer or reminder.",
      parameters: {
        type: "object",
        properties: { type: { type: "string", enum: ["timer", "reminder", "any"], description: "Which kind to cancel." } },
        required: ["type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agenda",
      description: "Get the user's upcoming reminders/timers/events — 'what's on my agenda', 'what do I have today', 'do I have anything coming up'.",
      parameters: {
        type: "object",
        properties: { scope: { type: "string", enum: ["today", "upcoming"], description: "Limit to today, or show everything upcoming." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get current weather conditions.",
      parameters: {
        type: "object",
        properties: { location: { type: "string", description: "City name, if the user specified one. Omit to use the default configured location." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "control_spotify",
      description: "Control Spotify — play a song/artist, pause, resume, skip, check what's playing, or change volume.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The playback command in natural language, e.g. 'play Bohemian Rhapsody', 'pause', 'skip', 'volume 40', 'what's playing'." } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "control_home",
      description: "Control smart home devices — lights, plugs, thermostats, casting audio, etc.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "The home command in natural language, e.g. 'turn off the bedroom lights', 'set the thermostat to 70'." } },
        required: ["query"],
      },
    },
  },
];

// ── TOOL-CALLING CHAT ──────────────────────────────────────────
async function chatWithTools({ message, userTitle = "Sir", memories = [], context = "", conversationHistory = [], executeTool, tz }) {
  const T = userTitle || "Sir";
  const nowStr = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, dateStyle: "full", timeStyle: "short" }).format(new Date());
    } catch { return new Date().toString(); }
  })();

  const systemPrompt = getSystemPrompt(T, memories, context, []) + `

You have real tools for real actions — timers, reminders, weather, Spotify, and smart home control. Call the appropriate tool whenever the user is actually asking you to DO one of these things, no matter how casually or unusually they phrase it — infer intent, don't wait for exact wording. If nothing calls for a tool, just answer normally in plain text.

Current date/time for the user: ${nowStr}${tz ? ` (timezone: ${tz})` : ""}. Use this to compute datetime_iso for reminders.`;

  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-8),
    { role: "user", content: message },
  ];

  const assistantMsg = await groqFetchRaw(messages, { tools: TOOLS, tool_choice: "auto", maxTokens: 768 });

  if (!assistantMsg.tool_calls || !assistantMsg.tool_calls.length) {
    return { reply: (assistantMsg.content || "").trim(), toolCalls: [], usedTool: false };
  }

  const results = [];
  for (const call of assistantMsg.tool_calls) {
    let args = {};
    try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
    let result;
    try { result = await executeTool(call.function.name, args); }
    catch (e) { result = { reply: `That didn't go through, ${T}. ${e.message || ""}`.trim() }; }
    results.push({ name: call.function.name, args, result });
  }

  const primary = results[0]?.result || {};
  const reply = results.map(r => r.result?.reply).filter(Boolean).join(" ") || (assistantMsg.content || "").trim();

  return {
    reply,
    action:   primary.action,
    intent:   primary.intent,
    meta:     primary.meta,
    toolCalls: results,
    usedTool: true,
  };
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

  return `You are J.A.R.V.I.S (Just A Rather Very Intelligent System), Tony Stark's AI. You are the PRIMARY BRAIN of this assistant system, running on Nous Research's Hermes.

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

  const reply = await groqFetch(messages, MODELS.smart, 0.75, 768);
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

function isConfigured() { return !!GROQ_API_KEY; }

module.exports = {
  chat,
  chatWithTools,
  groqFetchRaw,
  TOOLS,
  generateCode,
  analyzeIntent,
  extractKnowledge,
  generateTrainingExamples,
  groqFetch,
  hermesFetch: groqFetch, 
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
