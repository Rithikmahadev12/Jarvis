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
const Home = require("./home");

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

// ══════════════════════════════════════════════════════════════════
// ── COMMS — Socket.IO real-time layer ────────────────────────────
// ══════════════════════════════════════════════════════════════════
const attachComms = require("./comms-server");
const io          = attachComms(httpServer);

// Serve the comms panel
app.get("/comms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "comms.html"));
});

// ── LINKS BANK ──────────────────────────────────────────────────
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

// ── LINKS API ────────────────────────────────────────────────────
app.get("/api/links",         (req, res) => res.json({ groups: Object.keys(LINKS), summary: getLinksSummary(), all: getAllLinksFormatted() }));
app.get("/api/links/summary", (req, res) => res.json(getLinksSummary()));
app.get("/api/links/all",     (req, res) => res.json({ links: getAllLinksFormatted() }));

app.post("/api/link", (req, res) => {
  const { query } = req.body;
  if (!query) return res.status(400).json({ found: false });
  res.json(lookupLink(query));
});

// ── PERSISTENT STORE ─────────────────────────────────────────────
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

// ── BOOTSTRAP OWNER ACCOUNT ──────────────────────────────────────
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
      console.log(`[BOOT] Owner account "${owner.username}" password synced from config.json`);
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
  console.log(`[BOOT] Owner account "${owner.username}" bootstrapped from config.json`);
}

app.get("/favicon.ico", (req, res) => res.status(204).end());

let _scanLog = '';

app.get("/home", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "home.html"));
});

app.get("/api/home/info", (req, res) => {
  res.json({ subnets: Home.getLocalSubnets(), localIPs: Home.getLocalIPs() });
});

app.get("/api/home/devices", async (req, res) => {
  const devices = Home.getDeviceList();
  res.json({ devices, count: devices.length, lastScan: Home.lastScanTime() });
});

app.post("/api/home/scan", async (req, res) => {
  const { deep } = req.body;
  _scanLog = 'Starting scan...';
  try {
    const devices = await Home.scanNetwork({
      useSSDP: true,
      useKasa: true,
      useHTTP: !!deep,
      onProgress: (msg) => { _scanLog = msg; console.log('[HOME]', msg); }
    });
    res.json({ devices, count: devices.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/home/scan-status", (req, res) => {
  res.json({ log: _scanLog });
});

app.post("/api/home/control/:id", async (req, res) => {
  const result = await Home.controlDevice(decodeURIComponent(req.params.id), req.body);
  res.json(result);
});

app.post("/api/home/control-all", async (req, res) => {
  const devices = Home.getDeviceList().filter(d => !d._needsPairing && d.reachable !== false);
  const results = await Promise.all(devices.map(d => Home.controlDevice(d.id, req.body)));
  res.json({ ok: true, count: results.filter(r => r.ok).length });
});

app.post("/api/home/voice", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });
  const reply = await Home.executeVoiceCommand(text, 'Sir');
  await Home.refreshStates();
  res.json({ reply });
});

app.post("/api/home/device/:id/room", async (req, res) => {
  const { room } = req.body;
  const ok = Home.assignRoom(decodeURIComponent(req.params.id), room);
  res.json({ ok });
});

app.post("/api/home/hue/pair", async (req, res) => {
  const result = await Home.pairHueBridge();
  res.json(result);
});
// ── PROFILE ROUTES ────────────────────────────────────────────────
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
  const key      = req.params.name.toLowerCase().trim();
  const profile  = profiles[key];
  if (!profile) return res.json({ found: false });
  const { passwordHash, ...safe } = profile;
  res.json({ found: true, profile: safe });
});

app.post("/api/verify", (req, res) => {
  const { name, passwordHash } = req.body;
  if (!name || !passwordHash) return res.status(400).json({ authorized: false });
  const profiles = loadProfiles();
  const key      = name.toLowerCase().trim();
  const stored   = profiles[key];
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

// ── MEMORY ROUTES ─────────────────────────────────────────────────
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
  const mem  = loadMemories();
  const key  = user.toLowerCase().trim();
  if (!mem[key]) return res.json({ removed: 0 });
  const before = mem[key].length;
  mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(hint.toLowerCase()));
  saveMemories(mem);
  res.json({ removed: before - mem[key].length });
});

