require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const https    = require("https");
const http     = require("http");
const AI       = require("./ai-engine");

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
// ── OLLAMA LLM INTEGRATION ──
// Requires Ollama running locally: https://ollama.ai
// Run: ollama pull llama3 (or mistral, phi3, etc.)
// ══════════════════════════════════════════════════════════════
const OLLAMA_URL   = process.env.OLLAMA_URL   || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3";

function buildSystemPrompt(userName, userTitle, memories, linkNames, linkSummary) {
  const memBlock = memories && memories.length
    ? `\nKnown facts about the user:\n${memories.map(m => `- ${m}`).join("\n")}`
    : "";
  const linkBlock = linkNames && linkNames.length
    ? `\nAvailable link groups (say the name to open): ${linkNames.join(", ")}. Total: ${linkSummary?.total || 0} links.`
    : "";

  return `You are J.A.R.V.I.S — Just A Rather Very Intelligent System. You are a sophisticated AI assistant with dry British wit, precision, and genuine intelligence. You address the user as "${userTitle}" (their name is ${userName || "unknown"}).

Your personality: confident, precise, subtly witty, genuinely helpful. You do NOT say "Certainly!", "Of course!" or sycophantic openers. You speak like a brilliant British butler who is also a supercomputer.

${memBlock}
${linkBlock}

CRITICAL: You must ALWAYS respond with ONLY valid JSON in this exact format:
{"reply": "Your spoken response here", "action": "ACTION_CODE", "meta": {}}

ACTION CODES — choose the most appropriate:
- "NONE" — general conversation, knowledge, questions, opinions (meta: {})
- "OPEN_LINK" — user wants to open/launch/go to a link or website. If it matches a known group, set meta.query to the group name. (meta: {"query": "group_name_or_search"})
- "SHOW_LINKS" — user wants to see all links / link bank (meta: {})
- "CLIP_SAVE" — save/clip/record the last N seconds of screen/camera (meta: {"clipType": "both|screen|camera", "duration": milliseconds_or_null})
- "SHOW_CLIPS" — show intruder clips / recordings (meta: {})
- "READ_SCREEN" — read/analyze/describe what's on screen (meta: {"question": "what they asked"})
- "SWITCH_CAMERA" — switch to camera N (meta: {"cameraIndex": 0_based_index})
- "SYSTEM_STATUS" — system health/diagnostics/status check (meta: {})
- "MEMORY_SAVE" — remember a fact (meta: {"saveFact": "the fact to store"})
- "MEMORY_RECALL" — show stored memories (meta: {})
- "MEMORY_FORGET" — forget something (meta: {"forgetHint": "what to forget"})
- "LOGOUT" — log out / goodbye / shutdown (meta: {})
- "NOTIF_SETTINGS" — notification settings (meta: {})
- "TIMER" — set a timer/reminder (meta: {"action": "TIMER_SET", "duration": ms, "task": "optional task label or null"})
- "WEATHER" — weather query (meta: {})
- "SPOTIFY" — music control (meta: {})
- "GMAIL" — email check (meta: {})
- "CALENDAR" — calendar/schedule (meta: {})
- "MATH" — calculation result (meta: {"result": number})

Duration parsing for TIMER/CLIP: convert "5 minutes" → 300000, "30 seconds" → 30000, "1 hour" → 3600000, "last 30" → 30000, etc.

For MATH, compute the result yourself and put it in meta.result. The reply should state the answer naturally.

For MEMORY_SAVE, extract what specifically should be remembered from the user's message.

Keep replies concise and spoken-word friendly — no markdown, no bullet points, no asterisks. Speak naturally as JARVIS would aloud. Under 3 sentences for most responses.

If unsure of the action, use "NONE" and just answer conversationally.`;
}

async function callOllama(messages, systemPrompt) {
  const payload = JSON.stringify({
    model: OLLAMA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      ...messages
    ],
    stream: false,
    format: "json",
    options: { temperature: 0.7, num_predict: 400 }
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
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject(new Error("Ollama parse error: " + data.slice(0, 200)));
        }
      });
    });

    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Ollama timeout")); });
    req.write(payload);
    req.end();
  });
}

