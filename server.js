require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const AI       = require("./ai-engine");   // ← Our custom AI

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

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

app.get("/api/links",    (req, res) => res.json({ groups: Object.keys(LINKS) }));
app.post("/api/link",    (req, res) => {
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
  if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, JSON.stringify({}),  "utf8");
  if (!fs.existsSync(MEMORIES_FILE)) fs.writeFileSync(MEMORIES_FILE, JSON.stringify({}),  "utf8");
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
// ── CHAT — Custom AI Engine (no external API) ──
// ══════════════════════════════════════════════════════════════
app.post("/api/chat", (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  try {
    const result = AI.process({ message, sessionId, userName, userTitle, memories, moodContext });
    res.json({ reply: result.reply, intent: result.intent });
  } catch (err) {
    console.error("[AI] Error:", err);
    const T = userTitle || "Sir";
    res.json({ reply: `Something went sideways, ${T}. Give it another go.` });
  }
});

// ── SCREEN VISION (frame analysis without external API) ──
// We describe the screen via metadata the client sends; for deeper
// vision analysis users can optionally plug in an API key later.
app.post("/api/screen", (req, res) => {
  const { question, userName, userTitle } = req.body;
  const T = userTitle || "Sir";
  // Without a vision model we give an honest reply
  const reply = `Screen vision requires a vision model, ${T}. I can see your camera and hear your voice, but pixel-level screen analysis is outside my built-in capability. Use the "read screen" command after enabling screen sharing — and consider plugging in a vision API for full analysis.`;
  res.json({ reply });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`J.A.R.V.I.S online → http://localhost:${PORT}`));
