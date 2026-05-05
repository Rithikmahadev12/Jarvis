require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const https    = require("https");
const http     = require("http");
const { exec } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "30mb" }));

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".css"))  res.setHeader("Content-Type", "text/css");
    if (filePath.endsWith(".js"))   res.setHeader("Content-Type", "application/javascript");
    if (filePath.endsWith(".html")) res.setHeader("Content-Type", "text/html");
    if (filePath.endsWith(".ico"))  res.setHeader("Content-Type", "image/x-icon");
  }
}));

// ── LINKS BANK ──────────────────────────────────────────────────────────────
const LINKS = {
  vapor: [
    "http://mededucation.org",
  ],
  infamous: [
    "https://hyperhub1344.b-cdn.net/",
    "https://cleandash9674.b-cdn.net/",
    "https://megaflux3286.b-cdn.net/",
    "https://sharpsite2701.b-cdn.net/",
    "https://megacache1652.b-cdn.net/",
    "https://superhost9557.b-cdn.net/",
    "https://ultranet9636.b-cdn.net/",
    "https://nextbeam6587.b-cdn.net/",
    "https://purebeam1223.b-cdn.net/",
    "https://cleansite3286.b-cdn.net/",
    "https://hyperwave5054.b-cdn.net/",
    "https://ultradash8638.b-cdn.net/",
    "https://brightcdn3129.b-cdn.net/",
    "https://quicklink3482.b-cdn.net/",
    "https://sharpcore2756.b-cdn.net/",
    "https://megapath4376.b-cdn.net/",
    "https://apexlink4070.b-cdn.net/",
    "https://clearzone3146.b-cdn.net/",
    "https://hyperflux1709.b-cdn.net/",
    "https://freshpath2163.b-cdn.net/",
    "https://rapidhost8809.b-cdn.net/",
    "https://nextflux2080.b-cdn.net/",
    "https://smartwave1191.b-cdn.net/",
    "https://quickhub6633.b-cdn.net/",
    "https://brightnet6599.b-cdn.net/",
    "https://clearnode9151.b-cdn.net/",
    "https://sharphost7119.b-cdn.net/",
    "https://ultragrid9599.b-cdn.net/",
    "https://boldcache3697.b-cdn.net/",
    "https://purecache8424.b-cdn.net/",
    "https://superwave1352.b-cdn.net/",
    "https://swiftsite2312.b-cdn.net/",
    "https://cleanhost7990.b-cdn.net/",
    "https://supervolt8657.b-cdn.net/",
    "https://cleanvolt4067.b-cdn.net/",
    "https://sharphost9404.b-cdn.net/",
    "https://freshgrid6118.b-cdn.net/",
    "https://cleanlink9053.b-cdn.net/",
    "https://swiftpath2975.b-cdn.net/",
    "https://swiftpipe1923.b-cdn.net/",
    "https://ultravolt1357.b-cdn.net/",
    "https://sharpbeam2341.b-cdn.net/",
    "https://primelink8224.b-cdn.net/",
    "https://pureweb5487.b-cdn.net/",
    "https://swiftlink1714.b-cdn.net/",
  ],
};

function lookupLink(text) {
  const lower = text.toLowerCase();
  for (const [name, urls] of Object.entries(LINKS)) {
    if (lower.includes(name)) {
      const url = urls[Math.floor(Math.random() * urls.length)];
      return { found: true, name, url };
    }
  }
  return { found: false };
}

function getLinksSummary() {
  const groups = Object.entries(LINKS).map(([name, urls]) => `${name} (${urls.length} link${urls.length > 1 ? "s" : ""})`);
  const total  = Object.values(LINKS).reduce((s, arr) => s + arr.length, 0);
  return { groups, total, names: Object.keys(LINKS) };
}

function getAllLinksFormatted() {
  const out = [];
  for (const [name, urls] of Object.entries(LINKS)) {
    out.push({ name, count: urls.length, urls });
  }
  return out;
}

