require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const AI       = require("./ai-engine");
const Spotify  = require("./integrations/spotify");
const Weather  = require("./integrations/weather");
const Google   = require("./integrations/google");

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
  const groups = Object.entries(LINKS).map(([name, urls]) => `${name} (${urls.length} link${urls.length>1?"s":""})`);
  const total  = Object.values(LINKS).reduce((s, arr) => s + arr.length, 0);
  return { groups, total, names: Object.keys(LINKS) };
}
function getAllLinksFormatted() {
  return Object.entries(LINKS).map(([name, urls]) => ({ name, count: urls.length, urls }));
}

// ── LINKS API ──
app.get("/api/links",         (_req, res) => res.json({ groups: Object.keys(LINKS), summary: getLinksSummary(), all: getAllLinksFormatted() }));
app.get("/api/links/summary", (_req, res) => res.json(getLinksSummary()));
app.get("/api/links/all",     (_req, res) => res.json({ links: getAllLinksFormatted() }));
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
function loadProfiles() { ensureDataDir(); try { return JSON.parse(fs.readFileSync(PROFILES_FILE,"utf8")); } catch { return {}; } }
function saveProfiles(p) { ensureDataDir(); fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2), "utf8"); }
function loadMemories() { ensureDataDir(); try { return JSON.parse(fs.readFileSync(MEMORIES_FILE,"utf8")); } catch { return {}; } }
function saveMemories(m) { ensureDataDir(); fs.writeFileSync(MEMORIES_FILE, JSON.stringify(m, null, 2), "utf8"); }

app.get("/favicon.ico", (_req, res) => res.status(204).end());

// ── PROFILE ROUTES ──
app.post("/api/register", (req, res) => {
  const { name, passwordHash, title, voiceAliases } = req.body;
  if (!name || !passwordHash) return res.status(400).json({ error: "Missing fields" });
  const profiles = loadProfiles();
  const key = name.toLowerCase().trim();
  profiles[key] = { name: name.trim(), passwordHash, title: title||"Sir", voiceAliases: voiceAliases||[], createdAt: profiles[key]?.createdAt||new Date().toISOString(), updatedAt: new Date().toISOString() };
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
  if (!stored) return res.json({ authorized: false, reason: "no_profile" });
  if (stored.passwordHash !== passwordHash) return res.json({ authorized: false, reason: "wrong_password" });
  const { passwordHash: _, ...safe } = stored;
  res.json({ authorized: true, profile: safe });
});
app.get("/api/profiles", (_req, res) => {
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

// ═══════════════════════════════════════════════════════════════
// ── INTEGRATION OAUTH ROUTES ─────────────────────────────────
// ═══════════════════════════════════════════════════════════════

// ── SPOTIFY AUTH ──
app.get("/api/spotify/auth", (_req, res) => {
  if (!Spotify.isConfigured()) return res.json({ error: "Spotify not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to .env" });
  res.redirect(Spotify.getAuthUrl());
});
app.get("/api/spotify/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("<h2>No code received</h2>");
  const result = await Spotify.exchangeCode(code);
  if (result.error) return res.send(`<h2>Spotify auth failed: ${result.error}</h2>`);
  res.send(`<h2>✓ Spotify connected!</h2><p>You can close this tab. J.A.R.V.I.S now has Spotify access.</p><script>setTimeout(()=>window.close(),2000)</script>`);
});
app.get("/api/spotify/status", (_req, res) => {
  res.json({ configured: Spotify.isConfigured(), connected: Spotify.hasToken() });
});

// ── GOOGLE AUTH ──
app.get("/api/google/auth", (_req, res) => {
  if (!Google.isConfigured()) return res.json({ error: "Google not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env" });
  res.redirect(Google.getAuthUrl());
});
app.get("/api/google/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send("<h2>No code received</h2>");
  const result = await Google.exchangeCode(code);
  if (result.error) return res.send(`<h2>Google auth failed: ${result.error}</h2>`);
  res.send(`<h2>✓ Google connected!</h2><p>Gmail and Calendar are now accessible. You can close this tab.</p><script>setTimeout(()=>window.close(),2000)</script>`);
});
app.get("/api/google/status", (_req, res) => {
  res.json({ configured: Google.isConfigured(), connected: Google.hasToken() });
});

