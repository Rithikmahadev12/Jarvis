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
const News        = require("./news");
const Spotify     = require("./spotify");
const Google      = require("./google");
const DIY         = require("./diy-builder");
const Build       = require("./build-engine");
const Home        = require("./home");
const Groq        = require("./hermes-engine");
const Improve     = require("./self-improve");
const Trainer     = require("./trainer");
const Brain       = require("./brain");
const Reminders   = require("./reminders");
const Briefing    = require("./briefing");
const TTS = require("./tts");
const Persistence = require("./persistence");

const app        = express();

// ── VOICE MISHEARING CORRECTION ─────────────────────────────────────────────
// Speech-to-text sometimes hears a close-but-wrong word for the handful of
// words that actually trigger something (e.g. "tired" -> "tarot"/"tyred").
// Regex/keyword routing further down needs the *exact* word, so before any
// routing happens we nudge near-miss words back to the closest known trigger
// word using Levenshtein distance. This never touches words that are already
// a clean match, and only fires when a word is close enough (short edit
// distance relative to its length) to be a plausible mishearing rather than
// an unrelated word -- so it won't rewrite the rest of the sentence.
const VOICE_TRIGGER_VOCAB = [
  "tired", "exhausted", "sleepy", "drained", "worn",
  "bored", "boring",
  "stressed", "overwhelmed",
  "break", "relax", "unwind",
  "instagram", "insta", "youtube",
  "reminder", "reminders", "timer", "timers",
  "weather", "music", "spotify",
  "lights", "thermostat",
  "calendar", "schedule", "agenda",
  "research",
];

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function correctMishearings(message) {
  if (!message || typeof message !== "string") return message;
  return message.replace(/[A-Za-z']+/g, (word) => {
    const lower = word.toLowerCase();
    if (word.length < 4 || VOICE_TRIGGER_VOCAB.includes(lower)) return word;

    let best = null, bestDist = Infinity;
    for (const cand of VOICE_TRIGGER_VOCAB) {
      if (Math.abs(cand.length - lower.length) > 2) continue;
      const d = levenshtein(lower, cand);
      if (d < bestDist) { bestDist = d; best = cand; }
    }
    const threshold = lower.length <= 5 ? 1 : 2; // stricter for short words
    if (!best || bestDist > threshold) return word;

    // preserve original capitalisation style
    return word[0] === word[0].toUpperCase() ? best[0].toUpperCase() + best.slice(1) : best;
  });
}

// ── CONVERSATION HISTORY STORE ──────────────────────────────────────────────
// Keeps last N exchanges per sessionId so JARVIS remembers what it asked you.
// Entries are { role: "user"|"assistant", content: string }
const SESSION_HISTORY = new Map();
const SESSION_MAX_TURNS = 12; // last 6 exchanges (user + assistant each)
const SESSION_TTL_MS    = 60 * 60 * 1000; // 1 hour of inactivity → forget
const sessionTimers     = new Map();

function getSessionHistory(sessionId) {
  return SESSION_HISTORY.get(sessionId) || [];
}

function appendToSession(sessionId, role, content) {
  if (!SESSION_HISTORY.has(sessionId)) SESSION_HISTORY.set(sessionId, []);
  const hist = SESSION_HISTORY.get(sessionId);
  hist.push({ role, content });
  // Keep only the last N turns
  while (hist.length > SESSION_MAX_TURNS) hist.shift();
  // Reset TTL
  if (sessionTimers.has(sessionId)) clearTimeout(sessionTimers.get(sessionId));
  sessionTimers.set(sessionId, setTimeout(() => {
    SESSION_HISTORY.delete(sessionId);
    sessionTimers.delete(sessionId);
  }, SESSION_TTL_MS));
}
// ────────────────────────────────────────────────────────────────────────────
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

// Serve /soundeffects/* (e.g. the mode-picker's hand-hover UI sound) from
// the top-level soundeffects/ folder, so files dropped there are reachable
// at the exact path referenced in the front-end: /soundeffects/<file>.
app.use("/soundeffects", express.static(path.join(__dirname, "soundeffects")));

// ═══════════════════════════════════════════════════════════════
// ── COMMS
// ═══════════════════════════════════════════════════════════════
const attachComms = require("./comms-server");
const io          = attachComms(httpServer);

app.get("/comms", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "comms.html"));
});

// ═══════════════════════════════════════════════════════════════
// ── BUILD MODE — hand-tracked CAD engine
// Pull real 3D models from Sketchfab, drag/spin them into place with
// your hands (or a mouse), and let Jarvis screw parts together once
// it notices two pieces are touching but not yet connected.
// ═══════════════════════════════════════════════════════════════
app.get("/build", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "build-mode.html"));
});

// ── Holographic Workspace — AI-powered multi-object scene builder ──
app.get("/workspace", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "hologram-workspace.html"));
});

// ── News Widget — standalone broadcast-style news dashboard.
// Also embedded as a panel inside the main HUD ("jarvis, news widget"),
// but reachable directly at /news (own tab, bookmark, TV cast, etc).
app.get("/news", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "news-widget.html"));
});

app.get("/api/build/search", async (req, res) => {
  const q = (req.query.q || "").trim();
  try {
    const data = await Build.searchModels(q, 12);
    res.json(data);
  } catch (e) {
    res.status(500).json({ results: [], error: e.message });
  }
});

app.get("/api/build/model/:uid", async (req, res) => {
  try {
    const data = await Build.getLoadableModel(req.params.uid);
    res.json(data);
  } catch (e) {
    res.status(500).json({ kind: "error", error: e.message });
  }
});

// Static cache of unpacked glTF models pulled from Sketchfab
app.use("/build-cache", express.static(Build.CACHE_DIR));

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