// ── LINKS API ────────────────────────────────────────────────────────────────
app.get("/api/links",         (req, res) => res.json({ groups: Object.keys(LINKS), summary: getLinksSummary(), all: getAllLinksFormatted() }));
app.get("/api/links/summary", (req, res) => res.json(getLinksSummary()));
app.get("/api/links/all",     (req, res) => res.json({ links: getAllLinksFormatted() }));

app.post("/api/link", (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ found: false });
  res.json(lookupLink(query));
});

// ── PERSISTENT STORE ─────────────────────────────────────────────────────────
const DATA_DIR      = path.join(__dirname, "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const MEMORIES_FILE = path.join(DATA_DIR, "memories.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR))      fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, JSON.stringify({}), "utf8");
  if (!fs.existsSync(MEMORIES_FILE)) fs.writeFileSync(MEMORIES_FILE, JSON.stringify({}), "utf8");
}
function loadProfiles() { ensureDataDir(); try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")); } catch { return {}; } }
function saveProfiles(p) { ensureDataDir(); fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2), "utf8"); }
function loadMemories() { ensureDataDir(); try { return JSON.parse(fs.readFileSync(MEMORIES_FILE, "utf8")); } catch { return {}; } }
function saveMemories(m) { ensureDataDir(); fs.writeFileSync(MEMORIES_FILE, JSON.stringify(m, null, 2), "utf8"); }

app.get("/favicon.ico", (req, res) => res.status(204).end());

// ── PROFILE ROUTES ────────────────────────────────────────────────────────────
app.post("/api/register", (req, res) => {
  const { name, passwordHash, title, voiceAliases } = req.body;
  if (!name || !passwordHash) return res.status(400).json({ error: "Missing fields" });
  const profiles = loadProfiles();
  const key = name.toLowerCase().trim();
  profiles[key] = {
    name: name.trim(), passwordHash, title: title || "Sir",
    voiceAliases: voiceAliases || [],
    createdAt: profiles[key]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  saveProfiles(profiles);
  res.json({ success: true });
});

app.get("/api/profile/:name", (req, res) => {
  const profiles = loadProfiles();
  const key = req.params.name.toLowerCase().trim();
  const profile = profiles[key];
  if (!profile) return res.json({ found: false });
  const { passwordHash, ...safe } = profile;
  res.json({ found: true, profile: safe });
});

app.post("/api/verify", (req, res) => {
  const { name, passwordHash } = req.body;
  if (!name || !passwordHash) return res.status(400).json({ authorized: false });
  const profiles = loadProfiles();
  const key = name.toLowerCase().trim();
  const stored = profiles[key];
  if (!stored) return res.json({ authorized: false, reason: "no_profile" });
  if (stored.passwordHash !== passwordHash) return res.json({ authorized: false, reason: "wrong_password" });
  const { passwordHash: _, ...safe } = stored;
  res.json({ authorized: true, profile: safe });
});

app.get("/api/profiles", (req, res) => {
  const profiles = loadProfiles();
  const list = Object.values(profiles).map(({ name, title, voiceAliases }) => ({ name, title, voiceAliases }));
  res.json({ profiles: list });
});

// ── MEMORY ROUTES ─────────────────────────────────────────────────────────────
app.get("/api/memory/:user", (req, res) => {
  const mem = loadMemories();
  res.json({ memories: mem[req.params.user.toLowerCase().trim()] || [] });
});

app.post("/api/memory", (req, res) => {
  const { user, fact } = req.body;
  if (!user || !fact) return res.status(400).json({ error: "Missing fields" });
  const mem = loadMemories();
  const key = user.toLowerCase().trim();
  if (!mem[key]) mem[key] = [];
  mem[key].push({ fact: fact.trim(), savedAt: new Date().toISOString() });
  if (mem[key].length > 50) mem[key] = mem[key].slice(-50);
  saveMemories(mem);
  res.json({ success: true });
});

app.post("/api/memory/forget", (req, res) => {
  const { user, hint } = req.body;
  if (!user || !hint) return res.status(400).json({ error: "Missing fields" });
  const mem = loadMemories();
  const key = user.toLowerCase().trim();
  if (!mem[key]) return res.json({ removed: 0 });
  const before = mem[key].length;
  mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(hint.toLowerCase()));
  saveMemories(mem);
  res.json({ removed: before - mem[key].length });
});

