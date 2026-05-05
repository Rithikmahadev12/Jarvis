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

// ── LINKS BANK ──
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

// ── LINKS API ──
app.get("/api/links",         (req, res) => res.json({ groups: Object.keys(LINKS), summary: getLinksSummary(), all: getAllLinksFormatted() }));
app.get("/api/links/summary", (req, res) => res.json(getLinksSummary()));
app.get("/api/links/all",     (req, res) => res.json({ links: getAllLinksFormatted() }));

app.post("/api/link", (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ found: false });
  res.json(lookupLink(query));
});

// ── PERSISTENT STORE ──
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

// ── PROFILE ROUTES ──
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

// ── MEMORY ROUTES ──
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

// ══════════════════════════════════════════════════════════════
// ── OLLAMA MANAGEMENT ──
// Handles "start ollama", "stop ollama", "ollama serve" etc.
// ══════════════════════════════════════════════════════════════
const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

let ollamaProcess = null;

function startOllamaServe() {
  return new Promise((resolve) => {
    if (ollamaProcess) {
      resolve({ started: false, reason: "already_running" });
      return;
    }
    // Try to start ollama serve as a background process
    const child = exec("ollama serve", (err) => {
      // This fires when the process ends — not on start
      ollamaProcess = null;
    });
    ollamaProcess = child;
    // Give it 2 seconds to start up, then check
    setTimeout(async () => {
      const up = await ollamaAvailable();
      resolve({ started: up, pid: child.pid });
    }, 2000);
  });
}

// POST /api/ollama/start — start ollama serve
app.post("/api/ollama/start", async (req, res) => {
  const already = await ollamaAvailable();
  if (already) return res.json({ success: true, message: "Ollama is already running." });
  const result = await startOllamaServe();
  if (result.started) {
    res.json({ success: true, message: `Ollama started successfully (PID ${result.pid}).` });
  } else if (result.reason === "already_running") {
    res.json({ success: true, message: "Ollama process already tracked." });
  } else {
    res.json({ success: false, message: "Could not start Ollama. Make sure it is installed: https://ollama.ai" });
  }
});

// POST /api/ollama/pull — pull a model
app.post("/api/ollama/pull", async (req, res) => {
  const model = req.body.model || OLLAMA_MODEL;
  res.json({ success: true, message: `Pulling ${model}... this runs in the background. Check terminal for progress.` });
  // Fire and forget
  exec(`ollama pull ${model}`, (err, stdout, stderr) => {
    if (err) console.error("[Ollama pull] error:", err.message);
    else console.log("[Ollama pull] done:", stdout);
  });
});

async function ollamaAvailable() {
  return new Promise((resolve) => {
    const url = new URL(OLLAMA_URL);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port || 11434, path: "/api/tags", method: "GET" }, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
    req.end();
  });
}

// ── Ollama status endpoint ──
app.get("/api/ollama/status", async (req, res) => {
  const available = await ollamaAvailable();
  if (!available) return res.json({ available: false, model: OLLAMA_MODEL });
  return new Promise((resolve) => {
    const url = new URL(OLLAMA_URL);
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request({ hostname: url.hostname, port: url.port || 11434, path: "/api/tags", method: "GET" }, (r) => {
      let d = ""; r.on("data", c => d += c); r.on("end", () => {
        try {
          const tags = JSON.parse(d);
          const models = (tags.models || []).map(m => m.name);
          const hasModel = models.some(m => m.includes(OLLAMA_MODEL.split(":")[0]));
          res.json({ available: true, model: OLLAMA_MODEL, hasModel, models });
        } catch { res.json({ available: true, model: OLLAMA_MODEL, hasModel: false }); }
        resolve();
      });
    });
    req.on("error", () => { res.json({ available: false }); resolve(); });
    req.end();
  });
});

