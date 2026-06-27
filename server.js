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
const Brain       = require("./brain");
const TTS = require("./tts");

const app        = express();
const httpServer = http.createServer(app);

// "phone"  → TTS audio is sent back to whichever client asked for it (default)
// "home"   → TTS audio is cast to the Google Home / Nest speaker instead
let outputMode = "phone";

const HOME_TALK_ON  = /\b(enable|turn on|activate)\s+home\s*talk\b/i;
const HOME_TALK_OFF = /\b(disable|turn off|deactivate)\s+home\s*talk\b/i;

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

// ═══════════════════════════════════════════════════════════════
// ── COMMS
// ═══════════════════════════════════════════════════════════════
const attachComms = require("./comms-server");
const io          = attachComms(httpServer);

app.get("/comms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "comms.html"));
});

// ═══════════════════════════════════════════════════════════════
// ── DRAFTING TABLE / BLUEPRINT MODE
// Hand-tracked sketch workspace: pull reference images from the
// web, draw over them, project the result as a 3D hologram.
// ═══════════════════════════════════════════════════════════════
app.get("/blueprint", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "blueprint-mode.html"));
});

app.get("/api/blueprint/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  if (!q) return res.json({ images: [] });
  try {
    const images = await DIY.searchImages(`${q} blueprint schematic engineering diagram`, 8);
    res.json({ images });
  } catch (e) {
    res.status(500).json({ images: [], error: e.message });
  }
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
app.get("/api/brain/stats", (req, res) => res.json(Brain.getGrowthStats()));
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

// ═══════════════════════════════════════════════════════════════
// ── HOME AUTOMATION
// ═══════════════════════════════════════════════════════════════
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
app.get("/api/home/scan-status",      (req, res) => res.json({ log: _scanLog }));
app.post("/api/home/control/:id", async (req, res) => res.json(await Home.controlDevice(decodeURIComponent(req.params.id), req.body)));
app.post("/api/home/control-all", async (req, res) => {
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

// ═══════════════════════════════════════════════════════════════
// ── SELF-IMPROVEMENT API
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// ── LEARNED INTENTS API
// ═══════════════════════════════════════════════════════════════
app.get("/api/learned", (req, res) => {
  res.json({
    stats:   Groq.getLearnedIntentsStats(),
    intents: Groq.getAllLearnedIntents(),
  });
});
app.delete("/api/learned/:id", (req, res) => {
  const ok = Groq.deleteLearnedIntent(req.params.id);
  res.json({ ok });
});
app.delete("/api/learned", (req, res) => {
  Groq.clearLearnedIntents();
  res.json({ ok: true, message: "All learned intents cleared" });
});
app.post("/api/learned/teach", (req, res) => {
  const { input, output, action, topic, keywords } = req.body;
  if (!input || !output) return res.status(400).json({ error: "Missing input or output" });
  const kw = keywords || Groq.extractKeywords(input);
  const ok  = Groq.learnIntent(input, output, action || "MANUAL_TEACH", topic || null, kw);
  res.json({ ok, keywords: kw });
});

// ═══════════════════════════════════════════════════════════════
// ── PROFILE ROUTES
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// ── MEMORY ROUTES
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// ── WEATHER
// ═══════════════════════════════════════════════════════════════
app.post("/api/weather", async (req, res) => {
  try { res.json(await Weather.handleWeatherCommand(req.body.message || "weather")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ── SPOTIFY
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// ── GOOGLE
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// ── PERSONALITY
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// ── EXTENSION API
// ═══════════════════════════════════════════════════════════════
const extensionQueue  = [];
let   extensionStatus = { phase: "idle", user: null, userTitle: null, mood: "neutral" };

app.get("/api/extension/poll",     (req, res) => res.json({ commands: extensionQueue.splice(0), status: extensionStatus }));
app.post("/api/extension/status",  (req, res) => { extensionStatus = { ...req.body }; res.json({ ok: true }); });
app.get("/api/extension/status",   (req, res) => res.json(extensionStatus));
app.post("/api/extension/command", (req, res) => {
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

// ═══════════════════════════════════════════════════════════════
// ── RESEARCH
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// ── SCREEN ANALYSIS
// ═══════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════
// ── NOTIFY ENDPOINT
// ═══════════════════════════════════════════════════════════════
app.post("/api/notify", (req, res) => {
  const { message, from, type } = req.body;
  if (!message) return res.status(400).json({ error: "Missing message" });
  console.log(`[NOTIFY] ${from || "Unknown"}: ${message}`);
  res.json({ ok: true, received: true });
});

// ═══════════════════════════════════════════════════════════════
// ── GITHUB DEPLOY (feature draft/ship)
// ═══════════════════════════════════════════════════════════════
let _pendingPR = null;

// Direct API endpoints (still available for manual use)
app.post("/api/feature/draft", async (req, res) => {
  const { description, filePath } = req.body;
  const T = "Sir";
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return res.json({ reply: `GitHub isn't configured, ${T}. Add GITHUB_TOKEN and GITHUB_REPO to your .env file.` });
  }
  if (!Groq.isConfigured()) {
    return res.json({ reply: `Groq isn't configured, ${T}. Add GROQ_API_KEY to .env.` });
  }
  try {
    const GitDeploy  = require("./github-deploy");
    const code = await Groq.generateCode(
      `Add this feature to a JARVIS Node.js assistant codebase: ${description}. Return only the complete updated file contents for ${filePath || "server.js"}. No explanation, no markdown fences.`
    );
    const branchName = `feature/${Date.now()}`;
    await GitDeploy.createFeatureBranch(branchName);
    await GitDeploy.commitFile(filePath || "server.js", code, `feat: ${description}`, branchName);
    const pr = await GitDeploy.openPullRequest(branchName, description, "Drafted by JARVIS — review before merging.");
    _pendingPR = pr.number;
    res.json({ reply: `Drafted "${description}", ${T}. PR #${pr.number} is open: ${pr.html_url}. Say "ship it" to merge.` });
  } catch (e) {
    res.json({ reply: `Couldn't draft that, ${T}: ${e.message}` });
  }
});

app.post("/api/feature/ship", async (req, res) => {
  const T = "Sir";
  if (!_pendingPR) return res.json({ reply: `Nothing drafted to ship yet, ${T}.` });
  try {
    const GitDeploy = require("./github-deploy");
    await GitDeploy.mergePullRequest(_pendingPR);
    const prNum = _pendingPR;
    _pendingPR  = null;
    res.json({ reply: `PR #${prNum} merged, ${T}. Deployment will trigger automatically if CI is configured.` });
  } catch (e) {
    res.json({ reply: `Merge failed, ${T}: ${e.message}` });
  }
});

// ═══════════════════════════════════════════════════════════════
// ── HARD COMMAND PATTERNS
// ═══════════════════════════════════════════════════════════════
const HARD_COMMANDS = {
  timer:        /\b(set a timer|timer for|remind me in|remind me to .+ in|alarm in|alert me in)\b/i,
  clip:         /\b(clip that|save clip|clip the last|save the last|record that|capture that)\b/i,
  weather:      /\b(weather|temperature|forecast|how hot|how cold|what's the temp)\b/i,
  spotify:      /\b(play|pause|skip|next track|now playing|what's playing|stop music|resume music|volume up|volume down)\b/i,
  gmail:        /\b(check (my )?email|unread emails|inbox|gmail|new emails|check mail)\b/i,
  calendar:     /\b(calendar|schedule|what's on|today's events|upcoming events|agenda|my meetings)\b/i,
  links:        /\b(show (my |all )?links|open links|link bank|all my links)\b/i,
  openLink:     /\b(open|launch|pull up|go to)\b.{1,40}\b(infamous|petzah|fern|vapor)\b/i,
  hologram:     /\b(show me a (3d|hologram)|holographic|3d model|3d scan|build mode)\b/i,
  lookup:       /\b(look up|lookup|background check|pull everything on|find info on|osint|intel on)\b/i,
  memory:       /\b(remember that|memorize|save that fact|note that|i want you to remember)\b/i,
  memForget:    /\b(forget|delete memory|erase|clear memory|stop remembering)\b/i,
  readScreen:   /\b(read (my )?screen|what('s| is) on (my )?screen|analyze screen|scan screen)\b/i,
  switchCam:    /\b(switch camera|camera \d|use camera|change camera)\b/i,
  systemStatus: /\b(system status|diagnostics|all systems|health check|uptime|are you ok)\b/i,
  logout:       /\b(log out|logout|sign out|goodbye|shut down jarvis|close session)\b/i,
  diy:          /\b(build|make|design|construct)\b.{0,40}\b(for \$\d+|under \$\d+|\d+ dollars?|cheap|budget)\b/i,
  home:         /\b(smart home|home panel|lights|plugs|devices on network|scan network|scan home)\b/i,
  showHUD:      /\b(show hud|pull up hud|open hud|solve|calculate|annotate screen)\b/i,
  hideHUD:      /\b(hide hud|close hud|dismiss hud|hud off)\b/i,
  call:         /\b(call|ring|facetime|video call|voice call)\b.{1,30}\b\w+\b/i,
  // ── NEW: GitHub feature draft & ship ──
  featureDraft: /\b(draft|build|add|create|implement|write)\s+.{3,80}(feature|function|route|endpoint|module|handler|integration|support|capability)\b/i,
  featureShip:  /\b(ship it|ship that|merge it|deploy it|push it|go live|merge the pr|ship the pr|merge and deploy)\b/i,
};

function isHardCommand(message) {
  // featureDraft must be checked before generic "create/build" patterns
  // to avoid collision with the diy pattern
  if (HARD_COMMANDS.featureShip.test(message))  return "featureShip";
  if (HARD_COMMANDS.featureDraft.test(message)) return "featureDraft";
  for (const [type, pattern] of Object.entries(HARD_COMMANDS)) {
    if (type === "featureDraft" || type === "featureShip") continue;
    if (pattern.test(message)) return type;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// ── SHARED FETCH HANDLERS
// ═══════════════════════════════════════════════════════════════
async function handleWeatherFetch(message, T) {
  try {
    const wd = await Weather.handleWeatherCommand(message);
    if (wd.error) return { reply: `Couldn't get weather right now, ${T}. ${wd.error}`, action: "WEATHER", intent: "weather" };
    const wr = `Current conditions in ${wd.city}, ${T}: ${wd.temp}°C — ${wd.description}. Feels like ${wd.feels_like}°C. Humidity ${wd.humidity}%, wind ${wd.wind_speed} m/s. Range today: ${wd.low}–${wd.high}°C.`;
    return { reply: wr, action: "WEATHER", intent: "weather", meta: { weatherData: wd } };
  } catch (e) {
    return { reply: `Weather fetch failed, ${T}. Check your OpenWeatherMap API key.`, action: "WEATHER", intent: "weather" };
  }
}

async function handleSpotifyFetch(message, T) {
  if (!Spotify.isConfigured()) return { reply: `Spotify isn't configured, ${T}. Add SPOTIFY_CLIENT_ID to .env.`, action: "SPOTIFY", intent: "spotify" };
  if (!Spotify.hasToken())     return { reply: `Spotify needs authorisation first, ${T}. Visit /api/spotify/auth.`, action: "SPOTIFY", intent: "spotify" };
  try {
    const sd = await Spotify.handleSpotifyCommand(message);
    if (sd.needsAuth) return { reply: `Spotify needs re-authorisation, ${T}.`, action: "SPOTIFY", intent: "spotify" };
    let sr = `Spotify command processed, ${T}.`;
    if (sd.action === "now_playing") sr = sd.track ? `${sd.is_playing ? "Playing" : "Paused on"}: "${sd.track}" by ${sd.artist}, ${T}.` : `Nothing playing right now, ${T}.`;
    else if (sd.action === "played")  sr = `Playing "${sd.track}" by ${sd.artist}, ${T}.`;
    else if (sd.action === "paused")  sr = `Spotify paused, ${T}.`;
    else if (sd.action === "resumed") sr = `Spotify resumed, ${T}.`;
    else if (sd.action === "next")    sr = sd.track ? `Skipped to "${sd.track}" by ${sd.artist}, ${T}.` : `Skipped to next track, ${T}.`;
    else if (sd.action === "volume")  sr = `Volume set to ${sd.volume}%, ${T}.`;
    return { reply: sr, action: "SPOTIFY", intent: "spotify", meta: { spotifyData: sd } };
  } catch (e) {
    return { reply: `Spotify command failed, ${T}.`, action: "SPOTIFY", intent: "spotify" };
  }
}

async function handleGmailFetch(message, T) {
  if (!Google.isConfigured()) return { reply: `Gmail isn't configured, ${T}.`, action: "GMAIL", intent: "gmail" };
  if (!Google.hasToken())     return { reply: `Gmail needs authorisation first, ${T}.`, action: "GMAIL", intent: "gmail" };
  try {
    const gd = await Google.handleGmailCommand(message);
    if (gd.needsAuth) return { reply: `Gmail needs re-authorisation, ${T}.`, action: "GMAIL", intent: "gmail" };
    const gr = gd.unread === 0 ? `Inbox clear, ${T}. No unread messages.` : `You have ${gd.unread} unread email${gd.unread > 1 ? "s" : ""}, ${T}.`;
    return { reply: gr, action: "GMAIL", intent: "gmail", meta: { gmailData: gd } };
  } catch (e) {
    return { reply: `Gmail fetch failed, ${T}.`, action: "GMAIL", intent: "gmail" };
  }
}

async function handleCalendarFetch(message, T) {
  if (!Google.isConfigured()) return { reply: `Google Calendar isn't configured, ${T}.`, action: "CALENDAR", intent: "calendar" };
  if (!Google.hasToken())     return { reply: `Calendar needs authorisation first, ${T}.`, action: "CALENDAR", intent: "calendar" };
  try {
    const cd = await Google.handleCalendarCommand(message);
    if (cd.needsAuth) return { reply: `Calendar needs re-authorisation, ${T}.`, action: "CALENDAR", intent: "calendar" };
    const cr = !cd.events?.length
      ? `Nothing on the calendar ${cd.period || "today"}, ${T}.`
      : `${cd.events.length} event${cd.events.length > 1 ? "s" : ""} ${cd.period || "today"}, ${T}: ${cd.events.slice(0, 4).map(e => `${e.time ? e.time + " — " : ""}${e.title}`).join("; ")}.`;
    return { reply: cr, action: "CALENDAR", intent: "calendar", meta: { calData: cd } };
  } catch (e) {
    return { reply: `Calendar fetch failed, ${T}.`, action: "CALENDAR", intent: "calendar" };
  }
}

async function handlePersonFetch(message, meta, T) {
  const personName = meta?.personName;
  if (!personName) return { reply: `Who do you want me to look up, ${T}?`, action: "LOOKUP_PERSON", intent: "lookup_person" };
  try {
    const ld = await Research.lookupPerson(personName);
    const lr = Research.buildPersonIntelReport(ld, T);
    return { reply: lr, action: "LOOKUP_PERSON", intent: "lookup_person", meta: { personName, raw: ld } };
  } catch (e) {
    return { reply: `Person lookup hit an error, ${T}. Try again.`, action: "LOOKUP_PERSON", intent: "lookup_person" };
  }
}

async function handleDIYFetch(message, userTitle) {
  const T = userTitle || "Sir";
  try {
    const dr = await DIY.buildDIYProject(message, userTitle);
    return { reply: dr.reply, action: "DIY_PROJECT", intent: "diy_project", meta: { images: dr.images, links: dr.links } };
  } catch (e) {
    return { reply: `DIY lookup failed, ${T}.`, action: "DIY_PROJECT", intent: "diy_project" };
  }
}

// ── NEW: Feature draft/ship handlers ─────────────────────────
async function handleFeatureDraft(message, T) {
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) {
    return {
      reply:  `GitHub isn't configured, ${T}. Add GITHUB_TOKEN and GITHUB_REPO to your .env file, then try again.`,
      action: "FEATURE_DRAFT",
      intent: "feature_draft",
    };
  }
  if (!Groq.isConfigured()) {
    return {
      reply:  `Groq isn't configured, ${T}. Add GROQ_API_KEY to .env — it's needed to generate the code.`,
      action: "FEATURE_DRAFT",
      intent: "feature_draft",
    };
  }

  // Strip filler words to get the core description
  const desc = message
    .replace(/\b(jarvis[,.]?\s*)?(draft|build|add|create|implement|write|a|an|the)\b/gi, "")
    .replace(/\b(feature|function|route|endpoint|module|handler|integration|support|capability)\b/gi, "")
    .trim()
    .replace(/\s+/g, " ")
    || message.trim();

  // Pick the most likely file to edit
  const fileMap = {
    route:       "server.js",
    endpoint:    "server.js",
    api:         "server.js",
    server:      "server.js",
    integration: "server.js",
    handler:     "ai-engine.js",
    intent:      "ai-engine.js",
    personality: "personality.js",
    research:    "research.js",
    diy:         "diy-builder.js",
    home:        "home.js",
    groq:        "groq-engine.js",
    spotify:     "spotify.js",
    weather:     "weather.js",
    google:      "google.js",
  };
  const lower    = message.toLowerCase();
  const fileKey  = Object.keys(fileMap).find(k => lower.includes(k)) || "feature";
  const filePath = fileMap[fileKey] || "server.js";

  try {
    const GitDeploy = require("./github-deploy");
    const code = await Groq.generateCode(
      `Add this feature to a JARVIS Node.js AI assistant codebase: "${desc}". ` +
      `Return ONLY the complete updated file contents for ${filePath}. ` +
      `No explanation, no markdown code fences, no preamble — just the raw JavaScript.`
    );
    const safeName   = desc.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
    const branchName = `feature/${safeName}-${Date.now()}`;
    await GitDeploy.createFeatureBranch(branchName);
    await GitDeploy.commitFile(filePath, code, `feat: ${desc}`, branchName);
    const pr = await GitDeploy.openPullRequest(
      branchName,
      desc,
      `Drafted by J.A.R.V.I.S\n\nFile: \`${filePath}\`\n\nReview before merging.`
    );
    _pendingPR = pr.number;
    return {
      reply:  `Drafted "${desc}", ${T}. PR #${pr.number} is open for review: ${pr.html_url}. Say "ship it" to merge.`,
      action: "FEATURE_DRAFT",
      intent: "feature_draft",
      meta:   { pr: pr.number, url: pr.html_url, branch: branchName, file: filePath },
    };
  } catch (e) {
    return {
      reply:  `Draft failed, ${T}: ${e.message}`,
      action: "FEATURE_DRAFT",
      intent: "feature_draft",
    };
  }
}

async function handleFeatureShip(T) {
  if (!_pendingPR) {
    return {
      reply:  `Nothing drafted to ship yet, ${T}. Say "draft a [description] feature" first.`,
      action: "FEATURE_SHIP",
      intent: "feature_ship",
    };
  }
  try {
    const GitDeploy = require("./github-deploy");
    await GitDeploy.mergePullRequest(_pendingPR);
    const prNum = _pendingPR;
    _pendingPR  = null;
    return {
      reply:  `PR #${prNum} merged, ${T}. If CI/CD is configured the deployment will trigger automatically.`,
      action: "FEATURE_SHIP",
      intent: "feature_ship",
    };
  } catch (e) {
    return {
      reply:  `Merge failed, ${T}: ${e.message}`,
      action: "FEATURE_SHIP",
      intent: "feature_ship",
    };
  }
}

// ═══════════════════════════════════════════════════════════════
// ── MAIN CHAT ROUTE
// ═══════════════════════════════════════════════════════════════
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  const T = userTitle || "Sir";

  // ── 0. Home Talk toggle — checked first so it never collides with
  //      smart-home / smalltalk / AI routing below ──
  if (HOME_TALK_ON.test(message)) {
    const Cast = require("./cast");
    if (!Cast.isConfigured()) {
      return res.json({
        reply:  `Home Talk needs a speaker configured first, ${T}. Set "castDevice" in config.json to your Google Home's name, then try again.`,
        action: "HOME_TALK_ON",
        intent: "home_talk",
        meta:   { outputMode, configured: false },
      });
    }
    outputMode = "home";
    return res.json({
      reply:  `Home Talk enabled, ${T}. I'll speak through ${Cast.deviceName()} from now on — say "Jarvis, disable home talk" to bring it back to your phone.`,
      action: "HOME_TALK_ON",
      intent: "home_talk",
      meta:   { outputMode, device: Cast.deviceName() },
    });
  }
  if (HOME_TALK_OFF.test(message)) {
    outputMode = "phone";
    return res.json({
      reply:  `Home Talk disabled, ${T}. Back to talking through your phone.`,
      action: "HOME_TALK_OFF",
      intent: "home_talk",
      meta:   { outputMode },
    });
  }

  // ── 1. Home commands ──
  if (Home.isHomeCommand(message) || Home.isHomePanelRequest(message)) {
    if (Home.isHomePanelRequest(message)) {
      return res.json({ reply: `Opening home control panel, ${T}.`, action: "OPEN_HOME", intent: "home", meta: { openHome: true } });
    }
    return Home.executeVoiceCommand(message, T)
      .then(homeReply => res.json({ reply: homeReply, action: "HOME_COMMAND", intent: "home" }))
      .catch(() => res.json({ reply: `Home command failed, ${T}.`, action: "HOME_COMMAND", intent: "home" }));
  }

  // ── 1.5. Drafting table / blueprint mode ──
  if (/\b(blueprint|blue print|drafting table|design table|engineering bay|cad mode|let'?s design|sketch (out|something)|draft something|design something)\b/i.test(message)) {
    return res.json({
      reply: `Opening the drafting table, ${T}. Pull a reference off the web, sketch over it with your hand, and I'll project it straight into a hologram.`,
      action: "SHOW_BLUEPRINT",
      intent: "blueprint",
      meta: { query: message },
    });
  }

  // ── 2. Personality shortcuts (no AI needed) ──
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

  // ── 3. Hard commands ──
  const hardCommandType = isHardCommand(message);

  if (hardCommandType) {
    // ── Feature draft/ship — handled directly, no AI engine needed ──
    if (hardCommandType === "featureDraft") {
      return res.json(await handleFeatureDraft(message, T));
    }
    if (hardCommandType === "featureShip") {
      return res.json(await handleFeatureShip(T));
    }

    const linkSummary = getLinksSummary();
    const serverData  = { ...linkSummary, allLinks: getAllLinksFormatted(), ...lookupLink(message) };

    let aiResult;
    try {
      aiResult = AI.process({ message, sessionId, userName, userTitle, memories, moodContext, serverData });
    } catch (err) {
      console.error("[AI] Hard command error:", err);
      aiResult = { reply: `Command failed, ${T}.`, action: "ERROR" };
    }

    const { reply, action, meta, intent, needsFetch, fetchType, topic } = aiResult;

    // Handle fetches for hard commands
    if (needsFetch) {
      switch (fetchType) {
        case "weather":  return res.json(await handleWeatherFetch(message, T));
        case "spotify":  return res.json(await handleSpotifyFetch(message, T));
        case "gmail":    return res.json(await handleGmailFetch(message, T));
        case "calendar": return res.json(await handleCalendarFetch(message, T));
        case "person":   return res.json(await handlePersonFetch(message, meta, T));
        case "diy":      return res.json(await handleDIYFetch(message, userTitle));
      }
    }

    // Special action handling
    if (action === "SHOW_LINKS") {
      return res.json({ reply, action, intent, meta: { requestLinks: true, linkGroups: getAllLinksFormatted(), total: getLinksSummary().total } });
    }
    if (action === "OPEN_LINK") {
      return res.json({ reply, action, intent, meta: { ...meta, ...lookupLink(message) } });
    }
    if (action === "SHOW_HUD" || action === "HIDE_HUD") {
      return res.json({ reply, action, intent, meta: { query: message } });
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
      if (!mem[key]) return res.json({ reply: `Nothing matching that on file, ${T}.`, action, intent });
      const before = mem[key].length;
      mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(meta.forgetHint.toLowerCase()));
      saveMemories(mem);
      const removed = before - mem[key].length;
      return res.json({ reply: removed > 0 ? `Done, ${T}. ${removed} memory entry removed.` : `Nothing matching that on file, ${T}.`, action, intent });
    }

    return res.json({ reply, action: action || "COMMAND", intent: intent || hardCommandType, topic, meta });
  }

// ── 4. Everything else → local brain first, Groq as tutor only when needed ──
  const linkSummary2 = getLinksSummary();
  const serverData2  = { ...linkSummary2, allLinks: getAllLinksFormatted(), ...lookupLink(message) };

  let result;
  try {
    result = await Brain.respond({ message, sessionId, userName, userTitle, memories, moodContext, serverData: serverData2 });
  } catch (err) {
    console.error("[BRAIN] Error:", err);
    Improve.failures.log(message, "", "BRAIN_CRASH", sessionId);
    return res.json({ reply: `Something went sideways, ${T}.`, action: "ERROR" });
  }

  if (result.needsFetch) {
    switch (result.fetchType) {
      case "weather":  return res.json(await handleWeatherFetch(message, T));
      case "spotify":  return res.json(await handleSpotifyFetch(message, T));
      case "gmail":    return res.json(await handleGmailFetch(message, T));
      case "calendar": return res.json(await handleCalendarFetch(message, T));
      case "person":   return res.json(await handlePersonFetch(message, result.meta, T));
      case "diy":      return res.json(await handleDIYFetch(message, userTitle));
    }
  }

  if (result.source === "tutor") {
    Trainer.addExample(message, result.reply, "tutored", result.topic, 0.75, "groq_tutor");
  } else if (result.action === "FALLBACK") {
    Improve.failures.log(message, result.reply || "", result.action, sessionId);
  } else {
    const quality = Trainer.scoreQuality(message, result.reply, result.action);
    Trainer.addExample(message, result.reply, result.intent || result.action, result.topic, quality, result.source || "local");
  }

  return res.json(result);
});

// ═══════════════════════════════════════════════════════════════
// ── BOOT
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

bootstrapOwnerAccount();
Improve.ensureDirs();

Improve.startImprovementLoop(5 * 60 * 1000);
Trainer.startTrainingLoop(15 * 60 * 1000);
// ═══════════════════════════════════════════════════════════════
// ── PIPER TTS ROUTE
// ═══════════════════════════════════════════════════════════════
app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });

  if (!TTS.isReady()) {
    // Model still downloading — tell client to use browser voice
    return res.status(503).json({ error: "Voice model loading", fallback: true });
  }

  const audio = await TTS.synthesize(text);
  if (!audio) {
    return res.status(500).json({ error: "Synthesis failed", fallback: true });
  }

  // ── Home Talk: cast the clip to the Google Home instead of the phone ──
  if (outputMode === "home") {
    const Cast = require("./cast");
    try {
      const mediaUrl = Cast.publishAudio(audio, PORT);
      await Cast.playOnDevice(mediaUrl);
      return res.json({ ok: true, castTo: Cast.deviceName() });
    } catch (e) {
      console.error("[CAST] Home Talk failed, falling back to phone audio:", e.message);
      // fall through to the normal phone-audio response below
    }
  }

  res.setHeader("Content-Type",  "audio/wav");
  res.setHeader("Content-Length", audio.length);
  res.setHeader("Cache-Control",  "no-cache");
  res.send(audio);
});

// Status check — client can poll this on startup to know when voice is ready
app.get("/api/tts/status", (req, res) => {
  res.json({ ready: TTS.isReady() });
});

// Home Talk state — lets the frontend show an accurate badge on load/refresh
app.get("/api/home-talk/status", (req, res) => {
  const Cast = require("./cast");
  res.json({ outputMode, device: Cast.deviceName(), configured: Cast.isConfigured() });
});

httpServer.listen(PORT, () => {
  console.log(`\nJ.A.R.V.I.S online → http://localhost:${PORT}`);
  console.log(`  Comms panel    → http://localhost:${PORT}/comms`);
  console.log(`  Drafting table → http://localhost:${PORT}/blueprint`);
  console.log(`  Groq AI:       ${Groq.isConfigured() ? "✓ configured — primary brain active" : "✗ not configured (add GROQ_API_KEY to .env)"}`);
  console.log(`  Spotify:       ${Spotify.isConfigured() ? "✓ configured" : "✗ add SPOTIFY_CLIENT_ID to .env"}`);
  console.log(`  Google:        ${Google.isConfigured()  ? "✓ configured" : "✗ add GOOGLE_CLIENT_ID to .env"}`);
  console.log(`  Weather:       ${process.env.OPENWEATHER_API_KEY ? "✓ configured" : "✗ add OPENWEATHER_API_KEY to .env"}`);
  console.log(`  GitHub deploy: ${process.env.GITHUB_TOKEN ? "✓ configured" : "✗ add GITHUB_TOKEN + GITHUB_REPO to .env"}`);
  console.log(`  Training data: /data/training_data.json`);
  console.log(`  Learned:       /data/learned/\n`);
});