// ══════════════════════════════════════════════════════════════════════════════
// ── POLLINATIONS AI BRAIN ─────────────────────────────────────────────────────
// Free, no key, no account. Uses Mistral/Llama under the hood.
// Endpoint: https://text.pollinations.ai/openai
// ══════════════════════════════════════════════════════════════════════════════

const POLLINATIONS_URL = "https://text.pollinations.ai/openai";
const AI_MODEL         = "mistral";   // or "llama", "openai" — all free on Pollinations

// Per-session conversation history for multi-turn context
const sessionHistories = new Map();
function getHistory(sessionId) {
  if (!sessionHistories.has(sessionId)) {
    const h = [];
    h._ts = Date.now();
    sessionHistories.set(sessionId, h);
  }
  return sessionHistories.get(sessionId);
}
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, hist] of sessionHistories) {
    if (hist._ts && hist._ts < cutoff) sessionHistories.delete(id);
  }
}, 600000);

// ── BUILD SYSTEM PROMPT ───────────────────────────────────────────────────────
function buildSystemPrompt(userName, userTitle, memories, linkNames, linkTotal) {
  const T = userTitle || "Sir";
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true });
  const dateStr = now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const memBlock = memories && memories.length
    ? `\nStored facts about ${userName}:\n${memories.map(m => `- ${m}`).join("\n")}`
    : "";

  const linkBlock = linkNames && linkNames.length
    ? `\nConfigured link groups the user can open by name: ${linkNames.join(", ")} (${linkTotal} total links).`
    : "";

  return `You are J.A.R.V.I.S — Just A Rather Very Intelligent System. A sophisticated AI with dry British wit, precision, and genuine intelligence. The user's name is ${userName || "unknown"} and you address them as "${T}".

Current time: ${timeStr}. Today: ${dateStr}.
${memBlock}
${linkBlock}

YOUR PERSONALITY:
- Confident, precise, subtly witty, genuinely helpful
- No sycophantic openers ("Certainly!", "Of course!", "Great question!")
- Speak like a brilliant British butler who is also a supercomputer
- Short, punchy, intelligent responses — under 3 sentences usually
- When you can DO something, just do it — don't ask for confirmation unless truly ambiguous
- You have real capabilities. Use them autonomously based on what the user wants

YOUR CAPABILITIES (use these naturally when relevant):
- Open saved link groups by name (${linkNames?.join(", ") || "none configured"})
- Save/clip screen or camera recordings
- Set timers and reminders with natural durations
- Store and recall memories across sessions
- Read and analyse screen content via OCR
- Switch between connected cameras
- Check system status and diagnostics
- Control Spotify playback
- Check Gmail inbox
- Check Google Calendar events
- Fetch live weather
- Show all saved links

CRITICAL: You MUST respond with ONLY valid JSON. No markdown, no text outside the JSON. Exactly this format:
{"reply": "Your spoken response here", "action": "ACTION_CODE", "meta": {}}

ACTION CODES — pick the right one based on what the user actually wants:
- "NONE" — conversation, questions, knowledge, opinions, math you answer inline, anything not listed below
- "OPEN_LINK" — user wants to visit/open/launch a named link group. meta: {"query": "the group name they said"}
- "SHOW_LINKS" — user wants to see all saved links displayed
- "CLIP_SAVE" — save/clip/record recent footage. meta: {"clipType": "both|screen|camera", "duration": milliseconds_or_null}
- "SHOW_CLIPS" — show recorded intruder/incident clips
- "READ_SCREEN" — read or analyse what's on screen. meta: {"question": "what they asked about the screen"}
- "SWITCH_CAMERA" — change to a different camera. meta: {"cameraIndex": zero_based_integer}
- "SYSTEM_STATUS" — run system health/diagnostics check
- "MEMORY_SAVE" — remember a fact. meta: {"saveFact": "the exact fact to store, extracted from what they said"}
- "MEMORY_RECALL" — show all stored memories
- "MEMORY_FORGET" — delete a memory. meta: {"forgetHint": "the search string to match and delete"}
- "LOGOUT" — end session and log out
- "NOTIF_SETTINGS" — open notification settings panel
- "TIMER" — set a timer or reminder. meta: {"action": "TIMER_SET", "duration": milliseconds, "task": "what to remind about or null"}
- "WEATHER" — fetch live weather. The server will get the data.
- "SPOTIFY" — music/Spotify control. The server will handle it.
- "GMAIL" — check email. The server will fetch it.
- "CALENDAR" — check calendar/schedule. The server will fetch it.

DURATION RULES for TIMER meta:
- "5 minutes" = 300000
- "30 seconds" = 30000
- "1 hour" = 3600000
- "half an hour" = 1800000
- "2 hours 30 minutes" = 9000000

SMART RULES:
- If user asks about time or date → answer directly in reply, action: "NONE" (you already know it)
- If user asks a maths question → compute it yourself and answer in reply, action: "NONE"
- If user mentions a link group name (${linkNames?.join(", ") || ""}) and wants to open it → action: "OPEN_LINK"
- If user says "remember X" or "note that X" → action: "MEMORY_SAVE", extract exactly what to remember
- If user says "what do you remember" or similar → action: "MEMORY_RECALL"
- If user mentions clipping/saving footage → action: "CLIP_SAVE"
- If user mentions setting a timer/reminder → action: "TIMER"
- If the request is ambiguous but you CAN do something useful → do it, don't ask
- For weather/Spotify/Gmail/Calendar → use the right action code, the server fetches the data

No markdown in reply. No bullet points. No asterisks. Spoken English only. Be concise and sharp.`;
}