// ══════════════════════════════════════════════════════════════
// ── TTS PROXY — StreamElements ──
// ══════════════════════════════════════════════════════════════
app.get("/api/tts", async (req, res) => {
  const text  = req.query.text;
  const voice = req.query.voice || "Brian";
  if (!text) return res.status(400).send("No text");
  const clean = text.trim().slice(0, 600);
  const url   = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(clean)}`;
  https.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; JARVIS/2.0)", "Accept": "audio/mpeg, audio/*, */*" }
  }, (ttsRes) => {
    if (ttsRes.statusCode !== 200) return res.status(502).send("TTS error");
    res.setHeader("Content-Type", ttsRes.headers["content-type"] || "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=300");
    ttsRes.pipe(res);
  }).on("error", (err) => res.status(502).send("TTS network error"));
});

app.get("/api/tts/voices", (req, res) => {
  res.json({
    voices: ["Brian","Amy","Emma","Geraint","Russell","Joey","Matthew","Joanna","Salli","Hans","Giorgio","Carla"],
    recommended: "Brian",
  });
});

// ══════════════════════════════════════════════════════════════
// ── OLLAMA LLM CORE ──
// ══════════════════════════════════════════════════════════════
function buildSystemPrompt(userName, userTitle, memories, linkNames, linkSummary) {
  const memBlock = memories && memories.length
    ? `\nKnown facts about the user:\n${memories.map(m => `- ${m}`).join("\n")}`
    : "";
  const linkBlock = linkNames && linkNames.length
    ? `\nAvailable link groups (the user can ask to open these by name): ${linkNames.join(", ")}. Total links: ${linkSummary?.total || 0}.`
    : "";

  return `You are J.A.R.V.I.S — Just A Rather Very Intelligent System. A sophisticated AI assistant with dry British wit, precision, and genuine intelligence. The user's name is ${userName || "unknown"} and you address them as "${userTitle}".

Your personality: confident, precise, subtly witty, genuinely helpful. No sycophantic openers like "Certainly!" or "Of course!". You speak like a brilliant British butler who is also a supercomputer. Short, punchy, intelligent responses.
${memBlock}
${linkBlock}

CRITICAL INSTRUCTION: You must ALWAYS respond with ONLY valid JSON. No markdown, no text outside the JSON. Format:
{"reply": "Your spoken response here", "action": "ACTION_CODE", "meta": {}}

UNDERSTAND INTENT NATURALLY — do not rely on keywords. Infer what the user wants from context:

ACTION CODES:
- "NONE" — general talk, questions, knowledge, opinions, anything conversational
- "OPEN_LINK" — user wants to open/visit/go to a named link group. meta: {"query": "group name"}
- "SHOW_LINKS" — user wants to see all saved links
- "CLIP_SAVE" — save/clip/record screen or camera footage. meta: {"clipType": "both|screen|camera", "duration": ms_number_or_null}
- "SHOW_CLIPS" — show recorded intruder clips
- "READ_SCREEN" — read/analyze screen. meta: {"question": "what they asked"}
- "SWITCH_CAMERA" — change camera. meta: {"cameraIndex": 0_based_number}
- "SYSTEM_STATUS" — system health check
- "MEMORY_SAVE" — store a fact. meta: {"saveFact": "exact fact to store"}
- "MEMORY_RECALL" — show what's been stored
- "MEMORY_FORGET" — delete a memory. meta: {"forgetHint": "search string"}
- "LOGOUT" — log out / end session
- "NOTIF_SETTINGS" — open notification settings
- "TIMER" — set a timer. meta: {"action": "TIMER_SET", "duration": milliseconds, "task": "label or null"}
- "OLLAMA_START" — user wants to start/run ollama, says "ollama serve", "start ollama", "run ollama", etc.
- "OLLAMA_PULL" — user wants to pull/download an ollama model. meta: {"model": "model name"}
- "MATH" — calculation. meta: {"result": computed_number}
- "WEATHER" — weather query (needs fetching)
- "SPOTIFY" — music control
- "GMAIL" — email
- "CALENDAR" — calendar/schedule

DURATION PARSING: "5 minutes" = 300000, "30 seconds" = 30000, "1 hour" = 3600000, "last 30" = 30000, "an hour" = 3600000.

For MATH: compute it yourself and put the number in meta.result. Reply should state it naturally.
For MEMORY_SAVE: extract exactly what to remember.
For OLLAMA_START: reply should tell the user you're starting it and it'll be ready in a moment.

No markdown in reply. No bullet points. No asterisks. Spoken-word only. Under 3 sentences usually. Be concise.`;
}

async function callOllama(messages, systemPrompt) {
  const payload = JSON.stringify({
    model: OLLAMA_MODEL,
    messages: [{ role: "system", content: systemPrompt }, ...messages],
    stream: false,
    format: "json",
    options: { temperature: 0.75, num_predict: 400 }
  });

  return new Promise((resolve, reject) => {
    const url = new URL(OLLAMA_URL + "/api/chat");
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === "https:" ? 443 : 11434),
      path:     url.pathname,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Ollama parse error: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.setTimeout(45000, () => { req.destroy(); reject(new Error("Ollama timeout")); });
    req.write(payload);
    req.end();
  });
}

// Per-session conversation history
const sessionHistories = new Map();
function getHistory(sessionId) {
  if (!sessionHistories.has(sessionId)) sessionHistories.set(sessionId, []);
  return sessionHistories.get(sessionId);
}
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, hist] of sessionHistories) {
    if (hist._ts && hist._ts < cutoff) sessionHistories.delete(id);
  }
}, 600000);

// ── SMART FALLBACK — when Ollama is offline ──
function smartFallback(message, userName, userTitle, memories) {
  const T = userTitle || "Sir";
  const lower = message.toLowerCase().trim();

  // Math
  const mathMatch = lower.match(/(\d+)\s*([\+\-\*\/\^]|times|plus|minus|divided by|over)\s*(\d+)/i);
  if (mathMatch) {
    try {
      const expr = lower
        .replace(/times/g, "*").replace(/plus/g, "+")
        .replace(/minus/g, "-").replace(/divided by|over/g, "/");
      const numExpr = expr.match(/[\d\s\+\-\*\/\.\(\)\%\^]+/)?.[0];
      if (numExpr) {
        // eslint-disable-next-line no-new-func
        const result = Function(`"use strict"; return (${numExpr.replace(/\^/g,"**")})`)();
        if (isFinite(result)) return { reply: `That's ${result}, ${T}.`, action: "MATH", meta: { result } };
      }
    } catch {}
  }

  // Time
  if (/what.*time|current time/i.test(lower)) {
    const t = new Date().toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true });
    return { reply: `It's ${t}, ${T}.`, action: "NONE", meta: {} };
  }
  // Date
  if (/what.*date|what day|today/i.test(lower)) {
    const d = new Date().toLocaleDateString("en-GB", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    return { reply: `Today is ${d}, ${T}.`, action: "NONE", meta: {} };
  }

  // Ollama commands
  if (/ollama\s+serve|start\s+ollama|run\s+ollama|launch\s+ollama/i.test(lower)) {
    return { reply: `Starting Ollama now, ${T}. Give it a moment.`, action: "OLLAMA_START", meta: {} };
  }
  if (/ollama\s+pull|pull\s+(\w+)|download.*model/i.test(lower)) {
    const modelMatch = lower.match(/pull\s+(\w+)/i);
    const model = modelMatch ? modelMatch[1] : OLLAMA_MODEL;
    return { reply: `Pulling ${model} in the background, ${T}. Check your terminal for progress.`, action: "OLLAMA_PULL", meta: { model } };
  }

  // Links
  if (/show.*link|link bank|all link/i.test(lower)) {
    return { reply: `Showing your link bank now, ${T}.`, action: "SHOW_LINKS", meta: {} };
  }
  const linkResult = lookupLink(lower);
  if (linkResult.found || /open|launch|go to|pull up/i.test(lower)) {
    if (linkResult.found) return { reply: `Opening ${linkResult.name} now, ${T}.`, action: "OPEN_LINK", meta: { query: lower } };
  }

  // Clips
  if (/clip|save.*footage|record that|save that/i.test(lower)) {
    return { reply: `Saving the clip, ${T}.`, action: "CLIP_SAVE", meta: { clipType: "both", duration: null } };
  }

  // Status
  if (/status|diagnostics|system|health|uptime/i.test(lower)) {
    return { reply: `Running the system check, ${T}.`, action: "SYSTEM_STATUS", meta: {} };
  }

  // Logout
  if (/log out|logout|goodbye|shut down|exit/i.test(lower)) {
    return { reply: `Goodbye, ${T}. Initiating shutdown.`, action: "LOGOUT", meta: {} };
  }

  // Greeting
  if (/^(hi|hello|hey|good morning|good afternoon|good evening|yo|sup)/i.test(lower)) {
    const h = new Date().getHours();
    const tod = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    return { reply: `Good ${tod}, ${T}. Ollama is offline — I'm running in limited mode. Start it with "start ollama" for full intelligence.`, action: "NONE", meta: {} };
  }

  // Timer
  const timerMatch = lower.match(/(?:set\s+)?(?:a\s+)?timer\s+(?:for\s+)?(\d+)\s*(second|minute|hour|min|sec|hr)/i);
  if (timerMatch || /remind me in/i.test(lower)) {
    const durMatch = lower.match(/(\d+)\s*(second|minute|hour|min|sec|hr)/i);
    if (durMatch) {
      const n = parseInt(durMatch[1]);
      const unit = durMatch[2].toLowerCase();
      const ms = unit.startsWith("h") ? n * 3600000 : unit.startsWith("m") ? n * 60000 : n * 1000;
      const label = `${n} ${unit}${n > 1 ? "s" : ""}`;
      return { reply: `Timer set for ${label}, ${T}.`, action: "TIMER", meta: { action: "TIMER_SET", duration: ms, task: null } };
    }
  }

  // Memory recall
  if (/what.*remember|show.*memor|recall/i.test(lower)) {
    if (memories && memories.length) {
      return { reply: `I have ${memories.length} thing${memories.length > 1 ? "s" : ""} stored for you, ${T}. Starting with: ${memories[0]}.`, action: "MEMORY_RECALL", meta: {} };
    }
    return { reply: `Nothing stored yet, ${T}.`, action: "MEMORY_RECALL", meta: {} };
  }

  // Default — inform user Ollama is offline
  return {
    reply: `Ollama is offline, ${T}. I'm in limited mode — I can handle basic commands but not open questions. Say "start ollama" and I'll fire it up.`,
    action: "NONE",
    meta: {}
  };
}

