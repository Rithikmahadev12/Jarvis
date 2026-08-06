"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Groq Engine v2.0
// Talks DIRECTLY to Groq's cloud API (api.groq.com) — no local
// gateway process, no separate agent to install/launch/babysit, and
// no local Ollama model to install/run. Exports the same interface
// the rest of the app expects
// (brain.js / server.js / ai-engine.js all require("./hermes-engine")
// and call these functions), so nothing else needed to change.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const GroqKeys = require("./groq-keys");
const LocalLLM = require("./local-llm");

// ── CONFIG ─────────────────────────────────────────────────────
// GROQ_API_KEY → your key from console.groq.com. Add GROQ_API_KEY2,
// GROQ_API_KEY3, etc. in .env for automatic failover — see
// groq-keys.js for details.
// GROQ_MODEL   → optional override; sensible Groq defaults below otherwise
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

  // ── LOCAL MODE — try Ollama first, but ONLY for plain replies ───
  // isLocalMode() is true whenever we're not on Render (i.e. running
  // on the user's own machine). If Ollama is actually up and serving,
  // use it instead of Groq — but only when this call has no `tools`.
  // Small local models are both much slower AND much less reliable
  // once you hand them a full function-calling schema (this project
  // ships 36 tool definitions, ~27KB of JSON — reading that alone is
  // most of the cost on CPU-only hardware, before it even generates a
  // token). Anything that needs tool-calling stays on Groq, which is
  // both faster (real inference hardware) and more accurate at
  // picking the right tool anyway. If Ollama isn't running, isn't
  // reachable, or errors out, fall straight through to Groq below.
  if (LocalLLM.isLocalMode() && !(tools && tools.length)) {
    try {
      const serving = await LocalLLM.isOllamaServing();
      if (serving) {
        const msg = await LocalLLM.ollamaChat(messages, { temperature, maxTokens, tools, tool_choice });
        return msg;
      }
    } catch (e) {
      console.warn(`[HERMES] Local Ollama call failed, falling back to Groq: ${e.message}`);
    }
  }

  if (!GroqKeys.hasGroqKey()) throw new Error("GROQ_API_KEY not set in .env");

  const body = { model, messages, temperature, max_tokens: maxTokens, stream: false };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }
  if (reasoning_effort) body.reasoning_effort = reasoning_effort;
  if (reasoning_format) body.reasoning_format = reasoning_format;

  const doFetch = (key) => fetch(GROQ_API_URL, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  // ── MULTI-KEY FAILOVER ────────────────────────────────────────
  // If only GROQ_API_KEY is set, behavior is unchanged from before.
  // If GROQ_API_KEY2 (etc.) is also set, a network failure, timeout,
  // rate limit (429), auth problem (401/403 — e.g. a revoked key), or
  // Groq-side error (5xx) on the current key rotates to the next key
  // and retries immediately instead of surfacing the failure. Each
  // key is tried at most once per call; if every key fails, the last
  // error encountered is what gets thrown.
  const totalKeys = GroqKeys.groqKeyCount();
  let lastError = null;

  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = GroqKeys.currentGroqKey();
    const keyLabel = totalKeys > 1 ? ` (key ${attempt + 1}/${totalKeys})` : "";
    const isLastKey = attempt === totalKeys - 1;

    let res;
    try {
      res = await doFetch(key);
    } catch (e) {
      lastError = new Error(`Could not reach Groq API${keyLabel}: ${e.message}`);
      if (isLastKey) throw lastError;
      console.warn(`[GROQ]${keyLabel} network failure: ${e.message} — rotating to next key...`);
      GroqKeys.rotateGroqKey();
      continue;
    }

    // ── 429 (RATE LIMIT) ──────────────────────────────────────────
    // With only one key: wait out Groq's own stated cooldown and
    // retry the SAME key once, same as before multi-key support
    // existed. With more than one key: skip the wait and rotate to
    // the next key immediately instead — strictly faster when a
    // fallback is available.
    if (res.status === 429) {
      if (totalKeys > 1) {
        const errBody = await res.json().catch(() => ({}));
        lastError = new Error(`Groq API error 429${keyLabel}: ${errBody.error?.message || "rate limit reached"}`);
        if (isLastKey) throw lastError;
        console.warn(`[GROQ]${keyLabel} hit its rate limit — rotating to next key...`);
        GroqKeys.rotateGroqKey();
        continue;
      }
      const err = await res.json().catch(() => ({}));
      const msg = err.error?.message || "";
      const waitMatch = msg.match(/try again in ([\d.]+)s/i);
      const waitSecs = waitMatch ? Math.min(parseFloat(waitMatch[1]), 15) : null;
      if (waitSecs !== null) {
        await new Promise(r => setTimeout(r, Math.ceil(waitSecs * 1000) + 250));
        try {
          res = await doFetch(key);
        } catch (e) {
          throw new Error(`Could not reach Groq API: ${e.message}`);
        }
      } else {
        throw new Error(`Groq API error 429: ${msg || "rate limit reached"}`);
      }
    }

    // ── AUTH / SERVER ERRORS ───────────────────────────────────────
    // 401/403 (bad or revoked key) and 5xx (Groq-side trouble) are
    // worth trying the next key for; anything else (400 bad request,
    // etc.) fails immediately since another key wouldn't fix it.
    if (!res.ok && (res.status === 401 || res.status === 403 || res.status >= 500) && !isLastKey) {
      const errBody = await res.json().catch(() => ({}));
      lastError = new Error(`Groq API error ${res.status}${keyLabel}: ${errBody.error?.message || res.statusText}`);
      console.warn(`[GROQ]${keyLabel} failed with ${res.status} — rotating to next key...`);
      GroqKeys.rotateGroqKey();
      continue;
    }

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(`Groq API error ${res.status}: ${err.error?.message || res.statusText}`);
    }

    const data = await res.json();
    return data.choices?.[0]?.message || {};
  }

  throw lastError || new Error("All configured Groq API keys failed.");
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
      description: "Play a song in the on-screen now-playing widget (audio pulled from YouTube in the background — not Spotify, Jarvis doesn't use Spotify for playback, and it never opens a browser tab for this). Call this whenever the user asks to play music or a song, named or not. If they don't name a song, leave query empty so Jarvis asks what to play. If they respond with something like 'you pick', 'surprise me', 'whatever you think', or 'play something good', set pick_for_me to true so Jarvis chooses based on the conversation's mood. IMPORTANT: 'jarvis play <anything>' is ALWAYS this tool, even if the name sounds unusual or could be misread as referring to video/recording — Jarvis has no tool that plays back a saved recording or clip, so never route a 'play' request to start_recording, stop_recording, or clip_recording instead. This includes phrases like 'play back in black' or 'play back <song>' — 'back' there is normally just part of the song title (e.g. AC/DC's 'Back in Black') or filler word, NOT the verb 'play back' meaning review old footage; treat the whole phrase after 'play' as the song query (e.g. query: 'back in black') and call play_music, not stop_recording.",
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
          display:  { type: "string", enum: ["page","widget"], description: "'widget' ONLY if the user's wording explicitly includes the word 'widget' (e.g. 'jarvis news widget', 'pull up the news widget'). Otherwise always 'page' — that's the default for 'show me the news', 'world news', 'what's on the news', etc." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "control_home",
      description: "Control smart home devices that were scanned/added on the home network — lights, plugs, thermostats, casting audio, IP/RTSP security cameras added on the home panel, etc. NEVER use this for the built-in webcam / on-screen camera feed, or for phrases like 'camera mode', 'turn on camera', 'turn on camera mode', 'activate camera' — those always mean show_camera, not a smart-home device. Only use control_home when the user clearly names a home device/room (lights, plugs, thermostat) or explicitly says 'smart home' / 'home panel'.",
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
      name: "make_board",
      description: "Create a small floating on-screen info board about a topic and display it right on the main screen (not a page or panel). Call this for things like 'make a board on how you work', 'make me a board about the solar system', 'jarvis, board on X'. The board is written by you and saved so it can be pulled back up later, even after the page is refreshed.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "What the board should be about, e.g. 'how you work', 'the solar system', 'my morning routine'." } },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "show_board",
      description: "Pull up a board that was already made earlier, by topic — e.g. 'pull up the board we made on how you work', 'show me that board again', 'bring back the solar system board'. Do NOT use this to make a new board; use make_board for that.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "The topic/title of the board to pull up. Leave empty if the user just says 'that board' / 'the board' with no topic — this will bring back the most recent one." } },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_boards",
      description: "List all the boards currently saved — 'what boards do I have', 'what boards have we made'.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "forget_board",
      description: "Permanently delete a saved board by topic — 'delete the board on X', 'forget that board', 'get rid of the board about X'. Note: dragging a board off the edge of the screen only hides it on screen; use this tool when the user wants it actually deleted from storage.",
      parameters: {
        type: "object",
        properties: { topic: { type: "string", description: "The topic/title of the board to delete." } },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "call_on_teams",
      description: "Place a real audio or video call to a person over Microsoft Teams (vision-guided UI automation on the user's real Teams desktop app — not Graph API). Call this for ANY phrasing that means 'get this person on a call' — 'call X', 'call X on teams', 'can you call X for me', 'give X a call', 'dial X', 'video call X', 'ring X on teams', etc. Do NOT use open_on_computer for this — that only launches the Teams app window and does nothing else, it can't find the person or press Call. If the user also wants a message relayed once connected (e.g. 'call X and tell them I'll join soon'), pass that in note_to_relay.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string", description: "The name of the person to call, as the user said it." },
          video: { type: "boolean", description: "True if they asked for a video call specifically; false/omit for a plain audio call." },
          note_to_relay: { type: "string", description: "Anything the user wants said to the person once the call connects, e.g. \"I'll join soon\" / \"I'll be back shortly\". Omit if nothing to relay." },
        },
        required: ["person"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "message_on_teams",
      description: "Send a real chat message to a person on Microsoft Teams (vision-guided — opens the actual chat and types/sends it). Call this for phrasing like 'message X on teams', 'text X on teams', 'tell X ... on teams', 'let X know ... on teams'.",
      parameters: {
        type: "object",
        properties: {
          person: { type: "string", description: "The name of the person to message." },
          text: { type: "string", description: "The exact message to send." },
        },
        required: ["person", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "join_teams_meeting",
      description: "Join an online meeting. If the user gave a link (Teams/Zoom/Google Meet), pass it in link and Jarvis opens it directly and works through the join flow. Otherwise pass meeting_hint (e.g. 'the standup') to find it in today's Teams calendar, or omit it to join whatever meeting is currently live/starting soonest. If the user also wants something relayed once they're in, pass note_to_relay.",
      parameters: {
        type: "object",
        properties: {
          link: { type: "string", description: "A meeting URL, if the user provided one." },
          meeting_hint: { type: "string", description: "Which meeting to join by name/topic, when no link was given." },
          note_to_relay: { type: "string", description: "Anything to say once joined, e.g. \"I'll join soon\". Omit if nothing to relay." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "open_on_computer",
      description: "Open an application, file, folder, or URL on the user's own computer — e.g. 'open VS Code', 'launch chrome', 'open my resume'. Only works when Jarvis is running locally, not in the cloud. IMPORTANT: for compound requests like 'open VS Code and type a flappy bird script', call THIS tool AND type_text in the SAME response — don't stop after just opening. IMPORTANT: never use this for camera requests ('open camera', 'open the camera', 'show camera') — those mean the on-screen webcam feed, not launching an OS camera app. Use show_camera for those instead.",
      parameters: {
        type: "object",
        properties: { target: { type: "string", description: "The app name, file/folder path, or URL to open." } },
        required: ["target"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_disk_space",
      description: "Check how much storage space is free/used on the user's own computer. Call for things like 'how much space do I have on my computer', 'check my disk space', 'how full is my drive/hard drive'. Only works when Jarvis is running locally on the user's machine, not in the cloud.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "run_computer_command",
      description: "Run a shell/terminal command on the user's own computer, e.g. 'check my battery', 'list files in Downloads', 'what's my IP address', 'run ipconfig'. Only works when Jarvis is running locally on the user's machine, not in the cloud. A short allowlist of read-only commands (like checking disk space, listing files) runs immediately; anything else asks the user to confirm before it actually runs.",
      parameters: {
        type: "object",
        properties: { command: { type: "string", description: "The literal shell command to run, translated to the right command for the user's OS if you can infer it (Windows/macOS/Linux)." } },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "type_text",
      description: "Type text into whatever window currently has focus on the user's own computer. Covers two kinds of requests: (1) literal dictation, e.g. 'type this for me: ...'; and (2) generation requests, e.g. 'type/write a flappy bird script', 'write a poem into the doc' — for these, YOU generate the actual full content yourself (real working code, real poem, etc.) and pass it as `text`; never ask the user to dictate it first. Only works when Jarvis is running locally. Always asks the user to confirm before actually typing, since it acts on whatever they're currently looking at.",
      parameters: {
        type: "object",
        properties: {
          text:     { type: "string", description: "The exact text to type — dictated verbatim, or generated by you if the user asked for code/writing rather than giving literal words." },
          new_file: { type: "boolean", description: "True if this should go into a brand-new file/tab (e.g. right after opening an editor) rather than wherever focus currently is — Jarvis will send Ctrl/Cmd+N before typing." },
        },
        required: ["text"],
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
  {
    type: "function",
    function: {
      name: "show_camera",
      description: "Open the live camera feed fullscreen on screen — e.g. 'show camera', 'open camera', 'open the camera', 'turn on camera mode', 'turn on camera', 'activate camera mode', 'enable camera mode', 'jarvis show me the camera', 'pull up the camera feed', 'let me see what the camera sees', 'full screen the camera'. This is ALWAYS what any 'camera' or 'camera mode' request means from Jarvis — never route these to open_on_computer or control_home, even though control_home can technically manage other smart-home cameras. The built-in on-screen webcam always wins unless the user explicitly names a smart-home camera by location (e.g. 'turn on the driveway camera'). Turns the camera on first if it isn't already active. IMPORTANT: if the phrase pairs 'camera mode' with an off/stop/disable/close/exit/hide word (e.g. 'disable camera mode', 'turn off camera mode', 'exit camera mode'), that is NOT this tool — use hide_camera instead.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "hide_camera",
      description: "Close the fullscreen camera feed that show_camera opened — e.g. 'hide the camera', 'close the camera view', 'get rid of the camera feed', 'turn off camera mode', 'disable camera mode', 'exit camera mode', 'stop camera mode', 'deactivate camera mode'. Any 'camera mode' phrasing paired with an off/stop/disable/close/exit word means THIS tool, not show_camera. Does not turn the camera itself off, just closes the fullscreen view.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "start_recording",
      description: "Begin recording video to a downloadable file — e.g. 'start recording this tab', 'record my screen', 'jarvis start recording', 'record my webcam'. Recording continues until stop_recording is called, at which point the file downloads. If Jarvis is running locally on the user's own computer, 'record my screen' or an unspecified 'start recording' should default to source 'screen' (the whole desktop); if Jarvis is being used on the hosted site, default to 'tab' instead, since a bare browser tab can't capture the whole desktop the same way. Always use 'tab' when the user specifically says 'this tab' or 'my tab', 'screen' when they say 'my screen'/'whole screen'/'desktop', and 'webcam' when they say 'webcam'/'camera' recording (as a saved file, not the live camera feed toggled by show_camera). NEVER call this for a 'play <song/artist>' request — that always means play_music, regardless of what the song/artist name sounds like.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["screen", "tab", "webcam"], description: "What to record. Infer 'screen' vs 'tab' from local vs hosted if the user didn't specify." },
        },
        required: ["source"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "stop_recording",
      description: "Stop whatever recording start_recording began, and download the finished video file. Only call this when the message explicitly says to STOP or END a recording — e.g. 'stop recording', 'end recording', 'jarvis stop recording', 'that's enough, save it'. Do NOT call this just because the words 'play', 'back', or 'recording' appear somewhere in the message — e.g. 'play back in black' is a song request (play_music), not this tool. If there's no clear stop/end instruction, don't call this.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "clip_recording",
      description: "Instantly save and download the last N seconds of screen/webcam activity that already happened, WITHOUT needing start_recording first — e.g. 'jarvis clip the last 30 seconds', 'clip that', 'save the last minute', 'grab the last 20 seconds of my webcam'. Jarvis keeps a short rolling buffer running in the background (up to about 60 seconds) whenever screen sharing and/or the webcam are active, so this works retroactively. Default to source 'screen' and 30 seconds if the user just says 'clip that' with no detail. This tool only SAVES a clip to a file — it never plays anything back. NEVER call this for a 'play <song/artist>' request — that always means play_music.",
      parameters: {
        type: "object",
        properties: {
          seconds: { type: "number", description: "How many of the last seconds to save. Defaults to 30 if not specified. Max useful value is about 60." },
          source:  { type: "string", enum: ["screen", "webcam", "both"], description: "Which feed to clip from. Defaults to 'screen'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_screen",
      description: "Look at whatever is currently on the user's shared screen and answer a question about it, describe it, or riff on it — e.g. 'what's on my screen', 'read my screen', 'what am I looking at', 'what am I doing right now', and ALSO any request to be funny/witty about the real content on screen: 'roast me', 'roast my screen', 'make fun of what I'm doing', 'clown on me', 'make a joke about what I'm doing', 'razz me based on my screen', 'talk trash about my tabs'. Requires the user to already be screen-sharing — if they aren't, Jarvis will say so and ask them to share first, so always call this rather than guessing from memory or claiming you can't see anything. Pass the user's exact question/request through in the question field so the right tone (informational vs. a joke) carries through.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "The user's request verbatim or lightly cleaned up — e.g. 'What is on my screen?' or 'Roast me based on what I'm doing right now.'" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "scan_for_threats",
      description: "Run a security sweep of the user's own computer for viruses/malware/suspicious activity — e.g. 'scan my computer for viruses', 'is there a hacker on my machine', 'check for threats', 'am I infected'. Only works when Jarvis is running locally (not the hosted site). Checks the OS's own built-in protection where available (e.g. Windows Defender) and flags suspicious-looking processes/connections. If it finds something, Jarvis will report it and ask whether to neutralize it — the user's next 'yes' handles that automatically, so don't also call neutralize_threat immediately after this in the same turn.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "neutralize_threat",
      description: "Act on a threat scan_for_threats just flagged and asked about — e.g. user says 'neutralize it', 'get rid of it', 'kill it', 'remove the threat' as a direct instruction rather than a plain 'yes'. Terminates the flagged process or quarantines the flagged file. Only call this when a scan_for_threats result is what's being reacted to; there must have been a recent threat report to act on.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "mute_jarvis",
      description: "Silence Jarvis's spoken voice output — e.g. 'mute', 'jarvis mute', 'stop talking', 'be quiet', 'keep it down', 'shut up'. Jarvis keeps listening and responding in text; only speech is silenced until unmute_jarvis is called.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "unmute_jarvis",
      description: "Restore Jarvis's spoken voice output after mute_jarvis silenced it — e.g. 'unmute', 'jarvis unmute', 'you can talk again', 'speak again'.",
      parameters: { type: "object", properties: {} },
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

  // NOTE ON TOKEN BUDGET: this account's Groq tier caps openai/gpt-oss-20b
  // at 8000 TPM (tokens/minute) — see groq-keys.js / the 429 logs. The full
  // getSystemPrompt() (personality voice/rules block) plus the ~30-tool
  // schema below plus conversation history was regularly eating most of
  // that budget in ONE request, which is what was causing both keys to
  // 429 back-to-back and the whole message to fall through to the dumb
  // legacy regex router (see server.js) instead of ever reaching the AI.
  // getSystemPrompt() already had a `compact` variant (same voice/rules,
  // ~1/3 the tokens) that just wasn't being used here — switching to it
  // is a free, behavior-preserving token cut.
  const systemPrompt = getSystemPrompt(T, memories, context, [], true) + `

You have real tools for real actions — timers, reminders, weather, playing music on YouTube, pulling up research, smart home control, checking the user's real Gmail inbox, reading a specific email in full once they pick one, checking their real Google Calendar, showing/hiding the live camera feed fullscreen, starting/stopping a downloadable screen/tab/webcam recording, instantly clipping the last N seconds of screen or webcam activity, noticing when the user needs a break, and (when Jarvis is running on the user's own computer) opening apps/files/URLs, checking disk space, running shell commands, typing text into the active window, and scanning for/neutralizing security threats. Call the appropriate tool whenever the user is actually asking you to DO one of these things, no matter how casually or unusually they phrase it — infer intent, don't wait for exact wording. COMPOUND REQUESTS matter here: if the user asks for more than one thing in the same message (e.g. "open VS Code and type a flappy bird script"), call ALL the relevant tools in that SAME response — do not stop after the first one. If the user asks about their email or calendar, ALWAYS call check_email / get_calendar — these are real, already-connected accounts, never claim you lack access. After check_email lists unread emails and the user replies with something like "read the first one" or "the one from Sarah", call read_email with the right index or sender. If nothing calls for a tool, just answer normally in plain text.

Current date/time for the user: ${nowStr}${tz ? ` (timezone: ${tz})` : ""}. Use this to compute datetime_iso for reminders.`;

  // Trimmed from -8 to -4: still enough turns for follow-ups ("read the
  // first one", "yes do that") to resolve correctly, at roughly half the
  // token cost of the full 8-turn window — same TPM-budget reasoning as
  // the compact system prompt above.
  const messages = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.slice(-4),
    { role: "user", content: message },
  ];

  // NOTE ON maxTokens/reasoning_effort: gpt-oss models spend hidden
  // "reasoning" tokens out of the same max_tokens budget before they ever
  // emit the actual tool_calls JSON. 768 was tight enough that on compound
  // requests like "open VS Code and type a flappy bird script" — where the
  // second tool call's `text` argument has to contain an entire generated
  // script — the budget would run out after the first tool call (or mid-
  // generation of the second), so type_text either never got called or got
  // truncated into invalid JSON that silently parsed as {}.
  //
  // But this account's Groq tier has an 8000 TPM (tokens/minute) cap, which
  // a single big request can eat most of on its own — so the budget is now
  // ADAPTIVE rather than always maxed out: ordinary requests (timers,
  // weather, "open Chrome") get a small budget as before, and only
  // requests that look like "open X and type/write a script/poem/etc."
  // get the bigger allowance, and only on this first call. That keeps the
  // common case cheap on tokens and means the fallback round below rarely
  // has to fire at all (each round is a separate hit against the same
  // per-minute cap).
  const looksCompoundGenerate = /\b(type|write)\b/i.test(message) &&
    /\b(script|code|program|game|function|poem|essay|story|paragraph|text|snippet|class|component)\b/i.test(message);

  const assistantMsg = await groqFetchRaw(messages, {
    tools: TOOLS,
    tool_choice: "auto",
    maxTokens: looksCompoundGenerate ? 2048 : 900,
    reasoning_effort: "low",
  });

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

  // ── SAFETY NET FOR DROPPED COMPOUND CALLS ────────────────────────
  // Even with the bigger budget, models sometimes still only call one
  // tool from a compound request despite the system-prompt instruction.
  // If the user's message opened something AND clearly also wanted
  // something typed/generated, but type_text never got called, give
  // Groq one more forced round — feeding back what already happened —
  // specifically to produce the content and call type_text. This is a
  // fallback safety net that runs AFTER Groq has already seen and acted
  // on the message, not a regex router intercepting it beforehand.
  const calledNames = results.map(r => r.name);

  if (calledNames.includes("open_on_computer") && !calledNames.includes("type_text") && looksCompoundGenerate) {
    try {
      const followupMessages = [
        ...messages,
        { role: "assistant", content: assistantMsg.content || "", tool_calls: assistantMsg.tool_calls },
        ...assistantMsg.tool_calls.map(c => ({
          role: "tool",
          tool_call_id: c.id,
          name: c.function.name,
          content: JSON.stringify(results.find(r => r.name === c.function.name)?.result || {}),
        })),
        { role: "user", content: "Now generate the actual full content that was asked for and call type_text with it as the `text` argument (set new_file: true since an editor/app was just opened)." },
      ];
      const followupMsg = await groqFetchRaw(followupMessages, {
        tools: TOOLS,
        tool_choice: { type: "function", function: { name: "type_text" } },
        maxTokens: 1800,
        reasoning_effort: "low",
      });
      if (followupMsg.tool_calls && followupMsg.tool_calls.length) {
        for (const call of followupMsg.tool_calls) {
          let args = {};
          try { args = JSON.parse(call.function.arguments || "{}"); } catch {}
          let result;
          try { result = await executeTool(call.function.name, args); }
          catch (e) { result = { reply: `That didn't go through, ${T}. ${e.message || ""}`.trim() }; }
          results.push({ name: call.function.name, args, result });
        }
      }
    } catch (e) {
      console.error("[TOOLS] Follow-up type_text round failed:", e.message);
    }
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
function getSystemPrompt(userTitle, memories, context, learnedExamples, compact = false) {
  const T = userTitle || "Sir";

  let examplesBlock = "";
  if (learnedExamples && learnedExamples.length > 0) {
    examplesBlock = `\n\nPreviously learned responses (use these as style/format reference):\n${
      learnedExamples.map(e => `User: ${e.exampleInput}\nJARVIS: ${e.exampleOutput}`).join("\n\n---\n\n")
    }`;
  }

  // ── COMPACT VARIANT ─────────────────────────────────────────────
  // Same voice/rules, condensed to roughly a third of the token count.
  // Not currently used by default, kept available for any caller that
  // wants a cheaper/shorter system prompt.
  if (compact) {
    return `You are J.A.R.V.I.S, Tony Stark's AI — formal, precise, dry British wit, address the user as "${T}" (not every line), never starts a reply with "I", never gushing or using exclamation points. Answer directly and usefully — you can handle anything (questions, code, math, advice). Keep replies under 3 sentences unless the request needs more.${memories && memories.length > 0 ? ` Known facts: ${memories.join(", ")}.` : ""}${context ? ` Context: ${context}.` : ""}${examplesBlock}`;
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
    // NOTE: this is qwen/qwen3.6-27b, not one of the gpt-oss models —
    // Groq's Qwen3.6 endpoint only accepts reasoning_effort "none" or
    // "default" and 400s on anything else ("low"/"medium"/"high" are
    // gpt-oss-only values). Sending "high" here made every single
    // codeChat() call fail and fall back to the smart model, which is
    // the "[HERMES] Code model failed" message you were seeing.
    reasoning_effort: "default",
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
  if (!GroqKeys.hasGroqKey()) return null;
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

// ── AMBIENT ASSIST ─────────────────────────────────────────────
// Not a command. This looks at a short window of speech JARVIS picked up
// WITHOUT being addressed by name, and decides on its own whether
// there's something clearly useful worth interjecting about — someone
// asked a factual question out loud, mentioned a task it could help
// with, stated a problem it can solve. Deliberately conservative: the
// default, expected answer is nothing. It's meant to interject rarely
// and be right when it does, not comment on every sentence it hears.
async function ambientAssist(snippet, userTitle = "Sir") {
  if (!GroqKeys.hasGroqKey()) return null;
  if (!snippet || snippet.trim().length < 8) return null;

  const T = userTitle || "Sir";
  const messages = [
    {
      role: "system",
      content: `You are J.A.R.V.I.S, silently overhearing a snippet of nearby conversation. Nobody said your name or spoke to you directly — you are deciding, entirely on your own, whether it's worth interjecting.

Only interject if the snippet contains something CLEARLY actionable and low-risk to jump in on — e.g. someone asked a factual question out loud that you can just answer, mentioned needing to do something you can help with (look something up, do a calculation, remember something), stated an obvious problem you could solve right now, OR expressed a want/need you could offer a concrete next step for (hungry and wondering what to eat, need to leave somewhere and don't know the time/traffic, trying to remember something).

Do NOT interject on: small talk, opinions, pure venting, arguments, jokes, or anything ambiguous with no concrete need in it. When genuinely in doubt, say nothing.

Examples:
- "mom what's for dinner, I'm hungry" → interject, offer something concrete: "If I may, ${T}, would you like me to pull up some recipes?"
- "I need to remember to call the dentist tomorrow" → interject, offer to set a reminder
- "ugh I can't believe that happened today" → NONE (venting, not a need)
- "haha that's so random" → NONE (small talk)
- "I wonder what time the game starts tonight" → interject if you can find out, or offer to check

If there's nothing worth saying, respond with EXACTLY: NONE
If there is, respond with ONE short spoken sentence, in character as JARVIS — dry, precise, respectful, address the user as "${T}" — and make it clear you're jumping in unprompted (e.g. open with "If I may, ${T}," or "Actually, ${T},"). Never repeat back what was said, never explain that you were listening — just help.`,
    },
    { role: "user", content: snippet.trim().slice(0, 600) },
  ];

  try {
    const reply = await groqFetch(messages, MODELS.fast, 0.4, 120);
    const clean = (reply || "").trim().replace(/^["']|["']$/g, "");
    if (!clean || /^none\b/i.test(clean)) return null;
    return clean;
  } catch (e) {
    console.warn("[AMBIENT] assist failed:", e.message);
    return null;
  }
}

function isConfigured() { return GroqKeys.hasGroqKey(); }

module.exports = {
  chat,
  chatWithTools,
  codeChat,
  groqFetchRaw,
  summarizeNewsSarcastically,
  ambientAssist,
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