// Check if Ollama is available
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
  // Check if model is pulled
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
// ── TTS PROXY — StreamElements (free, no API key) ──
// Voice: Brian = deep British male, perfect for JARVIS
// ══════════════════════════════════════════════════════════════
app.get("/api/tts", async (req, res) => {
  const text  = req.query.text;
  const voice = req.query.voice || "Brian";

  if (!text) return res.status(400).send("No text");

  // StreamElements TTS — completely free, no key needed
  const clean = text.trim().slice(0, 600); // cap length
  const url   = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice)}&text=${encodeURIComponent(clean)}`;

  https.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; JARVIS/2.0)",
      "Accept": "audio/mpeg, audio/*, */*",
    }
  }, (ttsRes) => {
    if (ttsRes.statusCode !== 200) {
      console.error("[TTS] StreamElements returned", ttsRes.statusCode);
      return res.status(502).send("TTS error");
    }
    res.setHeader("Content-Type", ttsRes.headers["content-type"] || "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=300");
    ttsRes.pipe(res);
  }).on("error", (err) => {
    console.error("[TTS] Network error:", err.message);
    res.status(502).send("TTS network error");
  });
});

// Also proxy ElevenLabs-style voices via StreamElements
// Available free voices: Brian, Amy, Emma, Geraint, Russell, Nicole, Joey, Justin, Matthew, Ivy, Joanna, Kendra, Kimberly, Salli, Conchita, Enrique, Hans, Marlene, Vicki, Chantal, Celine, Mathieu, Giorgio, Carla, Bianca, Mia, Mizuki, Seoyeon, Zhiyu
app.get("/api/tts/voices", (req, res) => {
  res.json({
    voices: ["Brian","Amy","Emma","Geraint","Russell","Joey","Matthew","Joanna","Salli","Hans","Giorgio","Carla"],
    recommended: "Brian",
    note: "Brian = deep British male, ideal for JARVIS"
  });
});

// ══════════════════════════════════════════════════════════════
// ── CHAT — Ollama LLM with ai-engine fallback ──
// ══════════════════════════════════════════════════════════════

// Per-session conversation history for Ollama
const sessionHistories = new Map();
function getHistory(sessionId) {
  if (!sessionHistories.has(sessionId)) sessionHistories.set(sessionId, []);
  return sessionHistories.get(sessionId);
}
// Clean up old sessions every 2 hours
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, hist] of sessionHistories) {
    if (hist._ts && hist._ts < cutoff) sessionHistories.delete(id);
  }
}, 600000);

app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  const T = userTitle || "Sir";

  const linkSummary = getLinksSummary();
  const serverData  = { ...linkSummary, allLinks: getAllLinksFormatted() };

  // Check link lookup first
  const linkResult = lookupLink(message);
  if (linkResult.found) Object.assign(serverData, linkResult);

  // ── Try Ollama first ──
  const useOllama = await ollamaAvailable();

  if (useOllama) {
    try {
      const history = getHistory(sessionId);
      history._ts = Date.now();

      const systemPrompt = buildSystemPrompt(userName, T, memories, getLinksSummary().names, getLinksSummary());
      const userMessages = [...history.filter(m => typeof m === "object"), { role: "user", content: message }];

      const ollamaResp = await callOllama(userMessages, systemPrompt);
      const rawContent = ollamaResp?.message?.content || ollamaResp?.choices?.[0]?.message?.content || "";

      // Parse JSON from Ollama
      let parsed;
      try {
        // Sometimes Ollama wraps in markdown code blocks
        const cleaned = rawContent.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
        parsed = JSON.parse(cleaned);
      } catch {
        // If JSON parse fails, treat entire response as the reply
        parsed = { reply: rawContent || `Understood, ${T}.`, action: "NONE", meta: {} };
      }

      const reply  = parsed.reply  || `Understood, ${T}.`;
      const action = parsed.action || "NONE";
      const meta   = parsed.meta   || {};

      // Save to history (keep last 10 turns = 20 messages)
      history.push({ role: "user", content: message });
      history.push({ role: "assistant", content: rawContent });
      while (history.filter(m => typeof m === "object").length > 20) {
        const idx = history.findIndex(m => typeof m === "object");
        if (idx >= 0) history.splice(idx, 1); else break;
      }

      // ── Server-side action processing ──
      return await processAction(action, meta, reply, message, userName, userTitle, T, linkSummary, res);

    } catch (err) {
      console.error("[Ollama] Error:", err.message);
      // Fall through to ai-engine
    }
  }

  // ── Fallback: ai-engine ──
  let aiResult;
  try {
    aiResult = AI.process({ message, sessionId, userName, userTitle, memories, moodContext, serverData });
  } catch (err) {
    console.error("[AI] Error:", err);
    return res.json({ reply: `Something went sideways, ${T}. Give it another go.`, action: "ERROR" });
  }

  const { reply, action, meta, intent, topic } = aiResult;
  return await processAction(action, meta, reply, message, userName, userTitle, T, linkSummary, res, intent, topic);
});

// Shared action processor for both Ollama and ai-engine paths
async function processAction(action, meta, reply, message, userName, userTitle, T, linkSummary, res, intent, topic) {

  if (action === "SHOW_LINKS") {
    return res.json({
      reply, action, intent,
      meta: { requestLinks: true, linkGroups: getAllLinksFormatted(), total: linkSummary.total },
    });
  }

  if (action === "OPEN_LINK") {
    const query = meta?.query || message;
    const link  = lookupLink(query);
    return res.json({ reply, action, intent, meta: { ...meta, ...link } });
  }

  if (action === "MEMORY_SAVE" && meta?.saveFact) {
    const mem = loadMemories();
    const key = (userName || "user").toLowerCase().trim();
    if (!mem[key]) mem[key] = [];
    mem[key].push({ fact: meta.saveFact, savedAt: new Date().toISOString() });
    if (mem[key].length > 50) mem[key] = mem[key].slice(-50);
    saveMemories(mem);
    return res.json({ reply, action, intent, meta: { saved: true, fact: meta.saveFact } });
  }

  if (action === "MEMORY_FORGET" && meta?.forgetHint) {
    const mem = loadMemories();
    const key = (userName || "user").toLowerCase().trim();
    if (!mem[key]) return res.json({ reply: `Nothing on file matching that, ${T}.`, action, intent });
    const before = mem[key].length;
    mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(meta.forgetHint.toLowerCase()));
    saveMemories(mem);
    const removed = before - mem[key].length;
    const finalReply = removed > 0 ? `Done, ${T}. ${removed} memory entry removed.` : `Nothing matching that on file, ${T}.`;
    return res.json({ reply: finalReply, action, intent });
  }

  if (action === "SYSTEM_STATUS") {
    const uptime = Math.floor(process.uptime());
    const m      = process.memoryUsage();
    const mins   = Math.floor(uptime / 60), secs = uptime % 60;
    const used   = (m.heapUsed / 1024 / 1024).toFixed(1);
    const total  = (m.heapTotal / 1024 / 1024).toFixed(1);
    return res.json({ reply, action, intent, meta: { uptime, uptimeLabel: `${mins}m ${secs}s`, heapUsed: used, heapTotal: total } });
  }

  return res.json({ reply, action, intent, topic, meta });
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
      const systemPrompt = `You are J.A.R.V.I.S. The user has shared their screen content via OCR. Analyze it and answer their question. Be concise, spoken-word friendly (no markdown). Address them as "${T}". Respond with ONLY JSON: {"reply": "your answer"}`;
      const userMsg = `Screen content: "${ocrText.trim().slice(0, 800)}"\nUser question: "${question || "What is on my screen?"}"`;
      const result = await callOllama([{ role: "user", content: userMsg }], systemPrompt);
      const raw = result?.message?.content || "";
      let reply;
      try {
        const parsed = JSON.parse(raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim());
        reply = parsed.reply || raw;
      } catch { reply = raw || `Your screen shows: ${ocrText.trim().slice(0, 200)}`; }
      return res.json({ reply: `${reply}` });
    } catch (err) {
      console.error("[Ollama screen]", err.message);
    }
  }

  // Fallback
  const screenContext = `The user's screen contains: "${ocrText.trim().slice(0, 800)}". The user asked: "${question || "What is on my screen?"}"`;
  try {
    const result = AI.process({ message: screenContext, sessionId: `screen_${userName || "user"}`, userName, userTitle, memories, serverData: getLinksSummary() });
    return res.json({ reply: `I can see your screen, ${T}. ${result.reply}` });
  } catch {
    const lines = ocrText.trim().split("\n").filter(l => l.trim().length > 2).slice(0, 5);
    return res.json({ reply: `On your screen, ${T}: ${lines.join(". ")}` });
  }
});

