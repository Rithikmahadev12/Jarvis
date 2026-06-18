require("dotenv").config();
const express     = require("express");
const cors        = require("cors");
const path        = require("path");
const fs          = require("fs");
const http        = require("http");
const archiver    = require("archiver");
const AI          = require("./ai-engine");
const Research    = require("./research");
const Personality = require("./personality");
const Weather     = require("./weather");
const Spotify     = require("./spotify");
const Google      = require("./google");
const DIY         = require("./diy-builder");
const Home        = require("./home");
const Groq        = require("./groq-engine");
const Improve     = require("./self-improve");
const Trainer     = require("./trainer");

const app        = express();
const httpServer = http.createServer(app);

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

// ══════════════════════════════════════════════════════════════
// ── COMMS ─────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
const attachComms = require("./comms-server");
const io          = attachComms(httpServer);

app.get("/comms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "comms.html"));
});

// ── LINKS BANK ────────────────────────────────────────────────
const LINKS = {
  petzah: [
    "https://science.asturkiters.es/",
  ],
  fern: [
    "https://angelfern.s3.amazonaws.com/index.html",
  ],
  infamous: [
    "https://fastedge3157.b-cdn.net/",
    "https://megaweb4424.b-cdn.net/",
    "https://swifthub5327.b-cdn.net/",
    "https://cleanhub6357.b-cdn.net/",
    "https://hypernode1197.b-cdn.net/",
    "https://freshbeam4494.b-cdn.net/",
    "https://hypernet6886.b-cdn.net/",
    "https://sharpcore5833.b-cdn.net/",
    "https://megacache6703.b-cdn.net/",
    "https://megaweb7632.b-cdn.net/",
    "https://quickzone2072.b-cdn.net/",
    "https://boldgrid1787.b-cdn.net/",
    "https://smarthub9292.b-cdn.net/",
    "https://smartlink1299.b-cdn.net/",
    "https://apexpath3097.b-cdn.net/",
    "https://sharpcache5446.b-cdn.net/",
    "https://primepipe9647.b-cdn.net/",
    "https://swiftnet1429.b-cdn.net/",
    "https://rapidnet5865.b-cdn.net/",
    "https://smarthost5086.b-cdn.net/",
    "https://primebeam4104.b-cdn.net/",
    "https://smarthost1756.b-cdn.net/",
    "https://sharpcdn2890.b-cdn.net/",
    "https://sharpsite3374.b-cdn.net/",
    "https://megacache1865.b-cdn.net/",
    "https://cleargrid5772.b-cdn.net/",
    "https://primenet8634.b-cdn.net/",
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
  return Object.entries(LINKS).map(([name, urls]) => ({ name, count: urls.length, urls }));
}

// ── LINKS API ─────────────────────────────────────────────────
app.get("/api/links",         (req, res) => res.json({ groups: Object.keys(LINKS), summary: getLinksSummary(), all: getAllLinksFormatted() }));
app.get("/api/links/summary", (req, res) => res.json(getLinksSummary()));
app.get("/api/links/all",     (req, res) => res.json({ links: getAllLinksFormatted() }));
app.post("/api/link",         (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ found: false });
  res.json(lookupLink(query));
});

// ── PERSISTENT STORE ──────────────────────────────────────────
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

// ── BOOTSTRAP OWNER ───────────────────────────────────────────
function bootstrapOwnerAccount() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) return;
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (e) { console.warn("[BOOT] Could not read config.json:", e.message); return; }
  const owner = config.owner;
  if (!owner || !owner.username || !owner.passwordHash) return;
  const profiles = loadProfiles();
  const key      = owner.username.toLowerCase().trim();
  if (profiles[key]) {
    if (profiles[key].passwordHash !== owner.passwordHash) {
      profiles[key].passwordHash = owner.passwordHash;
      saveProfiles(profiles);
      console.log(`[BOOT] Owner account "${owner.username}" password synced`);
    }
    return;
  }
  profiles[key] = {
    name:         owner.username,
    passwordHash: owner.passwordHash,
    title:        owner.title || "Sir",
    voiceAliases: owner.voiceAliases || [],
    role:         "owner",
    createdAt:    new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
  };
  saveProfiles(profiles);
  console.log(`[BOOT] Owner account "${owner.username}" bootstrapped`);
}

app.get("/favicon.ico", (req, res) => res.status(204).end());

// ══════════════════════════════════════════════════════════════
// ── HOME AUTOMATION ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
let _scanLog = "";

