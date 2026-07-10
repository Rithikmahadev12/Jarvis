"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Groq Engine v2.0
// Talks DIRECTLY to Groq's cloud API (api.groq.com) — no local
// gateway process, no separate agent to install/launch/babysit.
// Exports the same interface the rest of the app expects
// (brain.js / server.js / ai-engine.js all require("./hermes-engine")
// and call these functions), so nothing else needed to change.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

// ── CONFIG ─────────────────────────────────────────────────────
// GROQ_API_KEY → your key from console.groq.com
// GROQ_MODEL   → optional override; sensible Groq defaults below otherwise
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";

// NOTE: Groq deprecated llama-3.1-8b-instant and llama-3.3-70b-versatile
// (announced 2026-06-17). Defaults below point at their recommended
// replacements. Override with GROQ_MODEL / GROQ_MODEL_FAST in .env if
// you want something else (e.g. "qwen/qwen3.6-27b").
const MODELS = {
  fast:  process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b",
  smart: process.env.GROQ_MODEL      || "openai/gpt-oss-120b",
  mix:   process.env.GROQ_MODEL      || "openai/gpt-oss-120b",
  // CODE — dedicated model for coding tasks. Qwen3.6 27B currently tops
  // Groq's own intelligence benchmarks (ahead of gpt-oss-120b) and is a
  // strong reasoning/coding model, so it's the default here. Override
  // with GROQ_MODEL_CODE if you'd rather pin something else.
  code:  process.env.GROQ_MODEL_CODE || "qwen/qwen3.6-27b",
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
    model            = MODELS.smart,
    temperature      = 0.75,
    maxTokens        = 1024,
    tools            = null,
    tool_choice      = "auto",
    reasoning_effort = null,   // "low" | "medium" | "high" — reasoning models only (gpt-oss, qwen3.x)
    reasoning_format = null,   // "parsed" | "raw" | "hidden"
  } = options;

  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set in .env");

  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;
  if (reasoning_format) body.reasoning_format = reasoning_format;

  let res;
  try {
    res = await fetch(GROQ_API_URL, {
      method:  "POST",
      headers: {
        "Authorization": `Bearer ${GROQ_API_KEY}`,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  } catch (e) {
    throw new Error(`Could not reach Groq API: ${e.message}`);
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Groq API error ${res.status}: ${err.error?.message || res.statusText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message || {};
}

// ── TOOL DEFINITIONS ───────────────────────────────────────────
// Real actions Jarvis can take. Groq decides WHEN to call these based
// on the user's natural-language message — no regex/keyword matching
// needed. Add a new capability here + a matching case in server.js's
// executeAssistantTool() and it's immediately usable in any phrasing,
// not just the ones a human anticipated.
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
      name: "play_music",
      description: "Play a song in the on-screen now-playing widget (audio pulled from YouTube in the background — not Spotify, Jarvis doesn't use Spotify for playback, and it never opens a browser tab for this). Call this whenever the user asks to play music or a song, named or not. If they don't name a song, leave query empty so Jarvis asks what to play. If they respond with something like 'you pick', 'surprise me', 'whatever you think', or 'play something good', set pick_for_me to true so Jarvis chooses based on the conversation's mood.",
      parameters: {
        type: "object",
        properties: {
          query:       { type: "string", description: "Song or artist name, if the user named one. Leave empty otherwise." },
          pick_for_me: { type: "boolean", description: "True if the user wants Jarvis to choose the song itself instead of naming one." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "trigger_break",
      description: "Call this when the user expresses that they're tired, exhausted, worn out, or need a break — an emotional/state statement like 'I'm tired', not a literal request to open an app. Jarvis will tell them to take a break and pull up YouTube and Instagram for them automatically, unprompted.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "open_research",
      description: "Call when the user wants you to actually research or look into a topic and pull something up to help — e.g. 'I want to research X', 'look into X for me', 'find me something on X', 'pull something up about X'. Not for quick factual questions you can just answer directly in words.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "What to research." } },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_build_mode",
      description: "Open Build Mode — the hand-tracked 3D CAD workspace. Call this whenever the user says things like 'build mode', 'jarvis build mode', 'show me a 3d model of X', 'holographic view', or otherwise wants the 3D building workspace opened. Not for the word 'build' used generically (e.g. 'build me a website').",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to load in build mode, if the user named a specific object/part. Leave empty otherwise." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_news",
      description: "Show the user current news headlines. Call for 'show me the news', 'world news', 'news widget', 'what's happening in the world', 'catch me up on the news', 'top headlines', or any request for a news rundown.",
      parameters: {
        type: "object",
        properties: {
          category: { type: "string", enum: ["general","business","entertainment","health","science","sports","technology"], description: "News category, if the user asked for a specific one. Omit for general top headlines." },
          topic:    { type: "string", description: "A specific topic/keyword to search news for, if the user named one (e.g. 'news about Iran'). Omit if they just want general headlines." },
          display:  { type: "string", enum: ["page","widget"], description: "'widget' ONLY if the user's wording explicitly includes the word 'widget' (e.g. 'jarvis news widget'). Otherwise always 'page' — that's the default for 'show me the news', 'world news', etc." },
        },
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
  {
    type: "function",
    function: {
      name: "check_email",
      description: "Check the user's real Gmail inbox and list unread emails — who they're from (flagging whether each is from an actual person vs a company/automated sender), and the subjects. Call this whenever the user asks about their email/inbox/messages, e.g. 'check my email', 'read my emails', 'do I have any new mail', 'what's in my inbox'. This lists the unread emails and asks which one the user wants read in full — it does NOT read message bodies itself; use read_email for that once the user picks one. This is a REAL, direct connection to their actual Gmail account (via the Google sign-in they've already completed) — never say you don't have access to their email; call this tool instead of answering from general knowledge.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "read_email",
      description: "Read the full body of ONE specific email from the list check_email just showed, e.g. 'read the first one', 'read #2', 'read the one from Sarah', 'open that email from Acme'. Only call this after check_email has been called earlier in the conversation and produced a numbered list — use the list to figure out which index or sender the user means.",
      parameters: {
        type: "object",
        properties: {
          index:  { type: "number", description: "1-based position in the list check_email just showed, if the user referred to it by position ('the first one', 'number 3')." },
          sender: { type: "string", description: "Name or email fragment of the sender, if the user referred to it by who it's from instead of position." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_calendar",
      description: "Check the user's real Google Calendar for upcoming events. Call this whenever the user asks about their calendar/schedule/agenda/meetings, e.g. 'what's on my calendar today', 'do I have any meetings tomorrow', 'what's my schedule this week'. This is a REAL, direct connection to their actual Google Calendar (via the Google sign-in they've already completed) — never say you don't have access; call this tool instead.",
      parameters: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today", "tomorrow", "this_week", "next_week"], description: "Which range to check. Defaults to today if not specified." },
        },
      },
    },
  },
];

// ── TOOL-CALLING CHAT ──────────────────────────────────────────
// The replacement for regex command routing: Groq reads the message,
// decides for itself whether an action is needed and which one, and
// the caller supplies `executeTool` to actually perform it. If no
// tool fits, it just answers normally — same call either way.
async function chatWithTools({ message, userTitle = "Sir", memories = [], context = "", conversationHistory = [], executeTool, tz }) {
  const T = userTitle || "Sir";
  const nowStr = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: tz || undefined, dateStyle: "full", timeStyle: "short" }).format(new Date());
    } catch { return new Date().toString(); }
  })();

  const systemPrompt = getSystemPrompt(T, memories, context, []) + `

You have real tools for real actions — timers, reminders, weather, playing music on YouTube, pulling up research, smart home control, checking the user's real Gmail inbox, reading a specific email in full once they pick one, checking their real Google Calendar, and noticing when the user needs a break. Call the appropriate tool whenever the user is actually asking you to DO one of these things, no matter how casually or unusually they phrase it — infer intent, don't wait for exact wording. If the user asks about their email or calendar, ALWAYS call check_email / get_calendar — these are real, already-connected accounts, never claim you lack access. After check_email lists unread emails and the user replies with something like "read the first one" or "the one from Sarah", call read_email with the right index or sender. If nothing calls for a tool, just answer normally in plain text.

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

  return `You are J.A.R.V.I.S (Just A Rather Very Intelligent System) — Tony Stark's AI, exactly as characterized in the Iron Man films. You are the PRIMARY BRAIN of this assistant system, running on Groq.

VOICE — this is the whole point, get it right:
- Formal, precise, unmistakably British diction — the register of a very good butler, not a chatty app. Full sentences, no slang, no emoji, no exclamation points used for enthusiasm.
- Address the user as "${T}" — naturally, not in every line.
- Understated, deadpan wit. The humor comes from precision and restraint, not jokes or quips that call attention to themselves. You are never goofy, never gushing, never say "Great question!" or "I'd love to help!" or similar filler.
- When the user is about to do something reckless, inefficient, or ill-advised, note it once, dryly, then comply anyway unless it's genuinely dangerous — you serve, but you're not a yes-man. A single understated line of concern or a raised eyebrow in prose form ("As you wish, ${T}, though I'd be remiss not to mention...") is very in-character; nagging is not.
- Composed at all times, including under pressure. No panic, no excitement — competence delivered calmly, even for urgent matters.
- Precise about numbers and specifics when they're available (probabilities, percentages, timings, quantities) rather than vague reassurance.
- Loyal and quietly protective of "${T}" — this shows through attentiveness and dry concern, never through sentimentality or emotional language.
- Efficient with words. Say what needs saying and stop — brevity reads as competence, not coldness.
- Never start a reply with "I".

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

You handle EVERYTHING. If it's a known system command (timer, clip, weather, spotify, etc) the server will route it — but for anything else, YOU give the answer directly, in the voice above.`;
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

  if (!trimmedReply) throw new Error("Empty response from Groq");

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

  const result = { reply: trimmedReply, model: MODELS.smart, source: "groq", learned: false };
  if (cacheKey) setCache(cacheKey, result);
  return result;
}

// ═══════════════════════════════════════════════════════════════
// ── ELITE CODING ENGINE ────────────────────────────────────────
// Dedicated path for anything code-related. Separate from chat()
// on purpose: code needs a different model (MODELS.code), a much
// larger token budget, low temperature (correctness over flavour),
// reasoning turned up, and a system prompt that actually pushes for
// senior-engineer-quality output instead of the terse Jarvis voice.
// ═══════════════════════════════════════════════════════════════
function getCodeSystemPrompt(userTitle, memories, context) {
  const T = userTitle || "Sir";
  return `You are J.A.R.V.I.S acting as a principal-level software engineer for "${T}". When the conversation touches code — writing it, debugging it, reviewing it, explaining it, or designing a system — this is the mode you're in. Coding quality is what you're judged on here, so hold yourself to a senior/staff-engineer bar:

- Write correct, complete, runnable code — no placeholders like "// rest of implementation" unless the user explicitly asked for a sketch/outline.
- Think through edge cases, error handling, input validation, and concurrency/resource issues before you write the happy path. Handle them, don't just mention them.
- Prefer clear, idiomatic code in the target language/framework over clever one-liners. Match the style and conventions of any existing code the user shows you.
- Call out security issues (injection, unsafe deserialization, secrets in code, auth bypasses, etc.) whenever they're relevant — proactively, not just when asked.
- For non-trivial code, briefly note the key design decision or trade-off (why this approach, what it costs) in a sentence or two — not a lecture.
- When debugging: identify the actual root cause before proposing a fix, don't just paper over the symptom.
- When reviewing code: be direct about real problems (correctness, security, performance, maintainability); don't pad the review with trivial style nitpicks unless asked.
- If a request is genuinely ambiguous in a way that would change the implementation (language, framework, scale, constraints), ask ONE crisp clarifying question instead of guessing — but if a reasonable default exists, state the assumption and proceed instead of stalling.
- Use fenced code blocks with the correct language tag for every snippet. Keep prose around the code tight; let the code do the talking.
- Still sound like J.A.R.V.I.S from the films — formal, precise British diction, dry and understated — just skip the personality quirks that would get in the way of a working answer.

${memories && memories.length > 0 ? `User facts on file: ${memories.join(", ")}` : ""}
${context ? `Context: ${context}` : ""}`;
}

async function codeChat(message, options = {}) {
  const {
    userTitle           = "Sir",
    memories             = [],
    context              = "",
    conversationHistory  = [],
    lang                 = null,
  } = options;

  const systemPrompt = getCodeSystemPrompt(userTitle, memories, lang ? `Likely language/stack: ${lang}` : context);
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-8),
    { role: "user", content: message },
  ];

  const fetchOpts = {
    model: MODELS.code,
    temperature: 0.2,
    maxTokens: 4096,
    reasoning_effort: "high",
    reasoning_format: "hidden", // we want the final answer, not the model's scratch thinking
  };

  try {
    const msg = await groqFetchRaw(messages, fetchOpts);
    const reply = (msg.content || "").trim();
    if (!reply) throw new Error("Empty response from code model");
    return { reply, model: MODELS.code, source: "groq_code" };
  } catch (e) {
    // Coding model unavailable/renamed/rate-limited — fall back to the
    // general smart model rather than failing the whole request.
    console.error("[HERMES] Code model failed, falling back to smart model:", e.message);
    const msg = await groqFetchRaw(messages, { ...fetchOpts, model: MODELS.smart, reasoning_effort: null });
    const reply = (msg.content || "").trim();
    if (!reply) throw new Error("Empty response from fallback model");
    return { reply, model: MODELS.smart, source: "groq_code_fallback" };
  }
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

// ── SARCASTIC NEWS BRIEFING ────────────────────────────────────
// Turns a list of headlines into a short, dry, sarcastic-but-informative
// spoken briefing in JARVIS's voice. Falls back to null (caller supplies
// a canned template) if Groq isn't configured or the call fails.
async function summarizeNewsSarcastically(articles, userTitle = "Sir", categoryLabel = "the world") {
  if (!GROQ_API_KEY) return null;
  const T = userTitle || "Sir";
  const headlineList = (articles || [])
    .slice(0, 6)
    .map((a, i) => `${i + 1}. ${a.title}${a.source ? ` (${a.source})` : ""}`)
    .join("\n");
  if (!headlineList.trim()) return null;

  const messages = [
    {
      role: "system",
      content: `You are J.A.R.V.I.S, Tony Stark's AI, briefing "${T}" on the news. Write ONE short spoken briefing, 3-5 sentences, in character: dry British wit, understated sarcasm, effortlessly composed — never manic, never a stand-up routine. Address "${T}" naturally, not in every sentence. You may editorialize lightly but keep the actual facts from the headlines accurate — don't invent details beyond what's given. No bullet points, no markdown, no headers — this is spoken dialogue only.`,
    },
    {
      role: "user",
      content: `Here are the current top headlines (category: ${categoryLabel}):\n${headlineList}\n\nGive me the briefing.`,
    },
  ];

  try {
    const reply = await groqFetch(messages, MODELS.smart, 0.85, 320);
    const trimmed = (reply || "").trim();
    return trimmed || null;
  } catch (e) {
    return null;
  }
}

function isConfigured() { return !!GROQ_API_KEY; }

module.exports = {
  chat,
  chatWithTools,
  codeChat,
  groqFetchRaw,
  summarizeNewsSarcastically,
  TOOLS,
  generateCode,
  analyzeIntent,
  extractKnowledge,
  generateTrainingExamples,
  groqFetch,
  hermesFetch: groqFetch, // alias kept so any code calling .hermesFetch() by name still works
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