// ── INTEGRATIONS STATUS ──
app.get("/api/integrations/status", (_req, res) => {
  res.json({
    spotify:  { configured: Spotify.isConfigured(), connected: Spotify.hasToken() },
    google:   { configured: Google.isConfigured(),  connected: Google.hasToken()  },
    weather:  { configured: !!(process.env.OPENWEATHER_API_KEY) },
  });
});

// ═══════════════════════════════════════════════════════════════
// ── CHAT ENDPOINT ────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  const T = userTitle || "Sir";

  // Build server data
  const linkSummary = getLinksSummary();
  const linkResult  = lookupLink(message);
  const serverData  = { ...linkSummary, allLinks: getAllLinksFormatted(), ...(linkResult.found ? linkResult : {}) };

  // ── First AI pass — detect if an integration is needed ──
  let aiResult;
  try {
    aiResult = AI.process({ message, sessionId, userName, userTitle, memories, moodContext, serverData });
  } catch (err) {
    console.error("[AI]", err);
    return res.json({ reply: `Something went sideways, ${T}. Give it another go.`, action: "ERROR" });
  }

  const { reply, action, meta, intent, topic, needsFetch, fetchType } = aiResult;

  // ── Integration fetch ──
  if (needsFetch || ["WEATHER","SPOTIFY","GMAIL","CALENDAR"].includes(action)) {
    const type = (fetchType || action).toLowerCase();
    let integrationData = null;
    let integrationError = null;

    try {
      if (type === "weather") {
        integrationData = await Weather.handleWeatherCommand(message);
      } else if (type === "spotify") {
        integrationData = await Spotify.handleSpotifyCommand(message);
      } else if (type === "gmail") {
        integrationData = await Google.handleGmailCommand(message);
      } else if (type === "calendar") {
        integrationData = await Google.handleCalendarCommand(message);
      }
    } catch (e) {
      integrationError = e.message;
      console.error(`[${type.toUpperCase()}]`, e);
    }

    // Re-process with integration data
    if (integrationData) {
      let finalResult;
      try {
        finalResult = AI.process({
          message, sessionId, userName, userTitle, memories, moodContext, serverData,
          integrationData: { type, data: integrationData },
        });
      } catch (e) {
        finalResult = { reply: `Got the data but hit a processing error, ${T}.`, action };
      }

      // Handle auth redirects
      if (integrationData.needsAuth) {
        return res.json({
          reply:  finalResult.reply,
          action: action,
          intent,
          meta: { needsAuth: true, authUrl: integrationData.authUrl, service: type },
        });
      }

      return res.json({
        reply:  finalResult.reply,
        action: action,
        intent,
        topic,
        meta:   { integrationData, type },
      });
    }

    // Error case
    const errReply = integrationError
      ? `I ran into a problem reaching ${type}, ${T}: ${integrationError}`
      : `Couldn't fetch ${type} data right now, ${T}. Check your credentials in .env.`;
    return res.json({ reply: errReply, action, intent });
  }

  // ── SHOW_LINKS ──
  if (action === "SHOW_LINKS") {
    return res.json({
      reply, action, intent,
      meta: { requestLinks: true, linkGroups: getAllLinksFormatted(), total: linkSummary.total },
    });
  }

  // ── OPEN_LINK ──
  if (action === "OPEN_LINK") {
    return res.json({ reply, action, intent, meta: { ...meta, ...linkResult } });
  }

  // ── MEMORY_SAVE ──
  if (action === "MEMORY_SAVE" && meta?.saveFact) {
    const mem = loadMemories();
    const key = (userName || "user").toLowerCase().trim();
    if (!mem[key]) mem[key] = [];
    mem[key].push({ fact: meta.saveFact, savedAt: new Date().toISOString() });
    if (mem[key].length > 50) mem[key] = mem[key].slice(-50);
    saveMemories(mem);
    return res.json({ reply, action, intent, meta: { saved: true, fact: meta.saveFact } });
  }

  // ── MEMORY_FORGET ──
  if (action === "MEMORY_FORGET" && meta?.forgetHint) {
    const mem = loadMemories();
    const key = (userName || "user").toLowerCase().trim();
    if (!mem[key]) return res.json({ reply: `Nothing on file matching that, ${T}.`, action, intent });
    const before = mem[key].length;
    mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(meta.forgetHint.toLowerCase()));
    saveMemories(mem);
    const removed = before - mem[key].length;
    const finalReply = removed > 0 ? `Done, ${T}. ${removed} memory entr${removed>1?"ies":"y"} removed.` : `Nothing matching that on file, ${T}.`;
    return res.json({ reply: finalReply, action, intent });
  }

  // ── SYSTEM_STATUS ──
  if (action === "SYSTEM_STATUS") {
    const uptime = Math.floor(process.uptime());
    const mem    = process.memoryUsage();
    const mins   = Math.floor(uptime / 60), secs = uptime % 60;
    return res.json({
      reply, action, intent,
      meta: { uptime, uptimeLabel: `${mins}m ${secs}s`, heapUsed: (mem.heapUsed/1024/1024).toFixed(1), heapTotal: (mem.heapTotal/1024/1024).toFixed(1) },
    });
  }

  return res.json({ reply, action, intent, topic, meta });
});