app.get("/home", (req, res) => res.sendFile(path.join(__dirname, "public", "home.html")));
app.get("/api/home/info",    (req, res) => res.json({ subnets: Home.getLocalSubnets(), localIPs: Home.getLocalIPs() }));
app.get("/api/home/devices", async (req, res) => {
  const devices = Home.getDeviceList();
  res.json({ devices, count: devices.length, lastScan: Home.lastScanTime() });
});
app.post("/api/home/scan", async (req, res) => {
  const { deep } = req.body;
  _scanLog = "Starting scan...";
  try {
    const devices = await Home.scanNetwork({
      useSSDP: true, useKasa: true, useHTTP: !!deep,
      onProgress: (msg) => { _scanLog = msg; console.log("[HOME]", msg); }
    });
    res.json({ devices, count: devices.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/home/scan-status",         (req, res) => res.json({ log: _scanLog }));
app.post("/api/home/control/:id",    async (req, res) => res.json(await Home.controlDevice(decodeURIComponent(req.params.id), req.body)));
app.post("/api/home/control-all",    async (req, res) => {
  const devices = Home.getDeviceList().filter(d => d.reachable !== false);
  const results = await Promise.all(devices.map(d => Home.controlDevice(d.id, req.body)));
  res.json({ ok: true, count: results.filter(r => r.ok).length });
});
app.post("/api/home/voice", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });
  const reply = await Home.executeVoiceCommand(text, "Sir");
  res.json({ reply });
});
app.post("/api/home/device/:id/room", async (req, res) => {
  const ok = Home.assignRoom(decodeURIComponent(req.params.id), req.body.room);
  res.json({ ok });
});
app.post("/api/home/message/:id", async (req, res) => {
  const { message, from } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });
  const result = await Home.sendMessageToDevice(decodeURIComponent(req.params.id), message, from || "J.A.R.V.I.S");
  res.json(result);
});
app.post("/api/home/broadcast", async (req, res) => {
  const { message, from } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });
  const results = await Home.broadcastMessage(message, from || "J.A.R.V.I.S");
  res.json({ ok: true, results });
});
app.post("/api/home/add-tuya", async (req, res) => {
  const { ip, name } = req.body;
  if (!ip) return res.status(400).json({ error: "Missing IP" });
  try {
    const devices = await Home.scanNetwork({ specificIP: ip, onProgress: () => {} });
    const device  = devices.find(d => d.ip === ip);
    if (device && name) { device.name = name; }
    res.json({ device: device || null });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/home/pending-messages", (req, res) => {
  const ip = req.query.ip || req.ip;
  res.json({ messages: Home.getPendingMessages(ip) });
});

// ══════════════════════════════════════════════════════════════
// ── SELF-IMPROVEMENT API ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════
app.get("/api/improve/stats", (req, res) => {
  res.json({
    improve:  Improve.getStats(),
    training: Trainer.getStats(),
    groq:     Groq.isConfigured() ? "online" : "not configured",
  });
});
app.get("/api/improve/patterns",  (req, res) => res.json({ patterns:  Improve.patterns.getAll() }));
app.get("/api/improve/handlers",  (req, res) => res.json({ handlers:  Improve.handlers.getAll() }));
app.get("/api/improve/knowledge", (req, res) => res.json({ topics:    Improve.knowledge.getTopTopics(20) }));
app.get("/api/improve/knowledge/:topic", (req, res) => {
  const entry = Improve.knowledge.lookup(req.params.topic);
  if (!entry) return res.json({ found: false });
  res.json({ found: true, ...entry });
});
app.get("/api/training/stats", (req, res) => res.json(Trainer.getStats()));
app.get("/api/training/examples", (req, res) => {
  const { intent, limit } = req.query;
  const ex = Trainer.exportForPromptStuffing(intent || "general", parseInt(limit) || 5);
  res.json({ examples: ex });
});
app.post("/api/training/generate", async (req, res) => {
  if (!Groq.isConfigured()) return res.status(400).json({ error: "GROQ_API_KEY not set" });
  const { intent, count } = req.body;
  try {
    const examples = await Trainer.generateSyntheticExamples(intent || "general", count || 5);
    res.json({ generated: examples.length, examples });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/training/clean", (req, res) => {
  const removed = Trainer.cleanTrainingData();
  res.json({ removed, stats: Trainer.getStats() });
});
app.post("/api/improve/analyze", async (req, res) => {
  const { message, response } = req.body;
  if (!message || !response) return res.status(400).json({ error: "Missing fields" });
  if (!Groq.isConfigured())   return res.status(400).json({ error: "GROQ_API_KEY not set" });
  try {
    const analysis = await Groq.analyzeIntent(message, response);
    if (analysis.confidence > 0.5) await Improve.patterns.learn(message, analysis);
    res.json({ analysis });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── PROFILE ROUTES ────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
app.post("/api/register", (req, res) => {
  const { name, passwordHash, title, voiceAliases } = req.body;
  if (!name || !passwordHash) return res.status(400).json({ error: "Missing fields" });
  const profiles = loadProfiles();
  const key = name.toLowerCase().trim();
  profiles[key] = {
    name:         name.trim(),
    passwordHash,
    title:        title || "Sir",
    voiceAliases: voiceAliases || [],
    createdAt:    profiles[key]?.createdAt || new Date().toISOString(),
    updatedAt:    new Date().toISOString(),
  };
  saveProfiles(profiles);
  res.json({ success: true });
});
app.get("/api/profile/:name", (req, res) => {
  const profiles = loadProfiles();
  const profile  = profiles[req.params.name.toLowerCase().trim()];
  if (!profile) return res.json({ found: false });
  const { passwordHash, ...safe } = profile;
  res.json({ found: true, profile: safe });
});
app.post("/api/verify", (req, res) => {
  const { name, passwordHash } = req.body;
  if (!name || !passwordHash) return res.status(400).json({ authorized: false });
  const profiles = loadProfiles();
  const stored   = profiles[name.toLowerCase().trim()];
  if (!stored)                              return res.json({ authorized: false, reason: "no_profile" });
  if (stored.passwordHash !== passwordHash) return res.json({ authorized: false, reason: "wrong_password" });
  const { passwordHash: _, ...safe } = stored;
  res.json({ authorized: true, profile: safe });
});
app.get("/api/profiles", (req, res) => {
  const profiles = loadProfiles();
  const list = Object.values(profiles).map(({ name, title, voiceAliases }) => ({ name, title, voiceAliases }));
  res.json({ profiles: list });
});

// ══════════════════════════════════════════════════════════════
// ── MEMORY ROUTES ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
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
  const mem    = loadMemories();
  const key    = user.toLowerCase().trim();
  if (!mem[key]) return res.json({ removed: 0 });
  const before = mem[key].length;
  mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(hint.toLowerCase()));
  saveMemories(mem);
  res.json({ removed: before - mem[key].length });
});

// ══════════════════════════════════════════════════════════════
// ── WEATHER ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
app.post("/api/weather", async (req, res) => {
  try { res.json(await Weather.handleWeatherCommand(req.body.message || "weather")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── SPOTIFY ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
app.get("/api/spotify/auth", (req, res) => {
  if (!Spotify.isConfigured()) return res.status(400).json({ error: "Spotify credentials not configured in .env" });
  res.redirect(Spotify.getAuthUrl());
});
app.get("/api/spotify/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Spotify auth failed: ${error}</h2>`);
  if (!code)  return res.send("<h2>No code returned.</h2>");
  const result = await Spotify.exchangeCode(code);
  if (result.error) return res.send(`<h2>Token exchange failed: ${result.error}</h2>`);
  res.send(`<html><body style="background:#010c14;color:#00c8ff;font-family:monospace;text-align:center;padding:60px"><h2>✓ Spotify connected</h2><p>Close this tab.</p></body></html>`);
});
app.post("/api/spotify", async (req, res) => {
  if (!Spotify.isConfigured()) return res.json({ error: "Not configured", needsAuth: true, authUrl: "/api/spotify/auth" });
  if (!Spotify.hasToken())     return res.json({ needsAuth: true, authUrl: "/api/spotify/auth" });
  try { res.json(await Spotify.handleSpotifyCommand(req.body.message || "now playing")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── GOOGLE ────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
app.get("/api/google/auth", (req, res) => {
  if (!Google.isConfigured()) return res.status(400).json({ error: "Google credentials not configured in .env" });
  res.redirect(Google.getAuthUrl());
});
app.get("/api/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Google auth failed: ${error}</h2>`);
  if (!code)  return res.send("<h2>No code returned.</h2>");
  const result = await Google.exchangeCode(code);
  if (result.error) return res.send(`<h2>Token exchange failed: ${result.error}</h2>`);
  res.send(`<html><body style="background:#010c14;color:#00c8ff;font-family:monospace;text-align:center;padding:60px"><h2>✓ Google connected</h2><p>Gmail and Calendar active. Close this tab.</p></body></html>`);
});
app.post("/api/gmail", async (req, res) => {
  if (!Google.isConfigured()) return res.json({ error: "Not configured", needsAuth: true, authUrl: "/api/google/auth" });
  if (!Google.hasToken())     return res.json({ needsAuth: true, authUrl: "/api/google/auth" });
  try { res.json(await Google.handleGmailCommand(req.body.message || "check inbox")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/calendar", async (req, res) => {
  if (!Google.isConfigured()) return res.json({ error: "Not configured", needsAuth: true, authUrl: "/api/google/auth" });
  if (!Google.hasToken())     return res.json({ needsAuth: true, authUrl: "/api/google/auth" });
  try { res.json(await Google.handleCalendarCommand(req.body.message || "today")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── PERSONALITY ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
app.post("/api/personality/comment", (req, res) => {
  const { scene, userTitle, sessionMinutes, previousScene } = req.body;
  const T = userTitle || "Sir";
  if (scene === previousScene && scene === "idle") return res.json({ reply: null });
  res.json({ reply: Personality.getCameraComment(scene, T, sessionMinutes) || null });
});
app.post("/api/personality/smalltalk", (req, res) => {
  const { message, userTitle } = req.body;
  const T = userTitle || "Sir";
  if (!message) return res.status(400).json({ reply: null });
  const news = Personality.routePersonalNews(message, T);
  if (news) return res.json({ reply: news });
  res.json({ reply: Personality.routeSmallTalk(message, T) || null });
});

// ══════════════════════════════════════════════════════════════
// ── EXTENSION API ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
const extensionQueue  = [];
let   extensionStatus = { phase: "idle", user: null, userTitle: null, mood: "neutral" };

app.get("/api/extension/poll",         (req, res) => res.json({ commands: extensionQueue.splice(0), status: extensionStatus }));
app.post("/api/extension/status",      (req, res) => { extensionStatus = { ...req.body }; res.json({ ok: true }); });
app.get("/api/extension/status",       (req, res) => res.json(extensionStatus));
app.post("/api/extension/command",     (req, res) => {
  const { action, data } = req.body;
  if (!action) return res.status(400).json({ error: "Missing action" });
  extensionQueue.push({ action, data: data || {} });
  res.json({ ok: true, queued: extensionQueue.length });
});
app.get("/api/extension/download", (req, res) => {
  const extDir = path.join(__dirname, "extension");
  if (!fs.existsSync(extDir)) return res.status(404).json({ error: "Extension folder not found" });
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="jarvis-extension.zip"');
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", err => { console.error("[EXT] Archive error:", err); res.status(500).end(); });
  archive.pipe(res);
  archive.directory(extDir, "jarvis-extension");
  archive.finalize();
});

// ══════════════════════════════════════════════════════════════
// ── RESEARCH ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
app.post("/api/research", async (req, res) => {
  const { query, userTitle } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });
  try { res.json(await Research.research(query, userTitle || "Sir") || { reply: null }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/research/person", async (req, res) => {
  const { name, userTitle } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });
  try {
    const data   = await Research.lookupPerson(name);
    const report = Research.buildPersonIntelReport(data, userTitle || "Sir");
    res.json({ reply: report, raw: data, name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// ── SCREEN ANALYSIS ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
app.post("/api/screen", (req, res) => {
  const { ocrText, question, userName, userTitle, memories } = req.body;
  const T = userTitle || "Sir";
  if (!ocrText || ocrText.trim().length < 5) {
    return res.json({ reply: `I received the screen frame but couldn't extract readable text, ${T}.` });
  }
  const screenContext = `The user's screen contains: "${ocrText.trim().slice(0, 800)}". The user asked: "${question || "What is on my screen?"}"`;
  try {
    const result = AI.process({ message: screenContext, sessionId: `screen_${userName || "user"}`, userName, userTitle, memories, serverData: getLinksSummary() });
    const reply  = result.reply.length > 20 ? `I can see your screen, ${T}. ${result.reply}` : `Your screen shows: ${ocrText.trim().slice(0, 200)}`;
    return res.json({ reply });
  } catch {
    const lines = ocrText.trim().split("\n").filter(l => l.trim().length > 2).slice(0, 5);
    return res.json({ reply: `On your screen, ${T}: ${lines.join(". ")}` });
  }
});

// ══════════════════════════════════════════════════════════════
// ── NOTIFY ENDPOINT (for home device messages) ────────────────
// ══════════════════════════════════════════════════════════════
app.post("/api/notify", (req, res) => {
  const { message, from, type } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });
  console.log(`[NOTIFY] ${from || "Unknown"}: ${message}`);
  // In a real deployment you could push via Socket.IO here
  res.json({ ok: true, received: true });
});

// ══════════════════════════════════════════════════════════════
// ── MAIN CHAT ROUTE (with Groq self-improvement + trainer) ────
// ══════════════════════════════════════════════════════════════
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  const T = userTitle || "Sir";

  // ── Home commands ──
  if (Home.isHomeCommand(message) || Home.isHomePanelRequest(message)) {
    if (Home.isHomePanelRequest(message)) {
      return res.json({ reply: `Opening home control panel, ${T}.`, action: "OPEN_HOME", intent: "home", meta: { openHome: true } });
    }
    return Home.executeVoiceCommand(message, T)
      .then(homeReply => res.json({ reply: homeReply, action: "HOME_COMMAND", intent: "home" }))
      .catch(() => res.json({ reply: `Home command failed, ${T}.`, action: "HOME_COMMAND", intent: "home" }));
  }

  // ── Personality shortcuts (no AI needed) ──
  const personalNewsReply = Personality.routePersonalNews(message, T);
  if (personalNewsReply) {
    Trainer.addExample(message, personalNewsReply, "personal_news", "personal", 0.8, "personality");
    return res.json({ reply: personalNewsReply, action: "PERSONAL_NEWS", intent: "personal_news" });
  }
  const smalltalkReply = Personality.routeSmallTalk(message, T);
  if (smalltalkReply) {
    Trainer.addExample(message, smalltalkReply, "smalltalk", null, 0.8, "personality");
    return res.json({ reply: smalltalkReply, action: "SMALLTALK", intent: "smalltalk" });
  }

  // ── Try learned handlers first ──
  const learnedResult = Improve.handlers.tryAll(message, T);
  if (learnedResult) {
    Trainer.addExample(message, learnedResult.reply, "learned", null, 0.75, "learned");
    return res.json({ ...learnedResult, action: "LEARNED", intent: "learned" });
  }

  // ── Check knowledge base ──
  const knowledgeMatch = Improve.patterns.match(message);
  if (knowledgeMatch && knowledgeMatch.score > 0.7) {
    const knowledgeEntry = Improve.knowledge.lookup(knowledgeMatch.intent);
    if (knowledgeEntry && knowledgeEntry.facts.length > 0) {
      const reply = `${knowledgeEntry.facts.slice(0, 2).join(". ")}, ${T}.`;
      Trainer.addExample(message, reply, "knowledge", knowledgeMatch.intent, 0.65, "knowledge_base");
      return res.json({ reply, action: "KNOWLEDGE_BASE", intent: "knowledge" });
    }
  }

  // ── Run original JARVIS AI engine ──
  const linkSummary = getLinksSummary();
  const serverData  = { ...linkSummary, allLinks: getAllLinksFormatted() };
  const linkResult  = lookupLink(message);
  if (linkResult.found) Object.assign(serverData, linkResult);

  let aiResult;
  try {
    aiResult = AI.process({ message, sessionId, userName, userTitle, memories, moodContext, serverData });
  } catch (err) {
    console.error("[AI] Error:", err);
    // Log as failure and try Groq
    Improve.failures.log(message, "AI engine crashed", "CRASH", sessionId);
    if (Groq.isConfigured()) {
      try {
        const groqResult = await Groq.chat(message, { userTitle: T, memories: (memories || []).slice(0, 5) });
        if (groqResult.reply) {
          Trainer.addExample(message, groqResult.reply, "groq_fallback", null, 0.7, "groq");
          return res.json({ reply: groqResult.reply, action: "GROQ_FALLBACK", intent: "groq", source: "groq" });
        }
      } catch {}
    }
    return res.json({ reply: `Something went sideways, ${T}. Give it another go.`, action: "ERROR" });
  }

  const { reply, action, meta, intent, topic, needsFetch, fetchType } = aiResult;

  // ── needsFetch: person lookup ──
  if (action === "LOOKUP_PERSON" && needsFetch && meta?.personName) {
    try {
      const lookupData  = await Research.lookupPerson(meta.personName);
      const intelReport = Research.buildPersonIntelReport(lookupData, T);
      Trainer.addExample(message, intelReport, "lookup_person", meta.personName, 0.8, "research");
      return res.json({ reply: intelReport, action: "LOOKUP_PERSON", intent: "lookup_person", meta: { personName: meta.personName, raw: lookupData } });
    } catch (e) {
      const fallback = `I ran ${meta.personName} through the public databases, ${T}, but hit an error mid-sweep. Try again in a moment.`;
      return res.json({ reply: fallback, action: "LOOKUP_PERSON", intent: "lookup_person" });
    }
  }

  // ── needsFetch: integrations ──
  if (needsFetch) {
    switch (fetchType) {
      case "weather": {
        try {
          const weatherData = await Weather.handleWeatherCommand(message);
          if (weatherData.error) return res.json({ reply: `Couldn't pull weather right now, ${T}. ${weatherData.error}`, action: "WEATHER", intent: "weather" });
          const { city, temp, feels_like, description, humidity, wind_speed, high, low } = weatherData;
          const tempDesc    = temp > 30 ? "quite warm" : temp > 20 ? "pleasant" : temp > 10 ? "cool" : temp > 0 ? "cold" : "freezing";
          const weatherReply = `Current conditions in ${city}, ${T}: ${temp}°C — ${description}. Feels like ${feels_like}°C, which is ${tempDesc}. Humidity at ${humidity}%, wind ${wind_speed} m/s. Today's range: ${low}–${high}°C.`;
          Trainer.addExample(message, weatherReply, "weather", city, 0.85, "integration");
          return res.json({ reply: weatherReply, action: "WEATHER", intent: "weather", meta: { weatherData } });
        } catch (e) {
          return res.json({ reply: `Weather fetch failed, ${T}. Check your OpenWeatherMap API key in .env.`, action: "WEATHER", intent: "weather" });
        }
      }
      case "spotify": {
        if (!Spotify.isConfigured()) return res.json({ reply: `Spotify isn't configured yet, ${T}.`, action: "SPOTIFY", intent: "spotify" });
        if (!Spotify.hasToken())     return res.json({ reply: `Spotify needs to be authorised first, ${T}. Visit /api/spotify/auth.`, action: "SPOTIFY", intent: "spotify" });
        try {
          const spotifyData = await Spotify.handleSpotifyCommand(message);
          if (spotifyData.needsAuth) return res.json({ reply: `Spotify needs re-authorisation, ${T}.`, action: "SPOTIFY", intent: "spotify" });
          let spotifyReply = `Spotify command processed, ${T}.`;
          if (spotifyData.action === "now_playing") spotifyReply = spotifyData.track ? `${spotifyData.is_playing ? "Currently playing" : "Paused on"}: "${spotifyData.track}" by ${spotifyData.artist}, ${T}.` : `Nothing playing on Spotify right now, ${T}.`;
          else if (spotifyData.action === "played")  spotifyReply = `Playing "${spotifyData.track}" by ${spotifyData.artist} on Spotify, ${T}.`;
          else if (spotifyData.action === "paused")  spotifyReply = `Spotify paused, ${T}.`;
          else if (spotifyData.action === "resumed") spotifyReply = `Spotify resumed, ${T}.`;
          else if (spotifyData.action === "next")    spotifyReply = spotifyData.track ? `Skipped to "${spotifyData.track}" by ${spotifyData.artist}, ${T}.` : `Skipped to next track, ${T}.`;
          else if (spotifyData.action === "volume")  spotifyReply = `Volume set to ${spotifyData.volume}%, ${T}.`;
          return res.json({ reply: spotifyReply, action: "SPOTIFY", intent: "spotify", meta: { spotifyData } });
        } catch (e) { return res.json({ reply: `Spotify command failed, ${T}. ${e.message}`, action: "SPOTIFY", intent: "spotify" }); }
      }
      case "gmail": {
        if (!Google.isConfigured()) return res.json({ reply: `Gmail isn't configured, ${T}.`, action: "GMAIL", intent: "gmail" });
        if (!Google.hasToken())     return res.json({ reply: `Gmail needs to be authorised first, ${T}.`, action: "GMAIL", intent: "gmail" });
        try {
          const gmailData = await Google.handleGmailCommand(message);
          if (gmailData.needsAuth) return res.json({ reply: `Gmail needs re-authorisation, ${T}.`, action: "GMAIL", intent: "gmail" });
          const gmailReply = gmailData.unread === 0 ? `Inbox clear, ${T}. No unread messages.` : `You have ${gmailData.unread} unread email${gmailData.unread > 1 ? "s" : ""}, ${T}.`;
          return res.json({ reply: gmailReply, action: "GMAIL", intent: "gmail", meta: { gmailData } });
        } catch (e) { return res.json({ reply: `Gmail fetch failed, ${T}. ${e.message}`, action: "GMAIL", intent: "gmail" }); }
      }
      case "diy": {
        try {
          const diyResult = await DIY.buildDIYProject(message, userTitle);
          Trainer.addExample(message, diyResult.reply, "diy_project", diyResult.project, 0.8, "diy");
          return res.json({ reply: diyResult.reply, action: "DIY_PROJECT", intent: "diy_project", meta: { images: diyResult.images, links: diyResult.links } });
        } catch (e) { return res.json({ reply: `DIY lookup failed, ${T}. ${e.message}`, action: "DIY_PROJECT", intent: "diy_project" }); }
      }
      case "calendar": {
        if (!Google.isConfigured()) return res.json({ reply: `Google Calendar isn't configured, ${T}.`, action: "CALENDAR", intent: "calendar" });
        if (!Google.hasToken())     return res.json({ reply: `Google Calendar needs to be authorised first, ${T}.`, action: "CALENDAR", intent: "calendar" });
        try {
          const calData = await Google.handleCalendarCommand(message);
          if (calData.needsAuth) return res.json({ reply: `Calendar needs re-authorisation, ${T}.`, action: "CALENDAR", intent: "calendar" });
          const calReply = !calData.events?.length ? `Nothing on the calendar ${calData.period || "today"}, ${T}.` : `${calData.events.length} event${calData.events.length > 1 ? "s" : ""} ${calData.period || "today"}, ${T}: ${calData.events.slice(0, 4).map(e => `${e.time ? e.time + " — " : ""}${e.title}`).join("; ")}.`;
          return res.json({ reply: calReply, action: "CALENDAR", intent: "calendar", meta: { calData } });
        } catch (e) { return res.json({ reply: `Calendar fetch failed, ${T}. ${e.message}`, action: "CALENDAR", intent: "calendar" }); }
      }
    }
  }

  if (action === "SHOW_HUD" || action === "HIDE_HUD") {
    return res.json({ reply, action, intent, meta: { query: message } });
  }

  // ── Fallback: try Groq if JARVIS gave a weak response ──
  const isWeakResponse = action === "FALLBACK" || (reply && reply.length < 50) || (action === "KNOWLEDGE" && reply.length < 100);

  if (isWeakResponse && Groq.isConfigured()) {
    // Log failure for learning
    Improve.failures.log(message, reply || "", action, sessionId);

    try {
      const memoryFacts = (memories || []).slice(0, 5);

      // Check if we have relevant training examples to prime Groq
      const relevantExamples = Trainer.findRelevantExamples(message, 2);
      const contextHint = relevantExamples.length > 0
        ? `Similar past conversations:\n${relevantExamples.map(e => `Q: ${e.input}\nA: ${e.output}`).join("\n\n")}\n\n`
        : "";

      const groqResult = await Groq.chat(message, {
        userTitle: T,
        memories:  memoryFacts,
        context:   contextHint + (topic ? `The user may be asking about: ${topic}` : ""),
      });

      if (groqResult.reply && groqResult.reply.length > 20) {
        // Learn from this — both in knowledge base and training data
        if (topic) {
          Improve.conversationLearner.learnFromSuccess(message, groqResult.reply, topic).catch(() => {});
        }
        Trainer.addExample(message, groqResult.reply, intent || "groq_answer", topic, 0.72, "groq");

        return res.json({
          reply:  groqResult.reply,
          action: action === "FALLBACK" ? "GROQ_ANSWER" : action,
          intent,
          topic,
          meta:   { ...meta, groqUsed: true },
        });
      }
    } catch (e) {
      console.warn("[GROQ] Fallback failed:", e.message);
    }

  } else if (action !== "FALLBACK" && reply && reply.length > 50) {
    // Successful JARVIS response — learn from it
    const quality = Trainer.scoreQuality(message, reply, action);
    Trainer.addExample(message, reply, intent || action, topic, quality, "jarvis");

    if (topic) {
      Improve.conversationLearner.learnFromSuccess(message, reply, topic).catch(() => {});
    }
  }

  // ── Standard actions ──
  if (action === "SHOW_LINKS") {
    return res.json({ reply, action, intent, meta: { requestLinks: true, linkGroups: getAllLinksFormatted(), total: linkSummary.total } });
  }
  if (action === "OPEN_LINK") {
    return res.json({ reply, action, intent, meta: { ...meta, ...lookupLink(message) } });
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
    const mem    = loadMemories();
    const key    = (userName || "user").toLowerCase().trim();
    if (!mem[key]) return res.json({ reply: `Nothing on file matching that, ${T}.`, action, intent });
    const before = mem[key].length;
    mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(meta.forgetHint.toLowerCase()));
    saveMemories(mem);
    const removed = before - mem[key].length;
    return res.json({ reply: removed > 0 ? `Done, ${T}. ${removed} memory entry removed.` : `Nothing matching that on file, ${T}.`, action, intent });
  }
  if (action === "SYSTEM_STATUS") {
    const uptime = Math.floor(process.uptime());
    const mem    = process.memoryUsage();
    return res.json({ reply, action, intent, meta: { uptime, heapUsed: (mem.heapUsed/1024/1024).toFixed(1), heapTotal: (mem.heapTotal/1024/1024).toFixed(1) } });
  }

  // ── Research fallback ──
  const ACTION_VERB_CHECK   = /^(write|create|build|make|generate|code|script|program|implement|develop|debug|fix|refactor|optimise|optimize|review|improve|give|show|set|open|launch|play|pause|stop|clip|save|record|switch|turn|enable|disable|activate|start|run|help me|can you|could you|please|navigate|pull up|bring up|load|display|render|draw|check|scan|find|remind|alert|schedule|automate|watch|monitor|read|translate|convert|calculate|solve|compute|figure out|work out|summarize|summarise|list|compare|call|ring|connect)/i;
  const COMMAND_SIGNALS     = /\b(clip|timer|alarm|reminder|links|camera|screen|memory|remember|forget|log.?out|weather|spotify|gmail|calendar|open|launch|navigate|turn on|turn off|set a|remind me|alert me|show me|pull up|build mode|hologram|3d|write me|create a|build me|make me|generate|give me|code a|function|class|script|api|server|endpoint|hello|hi|hey|good morning|good evening|how are you|thank|thanks|bye|goodbye|shut down|what time|what day|what date|clip that|save that|switch camera|smart home|lights|plug)\b/i;
  const looksLikeCommand    = ACTION_VERB_CHECK.test(message) || COMMAND_SIGNALS.test(message.toLowerCase());
  const shouldTryResearch   = !looksLikeCommand && (action === "FALLBACK" || (action === "KNOWLEDGE" && reply.length < 200) || Research.shouldResearch(message));

  if (shouldTryResearch) {
    try {
      const researched = await Research.research(message, userTitle);
      if (researched?.reply) {
        Trainer.addExample(message, researched.reply, "research", researched.query, 0.78, "research");
        if (researched.query) Improve.knowledge.store(researched.query, [researched.reply], "research");
        return res.json({ reply: researched.reply, action: action === "FALLBACK" ? "RESEARCH" : action, intent: "research", topic: researched.query, meta: { researched: true, sources: researched.sources } });
      }
    } catch {}
  }

  return res.json({ reply, action, intent, topic, meta });
});

// ══════════════════════════════════════════════════════════════
// ── BOOT ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

bootstrapOwnerAccount();
Improve.ensureDirs();

// Start background loops
Improve.startImprovementLoop(5 * 60 * 1000);   // analyse failures every 5 min
Trainer.startTrainingLoop(15 * 60 * 1000);       // reinforce weak areas every 15 min

httpServer.listen(PORT, () => {
  console.log(`\nJ.A.R.V.I.S online → http://localhost:${PORT}`);
  console.log(`  Comms panel    → http://localhost:${PORT}/comms`);
  console.log(`  Groq AI:       ${Groq.isConfigured() ? "✓ configured — self-improvement active" : "✗ not configured (add GROQ_API_KEY to .env)"}`);
  console.log(`  Spotify:       ${Spotify.isConfigured() ? "✓ configured" : "✗ add SPOTIFY_CLIENT_ID to .env"}`);
  console.log(`  Google:        ${Google.isConfigured()  ? "✓ configured" : "✗ add GOOGLE_CLIENT_ID to .env"}`);
  console.log(`  Weather:       ${process.env.OPENWEATHER_API_KEY ? "✓ configured" : "✗ add OPENWEATHER_API_KEY to .env"}`);
  console.log(`  Training data: /data/training_data.json`);
  console.log(`  Learned:       /data/learned/\n`);
});