// ══════════════════════════════════════════════════════════════
// ── MAIN CHAT ENDPOINT ──
// ══════════════════════════════════════════════════════════════
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });
  const T = userTitle || "Sir";
  const linkSummary = getLinksSummary();

  const useOllama = await ollamaAvailable();

  let parsed;

  if (useOllama) {
    try {
      const history = getHistory(sessionId);
      history._ts = Date.now();
      const systemPrompt = buildSystemPrompt(userName, T, memories, getLinksSummary().names, getLinksSummary());
      const userMessages = [...history.filter(m => typeof m === "object" && m.role), { role: "user", content: message }];
      const ollamaResp = await callOllama(userMessages, systemPrompt);
      const rawContent = ollamaResp?.message?.content || ollamaResp?.choices?.[0]?.message?.content || "";

      try {
        const cleaned = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        parsed = { reply: rawContent || `Understood, ${T}.`, action: "NONE", meta: {} };
      }

      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: rawContent });
      const objMessages = history.filter(m => typeof m === "object" && m.role);
      if (objMessages.length > 20) {
        history.splice(history.findIndex(m => typeof m === "object" && m.role), 1);
        history.splice(history.findIndex(m => typeof m === "object" && m.role), 1);
      }
    } catch (err) {
      console.error("[Ollama] Error:", err.message);
      parsed = smartFallback(message, userName, userTitle, memories);
    }
  } else {
    parsed = smartFallback(message, userName, userTitle, memories);
  }

  const reply  = parsed.reply  || `Understood, ${T}.`;
  const action = parsed.action || "NONE";
  const meta   = parsed.meta   || {};

  return await processAction(action, meta, reply, message, userName, userTitle, T, linkSummary, res);
});