// ── CALL POLLINATIONS AI ──────────────────────────────────────────────────────
async function callPollinations(messages, systemPrompt) {
  const payload = JSON.stringify({
    model:    AI_MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    temperature: 0.72,
    max_tokens:  400,
    response_format: { type: "json_object" },
    private: true,   // don't log/share our prompts
    seed: Math.floor(Math.random() * 999999),
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "text.pollinations.ai",
      path:     "/openai",
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(payload),
        "Accept":         "application/json",
      },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error("Pollinations parse error: " + data.slice(0, 300)));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Pollinations timeout")); });
    req.write(payload);
    req.end();
  });
}

// ── SMART LOCAL FALLBACK ──────────────────────────────────────────────────────
// Used when Pollinations is unreachable. Handles the most common cases locally.
function localFallback(message, userName, userTitle, memories) {
  const T     = userTitle || "Sir";
  const lower = message.toLowerCase().trim();
  const now   = new Date();

  // Time
  if (/what.*time|current time|time is it/i.test(lower)) {
    const t = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true });
    return { reply: `It's ${t}, ${T}.`, action: "NONE", meta: {} };
  }

  // Date
  if (/what.*date|what day|today'?s date/i.test(lower)) {
    const d = now.toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    return { reply: `Today is ${d}, ${T}.`, action: "NONE", meta: {} };
  }

  // Math — handle inline
  const mathTest = lower.match(/(\d+)\s*([\+\-\*\/]|times|plus|minus|divided by)\s*(\d+)/i);
  if (mathTest) {
    try {
      const expr = lower
        .replace(/times/gi, "*").replace(/plus/gi, "+")
        .replace(/minus/gi, "-").replace(/divided by/gi, "/");
      const numExpr = expr.match(/[\d\s\+\-\*\/\.\(\)]+/)?.[0]?.trim();
      if (numExpr) {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${numExpr})`)();
        if (isFinite(result)) return { reply: `That's ${result}, ${T}.`, action: "NONE", meta: {} };
      }
    } catch {}
  }

  // Links
  if (/show.*link|all link|link bank/i.test(lower)) {
    return { reply: `Pulling up your link bank now, ${T}.`, action: "SHOW_LINKS", meta: {} };
  }
  const linkResult = lookupLink(lower);
  if (linkResult.found) {
    return { reply: `Opening ${linkResult.name} now, ${T}.`, action: "OPEN_LINK", meta: { query: lower } };
  }
  if (/open|launch|go to|pull up/i.test(lower)) {
    return { reply: `I couldn't find a matching link group, ${T}. Say "show links" to see what's available.`, action: "NONE", meta: {} };
  }

  // Clip/record
  if (/clip|save.*footage|record that|save that|grab that/i.test(lower)) {
    return { reply: `Saving the clip now, ${T}.`, action: "CLIP_SAVE", meta: { clipType: "both", duration: null } };
  }

  // Timer
  const timerDur = lower.match(/(\d+)\s*(second|minute|hour|min|sec|hr)/i);
  if (timerDur && /timer|remind|alarm|alert/i.test(lower)) {
    const n    = parseInt(timerDur[1]);
    const unit = timerDur[2].toLowerCase();
    const ms   = unit.startsWith("h") ? n * 3600000 : unit.startsWith("m") ? n * 60000 : n * 1000;
    const label = `${n} ${unit}${n > 1 ? "s" : ""}`;
    return { reply: `Timer set for ${label}, ${T}.`, action: "TIMER", meta: { action: "TIMER_SET", duration: ms, task: null } };
  }

  // Memory
  if (/what.*remember|show.*memor|recall|memory bank/i.test(lower)) {
    if (memories && memories.length) {
      return { reply: `I have ${memories.length} item${memories.length > 1 ? "s" : ""} stored, ${T}. Starting with: ${memories[0]}.`, action: "MEMORY_RECALL", meta: {} };
    }
    return { reply: `Nothing stored yet, ${T}.`, action: "MEMORY_RECALL", meta: {} };
  }
  if (/remember|note that|memorize|keep that|store/i.test(lower)) {
    const factMatch = lower.match(/(?:remember|note that|memorize|store|keep that)\s+(?:that\s+)?(.+)/i);
    const fact = factMatch ? factMatch[1].trim() : lower;
    return { reply: `Noted and filed, ${T}.`, action: "MEMORY_SAVE", meta: { saveFact: fact } };
  }

  // Status
  if (/status|diagnostics|health|system check|uptime/i.test(lower)) {
    return { reply: `Running diagnostics, ${T}.`, action: "SYSTEM_STATUS", meta: {} };
  }

  // Logout
  if (/log.*out|logout|goodbye|shut.*down|exit.*session/i.test(lower)) {
    return { reply: `Goodbye, ${T}. Initiating shutdown.`, action: "LOGOUT", meta: {} };
  }

  // Screen read
  if (/read.*screen|what.*screen|screen.*say|analyse.*screen/i.test(lower)) {
    return { reply: `Reading your screen now, ${T}.`, action: "READ_SCREEN", meta: { question: lower } };
  }

  // Weather
  if (/weather|temperature|forecast|rain|sunny|hot|cold/i.test(lower)) {
    return { reply: `Fetching weather for you, ${T}.`, action: "WEATHER", meta: {} };
  }

  // Spotify
  if (/music|spotify|play|pause|skip|next song|what.*playing/i.test(lower)) {
    return { reply: `On it, ${T}.`, action: "SPOTIFY", meta: {} };
  }

  // Gmail
  if (/email|gmail|inbox|unread|mail/i.test(lower)) {
    return { reply: `Checking your inbox, ${T}.`, action: "GMAIL", meta: {} };
  }

  // Calendar
  if (/calendar|schedule|meeting|appointment|agenda/i.test(lower)) {
    return { reply: `Pulling up your calendar, ${T}.`, action: "CALENDAR", meta: {} };
  }

  // Greeting
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|yo|sup)/i.test(lower)) {
    const h   = now.getHours();
    const tod = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    return { reply: `Good ${tod}, ${T}. Running in local mode — inference is temporarily unavailable. I can still handle most commands.`, action: "NONE", meta: {} };
  }

  // Default
  return {
    reply: `I'm running without inference right now, ${T}. I can handle commands — links, clips, timers, memory — but open questions need the AI back online.`,
    action: "NONE",
    meta:   {}
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// ── MAIN CHAT ENDPOINT ────────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════════════
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  const T           = userTitle || "Sir";
  const linkSummary = getLinksSummary();
  const history     = getHistory(sessionId);
  history._ts       = Date.now();

  let parsed;

  try {
    // Build conversation messages (last 10 turns for context)
    const contextMessages = history
      .filter(m => m && m.role)
      .slice(-10);
    contextMessages.push({ role: "user", content: message });

    const systemPrompt = buildSystemPrompt(
      userName, T, memories,
      linkSummary.names, linkSummary.total
    );

    const aiResponse = await callPollinations(contextMessages, systemPrompt);

    // Extract content from response
    const rawContent =
      aiResponse?.choices?.[0]?.message?.content ||
      aiResponse?.message?.content ||
      aiResponse?.content ||
      "";

    // Parse JSON from AI response
    try {
      const cleaned = rawContent
        .replace(/```json\n?/g, "")
        .replace(/```\n?/g, "")
        .trim();

      // Handle cases where model wraps in extra text
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(cleaned);
    } catch {
      // If JSON parse fails, treat raw content as the reply
      parsed = {
        reply:  rawContent || `Understood, ${T}.`,
        action: "NONE",
        meta:   {}
      };
    }

    // Store turn in history
    history.push({ role: "user",      content: message });
    history.push({ role: "assistant", content: rawContent });

    // Keep history from ballooning
    while (history.filter(m => m && m.role).length > 20) {
      const firstIdx = history.findIndex(m => m && m.role);
      if (firstIdx !== -1) history.splice(firstIdx, 1);
    }

  } catch (err) {
    console.error("[Pollinations] Error:", err.message);
    parsed = localFallback(message, userName, userTitle, memories);
  }

  // Ensure we always have something valid
  if (!parsed || typeof parsed !== "object") {
    parsed = localFallback(message, userName, userTitle, memories);
  }

  const reply  = (parsed.reply  || `Understood, ${T}.`).replace(/[*_`#]/g, "");
  const action = parsed.action || "NONE";
  const meta   = parsed.meta   || {};

  return await processAction(action, meta, reply, message, userName, userTitle, T, linkSummary, res);
});

// ── ACTION PROCESSOR ──────────────────────────────────────────────────────────
async function processAction(action, meta, reply, message, userName, userTitle, T, linkSummary, res) {

  // Show all links
  if (action === "SHOW_LINKS") {
    return res.json({
      reply, action,
      meta: {
        requestLinks: true,
        linkGroups:   getAllLinksFormatted(),
        total:        linkSummary.total
      }
    });
  }

  // Open a specific link group
  if (action === "OPEN_LINK") {
    const query = meta?.query || message;
    const link  = lookupLink(query);
    return res.json({ reply, action, meta: { ...meta, ...link } });
  }

  // Save a memory
  if (action === "MEMORY_SAVE" && meta?.saveFact) {
    const mem = loadMemories();
    const key = (userName || "user").toLowerCase().trim();
    if (!mem[key]) mem[key] = [];
    // Avoid storing duplicates
    const exists = mem[key].some(m => m.fact.toLowerCase() === meta.saveFact.toLowerCase());
    if (!exists) {
      mem[key].push({ fact: meta.saveFact, savedAt: new Date().toISOString() });
      if (mem[key].length > 50) mem[key] = mem[key].slice(-50);
      saveMemories(mem);
    }
    return res.json({ reply, action, meta: { saved: !exists, fact: meta.saveFact } });
  }

  // Forget a memory
  if (action === "MEMORY_FORGET") {
    const hint = meta?.forgetHint || "";
    if (hint) {
      const mem = loadMemories();
      const key = (userName || "user").toLowerCase().trim();
      if (mem[key]) {
        const before = mem[key].length;
        mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(hint.toLowerCase()));
        saveMemories(mem);
        const removed = before - mem[key].length;
        const finalReply = removed > 0
          ? `Done, ${T}. ${removed} memory entry removed.`
          : `Nothing matching that on file, ${T}.`;
        return res.json({ reply: finalReply, action, meta: {} });
      }
    }
    return res.json({ reply: `Nothing to remove, ${T}.`, action, meta: {} });
  }

  // System status
  if (action === "SYSTEM_STATUS") {
    const uptime = Math.floor(process.uptime());
    const m      = process.memoryUsage();
    const mins   = Math.floor(uptime / 60), secs = uptime % 60;
    const used   = (m.heapUsed / 1024 / 1024).toFixed(1);
    const total  = (m.heapTotal / 1024 / 1024).toFixed(1);
    const statusReply = `All systems nominal, ${T}. Uptime: ${mins}m ${secs}s. Heap: ${used} MB of ${total} MB. Pollinations AI engine active.`;
    return res.json({ reply: statusReply, action, meta: { uptime, heapUsed: used, heapTotal: total } });
  }

  // Weather — fetch live data
  if (action === "WEATHER") {
    try {
      const weather = require("./weather");
      const data    = await weather.handleWeatherCommand(message);
      return res.json({ reply, action, meta: { weatherData: data } });
    } catch {
      return res.json({ reply: `Weather module isn't available right now, ${T}.`, action: "NONE", meta: {} });
    }
  }

  // Spotify
  if (action === "SPOTIFY") {
    try {
      const spotify = require("./spotify");
      const data    = await spotify.handleSpotifyCommand(message);
      return res.json({ reply, action, meta: { spotifyData: data } });
    } catch {
      return res.json({ reply: `Spotify module isn't connected, ${T}.`, action: "NONE", meta: {} });
    }
  }

  // Gmail
  if (action === "GMAIL") {
    try {
      const google = require("./google");
      const data   = await google.handleGmailCommand(message);
      return res.json({ reply, action, meta: { gmailData: data } });
    } catch {
      return res.json({ reply: `Gmail module isn't connected, ${T}.`, action: "NONE", meta: {} });
    }
  }

  // Calendar
  if (action === "CALENDAR") {
    try {
      const google = require("./google");
      const data   = await google.handleCalendarCommand(message);
      return res.json({ reply, action, meta: { calendarData: data } });
    } catch {
      return res.json({ reply: `Calendar module isn't connected, ${T}.`, action: "NONE", meta: {} });
    }
  }

  // Everything else — pass straight through to client
  return res.json({ reply, action, meta });
}

