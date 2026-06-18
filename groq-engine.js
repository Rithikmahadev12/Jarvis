"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Groq AI Engine
// Free tier — no credit card needed
// Models: llama3-8b-8192, llama3-70b-8192, mixtral-8x7b-32768
// ═══════════════════════════════════════════════════════════════

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// ── MODEL TIERS ───────────────────────────────────────────────
// Use fast small model for most things, big model for code gen
const MODELS = {
  fast:  "llama3-8b-8192",      // Fast, good for conversation
  smart: "llama3-70b-8192",     // Slower, better for code/reasoning
  mix:   "mixtral-8x7b-32768",  // Good balance
};

// ── CACHE ─────────────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;
function getCached(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(k); return null; }
  return e.data;
}
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

// ── CORE FETCH ────────────────────────────────────────────────
async function groqFetch(messages, model = MODELS.fast, temperature = 0.7, maxTokens = 1024) {
  if (!GROQ_API_KEY) {
    throw new Error("GROQ_API_KEY not set in environment variables");
  }

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq API error ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  return data.choices[0]?.message?.content || "";
}

// ── JARVIS PERSONALITY SYSTEM PROMPT ─────────────────────────
function getSystemPrompt(userTitle = "Sir", memories = [], context = "") {
  return `You are J.A.R.V.I.S (Just A Rather Very Intelligent System), Tony Stark's AI assistant. You speak with dry wit, precision, and warmth. You address the user as "${userTitle}".

Key traits:
- Concise but complete answers
- Dry British wit without being sarcastic to the point of rudeness  
- Genuinely helpful and proactive
- Never robotic or formulaic
- Reference specific details from the conversation

${memories.length > 0 ? `Things you know about the user: ${memories.join(", ")}` : ""}
${context ? `Context: ${context}` : ""}

Respond naturally as JARVIS would. Keep responses under 3 sentences unless complexity demands more. Never start with "I" — start with something more interesting.`;
}

// ── MAIN CHAT FUNCTION ────────────────────────────────────────
async function chat(message, options = {}) {
  const {
    userTitle = "Sir",
    memories = [],
    context = "",
    conversationHistory = [],
    model = MODELS.fast,
  } = options;

  const cacheKey = `chat:${message.toLowerCase().trim()}:${userTitle}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const messages = [
    { role: "system", content: getSystemPrompt(userTitle, memories, context) },
    ...conversationHistory.slice(-6), // Keep last 3 exchanges for context
    { role: "user", content: message },
  ];

  try {
    const reply = await groqFetch(messages, model, 0.75, 512);
    const result = { reply: reply.trim(), model, source: "groq" };
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    console.error("[GROQ] Chat error:", e.message);
    throw e;
  }
}

// ── CODE GENERATION ───────────────────────────────────────────
// Used by self-improvement system to generate new handlers
async function generateCode(prompt, context = "") {
  const messages = [
    {
      role: "system",
      content: `You are an expert Node.js developer working on J.A.R.V.I.S, an AI assistant system. 
Generate clean, production-quality JavaScript code.
Rules:
- Use "use strict"
- No external dependencies beyond what's in package.json (express, cors, socket.io, archiver)
- Export as module.exports
- Include error handling
- Code must be immediately runnable
- Return ONLY the code, no markdown, no explanation, no backticks
${context}`
    },
    { role: "user", content: prompt }
  ];

  try {
    const code = await groqFetch(messages, MODELS.smart, 0.3, 2048);
    // Strip any markdown code blocks if model adds them anyway
    return code
      .replace(/^```(?:javascript|js)?\n?/gm, "")
      .replace(/```$/gm, "")
      .trim();
  } catch (e) {
    console.error("[GROQ] Code generation error:", e.message);
    throw e;
  }
}

// ── INTENT ANALYSIS ───────────────────────────────────────────
// Analyze what the user actually wanted when JARVIS failed
async function analyzeIntent(message, failedResponse, userTitle = "Sir") {
  const messages = [
    {
      role: "system",
      content: `You analyze failed AI assistant responses to understand what the user actually wanted.
Return a JSON object with these exact fields:
{
  "intent": "short description of what user wanted",
  "category": "one of: question, command, creative, calculation, lookup, conversation, unknown",
  "keywords": ["array", "of", "key", "words"],
  "suggestedHandler": "brief description of what code should handle this",
  "confidence": 0.0 to 1.0
}
Return ONLY valid JSON, nothing else.`
    },
    {
      role: "user",
      content: `User said: "${message}"
JARVIS responded with: "${failedResponse}"
This response was inadequate. What did the user actually want?`
    }
  ];

  try {
    const raw = await groqFetch(messages, MODELS.fast, 0.2, 256);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("[GROQ] Intent analysis error:", e.message);
    return {
      intent: "unknown",
      category: "unknown",
      keywords: [],
      suggestedHandler: "general fallback improvement",
      confidence: 0
    };
  }
}

// ── TRAINING DATA GENERATION ──────────────────────────────────
// Generate example conversations for a given topic
async function generateTrainingExamples(topic, count = 5) {
  const messages = [
    {
      role: "system",
      content: `Generate training examples for J.A.R.V.I.S AI assistant.
Return a JSON array of objects with "input" and "output" fields.
JARVIS speaks with dry wit, precision, addresses user as "Sir" or "Ma'am".
Return ONLY valid JSON array, nothing else.`
    },
    {
      role: "user",
      content: `Generate ${count} diverse training examples for the topic: "${topic}".
Each example should show a user request and ideal JARVIS response.`
    }
  ];

  try {
    const raw = await groqFetch(messages, MODELS.fast, 0.8, 1024);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    console.error("[GROQ] Training generation error:", e.message);
    return [];
  }
}

// ── RESPONSE QUALITY SCORER ───────────────────────────────────
async function scoreResponse(userMessage, response) {
  const messages = [
    {
      role: "system",
      content: `Score the quality of an AI assistant response on a scale of 0-10.
Return ONLY a JSON object: {"score": number, "reason": "brief reason"}
10 = perfect, 0 = completely wrong or useless.`
    },
    {
      role: "user",
      content: `User asked: "${userMessage}"
Assistant responded: "${response}"
Score this response.`
    }
  ];

  try {
    const raw = await groqFetch(messages, MODELS.fast, 0.1, 128);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { score: 5, reason: "Could not evaluate" };
  }
}

// ── KNOWLEDGE EXTRACTION ──────────────────────────────────────
// Extract structured knowledge from unstructured text
async function extractKnowledge(text, topic) {
  const messages = [
    {
      role: "system",
      content: `Extract key facts from text about a topic.
Return a JSON object: {
  "facts": ["array of key facts"],
  "definition": "one sentence definition",
  "relatedTopics": ["related topics"],
  "applications": ["real world applications"]
}
Return ONLY valid JSON.`
    },
    {
      role: "user",
      content: `Topic: "${topic}"\nText: "${text.slice(0, 2000)}"`
    }
  ];

  try {
    const raw = await groqFetch(messages, MODELS.fast, 0.2, 512);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { facts: [], definition: "", relatedTopics: [], applications: [] };
  }
}

function isConfigured() { return !!GROQ_API_KEY; }

module.exports = {
  chat,
  generateCode,
  analyzeIntent,
  generateTrainingExamples,
  scoreResponse,
  extractKnowledge,
  groqFetch,
  MODELS,
  isConfigured,
};