// ── SCREEN ANALYSIS ──
app.post("/api/screen", (req, res) => {
  const { ocrText, question, userName, userTitle, memories } = req.body;
  const T = userTitle || "Sir";
  if (!ocrText || ocrText.trim().length < 5) {
    return res.json({ reply: `I received the screen frame but couldn't extract readable text, ${T}. Make sure the content is visible.` });
  }
  const screenContext = `The user's screen contains: "${ocrText.trim().slice(0, 800)}". The user asked: "${question || "What is on my screen?"}"`;
  try {
    const result = AI.process({ message: screenContext, sessionId: `screen_${userName||"user"}`, userName, userTitle, memories, serverData: getLinksSummary() });
    const replyText = result.reply.length > 20
      ? `I can see your screen, ${T}. ${result.reply}`
      : `Your screen shows: ${ocrText.trim().slice(0, 200)}`;
    return res.json({ reply: replyText });
  } catch {
    const lines = ocrText.trim().split("\n").filter(l => l.trim().length > 2).slice(0, 5);
    return res.json({ reply: `On your screen, ${T}: ${lines.join(". ")}` });
  }
});

// ── INTEGRATION STATUS PAGE ──
app.get("/api/setup", (_req, res) => {
  const status = {
    spotify: { configured: Spotify.isConfigured(), connected: Spotify.hasToken(), authUrl: "/api/spotify/auth" },
    google:  { configured: Google.isConfigured(),  connected: Google.hasToken(),  authUrl: "/api/google/auth"  },
    weather: { configured: !!(process.env.OPENWEATHER_API_KEY), envKey: "OPENWEATHER_API_KEY" },
  };
  res.json(status);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  J.A.R.V.I.S  →  http://localhost:${PORT}  ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log(`Integrations:`);
  console.log(`  Weather:  ${process.env.OPENWEATHER_API_KEY ? "✓ configured" : "✗ add OPENWEATHER_API_KEY to .env"}`);
  console.log(`  Spotify:  ${process.env.SPOTIFY_CLIENT_ID ? "✓ configured — visit /api/spotify/auth to connect" : "✗ add SPOTIFY_CLIENT_ID + SPOTIFY_CLIENT_SECRET"}`);
  console.log(`  Google:   ${process.env.GOOGLE_CLIENT_ID ? "✓ configured — visit /api/google/auth to connect" : "✗ add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET"}`);
  console.log(``);
});