// ── SCREEN ANALYSIS ────────────────────────────────────────────────────────────
app.post("/api/screen", async (req, res) => {
  const { ocrText, question, userName, userTitle, memories } = req.body;
  const T = userTitle || "Sir";

  if (!ocrText || ocrText.trim().length < 5) {
    return res.json({ reply: `I received the screen frame but couldn't extract readable text, ${T}.` });
  }

  try {
    const systemPrompt = `You are J.A.R.V.I.S. Analyse the screen content and answer the question concisely. Address the user as "${T}". Respond with ONLY JSON: {"reply": "your spoken answer"}`;
    const userMsg      = `Screen content: "${ocrText.trim().slice(0, 800)}"\nQuestion: "${question || "What is on my screen?"}"`;

    const result     = await callPollinations([{ role: "user", content: userMsg }], systemPrompt);
    const rawContent = result?.choices?.[0]?.message?.content || result?.message?.content || "";

    let reply;
    try {
      const p = JSON.parse(rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
      reply = p.reply || rawContent;
    } catch {
      reply = rawContent || `Your screen shows: ${ocrText.trim().slice(0, 200)}`;
    }

    return res.json({ reply });
  } catch (err) {
    console.error("[Screen] AI error:", err.message);
    const lines = ocrText.trim().split("\n").filter(l => l.trim().length > 2).slice(0, 5);
    return res.json({ reply: `On your screen, ${T}: ${lines.join(". ")}` });
  }
});

// ── TTS PROXY ─────────────────────────────────────────────────────────────────
app.get("/api/tts", async (req, res) => {
  const text  = req.query.text;
  const voice = req.query.voice || "Brian";
  if (!text) return res.status(400).send("No text");
  const clean = text.trim().slice(0, 600);
  const url   = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(clean)}`;
  https.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; JARVIS/2.0)",
      "Accept":     "audio/mpeg, audio/*, */*"
    }
  }, (ttsRes) => {
    if (ttsRes.statusCode !== 200) return res.status(502).send("TTS error");
    res.setHeader("Content-Type", ttsRes.headers["content-type"] || "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=300");
    ttsRes.pipe(res);
  }).on("error", () => res.status(502).send("TTS network error"));
});

app.get("/api/tts/voices", (req, res) => {
  res.json({
    voices:      ["Brian","Amy","Emma","Geraint","Russell","Joey","Matthew","Joanna","Salli","Hans","Giorgio","Carla"],
    recommended: "Brian",
  });
});

// ── GOOGLE OAUTH CALLBACK ─────────────────────────────────────────────────────
app.get("/api/google/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("<h2>No code received.</h2>");
  try {
    const google = require("./google");
    const result = await google.exchangeCode(code);
    if (result.error) return res.send(`<h2>Auth error: ${result.error}</h2>`);
    res.send(`<h2>Google connected!</h2><script>setTimeout(()=>window.close(),2000)</script>`);
  } catch { res.send("<h2>Google module not found.</h2>"); }
});

// ── SPOTIFY OAUTH CALLBACK ────────────────────────────────────────────────────
app.get("/api/spotify/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("<h2>No code received.</h2>");
  try {
    const spotify = require("./spotify");
    const result  = await spotify.exchangeCode(code);
    if (result.error) return res.send(`<h2>Auth error: ${result.error}</h2>`);
    res.send(`<h2>Spotify connected!</h2><script>setTimeout(()=>window.close(),2000)</script>`);
  } catch { res.send("<h2>Spotify module not found.</h2>"); }
});

// ── AI STATUS ENDPOINT ────────────────────────────────────────────────────────
app.get("/api/ai/status", async (req, res) => {
  try {
    const testPayload = JSON.stringify({
      model:       AI_MODEL,
      messages:    [{ role: "user", content: "ping" }],
      max_tokens:  5,
      private:     true,
    });
    const result = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: "text.pollinations.ai",
        path:     "/openai",
        method:   "POST",
        headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(testPayload) },
      }, (r) => {
        let d = ""; r.on("data", c => d += c);
        r.on("end", () => resolve({ ok: r.statusCode === 200 }));
      });
      req.on("error", reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error("timeout")); });
      req.write(testPayload);
      req.end();
    });
    res.json({ available: result.ok, model: AI_MODEL, provider: "Pollinations AI" });
  } catch {
    res.json({ available: false, model: AI_MODEL, provider: "Pollinations AI" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nJ.A.R.V.I.S online → http://localhost:${PORT}`);
  console.log(`AI Brain: Pollinations AI (${AI_MODEL}) — no API key required`);
  console.log(`Endpoint: ${POLLINATIONS_URL}\n`);
});