// ── ACTION PROCESSOR ──
async function processAction(action, meta, reply, message, userName, userTitle, T, linkSummary, res) {
  // Ollama management actions
  if (action === "OLLAMA_START") {
    const already = await ollamaAvailable();
    if (already) {
      return res.json({ reply: `Ollama is already running, ${T}.`, action: "NONE", meta: {} });
    }
    const result = await startOllamaServe();
    const finalReply = result.started
      ? `Ollama is up and running, ${T}. Full intelligence restored.`
      : `I tried to start Ollama but it didn't respond, ${T}. Make sure it's installed — get it at ollama dot ai.`;
    return res.json({ reply: finalReply, action: "NONE", meta: {} });
  }

  if (action === "OLLAMA_PULL") {
    const model = meta?.model || OLLAMA_MODEL;
    exec(`ollama pull ${model}`, (err) => {
      if (err) console.error("[Ollama pull] error:", err.message);
    });
    return res.json({ reply, action: "NONE", meta: {} });
  }

  if (action === "SHOW_LINKS") {
    return res.json({ reply, action, meta: { requestLinks: true, linkGroups: getAllLinksFormatted(), total: linkSummary.total } });
  }

  if (action === "OPEN_LINK") {
    const query = meta?.query || message;
    const link  = lookupLink(query);
    return res.json({ reply, action, meta: { ...meta, ...link } });
  }

  if (action === "MEMORY_SAVE" && meta?.saveFact) {
    const mem = loadMemories();
    const key = (userName || "user").toLowerCase().trim();
    if (!mem[key]) mem[key] = [];
    mem[key].push({ fact: meta.saveFact, savedAt: new Date().toISOString() });
    if (mem[key].length > 50) mem[key] = mem[key].slice(-50);
    saveMemories(mem);
    return res.json({ reply, action, meta: { saved: true, fact: meta.saveFact } });
  }

  if (action === "MEMORY_FORGET" && meta?.forgetHint) {
    const mem = loadMemories();
    const key = (userName || "user").toLowerCase().trim();
    if (!mem[key]) return res.json({ reply: `Nothing matching that on file, ${T}.`, action, meta: {} });
    const before = mem[key].length;
    mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(meta.forgetHint.toLowerCase()));
    saveMemories(mem);
    const removed = before - mem[key].length;
    const finalReply = removed > 0 ? `Done, ${T}. ${removed} memory entry removed.` : `Nothing matching that on file, ${T}.`;
    return res.json({ reply: finalReply, action, meta: {} });
  }

  if (action === "SYSTEM_STATUS") {
    const uptime = Math.floor(process.uptime());
    const m      = process.memoryUsage();
    const mins   = Math.floor(uptime / 60), secs = uptime % 60;
    const used   = (m.heapUsed / 1024 / 1024).toFixed(1);
    const total  = (m.heapTotal / 1024 / 1024).toFixed(1);
    return res.json({ reply, action, meta: { uptime, uptimeLabel: `${mins}m ${secs}s`, heapUsed: used, heapTotal: total } });
  }

  return res.json({ reply, action, meta });
}