// ── NEWS — used by the Monitor screen and by "jarvis show me the news" ──
// ?category=technology|business|entertainment|general|health|science|sports
// ?q=some+search+term   (overrides category, searches everything instead)
app.get("/api/news", async (req, res) => {
  try {
    const { q, category, country } = req.query;
    const result = q
      ? await News.searchNews(q)
      : await News.fetchTopHeadlines({ category: category || "general", country: country || "us" });
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
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

// ── MUSIC LIBRARY ────────────────────────────────────────────
// No YouTube API key needed. Each entry is a real youtube.com/watch
// URL — grab one straight from your browser. Tacking on
// "&list=RDxxxxxxxx&start_radio=1" (copy the ID from the "Mix"/Radio
// link YouTube generates under any video) makes it auto-continue into
// similar songs once the first one ends, so Jarvis never just stops.
// Add more songs by editing data/music-library.json directly — no
// code changes or restart needed, it's read fresh on every request.
// Optional "artist" and "album" fields are shown on the now-playing
// widget in the UI — purely cosmetic, safe to omit.
const MUSIC_FILE = path.join(DATA_DIR, "music-library.json");
function ensureMusicFile() {
  if (!fs.existsSync(MUSIC_FILE)) {
    fs.writeFileSync(MUSIC_FILE, JSON.stringify({
      "self aware": {
        title: "Self Aware",
        artist: "",
        album: "",
        url: "https://www.youtube.com/watch?v=pGsgAOmkS40&list=RDpGsgAOmkS40&start_radio=1",
        mood: "chill, introspective, late-night",
      },
    }, null, 2), "utf8");
  }
}
function loadMusicLibrary() {
  ensureDataDir(); ensureMusicFile();
  try { return JSON.parse(fs.readFileSync(MUSIC_FILE, "utf8")); } catch { return {}; }
}
function lookupMusicByKeyword(text) {
  const lib = loadMusicLibrary();
  const lower = (text || "").toLowerCase();
  for (const [key, song] of Object.entries(lib)) {
    if (lower.includes(key.toLowerCase())) return { found: true, key, ...song };
  }
  return { found: false };
}
function youtubeSearchUrl(query) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}
// For songs that aren't in the library, we still want the widget to play
// something specific rather than dumping a search-results page — so we
// pull the top result's video ID straight off YouTube's search page (no
// API key needed) and hand back a normal watch URL for that video.
async function findYoutubeVideoId(query) {
  try {
    const res = await fetch(youtubeSearchUrl(query), {
      signal: AbortSignal.timeout(6000),
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36" },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const match = html.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
    return match ? match[1] : null;
  } catch { return null; }
}
// Pulls real title/channel info for a video via YouTube's public oEmbed
// endpoint (no API key needed) so the widget can show an actual artist
// instead of just falling back to "YouTube". Many music uploads use an
// auto-generated "<Artist> - Topic" channel, so we strip that suffix to
// get a clean artist name. If the video title itself looks like
// "Artist - Song", we prefer that as the more reliable source and use
// it to fill in the artist too when the channel name isn't usable.
async function getYoutubeVideoMeta(videoId) {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    let title = (data.title || "").trim();
    let author = (data.author_name || "").trim();
    let artist = author.replace(/\s*-\s*Topic$/i, "").trim();

    // "Artist - Song Title" is the most common convention for music
    // uploads — prefer splitting the video title when it matches, since
    // it's usually more accurate than the channel name.
    const dashSplit = title.match(/^(.{1,60}?)\s+-\s+(.{1,80})$/);
    if (dashSplit) {
      const [, left, right] = dashSplit;
      artist = left.trim();
      title = right.trim();
    }

    return { title: title || null, artist: artist || null };
  } catch { return null; }
}
// YouTube has no reliable album metadata, so for that we go to a
// different source entirely: Apple's public iTunes Search API (no key
// needed), searching by song name (+ artist if we have one). Used to
// backfill album (and can correct/confirm artist) for any track missing it.
async function lookupAlbumMetadata(title, artist) {
  const term = [artist, title].filter(Boolean).join(" ").trim();
  if (!term) return null;
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=1`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const hit = data?.results?.[0];
    if (!hit) return null;
    return {
      album: hit.collectionName || null,
      artist: hit.artistName || null,
      artwork: hit.artworkUrl100 ? hit.artworkUrl100.replace("100x100", "600x600") : null,
    };
  } catch { return null; }
}
// Asks Groq to pick the best-fitting song from the library given the
// current mood/context. Falls back to a random pick if Groq is
// unavailable or doesn't clearly match anything in the list.
async function pickSongForMood(contextText) {
  const lib = loadMusicLibrary();
  const entries = Object.entries(lib);
  if (!entries.length) return null;
  if (entries.length === 1 || !Groq.isConfigured()) {
    const [key, song] = entries[Math.floor(Math.random() * entries.length)];
    return { key, ...song };
  }
  const menu = entries.map(([key, s]) => `- "${key}" (mood: ${s.mood || "n/a"})`).join("\n");
  try {
    const raw = await Groq.groqFetch([
      { role: "system", content: `Pick exactly one song from this library based on the conversation's mood. Reply with ONLY the song's key, in quotes, nothing else:\n${menu}` },
      { role: "user", content: contextText || "Pick something good." },
    ], undefined, 0.6, 30);
    const match = entries.find(([key]) => raw.toLowerCase().includes(key.toLowerCase()));
    if (match) return { key: match[0], ...match[1] };
  } catch (e) { /* fall through to random */ }
  const [key, song] = entries[Math.floor(Math.random() * entries.length)];
  return { key, ...song };
}

// ── BOOTSTRAP OWNER ───────────────────────────────────────────
// Face-ID only: an owner account is only auto-created if config.json
// already has a captured faceDescriptor for them. Plain password-based
// bootstrap has been removed — new accounts are created through the
// "CREATE ACCOUNT" screen, which now enrolls a face instead of a password.
function bootstrapOwnerAccount() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) return;
  let config;
  try { config = JSON.parse(fs.readFileSync(configPath, "utf8")); }
  catch (e) { console.warn("[BOOT] Could not read config.json:", e.message); return; }
  const owner = config.owner;
  if (!owner || !owner.username || !Array.isArray(owner.faceDescriptor) || owner.faceDescriptor.length !== 128) return;
  const profiles = loadProfiles();
  const key      = owner.username.toLowerCase().trim();
  if (profiles[key]) return;
  profiles[key] = {
    name:           owner.username,
    faceDescriptor: owner.faceDescriptor,
    title:          owner.title || "Sir",
    voiceAliases:   owner.voiceAliases || [],
    role:           "owner",
    createdAt:      new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
  };
  saveProfiles(profiles);
  console.log(`[BOOT] Owner account "${owner.username}" bootstrapped from config`);
}

// ── FACE DESCRIPTOR MATCHING ───────────────────────────────────
// face-api.js descriptors are 128-length float arrays. Euclidean distance
// below ~0.5-0.6 is considered the same person (0.6 is face-api's own default).
const FACE_MATCH_THRESHOLD = 0.55;
function euclideanDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return Infinity;
  let sum = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
  return Math.sqrt(sum);
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
  const { name, faceDescriptor, title, voiceAliases } = req.body;
  if (!name || !Array.isArray(faceDescriptor) || faceDescriptor.length !== 128) {
    return res.status(400).json({ error: "Missing name or valid face descriptor" });
  }
  const profiles = loadProfiles();
  const key = name.toLowerCase().trim();
  profiles[key] = {
    name:           name.trim(),
    faceDescriptor,
    title:          title || "Sir",
    voiceAliases:   voiceAliases || [],
    createdAt:      profiles[key]?.createdAt || new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
  };
  saveProfiles(profiles);
  res.json({ success: true });
});
app.get("/api/profile/:name", (req, res) => {
  const profiles = loadProfiles();
  const profile  = profiles[req.params.name.toLowerCase().trim()];
  if (!profile) return res.json({ found: false });
  // Never expose faceDescriptor or raw tokens; expose a simple connected flag instead
  const { faceDescriptor, googleTokens, ...safe } = profile;
  safe.googleConnected = !!googleTokens?.access;
  res.json({ found: true, profile: safe });
});
// Face sign-in: client captures a descriptor from the camera and posts it
// here. We compare it against every enrolled profile's stored descriptor
// and sign the person in automatically if there's a close-enough match —
// no password, no typing.
app.post("/api/verify-face", (req, res) => {
  const { descriptor } = req.body;
  if (!Array.isArray(descriptor) || descriptor.length !== 128) {
    return res.status(400).json({ authorized: false, reason: "invalid_descriptor" });
  }
  const profiles = loadProfiles();
  let best = null, bestDist = Infinity;
  for (const profile of Object.values(profiles)) {
    if (!Array.isArray(profile.faceDescriptor)) continue;
    const dist = euclideanDistance(profile.faceDescriptor, descriptor);
    if (dist < bestDist) { bestDist = dist; best = profile; }
  }
  if (best && bestDist < FACE_MATCH_THRESHOLD) {
    const { faceDescriptor, ...safe } = best;
    return res.json({ authorized: true, profile: safe, distance: bestDist });
  }
  res.json({ authorized: false, reason: "no_match" });
});
// One-time wipe: clears every stored account so the app starts fresh
// with the new Face-ID-only sign in. Call once, e.g.:
//   curl -X POST http://localhost:3000/api/accounts/reset-all
app.post("/api/accounts/reset-all", (req, res) => {
  saveProfiles({});
  res.json({ success: true, message: "All accounts cleared. Create a new one to set up Face ID." });
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
// ── DAILY BRIEFING
// ═══════════════════════════════════════════════════════════════
// GET  /api/briefing/:user            → today's stored briefing, or { briefing: null }
// POST /api/briefing  { user, userTitle, task } → generates + stores today's briefing
// POST /api/briefing/reset  { user }  → clears today's entry so the user is asked again
app.get("/api/briefing/:user", (req, res) => {
  try {
    const entry = Briefing.getToday(req.params.user);
    res.json({ briefing: entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/briefing", async (req, res) => {
  const { user, userTitle, task } = req.body || {};
  if (!user || !task || !String(task).trim()) {
    return res.status(400).json({ error: "Missing fields: user and task are required" });
  }
  try {
    const entry = await Briefing.setToday(user, task, userTitle || "Sir");
    res.json({ briefing: entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/briefing/reset", (req, res) => {
  const { user } = req.body || {};
  if (!user) return res.status(400).json({ error: "Missing field: user" });
  Briefing.clearToday(user);
  res.json({ success: true });
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
// ── GOOGLE (single "Sign in with Google" — one app-wide OAuth app)
// ═══════════════════════════════════════════════════════════════
// The deployer sets GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET once in .env
// (one Google Cloud OAuth app for the whole deployment). Every user just
// clicks "Sign in with Google" and grants access — no console.cloud.google.com,
// no pasting in a client ID/secret.

// Start OAuth flow for a specific (already logged-in) Jarvis user
app.get("/api/google/auth", (req, res) => {
  if (!Google.isConfigured())
    return res.status(400).send("<h2>Google sign-in isn't configured yet. The app owner needs to add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.</h2>");
  const userKey = (req.query.user || "").toLowerCase().trim();
  if (!userKey) return res.status(400).send("<h2>Missing ?user= parameter</h2>");
  const reqHost = req.headers.host;
  const url = Google.getAuthUrl(userKey, reqHost);
  if (!url) return res.status(400).send("<h2>Could not build auth URL</h2>");
  res.redirect(url);
});

// OAuth callback — state param tells us which Jarvis user to attach tokens to
app.get("/api/google/callback", async (req, res) => {
  const { code, error, state: userKey } = req.query;
  if (error)    return res.send(`<h2>Google auth failed: ${error}</h2>`);
  if (!code)    return res.send("<h2>No code returned.</h2>");
  if (!userKey) return res.send("<h2>Missing state (user key). Try connecting again.</h2>");

  const profiles = loadProfiles();
  const profile  = profiles[userKey];
  if (!profile) return res.send("<h2>Unknown user. Try connecting again.</h2>");

  const reqHost = req.headers.host;
  const result = await Google.exchangeCode(code, userKey, reqHost);
  if (result.error) return res.send(`<h2>Token exchange failed: ${result.error}</h2>`);

  // Persist tokens in the user's profile
  profiles[userKey].googleTokens = result.tokens;
  saveProfiles(profiles);

  res.send(`<html><body style="background:#010c14;color:#00c8ff;font-family:monospace;text-align:center;padding:60px">
    <h2>✓ Google connected for ${profile.name}</h2>
    <p>Gmail and Calendar are now active for this account. Close this tab.</p>
  </body></html>`);
});

// Disconnect Google for a user — just wipes their stored tokens
app.post("/api/google/disconnect", (req, res) => {
  const userKey = (req.body.userName || "").toLowerCase().trim();
  const profiles = loadProfiles();
  if (!profiles[userKey]) return res.status(404).json({ error: "User not found" });
  delete profiles[userKey].googleTokens;
  saveProfiles(profiles);
  res.json({ success: true });
});

// Gmail — requires userName in body
app.post("/api/gmail", async (req, res) => {
  const userKey = (req.body.userName || "").toLowerCase().trim();
  const profiles = loadProfiles();
  const profile  = profiles[userKey];
  if (!Google.isConfigured())
    return res.json({ error: "Not configured", needsAuth: false });
  // Warm the token cache from saved profile tokens if needed
  if (profile?.googleTokens && !Google.hasTokenForUser(userKey))
    Google.hydrateTokens(userKey, profile.googleTokens);
  if (!Google.hasTokenForUser(userKey))
    return res.json({ needsAuth: true, authUrl: `/api/google/auth?user=${userKey}` });
  try { res.json(await Google.handleGmailCommand(req.body.message || "check inbox", userKey)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Calendar — requires userName in body
app.post("/api/calendar", async (req, res) => {
  const userKey = (req.body.userName || "").toLowerCase().trim();
  const profiles = loadProfiles();
  const profile  = profiles[userKey];
  if (!Google.isConfigured())
    return res.json({ error: "Not configured", needsAuth: false });
  if (profile?.googleTokens && !Google.hasTokenForUser(userKey))
    Google.hydrateTokens(userKey, profile.googleTokens);
  if (!Google.hasTokenForUser(userKey))
    return res.json({ needsAuth: true, authUrl: `/api/google/auth?user=${userKey}` });
  try { res.json(await Google.handleCalendarCommand(req.body.message || "today", userKey)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════════════════════════════════════════════════
// ── NATIVE REMINDERS / TIMERS / CALENDAR
// ═══════════════════════════════════════════════════════════════
// Client polls this every few seconds; anything due gets spoken once.
app.get("/api/reminders/due", (req, res) => {
  res.json({ due: Reminders.getDue() });
});
app.get("/api/reminders", (req, res) => {
  res.json({ items: Reminders.listUpcoming(20) });
});

// ═══════════════════════════════════════════════════════════════
// ── PERSONALITY
// ═══════════════════════════════════════════════════════════════
app.post("/api/personality/comment", (req, res) => {
  const { scene, userTitle, sessionMinutes, previousScene, userTimezone } = req.body;
  const T = userTitle || "Sir";
  if (scene === previousScene && scene === "idle") return res.json({ reply: null });
  res.json({ reply: Personality.getCameraComment(scene, T, sessionMinutes, userTimezone) || null });
});
app.post("/api/personality/smalltalk", (req, res) => {
  const { message, userTitle, userTimezone } = req.body;
  const T = userTitle || "Sir";
  if (!message) return res.status(400).json({ reply: null });
  const news = Personality.routePersonalNews(message, T);
  if (news) return res.json({ reply: news });
  res.json({ reply: Personality.routeSmallTalk(message, T, userTimezone) || null });
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
    return res.json({ reply: `Groq isn't configured, ${T}. Add GROQ_API_KEY to your .env.` });
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
  gmail:        /\b(email|emails|e-mail|gmail|inbox|unread|messages?)\b/i,
  calendar:     /\b(calendar|schedule|events?|agenda|meetings?|appointments?|what('s| is) (on|planned)|my day|today'?s? (plan|event|meeting|schedule))\b/i,
  links:        /\b(show (my |all )?links|open links|link bank|all my links)\b/i,
  openLink:     /\b(open|launch|pull up|go to)\b.{1,40}\b(infamous|petzah|fern|vapor)\b/i,
  hologram:     /\b(show me a (3d|hologram)|holographic|3d model|3d scan|build mode)\b/i,
  workspace:    /\b(hologram(ic)? workspace|holo workspace|open workspace|scene builder|build a scene|3d workspace)\b/i,
  newsWidget:   /\bnews widget\b/i,
  newsPage:     /\b(world news|news dashboard|news wall|open (the )?news|pull up (the )?news|show (me )?(the )?news|what'?s happening in the world|what'?s going on in the world|catch me up on the news|latest headlines|top headlines)\b/i,
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

async function handleGmailFetch(message, T, userName) {
  const userKey = (userName || "").toLowerCase().trim();
  const profiles = loadProfiles();
  const profile  = profiles[userKey];
  if (!Google.isConfigured())
    return { reply: `Gmail sign-in isn't set up yet, ${T}. The app owner needs to add Google credentials to the server.`, action: "GMAIL", intent: "gmail" };
  if (profile?.googleTokens && !Google.hasTokenForUser(userKey))
    Google.hydrateTokens(userKey, profile.googleTokens);
  if (!Google.hasTokenForUser(userKey))
    return { reply: `Gmail needs authorisation, ${T}. Visit /api/google/auth?user=${userKey} to sign in with Google.`, action: "GMAIL", intent: "gmail" };
  try {
    const gd = await Google.handleGmailCommand(message, userKey);
    if (gd.needsAuth) return { reply: `Gmail needs re-authorisation, ${T}. Visit /api/google/auth?user=${userKey}.`, action: "GMAIL", intent: "gmail" };
    const gr = gd.unread === 0 ? `Inbox clear, ${T}. No unread messages.` : `You have ${gd.unread} unread email${gd.unread > 1 ? "s" : ""}, ${T}.`;
    return { reply: gr, action: "GMAIL", intent: "gmail", meta: { gmailData: gd } };
  } catch (e) {
    return { reply: `Gmail fetch failed, ${T}.`, action: "GMAIL", intent: "gmail" };
  }
}

async function handleCalendarFetch(message, T, userName) {
  const userKey = (userName || "").toLowerCase().trim();
  const profiles = loadProfiles();
  const profile  = profiles[userKey];
  if (!Google.isConfigured())
    return { reply: `Google Calendar sign-in isn't set up yet, ${T}. The app owner needs to add Google credentials to the server.`, action: "CALENDAR", intent: "calendar" };
  if (profile?.googleTokens && !Google.hasTokenForUser(userKey))
    Google.hydrateTokens(userKey, profile.googleTokens);
  if (!Google.hasTokenForUser(userKey))
    return { reply: `Calendar needs authorisation, ${T}. Visit /api/google/auth?user=${userKey} to sign in with Google.`, action: "CALENDAR", intent: "calendar" };
  try {
    const cd = await Google.handleCalendarCommand(message, userKey);
    if (cd.needsAuth) return { reply: `Calendar needs re-authorisation, ${T}. Visit /api/google/auth?user=${userKey}.`, action: "CALENDAR", intent: "calendar" };
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

// ── NEWS WIDGET — real headlines + a sarcastic spoken briefing ──
// Canned sarcastic openers, used only when Groq isn't configured
// (or the call fails) so the briefing never falls flat-silent.
const NEWS_SARCASM_OPENERS = [
  `Here's the world, ${"%T%"}, in all its chaotic glory.`,
  `Brace yourself, ${"%T%"} — humanity's been busy again.`,
  `Right then, ${"%T%"}. Let's see what's on fire today.`,
  `Today's headlines, ${"%T%"}. Try to contain your excitement.`,
];
function buildCannedNewsBriefing(articles, T) {
  const opener = pickRandom(NEWS_SARCASM_OPENERS).replace(/%T%/g, T);
  if (!articles || !articles.length) {
    return `${opener} Unfortunately the wire's gone quiet — nothing came through. Riveting.`;
  }
  const top = articles.slice(0, 4).map(a => a.title).filter(Boolean);
  const lines = top.map((t, i) => `${i === 0 ? "" : i === top.length - 1 ? "And finally, " : "Meanwhile, "}${t}.`);
  return `${opener} ${lines.join(" ")} Riveting stuff, as always.`;
}
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function handleNewsFetch(message, T, mode) {
  const action = mode === "widget" ? "SHOW_NEWS_WIDGET" : "SHOW_NEWS_PAGE";
  try {
    const nd = await News.handleNewsCommand(message || "news");
    if (nd.error) {
      return { reply: `Couldn't reach the news wire, ${T}. ${nd.error}`, action, intent: "news" };
    }
    const label = nd.type === "search" ? nd.query : nd.category;
    let briefing = null;
    if (Groq.isConfigured()) {
      try { briefing = await Groq.summarizeNewsSarcastically(nd.articles, T, label); } catch {}
    }
    if (!briefing) briefing = buildCannedNewsBriefing(nd.articles, T);
    return {
      reply: briefing,
      action,
      intent: "news",
      meta: { newsData: nd, briefing, label },
    };
  } catch (e) {
    return { reply: `News fetch failed, ${T}.`, action, intent: "news" };
  }
}

// ── BUILD MODE — open the 3D hologram/CAD workspace ─────────────
function handleHologramOpen(message, T) {
  const q = (message || "")
    .replace(/\b(jarvis|hey|show me a|3d model of|3d scan of|holographic view of|build mode|hologram|holographic|3d model|3d scan)\b/gi, "")
    .trim();
  const reply = q
    ? `Pulling up build mode for "${q}", ${T}.`
    : `Build mode, ${T}. Try not to break anything.`;
  return { reply, action: "SHOW_HOLOGRAM", intent: "hologram", meta: { query: q } };
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
      reply:  `Groq isn't configured, ${T}. Add GROQ_API_KEY to your .env — it's needed to generate the code.`,
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
    groq:        "hermes-engine.js",
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
// ═══════════════════════════════════════════════════════════════
// ── TOOL EXECUTOR — real actions Groq can call directly ─────────
// This is what replaces regex command-matching: Groq decides which
// of these to call and with what arguments, straight from natural
// language. Add a case here + a definition in hermes-engine.js's
// TOOLS array to give Jarvis a new capability with no keyword list
// to maintain.
// ═══════════════════════════════════════════════════════════════
async function executeAssistantTool(name, args, ctx) {
  const { T, userTimezone, userName } = ctx;

  switch (name) {
    case "set_timer": {
      const secs = Number(args.duration_seconds) || 0;
      if (secs <= 0) return { reply: `How long should the timer be, ${T}?` };
      return Reminders.createTimer(Date.now() + secs * 1000, args.label, T);
    }

    case "set_reminder": {
      let dueAt = null;
      if (args.datetime_iso) {
        const parsed = Date.parse(args.datetime_iso);
        if (!Number.isNaN(parsed)) dueAt = parsed;
      }
      if (dueAt == null && args.duration_seconds) dueAt = Date.now() + Number(args.duration_seconds) * 1000;
      if (dueAt == null) return { reply: `When should I remind you, ${T}?` };
      return Reminders.createReminder(dueAt, args.label, T);
    }

    case "set_conditional_reminder": {
      Reminders.addConditional(args.label, args.trigger || "next_agenda_check");
      return {
        reply: `Got it, ${T}. I'll bring up "${args.label}" the next time you check your agenda.`,
        action: "REMINDER_SET",
        intent: "reminder",
      };
    }

    case "cancel_reminder": {
      const cancelled = Reminders.cancelMostRecent(args.type);
      return cancelled
        ? { reply: `Cancelled — "${cancelled.label}", ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" }
        : { reply: `Nothing active to cancel, ${T}.`, action: "REMINDER_CANCEL", intent: "reminder" };
    }

    case "get_agenda":
      return Reminders.buildAgendaReply(T, userTimezone, args.scope === "today" ? "today" : "");

    case "get_weather":
      return await handleWeatherFetch(args.location ? `weather in ${args.location}` : "weather", T);

    case "open_build_mode":
      return handleHologramOpen(args.query ? `build mode ${args.query}` : "build mode", T);

    case "get_news": {
      const msg = args.topic ? `news about ${args.topic}` : (args.category ? `${args.category} news` : "news");
      return await handleNewsFetch(msg, T, args.display === "widget" ? "widget" : "page");
    }

    case "play_music": {
      const query = (args.query || "").trim();
      const pickForMe = !!args.pick_for_me;

      if (!query && !pickForMe) {
        return { reply: `What do you want to hear, ${T}?`, action: "ASK_MUSIC", intent: "music" };
      }

      if (pickForMe) {
        const song = await pickSongForMood(ctx.moodContext || query);
        if (!song) {
          return { reply: `My music library's empty, ${T} — add a song or two to data/music-library.json and I'll start picking for you.`, action: "ASK_MUSIC", intent: "music" };
        }
        let album = song.album || "";
        let artist = song.artist || "";
        let artwork = song.artwork || "";
        if (!album || !artwork) {
          const found = await lookupAlbumMetadata(song.title, artist);
          if (found) { album = found.album || album; artwork = artwork || found.artwork || ""; if (!artist) artist = found.artist || artist; }
        }
        return { reply: `Playing "${song.title}", ${T}.`, action: "PLAY_MUSIC", intent: "music", meta: { playUrl: song.url, title: song.title, artist, album, artwork } };
      }

      const hit = lookupMusicByKeyword(query);
      if (hit.found) {
        let album = hit.album || "";
        let artist = hit.artist || "";
        let artwork = hit.artwork || "";
        if (!album || !artwork) {
          const found = await lookupAlbumMetadata(hit.title, artist);
          if (found) { album = found.album || album; artwork = artwork || found.artwork || ""; if (!artist) artist = found.artist || artist; }
        }
        return { reply: `Playing "${hit.title}", ${T}.`, action: "PLAY_MUSIC", intent: "music", meta: { playUrl: hit.url, title: hit.title, artist, album, artwork } };
      }

      const videoId = await findYoutubeVideoId(query);
      if (videoId) {
        const vidMeta = await getYoutubeVideoMeta(videoId);
        const title = vidMeta?.title || query;
        let artist = vidMeta?.artist || "";
        let album = "";
        let artwork = "";
        const found = await lookupAlbumMetadata(title, artist);
        if (found) {
          album = found.album || "";
          artwork = found.artwork || "";
          if (!artist) artist = found.artist || "";
        }
        return {
          reply: `That's not in my library yet, ${T} — playing it now.`,
          action: "PLAY_MUSIC_SEARCH",
          intent: "music",
          meta: {
            playUrl: `https://www.youtube.com/watch?v=${videoId}`,
            title,
            artist,
            album,
            artwork,
          },
        };
      }
      return {
        reply: `I couldn't find that one, ${T}.`,
        action: "ASK_MUSIC",
        intent: "music",
      };
    }

    case "trigger_break": {
      return {
        reply: `Take a break, ${T}.`,
        action: "OPEN_BREAK_TABS",
        intent: "break",
        meta: { urls: ["https://www.youtube.com", "https://www.instagram.com"] },
      };
    }

    case "open_research": {
      const topic = (args.topic || "").trim();
      if (!topic) return { reply: `What do you want me to look into, ${T}?`, action: "ASK_RESEARCH", intent: "research" };
      let url = `https://www.google.com/search?q=${encodeURIComponent(topic)}`;
      let spoken = `Pulling up some resources on ${topic}, ${T}.`;
      try {
        const r = await Research.research(topic, T);
        if (r && r.reply) {
          spoken = r.reply;
          if (r.sources?.wikiUrl) url = r.sources.wikiUrl;
        }
      } catch (e) { /* fall back to the plain search link above */ }
      return { reply: spoken, action: "OPEN_RESEARCH", intent: "research", meta: { url, topic } };
    }

    case "control_home": {
      try {
        const reply = await Home.executeVoiceCommand(args.query || "", T);
        return { reply, action: "HOME_COMMAND", intent: "home" };
      } catch {
        return { reply: `Home command failed, ${T}.`, action: "HOME_COMMAND", intent: "home" };
      }
    }

    default:
      return { reply: `I don't have a tool for that yet, ${T}.` };
  }
}

app.post("/api/chat", async (req, res) => {
  let { message, sessionId, userName, userTitle, memories, moodContext, cameraActive, screenActive, userTimezone } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  // Fix likely speech-to-text mishearings (e.g. "tired" heard as "tarot")
  // before anything downstream tries to match on exact words.
  const heardMessage = message;
  message = correctMishearings(message);
  if (message !== heardMessage) console.log(`[VOICE-CORRECT] "${heardMessage}" -> "${message}"`);

  // Inject camera/screen context into the message if relevant so AI knows they're already active
  let enrichedMessage = message;
  if (cameraActive && /\b(camera|see|look|watch|analyze|analyse|fighting|style|face|visual)\b/i.test(message) && !/permission|access|grant/i.test(message)) {
    enrichedMessage = `[Camera is already active and online] ${message}`;
  }

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

  // ── 1.1 Drafting table / blueprint mode ──
  if (/\b(blueprint|blue print|drafting table|design table|engineering bay|cad mode|let'?s design|sketch (out|something)|draft something|design something)\b/i.test(message)) {
    return res.json({
      reply: `Opening the drafting table, ${T}. Pull a reference off the web, sketch over it with your hand, and I'll project it straight into a hologram.`,
      action: "SHOW_BLUEPRINT",
      intent: "blueprint",
      meta: { query: message },
    });
  }

  // ── 1.2 Holographic Workspace — AI-powered scene builder ──
  if (/\b(hologram(ic)? workspace|holo workspace|open workspace|scene builder|build a scene|3d workspace|workspace mode)\b/i.test(message)) {
    return res.json({
      reply: `Opening the holographic workspace, ${T}. Describe what you're imagining and I'll generate it — or drag objects in manually and build it yourself. The workspace is a living scene you can grab, move, and trash objects in.`,
      action: "OPEN_WORKSPACE",
      intent: "workspace",
      meta: { url: "/workspace" },
    });
  }

  // ── 2. Personality shortcuts (no AI needed) ──
  const personalNewsReply = Personality.routePersonalNews(message, T);
  if (personalNewsReply) {
    Trainer.addExample(message, personalNewsReply, "personal_news", "personal", 0.8, "personality");
    return res.json({ reply: personalNewsReply, action: "PERSONAL_NEWS", intent: "personal_news" });
  }
  const smalltalkReply = Personality.routeSmallTalk(message, T, userTimezone);
  if (smalltalkReply) {
    Trainer.addExample(message, smalltalkReply, "smalltalk", null, 0.8, "personality");
    return res.json({ reply: smalltalkReply, action: "SMALLTALK", intent: "smalltalk" });
  }

  // ── 2.5 AI decides + acts — replaces regex command matching ──
  // Groq reads the message and either calls a real tool (reminder,
  // timer, weather, Spotify, home control) or just answers in text.
  // No keyword list to maintain — new phrasings work automatically.
  // The legacy pipeline below only runs if this throws (e.g. Groq
  // unreachable), so nothing regresses if the API call fails.
  if (Groq.isConfigured()) {
    try {
      const toolResult = await Groq.chatWithTools({
        message:             enrichedMessage,
        userTitle:           T,
        memories,
        context:             moodContext,
        conversationHistory: getSessionHistory(sessionId),
        tz:                  userTimezone,
        executeTool: (name, args) => executeAssistantTool(name, args, { T, userTimezone, userName, moodContext }),
      });

      if (toolResult.reply) {
        Trainer.addExample(message, toolResult.reply, toolResult.intent || (toolResult.usedTool ? "tool_call" : "chat"), null, 0.85, "tool_calling");
        appendToSession(sessionId, "user", enrichedMessage);
        appendToSession(sessionId, "assistant", toolResult.reply);
        return res.json({
          reply:  toolResult.reply,
          action: toolResult.action || (toolResult.usedTool ? "TOOL" : "CHAT"),
          intent: toolResult.intent,
          meta:   toolResult.meta,
        });
      }
    } catch (err) {
      console.error("[TOOLS] chatWithTools failed, falling back to legacy pipeline:", err.message);
      // fall through to the pipeline below
    }
  }

  // ── Legacy regex reminders — fallback only ──
  // Only reached if Groq is unconfigured or the tool-calling call
  // above threw. Kept as a safety net so timers/reminders still work
  // in some form if the API is down, but it no longer runs first —
  // that's what was hijacking messages before the AI stage could see
  // them and mangling labels with its regex-based extraction.
  const reminderResult = Reminders.route(message, T, userTimezone, sessionId);
  if (reminderResult) {
    return res.json(reminderResult);
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
    if (hardCommandType === "hologram") {
      return res.json(handleHologramOpen(message, T));
    }
    if (hardCommandType === "newsWidget") {
      return res.json(await handleNewsFetch(message, T, "widget"));
    }
    if (hardCommandType === "newsPage") {
      return res.json(await handleNewsFetch(message, T, "page"));
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
        case "gmail":    return res.json(await handleGmailFetch(message, T, userName));
        case "calendar": return res.json(await handleCalendarFetch(message, T, userName));
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
  const serverData2  = { ...linkSummary2, allLinks: getAllLinksFormatted(), ...lookupLink(enrichedMessage) };

  // Persist user turn + load full history so JARVIS remembers its own questions
  appendToSession(sessionId, "user", enrichedMessage);
  const conversationHistory = getSessionHistory(sessionId);

  let result;
  try {
    result = await Brain.respond({ message: enrichedMessage, sessionId, userName, userTitle, memories, moodContext, serverData: serverData2, conversationHistory });
  } catch (err) {
    console.error("[BRAIN] Error:", err);
    Improve.failures.log(message, "", "BRAIN_CRASH", sessionId);
    return res.json({ reply: `Something went sideways, ${T}.`, action: "ERROR" });
  }

  if (result.needsFetch) {
    switch (result.fetchType) {
      case "weather":  return res.json(await handleWeatherFetch(message, T));
      case "spotify":  return res.json(await handleSpotifyFetch(message, T));
      case "gmail":    return res.json(await handleGmailFetch(message, T, userName));
      case "calendar": return res.json(await handleCalendarFetch(message, T, userName));
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

  // Persist assistant reply so next turn has full context
  if (result.reply) appendToSession(sessionId, "assistant", result.reply);

  return res.json(result);
});

// ═══════════════════════════════════════════════════════════════
// ── BOOT
// ═══════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;

// Memory must be restored from Upstash BEFORE anything below touches
// data/ (bootstrapOwnerAccount() reads profiles.json immediately).
// Everything that used to run inline here now runs inside boot().
async function boot() {
  await Persistence.pullAll();

  bootstrapOwnerAccount();
  Improve.ensureDirs();

  Improve.startImprovementLoop(5 * 60 * 1000);
  Trainer.startTrainingLoop(15 * 60 * 1000);
  Persistence.startAutoSync();

  startServer();
}
// ═══════════════════════════════════════════════════════════════
// ── PIPER TTS ROUTE
// ═══════════════════════════════════════════════════════════════
app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "Missing text" });

  // ── Home Talk path ────────────────────────────────────────────
  // Cast to Google Home regardless of whether Piper is running.
  // Uses Google Translate TTS (no API key, no Python deps needed).
  if (outputMode === "home") {
    const Cast = require("./cast");
    try {
      const result = TTS.isReady() ? await TTS.synthesize(text) : null;
      let audio = result ? result.buffer : null;
      if (!audio) audio = await fetchGoogleTTS(text);

      if (!audio) {
        console.error("[HOME TALK] All TTS methods failed — falling back to browser");
        return res.status(503).json({ error: "TTS unavailable", fallback: true });
      }

      const mediaUrl = Cast.publishAudio(audio, PORT);
      await Cast.playOnDevice(mediaUrl);
      console.log(`[HOME TALK] Cast to ${Cast.deviceName()} ✓`);
      return res.json({ ok: true, castTo: Cast.deviceName() });

    } catch (e) {
      console.error("[HOME TALK] Cast failed:", e.message);
      return res.status(500).json({ error: e.message, fallback: true });
    }
  }

  // ── Phone / browser path ──────────────────────────────────────
  if (!TTS.isReady()) {
    return res.status(503).json({ error: "Voice model loading", fallback: true });
  }
  const result = await TTS.synthesize(text);
  if (!result) return res.status(500).json({ error: "Synthesis failed", fallback: true });

  res.setHeader("Content-Type",  result.mimeType);
  res.setHeader("Content-Length", result.buffer.length);
  res.setHeader("Cache-Control",  "no-cache");
  res.send(result.buffer);
});

// ── Google Translate TTS — pure Node.js, no Python, no API key ───────────────
// Splits long text into ≤200-char chunks, fetches each as MP3 from
// translate.google.com/translate_tts, then concatenates the raw MP3 frames.
// pychromecast is happy playing MP3 — no ffmpeg conversion needed.
async function fetchGoogleTTS(text) {
  const clean = TTS.cleanText(text);
  if (!clean) return null;

  // Split on sentence boundaries to stay under 200 chars per request
  const chunks = [];
  let current  = "";
  for (const sentence of clean.replace(/([.!?])\s+/g, "$1\n").split("\n")) {
    const part = sentence.trim();
    if (!part) continue;
    if ((current + " " + part).length > 195) {
      if (current) chunks.push(current.trim());
      current = part;
    } else {
      current += (current ? " " : "") + part;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  if (!chunks.length) return null;

  const parts = [];
  for (const chunk of chunks) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(chunk)}`;
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal:  AbortSignal.timeout(8000),
      });
      if (!r.ok) { console.error(`[gTTS] HTTP ${r.status} for chunk`); continue; }
      parts.push(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      console.error("[gTTS] fetch failed:", e.message);
    }
  }

  if (!parts.length) return null;
  return Buffer.concat(parts); // concatenated MP3 — valid for casting
}

// Status check — client can poll this on startup to know when voice is ready
app.get("/api/tts/status", (req, res) => {
  res.json({ ready: TTS.isReady() });
});

// Home Talk state — lets the frontend show an accurate badge on load/refresh
app.get("/api/home-talk/status", (req, res) => {
  const Cast = require("./cast");
  res.json({ outputMode, device: Cast.deviceName(), configured: Cast.isConfigured() });
});

function startServer() {
  httpServer.listen(PORT, "0.0.0.0", () => {
    console.log(`\nJ.A.R.V.I.S online → http://localhost:${PORT}`);
    console.log(`  Comms panel    → http://localhost:${PORT}/comms`);
    console.log(`  Drafting table → http://localhost:${PORT}/blueprint`);
    console.log(`  Groq AI:       ${Groq.isConfigured() ? "✓ configured — primary brain active" : "✗ not configured (add GROQ_API_KEY to .env)"}`);
    console.log(`  Spotify:       ${Spotify.isConfigured() ? "✓ configured" : "✗ add SPOTIFY_CLIENT_ID to .env"}`);
    console.log(`  Google:        ${Google.isConfigured() ? "✓ configured — users can Sign in with Google" : "✗ add GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET to .env"}`);
    console.log(`  Weather:       ${process.env.OPENWEATHER_API_KEY ? "✓ configured" : "✗ add OPENWEATHER_API_KEY to .env"}`);
    console.log(`  GitHub deploy: ${process.env.GITHUB_TOKEN ? "✓ configured" : "✗ add GITHUB_TOKEN + GITHUB_REPO to .env"}`);
    console.log(`  Training data: /data/training_data.json`);
    console.log(`  Learned:       /data/learned/`);
    console.log(`  Memory sync:   ${Persistence.isConfigured() ? "✓ Supabase — memory survives restarts" : "✗ local-only — memory LOST on restart (set SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY/SUPABASE_BUCKET)"}\n`);
  });
}

boot();