// ══════════════════════════════════════════════════════════════════
// ── WEATHER INTEGRATION ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
app.post("/api/weather", async (req, res) => {
  const { message } = req.body;
  try {
    const data = await Weather.handleWeatherCommand(message || "weather");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── SPOTIFY INTEGRATION ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
app.get("/api/spotify/auth", (req, res) => {
  if (!Spotify.isConfigured()) {
    return res.status(400).json({ error: "Spotify credentials not configured in .env" });
  }
  res.redirect(Spotify.getAuthUrl());
});

app.get("/api/spotify/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Spotify auth failed: ${error}</h2><p>Close this tab and try again.</p>`);
  if (!code)  return res.send("<h2>No code returned from Spotify.</h2>");
  const result = await Spotify.exchangeCode(code);
  if (result.error) return res.send(`<h2>Token exchange failed: ${result.error}</h2>`);
  res.send(`
    <html><body style="background:#010c14;color:#00c8ff;font-family:monospace;text-align:center;padding:60px">
      <h2>✓ Spotify connected successfully</h2>
      <p>You can close this tab. J.A.R.V.I.S now has Spotify control.</p>
    </body></html>
  `);
});

app.post("/api/spotify", async (req, res) => {
  const { message } = req.body;
  if (!Spotify.isConfigured()) {
    return res.json({ error: "Spotify not configured", needsAuth: true, authUrl: "/api/spotify/auth" });
  }
  if (!Spotify.hasToken()) {
    return res.json({ needsAuth: true, authUrl: "/api/spotify/auth" });
  }
  try {
    const data = await Spotify.handleSpotifyCommand(message || "now playing");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── GOOGLE INTEGRATION (Gmail + Calendar) ─────────────────────────
// ══════════════════════════════════════════════════════════════════
app.get("/api/google/auth", (req, res) => {
  if (!Google.isConfigured()) {
    return res.status(400).json({ error: "Google credentials not configured in .env" });
  }
  res.redirect(Google.getAuthUrl());
});

app.get("/api/google/callback", async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.send(`<h2>Google auth failed: ${error}</h2><p>Close this tab and try again.</p>`);
  if (!code)  return res.send("<h2>No code returned from Google.</h2>");
  const result = await Google.exchangeCode(code);
  if (result.error) return res.send(`<h2>Token exchange failed: ${result.error}</h2>`);
  res.send(`
    <html><body style="background:#010c14;color:#00c8ff;font-family:monospace;text-align:center;padding:60px">
      <h2>✓ Google connected successfully</h2>
      <p>Gmail and Google Calendar are now active. Close this tab.</p>
    </body></html>
  `);
});

app.post("/api/gmail", async (req, res) => {
  const { message } = req.body;
  if (!Google.isConfigured()) {
    return res.json({ error: "Google not configured", needsAuth: true, authUrl: "/api/google/auth" });
  }
  if (!Google.hasToken()) {
    return res.json({ needsAuth: true, authUrl: "/api/google/auth" });
  }
  try {
    const data = await Google.handleGmailCommand(message || "check inbox");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/calendar", async (req, res) => {
  const { message } = req.body;
  if (!Google.isConfigured()) {
    return res.json({ error: "Google not configured", needsAuth: true, authUrl: "/api/google/auth" });
  }
  if (!Google.hasToken()) {
    return res.json({ needsAuth: true, authUrl: "/api/google/auth" });
  }
  try {
    const data = await Google.handleCalendarCommand(message || "today's events");
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── PERSONALITY ───────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
app.post("/api/personality/comment", (req, res) => {
  const { scene, userTitle, sessionMinutes, previousScene } = req.body;
  const T = userTitle || "Sir";
  if (scene === previousScene && scene === "idle") return res.json({ reply: null });
  const reply = Personality.getCameraComment(scene, T, sessionMinutes);
  res.json({ reply: reply || null });
});
if (Home.isHomeCommand(message) || Home.isHomePanelRequest(message)) {
  if (Home.isHomePanelRequest(message)) {
    const reply = `Opening home control panel, ${T}.`;
    return res.json({ reply, action: "OPEN_HOME", intent: "home", meta: { openHome: true } });
  }
  const reply = await Home.executeVoiceCommand(message, T);
  await Home.refreshStates();
  return res.json({ reply, action: "HOME_COMMAND", intent: "home" });
}
app.post("/api/personality/smalltalk", (req, res) => {
  const { message, userTitle } = req.body;
  const T = userTitle || "Sir";
  if (!message) return res.status(400).json({ reply: null });
  const personalNewsReply = Personality.routePersonalNews(message, T);
  if (personalNewsReply) return res.json({ reply: personalNewsReply });
  const reply = Personality.routeSmallTalk(message, T);
  res.json({ reply: reply || null });
});

// ══════════════════════════════════════════════════════════════════
// ── EXTENSION API ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
const extensionQueue  = [];
let   extensionStatus = { phase: "idle", user: null, userTitle: null, mood: "neutral" };

app.get("/api/extension/poll", (req, res) => {
  const commands = extensionQueue.splice(0);
  res.json({ commands, status: extensionStatus });
});

app.post("/api/extension/status", (req, res) => {
  const { phase, user, userTitle, mood, moodScore } = req.body;
  extensionStatus = { phase, user, userTitle, mood, moodScore };
  res.json({ ok: true });
});

app.get("/api/extension/status", (req, res) => {
  res.json(extensionStatus);
});

app.post("/api/extension/command", (req, res) => {
  const { action, data } = req.body;
  if (!action) return res.status(400).json({ error: "Missing action" });
  extensionQueue.push({ action, data: data || {} });
  res.json({ ok: true, queued: extensionQueue.length });
});

app.get("/api/extension/download", (req, res) => {
  const extDir = path.join(__dirname, "extension");
  if (!fs.existsSync(extDir)) {
    return res.status(404).json({ error: "Extension folder not found" });
  }
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="jarvis-extension.zip"');
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => { console.error("[EXT] Archive error:", err); res.status(500).end(); });
  archive.pipe(res);
  archive.directory(extDir, "jarvis-extension");
  archive.finalize();
});

// ══════════════════════════════════════════════════════════════════
// ── RESEARCH ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
app.post("/api/research", async (req, res) => {
  const { query, userTitle } = req.body;
  if (!query) return res.status(400).json({ error: "Missing query" });
  try {
    const result = await Research.research(query, userTitle || "Sir");
    res.json(result || { reply: null, message: "No results found" });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/research/person", async (req, res) => {
  const { name, userTitle } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });
  try {
    const data   = await Research.lookupPerson(name);
    const report = Research.buildPersonIntelReport(data, userTitle || "Sir");
    res.json({ reply: report, raw: data, name });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// ── SCREEN ANALYSIS ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
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

// ══════════════════════════════════════════════════════════════════
// ── MAIN CHAT ROUTE ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  const T = userTitle || "Sir";

  const personalNewsReply = Personality.routePersonalNews(message, T);
  if (personalNewsReply) return res.json({ reply: personalNewsReply, action: "PERSONAL_NEWS", intent: "personal_news" });

  const smalltalkReply = Personality.routeSmallTalk(message, T);
  if (smalltalkReply) return res.json({ reply: smalltalkReply, action: "SMALLTALK", intent: "smalltalk" });

  const linkSummary = getLinksSummary();
  const serverData  = { ...linkSummary, allLinks: getAllLinksFormatted() };
  const linkResult  = lookupLink(message);
  if (linkResult.found) Object.assign(serverData, linkResult);

  let aiResult;
  try {
    aiResult = AI.process({ message, sessionId, userName, userTitle, memories, moodContext, serverData });
  } catch (err) {
    console.error("[AI] Error:", err);
    return res.json({ reply: `Something went sideways, ${T}. Give it another go.`, action: "ERROR" });
  }

  const { reply, action, meta, intent, topic, needsFetch, fetchType } = aiResult;

  if (action === "LOOKUP_PERSON" && needsFetch && meta?.personName) {
    try {
      const lookupData  = await Research.lookupPerson(meta.personName);
      const intelReport = Research.buildPersonIntelReport(lookupData, T);
      return res.json({ reply: intelReport, action: "LOOKUP_PERSON", intent: "lookup_person", meta: { personName: meta.personName, raw: lookupData } });
    } catch (e) {
      const fallback = `I ran ${meta.personName} through the public databases, ${T}, but hit an error mid-sweep. Try again in a moment.`;
      return res.json({ reply: fallback, action: "LOOKUP_PERSON", intent: "lookup_person" });
    }
  }

  if (needsFetch) {
    switch (fetchType) {
      case "weather": {
        try {
          const weatherData = await Weather.handleWeatherCommand(message);
          if (weatherData.error) return res.json({ reply: `Couldn't pull weather right now, ${T}. ${weatherData.error}`, action: "WEATHER", intent: "weather" });
          const { city, temp, feels_like, description, humidity, wind_speed, high, low } = weatherData;
          const tempDesc = temp > 30 ? "quite warm" : temp > 20 ? "pleasant" : temp > 10 ? "cool" : temp > 0 ? "cold" : "freezing";
          const weatherReply = `Current conditions in ${city}, ${T}: ${temp}°C — ${description}. Feels like ${feels_like}°C, which is ${tempDesc}. Humidity at ${humidity}%, wind ${wind_speed} m/s. Today's range: ${low}–${high}°C.`;
          return res.json({ reply: weatherReply, action: "WEATHER", intent: "weather", meta: { weatherData } });
        } catch (e) {
          return res.json({ reply: `Weather fetch failed, ${T}. Check your OpenWeatherMap API key in .env.`, action: "WEATHER", intent: "weather" });
        }
      }
      case "spotify": {
        if (!Spotify.isConfigured()) return res.json({ reply: `Spotify isn't configured yet, ${T}. Add your SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env, then visit /api/spotify/auth to connect.`, action: "SPOTIFY", intent: "spotify" });
        if (!Spotify.hasToken())      return res.json({ reply: `Spotify needs to be authorised first, ${T}. Visit http://localhost:3000/api/spotify/auth to connect your account.`, action: "SPOTIFY", intent: "spotify" });
        try {
          const spotifyData = await Spotify.handleSpotifyCommand(message);
          if (spotifyData.needsAuth) return res.json({ reply: `Spotify needs re-authorisation, ${T}. Visit http://localhost:3000/api/spotify/auth.`, action: "SPOTIFY", intent: "spotify" });
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
        if (!Google.isConfigured()) return res.json({ reply: `Gmail isn't configured, ${T}. Add your Google credentials to .env, then visit /api/google/auth.`, action: "GMAIL", intent: "gmail" });
        if (!Google.hasToken())     return res.json({ reply: `Gmail needs to be authorised first, ${T}. Visit http://localhost:3000/api/google/auth.`, action: "GMAIL", intent: "gmail" });
        try {
          const gmailData = await Google.handleGmailCommand(message);
          if (gmailData.needsAuth) return res.json({ reply: `Gmail needs re-authorisation, ${T}. Visit http://localhost:3000/api/google/auth.`, action: "GMAIL", intent: "gmail" });
          let gmailReply = gmailData.unread === 0 ? `Inbox clear, ${T}. No unread messages.` : gmailData.unread !== undefined ? `You have ${gmailData.unread} unread email${gmailData.unread > 1 ? "s" : ""}, ${T}.${gmailData.messages?.slice(0, 3).map(m => `"${m.subject}" from ${m.from}`).join("; ") ? ` Latest: ${gmailData.messages.slice(0,3).map(m=>`"${m.subject}" from ${m.from}`).join("; ")}.` : ""}` : `Gmail checked, ${T}.`;
          return res.json({ reply: gmailReply, action: "GMAIL", intent: "gmail", meta: { gmailData } });
        } catch (e) { return res.json({ reply: `Gmail fetch failed, ${T}. ${e.message}`, action: "GMAIL", intent: "gmail" }); }
      }
      case "diy": {
  try {
    const diyResult = await DIY.buildDIYProject(message, userTitle);
    return res.json({ reply: diyResult.reply, action: "DIY_PROJECT", intent: "diy_project", meta: { images: diyResult.images, links: diyResult.links, budget: diyResult.budget, project: diyResult.project } });
  } catch (e) {
    return res.json({ reply: `DIY lookup failed, ${T}. ${e.message}`, action: "DIY_PROJECT", intent: "diy_project" });
  }
}
      case "calendar": {
        if (!Google.isConfigured()) return res.json({ reply: `Google Calendar isn't configured, ${T}. Add your Google credentials to .env, then visit /api/google/auth.`, action: "CALENDAR", intent: "calendar" });
        if (!Google.hasToken())     return res.json({ reply: `Google Calendar needs to be authorised first, ${T}. Visit http://localhost:3000/api/google/auth.`, action: "CALENDAR", intent: "calendar" });
        try {
          const calData = await Google.handleCalendarCommand(message);
          if (calData.needsAuth) return res.json({ reply: `Calendar needs re-authorisation, ${T}. Visit http://localhost:3000/api/google/auth.`, action: "CALENDAR", intent: "calendar" });
          let calReply = !calData.events?.length ? `Nothing on the calendar ${calData.period || "today"}, ${T}. Schedule is clear.` : `${calData.events.length} event${calData.events.length > 1 ? "s" : ""} ${calData.period || "today"}, ${T}: ${calData.events.slice(0, 4).map(e => `${e.time ? e.time + " — " : ""}${e.title}`).join("; ")}.`;
          return res.json({ reply: calReply, action: "CALENDAR", intent: "calendar", meta: { calData } });
        } catch (e) { return res.json({ reply: `Calendar fetch failed, ${T}. ${e.message}`, action: "CALENDAR", intent: "calendar" }); }
      }
    }
  }

  if (action === "SHOW_HUD" || action === "HIDE_HUD") {
    return res.json({ reply, action, intent, meta: { query: message } });
  }

  const shouldTryResearch = (action === "FALLBACK" || (action === "KNOWLEDGE" && reply.length < 200) || Research.shouldResearch(message));
  if (shouldTryResearch) {
    try {
      const researched = await Research.research(message, userTitle);
      if (researched?.reply) {
        return res.json({ reply: researched.reply, action: action === "FALLBACK" ? "RESEARCH" : action, intent: "research", topic: researched.query, meta: { researched: true, sources: researched.sources } });
      }
    } catch {}
  }

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
    return res.json({ reply, action, intent, meta: { uptime, uptimeLabel: `${Math.floor(uptime/60)}m ${uptime%60}s`, heapUsed: (mem.heapUsed/1024/1024).toFixed(1), heapTotal: (mem.heapTotal/1024/1024).toFixed(1) } });
  }

  return res.json({ reply, action, intent, topic, meta });
});

// ── BOOT ──────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
bootstrapOwnerAccount();

httpServer.listen(PORT, () => {
  console.log(`J.A.R.V.I.S online → http://localhost:${PORT}`);
  console.log(`  Comms panel   → http://localhost:${PORT}/comms`);
  console.log(`  Spotify: ${Spotify.isConfigured() ? "configured" : "not configured (add SPOTIFY_CLIENT_ID to .env)"}`);
  console.log(`  Google:  ${Google.isConfigured()  ? "configured" : "not configured (add GOOGLE_CLIENT_ID to .env)"}`);
  console.log(`  Weather: ${process.env.OPENWEATHER_API_KEY ? "configured" : "not configured (add OPENWEATHER_API_KEY to .env)"}`);
});