// ── SCREEN ANALYSIS ──
app.post("/api/screen", async (req, res) => {
  const { ocrText, question, userName, userTitle, memories } = req.body;
  const T = userTitle || "Sir";
  if (!ocrText || ocrText.trim().length < 5) {
    return res.json({ reply: `I received the screen frame but couldn't extract readable text, ${T}.` });
  }
  const useOllama = await ollamaAvailable();
  if (useOllama) {
    try {
      const systemPrompt = `You are J.A.R.V.I.S. Analyze the screen content and answer the question. Be concise and spoken-word friendly. Address them as "${T}". Respond with ONLY JSON: {"reply": "your answer"}`;
      const userMsg = `Screen content: "${ocrText.trim().slice(0, 800)}"\nQuestion: "${question || "What is on my screen?"}"`;
      const result = await callOllama([{ role: "user", content: userMsg }], systemPrompt);
      const raw = result?.message?.content || "";
      let reply;
      try {
        const p = JSON.parse(raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
        reply = p.reply || raw;
      } catch { reply = raw || `Your screen shows: ${ocrText.trim().slice(0, 200)}`; }
      return res.json({ reply });
    } catch (err) { console.error("[Ollama screen]", err.message); }
  }
  const lines = ocrText.trim().split("\n").filter(l => l.trim().length > 2).slice(0, 5);
  return res.json({ reply: `On your screen, ${T}: ${lines.join(". ")}` });
});

// ── GOOGLE OAUTH CALLBACK ──
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

// ── SPOTIFY OAUTH CALLBACK ──
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nJ.A.R.V.I.S online → http://localhost:${PORT}`);
  console.log(`Ollama URL: ${OLLAMA_URL} | Model: ${OLLAMA_MODEL}`);
  console.log(`Tip: run "ollama serve" in a separate terminal, or say "start ollama" in the chat.\n`);
});