// ── GOOGLE OAUTH CALLBACK (optional) ──
app.get("/api/google/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("<h2>No code received.</h2>");
  try {
    const google = require("./google");
    const result = await google.exchangeCode(code);
    if (result.error) return res.send(`<h2>Auth error: ${result.error}</h2>`);
    res.send(`<h2>Google connected successfully!</h2><p>You can close this tab and return to J.A.R.V.I.S.</p><script>setTimeout(()=>window.close(),2000)</script>`);
  } catch { res.send("<h2>Google module not found.</h2>"); }
});

// ── SPOTIFY OAUTH CALLBACK (optional) ──
app.get("/api/spotify/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("<h2>No code received.</h2>");
  try {
    const spotify = require("./spotify");
    const result  = await spotify.exchangeCode(code);
    if (result.error) return res.send(`<h2>Auth error: ${result.error}</h2>`);
    res.send(`<h2>Spotify connected!</h2><p>You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script>`);
  } catch { res.send("<h2>Spotify module not found.</h2>"); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nJ.A.R.V.I.S online → http://localhost:${PORT}`);
  console.log(`Ollama URL: ${OLLAMA_URL} | Model: ${OLLAMA_MODEL}`);
  console.log(`Run "ollama pull ${OLLAMA_MODEL}" if you haven't already.\n`);
});
