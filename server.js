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
const BuildAI     = require("./build-ai");
const Studio      = require("./studio");
const Home        = require("./home");
const Groq        = require("./hermes-engine");
const JarvisAgent = require("./jarvis-agent");
const Improve     = require("./self-improve");
const Trainer     = require("./trainer");
const Brain       = require("./brain");
const Reminders   = require("./reminders");
const Boards      = require("./boards");
const Briefing    = require("./briefing");
const InboxTriage = require("./inbox-triage");
const Schedule    = require("./schedule");
const Proactive   = require("./proactive");
const TTS = require("./tts");
const Persistence = require("./persistence");
const Settings    = require("./settings");
const Comms       = require("./comms-router");

const app        = express();

// ── CRASH GUARD ───────────────────────────────────────────────────
// A bug once surfaced where a third-party client library rejected a
// promise in a way that bypassed the calling code's own try/catch
// entirely, which crashed the ENTIRE Jarvis process (exit 1) over
// one bad API call — taking down TTS, comms, memory sync, everything,
// not just the one feature that failed.
// These two handlers are the actual fix for that: whatever
// eventually throws something uncaught, log it and keep the server
// alive instead of dying. A single feature misbehaving should never
// take the whole assistant offline.
process.on("unhandledRejection", (reason) => {
  console.error("[CRASH GUARD] Unhandled promise rejection (server staying up):", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[CRASH GUARD] Uncaught exception (server staying up):", err);
});

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

// ── PENDING EMAIL LIST (for "read the one from John" / "read #2") ──────────
// After JARVIS lists unread emails, it remembers that list per-session so a
// follow-up like "read the second one" or "read the one from Sarah" can be
// resolved to an actual message id without re-fetching from Gmail.
const PENDING_EMAIL_LISTS = new Map(); // sessionId -> { entries, userKey, expiresAt }
const EMAIL_LIST_TTL_MS = 15 * 60 * 1000;

function setPendingEmailList(sessionId, entries, userKey) {
  if (!sessionId) return;
  PENDING_EMAIL_LISTS.set(sessionId, { entries, userKey, expiresAt: Date.now() + EMAIL_LIST_TTL_MS });
}
function getPendingEmailList(sessionId) {
  if (!sessionId) return null;
  const rec = PENDING_EMAIL_LISTS.get(sessionId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { PENDING_EMAIL_LISTS.delete(sessionId); return null; }
  return rec;
}

const httpServer = http.createServer(app);

// "phone"  → TTS audio is sent back to whichever client asked for it (default)
// "home"   → TTS audio is cast to the Google Home / Nest speaker instead
let outputMode = "phone";

const HOME_TALK_ON  = /\b(enable|turn on|activate)\s+home\s*talk\b/i;
const HOME_TALK_OFF = /\b(disable|turn off|deactivate)\s+home\s*talk\b/i;

// Mute/unmute — checked as an instant regex safety net (like Home Talk
// above) so it always works even if Groq is unconfigured/down, on top
// of the real `mute_jarvis` / `unmute_jarvis` tools Groq can also call
// for any other phrasing ("keep it down", "quiet please", etc).
const MUTE_ON  = /^\s*(?:jarvis[,]?\s*)?(?:please\s+)?mute\b|\bstop\s+talking\b|\bbe\s+quiet\b|\bsilence\b(?!\s+detection)/i;
const MUTE_OFF = /^\s*(?:jarvis[,]?\s*)?(?:please\s+)?unmute\b|\bstart\s+talking\b|\bspeak\s+again\b/i;

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

// ── FIND-OR-BUILD — "Jarvis, build me a drone" ──────────────────
// Searches Sketchfab for the real thing first; only tells the client
// to fall back to the AI feature-tree generator (/api/build/generate)
// when nothing downloadable turns up. See build-engine.js.
app.get("/api/build/find", async (req, res) => {
  const q = (req.query.q || "").trim();
  try {
    const data = await Build.findOrBuildModel(q);
    res.json(data);
  } catch (e) {
    res.status(500).json({ source: "none", query: q, results: [], error: e.message });
  }
});

// ── BUILD MODE AI — "Jarvis, build a helmet" ──────────────────
// Turns a natural-language description into a structured JSON scene
// plan (parts, welds, effects) that build-mode.html spawns using its
// existing primitive/weld/physics machinery. See build-ai.js.
app.post("/api/build/generate", async (req, res) => {
  const prompt = (req.body?.prompt || "").trim();
  if (!prompt) return res.status(400).json({ error: "Missing 'prompt'." });
  try {
    const plan = await BuildAI.generateBuildPlan(prompt);
    res.json({ plan });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// ── PROJECT STUDIO — "Jarvis, start a project" ────────────────
// Coding / Building / Hybrid projects: real file tree, save,
// AI code assist (Groq), sandboxed "Run Script", and ZIP export.
// See studio.js for the implementation; studio.html/js is the UI.
// ═══════════════════════════════════════════════════════════════
app.get("/studio", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "studio.html"));
});

app.get("/api/studio/projects", (req, res) => {
  try { res.json({ projects: Studio.listProjects() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/studio/projects", (req, res) => {
  try {
    const { name, type } = req.body || {};
    res.json({ project: Studio.createProject({ name, type }) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/studio/projects/:id", (req, res) => {
  try { res.json({ project: Studio.getProject(req.params.id) }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.delete("/api/studio/projects/:id", (req, res) => {
  try { Studio.deleteProject(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.get("/api/studio/projects/:id/file", (req, res) => {
  try {
    const p = (req.query.path || "").toString();
    res.json({ path: p, content: Studio.readFile(req.params.id, p) });
  } catch (e) { res.status(404).json({ error: e.message }); }
});

app.post("/api/studio/projects/:id/file", (req, res) => {
  try {
    const { path: p, content } = req.body || {};
    if (!p) return res.status(400).json({ error: "Missing 'path'." });
    res.json({ project: Studio.saveFile(req.params.id, p, content) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.post("/api/studio/projects/:id/file/rename", (req, res) => {
  try {
    const { from, to } = req.body || {};
    if (!from || !to) return res.status(400).json({ error: "Missing 'from'/'to'." });
    res.json({ project: Studio.renameFile(req.params.id, from, to) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.delete("/api/studio/projects/:id/file", (req, res) => {
  try {
    const p = (req.query.path || "").toString();
    res.json({ project: Studio.deleteFile(req.params.id, p) });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

app.get("/api/studio/projects/:id/download", (req, res) => {
  try { Studio.streamZip(req.params.id, res); }
  catch (e) { res.status(404).json({ error: e.message }); }
});

app.post("/api/studio/projects/:id/run", async (req, res) => {
  try {
    const p = (req.body?.path || "").toString();
    if (!p) return res.status(400).json({ error: "Missing 'path'." });
    const result = await Studio.runScript(req.params.id, p);
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI code assist inside the editor — reuses the same Groq "elite
// coding engine" the rest of Jarvis uses (hermes-engine.js), fed
// with the currently open file as context so answers are specific
// to what's on screen instead of generic.
app.post("/api/studio/projects/:id/ai", async (req, res) => {
  try {
    const { message, activeFile, activeFileContent, history } = req.body || {};
    if (!message || !message.trim()) return res.status(400).json({ error: "Missing 'message'." });
    if (!Groq.isConfigured || !Groq.isConfigured()) {
      return res.status(503).json({ error: "No AI key configured on the server (GROQ_API_KEY). Add one in .env to enable the code assistant." });
    }
    let context = activeFile
      ? `Currently open file: ${activeFile}\n\n\`\`\`\n${(activeFileContent || "").slice(0, 6000)}\n\`\`\``
      : "";

    // Hybrid projects (code + CAD build in one) get a real link between
    // the two: any line a script prints shaped like
    //   JARVIS_BUILD:{"action":"rotate","axis":"y","degrees":25}
    // is forwarded live to the DESIGN tab and animates the selected (or
    // named) part. Tell the AI about this so "make it move the arm when
    // it hears hey" produces code that actually drives the build, not
    // just a console.log placeholder.
    let project = null;
    try { project = Studio.getProject(req.params.id); } catch {}
    if (project && project.type === "hybrid") {
      context += `\n\nThis is a HYBRID project: this code runs alongside a CAD/build model in the DESIGN tab, and the two are connected. To make code actually move, highlight, or nudge the physical build (not just simulate it in a comment), print a line to stdout shaped exactly like:
JARVIS_BUILD:{"action":"rotate","axis":"y","degrees":25}
Supported actions: "rotate" (needs axis: "x"|"y"|"z", degrees), "move" (needs axis, distance), or "pulse" (just a visual flash, no args needed). Add an optional "id" (a feature id like "f3") to target a specific part; omit it to target whichever part the user has selected, or the whole model. When the user describes physical behavior (e.g. "when it hears 'hey', move the arm"), write real trigger logic (wake-word check, sensor read, etc.) that calls console.log with this exact JARVIS_BUILD line at the moment the action should happen — this is what "Run Script" uses to actually animate the build live during testing, so it must be genuinely runnable, not a placeholder.`;
    }

    const result = await Groq.codeChat(message, {
      context,
      conversationHistory: Array.isArray(history) ? history.slice(-8) : [],
    });
    res.json({ reply: result.reply });
  } catch (e) {
    res.status(500).json({ error: e.message });
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

// ── SETTINGS (persisted toggles — face detection, etc.) ──
// Reading: GET returns the full merged settings object (defaults + saved).
// Writing: POST body is merged into whatever's already saved and written
// back — send only the keys you're changing, e.g. { "faceDetection": false }.
// data/settings.json is inside the SAME data/ folder persistence.js mirrors
// to Supabase, so on Render (with SUPABASE_* env vars set) this survives
// redeploys and spin-downs exactly like profiles/memories already do.
app.get("/api/settings", (req, res) => res.json(Settings.load()));
app.post("/api/settings", (req, res) => res.json(Settings.save(req.body || {})));
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
// ── PROACTIVE INBOX TRIAGE (the "does it while you're away" feature)
// ═══════════════════════════════════════════════════════════════
// GET /api/inbox-briefing/:user?tz=America/New_York
// Returns today's already-generated summary if one exists (e.g. the
// background sweep already ran overnight). If none exists yet — for
// instance the server was asleep overnight on a free-tier host — it
// generates one right now, on the spot, so the user still gets an
// unprompted summary the moment they open the app, without ever having
// asked "check my email".
app.get("/api/inbox-briefing/:user", async (req, res) => {
  const userKey = (req.params.user || "").toLowerCase().trim();
  if (!userKey) return res.status(400).json({ error: "Missing user" });
  if (!Google.isConfigured()) return res.json({ available: false });

  const profiles = loadProfiles();
  const profile  = profiles[userKey];
  if (!profile?.googleTokens?.access) return res.json({ available: false, connected: false });

  if (!Google.hasTokenForUser(userKey)) Google.hydrateTokens(userKey, profile.googleTokens);

  try {
    const entry = await InboxTriage.getOrGenerateToday(userKey, profile.title, req.query.tz);
    if (!entry) return res.json({ available: false });
    res.json({ available: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
// ── FLOATING BOARDS ──
// ═══════════════════════════════════════════════════════════════
app.get("/api/boards", (req, res) => {
  res.json({ boards: Boards.listBoards() });
});
app.get("/api/boards/:id", (req, res) => {
  const board = Boards.loadAll().find(b => b.id === req.params.id);
  if (!board) return res.status(404).json({ error: "not found" });
  res.json(board);
});
app.delete("/api/boards/:id", (req, res) => {
  res.json({ deleted: Boards.deleteBoard(req.params.id) });
});

// ── WORK-SESSION NUDGE — polled every ~20s. Autonomous: if you've
//    been at it over an hour, JARVIS has already picked a break
//    suggestion by the time this responds; it never waits for a
//    separate "yes" round-trip. ──
app.get("/api/schedule/due", (req, res) => {
  res.json({ nudge: Schedule.checkWorkNudge(req.query.tz) });
});

// ═══════════════════════════════════════════════════════════════
// ── PROACTIVE MORNING BRIEFING ──
// Weather + top headline + today's calendar + inbox headline,
// combined into one unprompted "here's where things stand" message.
// Same lazy-generate-once-per-day pattern as inbox-briefing above —
// works even if the server was asleep overnight on a free host tier.
// ═══════════════════════════════════════════════════════════════
app.get("/api/proactive/briefing/:user", async (req, res) => {
  const userKey = (req.params.user || "").toLowerCase().trim();
  if (!userKey) return res.status(400).json({ error: "Missing user" });

  const profiles = loadProfiles();
  const profile  = profiles[userKey];
  if (profile?.googleTokens?.access && !Google.hasTokenForUser(userKey)) {
    Google.hydrateTokens(userKey, profile.googleTokens);
  }

  try {
    const entry = await Proactive.getOrGenerateToday(userKey, profile?.title, req.query.tz);
    if (!entry) return res.json({ available: false });
    res.json({ available: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lightweight, frequently-polled sibling of /briefing above — see
// proactive.js's "NUDGE ENGINE" section. Cheap on every call: it only
// hits the Calendar API and re-reads today's already-cached weather.
app.get("/api/proactive/nudges/:user", async (req, res) => {
  const userKey = (req.params.user || "").toLowerCase().trim();
  if (!userKey) return res.status(400).json({ error: "Missing user" });

  const profiles = loadProfiles();
  const profile  = profiles[userKey];
  if (profile?.googleTokens?.access && !Google.hasTokenForUser(userKey)) {
    Google.hydrateTokens(userKey, profile.googleTokens);
  }

  try {
    const nudge = await Proactive.checkNudges(userKey, profile?.title, req.query.tz);
    res.json({ nudge: nudge || null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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

// ── AMBIENT ASSIST ──
// Called with a short window of speech JARVIS overheard WITHOUT being
// addressed by name. Groq decides whether it's worth proactively
// offering help; almost always the answer should be "no" (reply: null).
app.post("/api/ambient/assist", async (req, res) => {
  try {
    const { snippet, userTitle } = req.body || {};
    if (!snippet) return res.json({ reply: null });
    const reply = await Groq.ambientAssist(snippet, userTitle || "Sir");
    res.json({ reply: reply || null });
  } catch (e) {
    console.error("[AMBIENT] /api/ambient/assist failed:", e.message);
    res.status(500).json({ reply: null, error: e.message });
  }
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
  try {
    let result = await Research.research(query, userTitle || "Sir");
    if (!result?.reply && Research.isDeepResearchQuery(query)) {
      result = await Research.deepResearch(query, userTitle || "Sir");
    }
    res.json(result || { reply: null });
  }
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
  // Local PC control (Jarvis Agent, Groq-powered) — "open notepad",
  // "launch chrome", "open C:\notes.txt on my computer", etc. Checked
  // after openLink so saved link names still win if they overlap.
  // Actually disabled at runtime (not just skipped) when running on
  // Render — see jarvis-agent.js's isEnabled().
  openOnPC:     /\b(open|launch|start|fire up|pull up)\b.{1,40}\b(on (my|the) (computer|pc|machine|desktop)|notepad|calculator|calc|file explorer|finder|paint|chrome|firefox|edge|safari|spotify app|word|excel|terminal|command prompt|cmd|vs\s?code|vscode|settings app)\b/i,
  hologram:     /\b(show me a (3d|hologram)|holographic|3d model|3d scan|build mode)\b/i,
  wireframe:    /\b(render (this|it)( into| as)? a wireframe|wireframe (mode|view|render|it|this)|show (me )?(the )?wireframe|turn (this|it) into a wireframe)\b/i,
  changeModel:  /\b((change|swap|switch) (the )?(sketchfab )?model|try (a |another )?different model|another model|next model|different (sketchfab )?model)\b/i,
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
// ── COMMS: SPEAK A RELAYED LINE INTO A LIVE TEAMS CALL
// ═══════════════════════════════════════════════════════════════
// Runs in the background after comms-router.js has already replied
// to the user ("Calling X now..."). Synthesizes the relayed line,
// publishes it as a URL a local browser can open, then hands off to
// call-voice.js — which defaults to the screen-share method (open a
// dedicated "Jarvis — Speaking" window, share it into the call with
// audio, stop sharing after) so nothing beyond Teams itself needs
// installing. Set CALL_VOICE_METHOD=cable in .env to use VB-CABLE
// instead (mic gets switched via Teams' own in-app device picker —
// see call-voice.js / teams-control.js's switchTeamsMicTo).
//
// speakAfterDialing() below actually confirms the call connected
// (teams-control.js's waitForCallConnected) before doing anything —
// mic switching and speaking only happen once someone's genuinely
// picked up, not on a blind timer. If nobody answers, it throws and
// the caller below logs that instead of silently trying anyway.
async function handleCallAndSpeak(meta) {
  const lineToSpeak = meta && meta.lineToSpeak;
  if (!lineToSpeak) return;

  if (!TTS.isReady()) {
    console.warn("[COMMS] TTS isn't configured (CAMB_API_KEY missing) — can't speak into the call.");
    return;
  }
  const result = await TTS.synthesize(lineToSpeak);
  if (!result) {
    console.warn("[COMMS] TTS synthesis failed — can't speak into the call.");
    return;
  }

  const CallVoice = require("./call-voice");
  const Cast = require("./cast");

  // Cast.publishAudio() both writes the clip to public/tts-cache and
  // returns the URL it's servable at — reusing it here instead of a
  // second write avoids the two ending up out of sync (it also prunes
  // older cached clips each call, so a second manual write would just
  // get deleted out from under us).
  const mediaUrl = Cast.publishAudio(result.buffer, PORT);
  const filePath = path.join(__dirname, "public", "tts-cache", path.basename(new URL(mediaUrl).pathname));

  await CallVoice.speakAfterDialing({ filePath, mediaUrl });
}

// ═══════════════════════════════════════════════════════════════
// ── COMMS: SPEAK A RELAYED LINE INTO A MEETING JOINED VIA LINK
// ═══════════════════════════════════════════════════════════════
// Same idea as handleCallAndSpeak above, but for comms-router.js's
// JOIN_LINK_AND_SPEAK action — Jarvis has already joined the meeting
// (synchronously, before replying to the user) via
// teams.joinMeetingByLink(), so there's no "wait for pickup" delay to
// add here, just a short settle beat before speaking.
async function handleJoinLinkAndSpeak(meta) {
  const lineToSpeak = meta && meta.lineToSpeak;
  if (!lineToSpeak) return;

  if (!TTS.isReady()) {
    console.warn("[COMMS] TTS isn't configured (CAMB_API_KEY missing) — can't speak into the meeting.");
    return;
  }
  const result = await TTS.synthesize(lineToSpeak);
  if (!result) {
    console.warn("[COMMS] TTS synthesis failed — can't speak into the meeting.");
    return;
  }

  const CallVoice = require("./call-voice");
  const Cast = require("./cast");

  const mediaUrl = Cast.publishAudio(result.buffer, PORT);
  const filePath = path.join(__dirname, "public", "tts-cache", path.basename(new URL(mediaUrl).pathname));

  // skipConnectCheck: joinMeetingByLink already confirmed we're in the
  // meeting (its own IN_MEETING/WAITING_ROOM screen check) before this
  // function is ever called — speakAfterDialing's connected check is
  // phrased around Teams' 1:1 call toolbar, not a meeting room, so
  // re-running it here would just be redundant and less accurate.
  await CallVoice.speakAfterDialing({ filePath, mediaUrl, skipConnectCheck: true }, 1500);
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

// ── JARVIS AGENT: open something on the local computer ─────────
async function handleOpenOnPC(message, T) {
  if (!JarvisAgent.isEnabled()) {
    return {
      reply: `Can't do that from here, ${T} — this instance is running in the cloud, not on your computer, so the Jarvis agent is disabled.`,
      action: "OPEN_ON_PC",
      intent: "open_on_pc",
    };
  }
  try {
    const result = await JarvisAgent.openOnComputer(message);
    return { reply: `Opening ${result.target}, ${T}.`, action: "OPEN_ON_PC", intent: "open_on_pc", meta: { opened: result.target } };
  } catch (e) {
    return { reply: `Couldn't do that, ${T}. ${e.message}`, action: "OPEN_ON_PC", intent: "open_on_pc" };
  }
}

// ── JARVIS AGENT: how much disk space do I have ─────────────────
async function handleCheckDiskSpace(T) {
  if (!JarvisAgent.isEnabled()) {
    return {
      reply: `Can't check that from here, ${T} — this instance is running in the cloud, not on your computer.`,
      action: "DISK_SPACE",
      intent: "disk_space",
    };
  }
  try {
    const drives = await JarvisAgent.getDiskSpace();
    const main = drives[0];
    const reply = main.percentUsed
      ? `You've got ${main.freeGB}GB free out of ${main.totalGB}GB, ${T} — that's ${main.percentUsed} used.`
      : `You've got ${main.freeGB}GB free (${main.usedGB}GB used), ${T}.`;
    // Show the full breakdown on screen too, and pop the native storage
    // viewer open as a bonus — both best-effort, never block the spoken answer.
    JarvisAgent.showTextResult("disk-space", JSON.stringify(drives, null, 2)).catch(() => {});
    JarvisAgent.openDiskSpaceViewer().catch(() => {});
    return { reply, action: "DISK_SPACE", intent: "disk_space", meta: { drives } };
  } catch (e) {
    return { reply: `Couldn't check disk space, ${T}. ${e.message}`, action: "DISK_SPACE", intent: "disk_space" };
  }
}

// ── JARVIS AGENT: run a shell command locally (tiered) ──────────
async function handleRunComputerCommand(command, T, sessionId) {
  if (!JarvisAgent.isEnabled()) {
    return {
      reply: `Can't run commands from here, ${T} — this instance is running in the cloud, not on your computer.`,
      action: "RUN_COMMAND",
      intent: "run_command",
    };
  }
  const cmd = (command || "").trim();
  if (!cmd) return { reply: `What command do you want me to run, ${T}?`, action: "RUN_COMMAND", intent: "run_command" };

  const tier = JarvisAgent.classifyShellTier(cmd);

  if (tier === "never") {
    return {
      reply: `I won't run that one, ${T} — it's the kind of command that can do irreversible damage, so it's blocked outright regardless of confirmation.`,
      action: "RUN_COMMAND",
      intent: "run_command",
    };
  }

  if (tier === "confirm") {
    JarvisAgent.proposeAction(sessionId, "shell", { command: cmd });
    return {
      reply: `Want me to run \`${cmd}\` on your computer, ${T}? Say yes to confirm.`,
      action: "RUN_COMMAND_CONFIRM",
      intent: "run_command",
      meta: { pendingCommand: cmd },
    };
  }

  // tier === "auto" — read-only/informational, safe to run immediately
  try {
    const result = await JarvisAgent.runShellCommand(cmd);
    const output = (result.stdout || result.stderr || "(no output)").trim();
    JarvisAgent.showTextResult("command-output", `$ ${cmd}\n\n${output}`).catch(() => {});
    const spoken = output.length > 220 ? `${output.slice(0, 220)}... — full output is open on screen.` : output;
    return { reply: `${spoken}, ${T}.`, action: "RUN_COMMAND", intent: "run_command", meta: { command: cmd, output } };
  } catch (e) {
    return { reply: `That command failed, ${T}. ${e.message}`, action: "RUN_COMMAND", intent: "run_command" };
  }
}

// ── JARVIS AGENT: type text into the focused window (always confirm) ──
async function handleTypeText(text, T, sessionId, newFile = false) {
  if (!JarvisAgent.isEnabled()) {
    return {
      reply: `Can't type on this machine from here, ${T} — this instance is running in the cloud.`,
      action: "TYPE_TEXT",
      intent: "type_text",
    };
  }
  const clean = (text || "").trim();
  if (!clean) return { reply: `What do you want me to type, ${T}?`, action: "TYPE_TEXT", intent: "type_text" };

  JarvisAgent.proposeAction(sessionId, "type", { text: clean, newFile });
  const where = newFile ? "into a new file" : "into whatever's currently focused on your screen";
  return {
    reply: `Want me to type that ${where}, ${T}? Say yes to confirm.`,
    action: "TYPE_TEXT_CONFIRM",
    intent: "type_text",
    meta: { pendingText: clean, newFile },
  };
}

// ── JARVIS AGENT: resolve a pending confirm-tier action (shell/type) ──
// Called at the very top of /api/chat when the session has something
// awaiting a yes/no. Returns null if there's nothing pending for this
// session, so the caller falls through to normal routing.
const AFFIRMATIVE_RE = /^\s*(yes|yeah|yep|yup|sure|do it|go ahead|confirm(ed)?|affirmative|please do|correct)\b/i;
const NEGATIVE_RE    = /^\s*(no|nope|nah|cancel|don'?t|stop|never ?mind|negative)\b/i;

// Strips leading filler/hesitation words ("umm", "uh", "well", "so", "like",
// "hmm", "actually") and stray punctuation before testing against the
// yes/no regexes above, which are anchored to the start of the string.
// Without this, a perfectly clear "umm... no" or "uh yeah" fails to match
// either regex, falls through to normal chat routing, and derails whatever
// pending yes/no question was actually being answered.
const LEADING_FILLER_RE = /^\s*(?:umm?|uh+|erm?|hm+|well|so|like|actually|okay|ok)[\s,.]+/i;
function stripLeadingFiller(message) {
  let m = String(message || "");
  let prev;
  do {
    prev = m;
    m = m.replace(LEADING_FILLER_RE, "");
  } while (m !== prev);
  return m;
}
function isAffirmative(message) { return AFFIRMATIVE_RE.test(stripLeadingFiller(message)); }
function isNegative(message)    { return NEGATIVE_RE.test(stripLeadingFiller(message)); }

// ── DAILY BRIEFING (conversational, no big screen) ──────────────
// Trigger phrases the user actually has to say — this never fires on
// its own (not on login, not after face enrollment, nothing proactive).
const DAILY_BRIEFING_RE = /\b(daily brief(?:ing)?|my brief(?:ing)?|brief me|today'?s brief(?:ing)?|morning brief(?:ing)?)\b/i;

function formatTaskBriefingReply(entry, T) {
  const ORD = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
  const stepsText = (entry.steps || [])
    .map((s, i) => `${ORD[i] || `Step ${i + 1}`}, ${s}.`)
    .join(" ");
  return `${entry.headline}, ${T}. ${stepsText}`.trim();
}

async function routeDailyBriefing(message, T, sessionId, userName, userTimezone) {
  const pending = Briefing.getPendingGoalQuestion(sessionId);

  if (pending) {
    if (isNegative(message)) {
      Briefing.clearPendingGoalQuestion(sessionId);
      // No goal — just deliver the general stuff (weather/calendar/news/inbox),
      // no task-based steps to insist on.
      const entry = await Proactive.getOrGenerateToday(userName, T, userTimezone);
      const reply = entry ? entry.headline : `Nothing configured to check yet, ${T} — weather, calendar, and inbox all need to be set up first.`;
      return { reply, action: "DAILY_BRIEFING", intent: "daily_briefing" };
    }

    if (pending.phase === "awaiting_yes_no") {
      if (isAffirmative(message)) {
        Briefing.setGoalQuestionPhase(sessionId, "awaiting_goal_text");
        return { reply: `What's the goal, ${T}?`, action: "DAILY_BRIEFING", intent: "daily_briefing" };
      }
      // Not a recognizable yes/no — drop the pending question and let
      // normal routing take the message instead of getting stuck.
      Briefing.clearPendingGoalQuestion(sessionId);
      return null;
    }

    if (pending.phase === "awaiting_goal_text") {
      Briefing.clearPendingGoalQuestion(sessionId);
      const entry = await Briefing.setToday(userName, message, T);
      return { reply: formatTaskBriefingReply(entry, T), action: "DAILY_BRIEFING", intent: "daily_briefing", meta: { briefing: entry } };
    }

    Briefing.clearPendingGoalQuestion(sessionId);
    return null;
  }

  if (!DAILY_BRIEFING_RE.test(message)) return null;

  // Already have today's task-based briefing set — just replay it,
  // don't ask again.
  const existing = Briefing.getToday(userName);
  if (existing) {
    return { reply: formatTaskBriefingReply(existing, T), action: "DAILY_BRIEFING", intent: "daily_briefing", meta: { briefing: existing } };
  }

  Briefing.proposeGoalQuestion(sessionId);
  return { reply: `Do you have a goal for today, ${T}?`, action: "DAILY_BRIEFING", intent: "daily_briefing" };
}

async function resolvePendingAgentAction(message, T, sessionId) {
  const pending = JarvisAgent.getPendingAction(sessionId);
  if (!pending) return null;

  if (isNegative(message)) {
    JarvisAgent.clearPendingAction(sessionId);
    return { reply: `Cancelled, ${T}.`, action: "AGENT_ACTION_CANCELLED", intent: "agent_confirm" };
  }
  if (!isAffirmative(message)) return null; // not a yes/no reply — let normal routing handle it

  JarvisAgent.clearPendingAction(sessionId);

  if (pending.kind === "shell") {
    try {
      const result = await JarvisAgent.runShellCommand(pending.payload.command);
      const output = (result.stdout || result.stderr || "(no output)").trim();
      JarvisAgent.showTextResult("command-output", `$ ${pending.payload.command}\n\n${output}`).catch(() => {});
      const spoken = output.length > 220 ? `${output.slice(0, 220)}... — full output is open on screen.` : output;
      return { reply: `${spoken}, ${T}.`, action: "RUN_COMMAND", intent: "run_command", meta: { command: pending.payload.command, output } };
    } catch (e) {
      return { reply: `That command failed, ${T}. ${e.message}`, action: "RUN_COMMAND", intent: "run_command" };
    }
  }

  if (pending.kind === "type") {
    try {
      // A small delay gives a just-opened app a moment to actually become
      // the focused window before keystrokes start firing at it.
      await JarvisAgent.typeText(pending.payload.text, { newFile: pending.payload.newFile, delayMs: 800 });
      return { reply: `Typed it, ${T}.`, action: "TYPE_TEXT", intent: "type_text" };
    } catch (e) {
      return { reply: `Couldn't type that, ${T}. ${e.message}`, action: "TYPE_TEXT", intent: "type_text" };
    }
  }

  if (pending.kind === "neutralize") {
    try {
      let reply;
      if (pending.payload.pid) {
        await JarvisAgent.killProcess(pending.payload.pid);
        reply = `Done, ${T} — process terminated.`;
      } else if (pending.payload.filePath) {
        const dest = await JarvisAgent.quarantineFile(pending.payload.filePath);
        reply = `Done, ${T} — quarantined to ${dest}.`;
      } else {
        reply = `Noted, ${T} — flagged, though there's nothing automatic I can remove for that one.`;
      }
      return { reply, action: "THREAT_NEUTRALIZED", intent: "security" };
    } catch (e) {
      return { reply: `Couldn't neutralize that, ${T}. ${e.message}`, action: "THREAT_NEUTRALIZED", intent: "security" };
    }
  }

  return null;
}

async function handleGmailFetch(message, T, userName, sessionId) {
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
    if (gd.error) return { reply: `Couldn't reach Gmail just now, ${T} — ${gd.error}`, action: "GMAIL", intent: "gmail" };

    const unread = gd.unread || 0;
    if (unread === 0 || !gd.messages?.length) {
      return { reply: `Inbox clear, ${T}. No unread messages.`, action: "GMAIL", intent: "gmail", meta: { gmailData: gd } };
    }

    setPendingEmailList(sessionId, gd.messages, userKey);

    const lines = gd.messages.map((m, i) => {
      const tag = m.senderType === "person"
        ? " — from a person"
        : m.senderType === "company"
          ? (m.senderPersonName ? ` — company, ${m.senderPersonName} reaching out` : " — company/automated")
          : "";
      return `${i + 1}. ${m.from}${tag}: "${m.subject}"`;
    }).join("\n");

    const reply = `You have ${unread} unread email${unread > 1 ? "s" : ""}, ${T}:\n${lines}\nWhich one do you want me to read?`;
    return { reply, action: "GMAIL", intent: "gmail", meta: { gmailData: gd } };
  } catch (e) {
    return { reply: `Gmail fetch failed, ${T}: ${e.message}`, action: "GMAIL", intent: "gmail" };
  }
}

// Resolves "read the second one" / "read the one from Sarah" against the
// list JARVIS just showed for this session, fetches the full message body,
// and reads it back. Read-only — never replies or sends anything.
async function handleReadEmail(args, T, sessionId) {
  const pending = getPendingEmailList(sessionId);
  if (!pending || !pending.entries?.length) {
    return { reply: `I haven't pulled up your inbox yet this session, ${T} — ask me to check your email first.`, action: "GMAIL", intent: "read_email" };
  }

  const { entries, userKey } = pending;
  let target = null;

  if (Number.isFinite(args?.index) && args.index >= 1 && args.index <= entries.length) {
    target = entries[args.index - 1];
  } else if (args?.sender) {
    const q = String(args.sender).toLowerCase();
    target = entries.find(m => m.from.toLowerCase().includes(q) || (m.fromEmail || "").toLowerCase().includes(q));
  } else if (entries.length === 1) {
    target = entries[0];
  }

  if (!target) {
    const lines = entries.map((m, i) => `${i + 1}. ${m.from}: "${m.subject}"`).join("\n");
    return { reply: `Not sure which one you mean, ${T}. Here's the list again:\n${lines}`, action: "GMAIL", intent: "read_email" };
  }

  try {
    const full = await Google.getMessageBody(userKey, target.id);
    if (full.needsAuth) return { reply: `Gmail needs re-authorisation, ${T}. Visit /api/google/auth?user=${userKey}.`, action: "GMAIL", intent: "read_email" };
    if (full.error) return { reply: `Couldn't open that email, ${T} — ${full.error}`, action: "GMAIL", intent: "read_email" };
    const body = full.body.length > 1200 ? full.body.slice(0, 1200).trim() + "…" : full.body;
    return {
      reply: `From ${full.from}, subject "${full.subject}":\n${body}`,
      action: "GMAIL",
      intent: "read_email",
      meta: { email: full },
    };
  } catch (e) {
    return { reply: `Couldn't open that email, ${T}: ${e.message}`, action: "GMAIL", intent: "read_email" };
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

// ── BUILD MODE — open the CAD workshop ───────────────────────────
function handleHologramOpen(message, T) {
  const q = (message || "")
    .replace(/\b(jarvis|hey|show me a|3d model of|3d scan of|holographic view of|build mode|hologram|holographic|3d model|3d scan)\b/gi, "")
    .trim();
  const reply = q
    ? `Pulling up build mode for "${q}", ${T}.`
    : `Build mode, ${T}. Try not to break anything.`;
  return { reply, action: "SHOW_HOLOGRAM", intent: "hologram", meta: { query: q } };
}

// ── WIREFRAME — "Jarvis, render this into a wireframe" ────────────
// Tells the client to (re)open Build Mode, flip the current model to
// wireframe rendering, and immediately push it into the holographic
// viewer — a single voice command instead of clicking through the UI.
function handleWireframeRender(message, T) {
  const q = (message || "")
    .replace(/\b(jarvis|hey|render|turn|show|me|the|this|it|into|as|a|wireframe|mode|view)\b/gi, "")
    .trim();
  const reply = q
    ? `Rendering "${q}" as a wireframe and pulling up the hologram, ${T}.`
    : `Rendering that as a wireframe and pulling up the hologram, ${T}.`;
  return { reply, action: "SHOW_HOLOGRAM_WIREFRAME", intent: "wireframe", meta: { query: q } };
}

// ── CHANGE MODEL — "Jarvis, change the sketchfab model" ────────────
// Cycles Build Mode to the next result from the last Sketchfab search
// so the user isn't stuck with whatever loaded first.
function handleChangeModel(T) {
  return {
    reply: `Swapping to the next Sketchfab model, ${T}.`,
    action: "BUILD_CHANGE_MODEL",
    intent: "changeModel",
    meta: {},
  };
}

// ── FLOATING BOARDS ────────────────────────────────────────────
// "Jarvis, make a board on how you work" / "pull up the board we
// made on X" — small floating cards rendered directly on the main
// screen (public/board-widget.js), backed by boards.js so they
// survive a page refresh and can be recalled by topic later.

// Real facts about this app's own architecture, so a board about
// "how you work" is grounded instead of invented.
const JARVIS_SELF_KNOWLEDGE = `
JARVIS's brain is Groq's cloud API (hermes-engine.js) — the conversation is sent to Groq along with a list of real callable tools, and Groq itself decides from natural language whether to answer in words or call one of them; there's no rigid keyword list. Tools include timers, reminders and the agenda (reminders.js), weather, on-screen music playback pulled from YouTube, a hand-tracked 3D Build Mode workspace (Three.js + a real camera hand-tracking pipeline), a news page/widget, smart-home device control, real Gmail and Google Calendar access via OAuth, person lookup/research, and now these floating boards. A self-improvement loop (self-improve.js, trainer.js) logs anything it fumbles and learns new phrasings over time. The personality layer (personality.js) is J.A.R.V.I.S from the Iron Man films — formal, dry British wit. It runs as a Node/Express server with a browser front end (public/jarvis.js) doing speech recognition and speech synthesis, and a data/ folder mirrored to Supabase storage (persistence.js) so memories, reminders, and boards survive restarts, not just refreshes.
`.trim();

function isSelfTopic(topic) {
  return /\b(you|your|yourself|jarvis)\b/i.test(topic) && /\b(work|function|built|made|architecture|system|brain|run|operate|how)\b/i.test(topic);
}

function fallbackBoardContent(topic, T) {
  // Used only if Groq is unavailable/unconfigured — a plain, honest
  // board rather than no board at all.
  if (isSelfTopic(topic)) {
    return {
      title: "How I Work",
      content: [
        "Groq is the brain — it reads plain English and picks the right tool itself.",
        "Tools on tap: timers, reminders, weather, music, Build Mode, news, smart home, email, calendar.",
        "A learning loop remembers what trips me up and improves over it.",
        "Everything — memories, reminders, boards — is saved to disk, not just this tab.",
      ].join("\n"),
    };
  }
  return {
    title: topic.slice(0, 40) || "Untitled Board",
    content: `${T}, I don't have a live connection to write this one up properly — add a GROQ_API_KEY and ask again for the full board.`,
  };
}

async function generateBoardContent(topic, T) {
  if (!Groq.isConfigured()) return fallbackBoardContent(topic, T);

  const selfTopic = isSelfTopic(topic);
  const sys = `You are writing the CONTENT for a small floating information board inside the JARVIS assistant app, on the topic: "${topic}".
Write in JARVIS's voice — formal, precise, dry British wit — but this is a board someone GLANCES at, not an essay, so keep it terse.
Reply in PLAIN TEXT ONLY (no markdown, no asterisks, no numbering).
Line 1: a short board title, at most 6 words.
Line 2: blank.
Then 3 to 6 short standalone lines, each a single punchy clause or fact — no bullet characters.
Whole thing under 110 words.${selfTopic ? `\nThis board is about JARVIS itself — base it on these real facts about how this specific system actually works, don't invent architecture:\n${JARVIS_SELF_KNOWLEDGE}` : ""}`;

  try {
    const raw = await Groq.groqFetch(
      [{ role: "system", content: sys }, { role: "user", content: topic }],
      Groq.MODELS.fast,
      0.65,
      350
    );
    const lines = raw.split("\n").map(l => l.trim()).filter((l, i) => !(i === 0 && l === ""));
    const title = (lines[0] || topic).replace(/^title:\s*/i, "").slice(0, 80) || topic;
    const body = lines.slice(1).join("\n").trim() || raw.trim();
    return { title, content: body };
  } catch (e) {
    console.error("[BOARDS] generation failed, using fallback:", e.message);
    return fallbackBoardContent(topic, T);
  }
}

async function handleMakeBoard(topic, T) {
  const clean = (topic || "").trim();
  if (!clean) return { reply: `What should the board be about, ${T}?`, action: "ASK_BOARD_TOPIC", intent: "board" };
  const { title, content } = await generateBoardContent(clean, T);
  const board = Boards.createBoard(title, content);
  return {
    reply: `Board's up, ${T} — "${board.title}". Move it wherever suits you.`,
    action: "SHOW_BOARD",
    intent: "board",
    meta: { id: board.id, title: board.title, content: board.content, mode: "create" },
  };
}

function handleShowBoard(topic, T) {
  const board = Boards.findBoard((topic || "").trim());
  if (!board) {
    return { reply: `I don't have a board on that yet, ${T}. Want me to make one?`, action: "BOARD_NOT_FOUND", intent: "board" };
  }
  return {
    reply: `Here's "${board.title}", ${T}.`,
    action: "SHOW_BOARD",
    intent: "board",
    meta: { id: board.id, title: board.title, content: board.content, mode: "open" },
  };
}

function handleListBoards(T) {
  const boards = Boards.listBoards();
  if (!boards.length) return { reply: `No boards saved yet, ${T}.`, action: "LIST_BOARDS", intent: "board", meta: { boards: [] } };
  return {
    reply: `You've got ${boards.length} board${boards.length === 1 ? "" : "s"} saved, ${T}: ${boards.map(b => b.title).join(", ")}.`,
    action: "LIST_BOARDS",
    intent: "board",
    meta: { boards: boards.map(b => ({ id: b.id, title: b.title })) },
  };
}

function handleForgetBoard(topic, T) {
  const board = Boards.findBoard((topic || "").trim());
  if (!board) return { reply: `Couldn't find a board on that, ${T}.`, action: "BOARD_NOT_FOUND", intent: "board" };
  Boards.deleteBoard(board.id);
  return { reply: `Deleted "${board.title}", ${T}.`, action: "BOARD_DELETED", intent: "board", meta: { id: board.id } };
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
  const { T, userTimezone, userName, sessionId } = ctx;

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

    // ── call_on_teams / message_on_teams / join_teams_meeting ──
    // These exist because comms-router.js's regexes are a hard
    // gatekeeper BEFORE this tool-calling block ever runs (see the
    // 2.4 comment above) — if a phrasing doesn't match one of those
    // regexes exactly (e.g. "can you call X for me" instead of
    // "call X on teams"), tryRoute returns null and control falls
    // through to here. Before these tools existed, this block had
    // no calling/messaging/joining capability of its own — the only
    // Teams-shaped tool available was open_on_computer, which just
    // launches the app window and stops. That's the "opens Teams and
    // does nothing" symptom: the model reached for the only tool it
    // had. Registering these as real tools means any natural
    // phrasing the regex misses still actually places the call.
    case "call_on_teams": {
      const Comms = require("./comms-router");
      const Teams = require("./teams-control");
      const { craftAgentIntro } = require("./personality");
      const person = String(args.person || "").trim();
      if (!person) return { reply: `Who should I call, ${T}?` };
      const isVideo = !!args.video;
      const note = args.note_to_relay ? String(args.note_to_relay).trim() : null;
      const ownerName = userName || Comms.defaultOwnerName();
      const { status } = Comms.noteToStatus(note, ownerName);

      let matchedName;
      try {
        matchedName = await Teams.callOnTeams(person, isVideo ? "video" : "audio");
      } catch (err) {
        console.error("[TOOLS] call_on_teams failed:", err.message);
        return { reply: `I couldn't get that call going, ${T} — ${err.message}`, action: "CALL_FAILED", intent: "comms", meta: { person, error: err.message } };
      }
      const matchNote = matchedName.toLowerCase() !== person.toLowerCase()
        ? ` (closest match to "${person}" I found was "${matchedName}")`
        : "";

      if (note) {
        const line = craftAgentIntro({ ownerName, status });
        handleCallAndSpeak({ lineToSpeak: line }).catch((err) => console.error("[TOOLS] speak-into-call failed:", err.message));
        return {
          reply: `Calling ${matchedName} now${matchNote}, ${T}. Once they pick up I'll tell them: "${line}"`,
          action: "CALL_AND_SPEAK", intent: "comms",
          meta: { person: matchedName, lineToSpeak: line, callType: isVideo ? "video" : "audio" },
        };
      }
      return { reply: `Calling ${matchedName} on Teams now${matchNote}, ${T}.`, action: "CALL", intent: "comms", meta: { person: matchedName, callType: isVideo ? "video" : "audio" } };
    }

    case "message_on_teams": {
      const Teams = require("./teams-control");
      const person = String(args.person || "").trim();
      const text = String(args.text || "").trim();
      if (!person || !text) return { reply: `Who should I message, and what should it say, ${T}?` };

      let matchedName;
      try {
        matchedName = await Teams.messageOnTeams(person, text);
      } catch (err) {
        console.error("[TOOLS] message_on_teams failed:", err.message);
        return { reply: `Couldn't send that, ${T} — ${err.message}`, action: "MESSAGE_FAILED", intent: "comms", meta: { person, error: err.message } };
      }
      const matchNote = matchedName.toLowerCase() !== person.toLowerCase()
        ? ` (closest match to "${person}" I found was "${matchedName}")`
        : "";
      return { reply: `Sent to ${matchedName} on Teams${matchNote}, ${T}.`, action: "MESSAGE", intent: "comms", meta: { person: matchedName, body: text } };
    }

    case "join_teams_meeting": {
      const Teams = require("./teams-control");
      const { craftAgentIntro } = require("./personality");
      const Comms = require("./comms-router");
      const link = args.link ? String(args.link).trim() : null;
      const note = args.note_to_relay ? String(args.note_to_relay).trim() : null;

      if (link) {
        try {
          await Teams.joinMeetingByLink(link);
        } catch (err) {
          console.error("[TOOLS] join_teams_meeting (link) failed:", err.message);
          return {
            reply: `I couldn't get all the way into that meeting on my own, ${T} — it got stuck partway through the join screen. You may need to finish that one manually this time.`,
            action: "JOIN_LINK_FAILED", intent: "comms", meta: { url: link, error: err.message },
          };
        }
        if (note) {
          const ownerName = userName || Comms.defaultOwnerName();
          const line = craftAgentIntro({ ownerName, status: note });
          handleJoinLinkAndSpeak({ lineToSpeak: line }).catch((err) => console.error("[TOOLS] speak-into-meeting failed:", err.message));
          return { reply: `Joined, ${T}. Once things settle I'll say: "${line}"`, action: "JOIN_LINK_AND_SPEAK", intent: "comms", meta: { url: link, lineToSpeak: line } };
        }
        return { reply: `Joined the meeting, ${T}.`, action: "JOIN_LINK", intent: "comms", meta: { url: link } };
      }

      try {
        await Teams.joinMeeting(args.meeting_hint || null);
      } catch (err) {
        console.error("[TOOLS] join_teams_meeting failed:", err.message);
        return { reply: `Couldn't find a joinable meeting, ${T} — ${err.message}`, action: "JOIN_MEETING_FAILED", intent: "comms", meta: { error: err.message } };
      }
      return { reply: `Joining now, ${T}.`, action: "JOIN_MEETING", intent: "comms" };
    }

    case "show_camera":
      return { reply: `Bringing up the camera feed, ${T}.`, action: "SHOW_CAMERA", intent: "camera" };

    case "hide_camera":
      return { reply: `Closing the camera feed, ${T}.`, action: "HIDE_CAMERA", intent: "camera" };

    case "start_recording": {
      const local = JarvisAgent.isEnabled();
      let source = args.source === "webcam" ? "webcam" : args.source === "screen" ? "screen" : args.source === "tab" ? "tab" : "";
      if (!source) source = local ? "screen" : "tab"; // local desktop defaults to whole screen, hosted site defaults to the tab
      const label = source === "webcam" ? "your webcam" : source === "screen" ? "your whole screen" : "this tab";
      return {
        reply: `Starting a recording of ${label}, ${T}. Say "stop recording" when you're done and I'll save it.`,
        action: "START_RECORDING",
        intent: "recording",
        meta: { source, local },
      };
    }

    case "stop_recording":
      return { reply: `Stopping the recording, ${T} — saving it now.`, action: "STOP_RECORDING", intent: "recording" };

    case "clip_recording": {
      let seconds = Number(args.seconds);
      if (!Number.isFinite(seconds) || seconds <= 0) seconds = 30;
      seconds = Math.max(5, Math.min(60, Math.round(seconds)));
      const clipType = args.source === "webcam" || args.source === "camera" ? "camera" : args.source === "both" ? "both" : "screen";
      const label = clipType === "camera" ? "webcam" : clipType === "both" ? "screen and webcam" : "screen";
      return {
        reply: `Here's the last ${seconds} seconds of your ${label}, ${T}.`,
        action: "CLIP_SAVE",
        intent: "recording",
        meta: { clipType, seconds },
      };
    }

    case "scan_for_threats": {
      if (!JarvisAgent.isEnabled()) {
        return { reply: `Can't scan this machine from here, ${T} — this instance is running in the cloud, not on your computer.`, action: "THREAT_SCAN", intent: "security" };
      }
      try {
        const report = await JarvisAgent.scanForThreats();
        JarvisAgent.showTextResult("threat-scan", JSON.stringify(report, null, 2)).catch(() => {});

        const actionable = report.findings.find(f => f.severity === "confirmed" || f.severity === "worth-a-look");
        if (!actionable) {
          const avNote = report.avStatus?.AntivirusEnabled === false ? " Also worth knowing — your antivirus looks disabled." : "";
          return { reply: `All clear, ${T}. Nothing suspicious found.${avNote}`, action: "THREAT_SCAN", intent: "security", meta: { report } };
        }

        JarvisAgent.proposeAction(sessionId, "neutralize", {
          pid: actionable.pid, filePath: actionable.filePath, label: actionable.label,
        });
        const certainty = actionable.severity === "confirmed" ? "" : " — worth a look, though not a confirmed infection";
        const extra = report.findings.length > 1 ? ` There were ${report.findings.length - 1} other item${report.findings.length - 1 === 1 ? "" : "s"} too — I'll flag those once this one's handled.` : "";
        return {
          reply: `Sir, there seems to be a threat on your computer${certainty}: ${actionable.label}. Do you want me to neutralize it?${extra}`,
          action: "THREAT_FOUND",
          intent: "security",
          meta: { report, actionable },
        };
      } catch (e) {
        return { reply: `Scan failed, ${T}. ${e.message}`, action: "THREAT_SCAN", intent: "security" };
      }
    }

    case "neutralize_threat": {
      const pending = JarvisAgent.getPendingAction(sessionId);
      if (!pending || pending.kind !== "neutralize") {
        return { reply: `Nothing's currently flagged to neutralize, ${T} — run a scan first.`, action: "THREAT_NEUTRALIZED", intent: "security" };
      }
      JarvisAgent.clearPendingAction(sessionId);
      try {
        let reply;
        if (pending.payload.pid) {
          await JarvisAgent.killProcess(pending.payload.pid);
          reply = `Done, ${T} — process terminated.`;
        } else if (pending.payload.filePath) {
          const dest = await JarvisAgent.quarantineFile(pending.payload.filePath);
          reply = `Done, ${T} — quarantined to ${dest}.`;
        } else {
          reply = `Noted, ${T} — flagged, though there's nothing automatic I can remove for that one.`;
        }
        return { reply, action: "THREAT_NEUTRALIZED", intent: "security" };
      } catch (e) {
        return { reply: `Couldn't neutralize that, ${T}. ${e.message}`, action: "THREAT_NEUTRALIZED", intent: "security" };
      }
    }

    case "mute_jarvis":
      return { reply: `Muted, ${T}.`, action: "MUTE_ON", intent: "mute" };

    case "unmute_jarvis":
      return { reply: `Unmuted, ${T}.`, action: "MUTE_OFF", intent: "mute" };

    case "get_weather":
      return await handleWeatherFetch(args.location ? `weather in ${args.location}` : "weather", T);

    case "open_build_mode":
      return handleHologramOpen(args.query ? `build mode ${args.query}` : "build mode", T);

    case "make_board":
      return await handleMakeBoard(args.topic, T);

    case "show_board":
      return handleShowBoard(args.topic, T);

    case "list_boards":
      return handleListBoards(T);

    case "forget_board":
      return handleForgetBoard(args.topic, T);

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
        let r = await Research.research(topic, T);
        if ((!r || !r.reply) && Research.isDeepResearchQuery(topic)) {
          r = await Research.deepResearch(topic, T);
        }
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

    case "check_email":
      return await handleGmailFetch("check inbox", T, userName, sessionId);

    case "read_email": {
      const idx = Number(args?.index);
      return await handleReadEmail({ index: Number.isFinite(idx) ? idx : undefined, sender: args?.sender }, T, sessionId);
    }

    case "get_calendar": {
      const periodPhrase = { today: "today", tomorrow: "tomorrow", this_week: "this week", next_week: "next week" }[args.period] || "today";
      return await handleCalendarFetch(periodPhrase, T, userName);
    }

    case "open_on_computer": {
      if (!JarvisAgent.isEnabled()) {
        return { reply: `Can't do that from here, ${T} — this instance is running in the cloud, not on your computer.`, action: "OPEN_ON_PC", intent: "open_on_pc" };
      }
      const target = (args.target || "").trim();
      if (!target) return { reply: `What do you want opened, ${T}?`, action: "OPEN_ON_PC", intent: "open_on_pc" };
      try {
        const result = await JarvisAgent.openTarget(target);
        return { reply: `Opening ${result.target}, ${T}.`, action: "OPEN_ON_PC", intent: "open_on_pc", meta: { opened: result.target } };
      } catch (e) {
        return { reply: `Couldn't open that, ${T}. ${e.message}`, action: "OPEN_ON_PC", intent: "open_on_pc" };
      }
    }

    case "check_disk_space":
      return await handleCheckDiskSpace(T);

    case "run_computer_command":
      return await handleRunComputerCommand(args.command, T, sessionId);

    case "type_text":
      return await handleTypeText(args.text, T, sessionId, !!args.new_file);

    default:
      return { reply: `I don't have a tool for that yet, ${T}.` };
  }
}

app.post("/api/chat", async (req, res) => {
  let { message, sessionId, userName, userTitle, memories, moodContext, cameraActive, cameraViewOpen, screenActive, userTimezone, attachments } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  // Fix likely speech-to-text mishearings (e.g. "tired" heard as "tarot")
  // before anything downstream tries to match on exact words.
  const heardMessage = message;
  message = correctMishearings(message);
  if (message !== heardMessage) console.log(`[VOICE-CORRECT] "${heardMessage}" -> "${message}"`);

  // Inject camera/screen context into the message if relevant so AI knows they're already active.
  // IMPORTANT: cameraActive reflects whether the camera STREAM/permission
  // is still granted (kept warm for face recognition even after the
  // fullscreen view is closed) — it does NOT mean camera mode's fullscreen
  // view is currently showing. cameraViewOpen is the real signal for that.
  // Older clients that don't send cameraViewOpen fall back to the phrasing
  // check below so this doesn't silently break for them.
  let enrichedMessage = message;
  const askingToOpenCamera = /\b(open|show|turn on|switch on|enable|activate|reopen|re-open|pull up|full ?screen)\b[\s\S]*\bcamera\b/i.test(message);
  const cameraViewKnown = cameraViewOpen !== undefined;
  const treatCameraAsShowing = cameraViewKnown ? !!cameraViewOpen : !askingToOpenCamera;
  if (cameraActive && treatCameraAsShowing && /\b(camera|see|look|watch|analyze|analyse|fighting|style|face|visual)\b/i.test(message) && !/permission|access|grant/i.test(message)) {
    enrichedMessage = `[Camera is already active and online] ${message}`;
  }

  // ── Chat-mode file attachments ──
  // Folded into enrichedMessage (not the raw `message` used for regex
  // routing above/below) so uploaded files reach the AI's context without
  // disturbing existing command matching. Text-ish files get their full
  // (truncated) content inlined; anything else is just named, so JARVIS
  // is honest about not being able to read that format yet.
  if (Array.isArray(attachments) && attachments.length) {
    const MAX_CHARS_PER_FILE = 6000;
    const blocks = attachments.slice(0, 5).map(a => {
      const name = String(a?.name || "file").slice(0, 200);
      if (a?.textContent) {
        let content = String(a.textContent);
        if (content.length > MAX_CHARS_PER_FILE) content = content.slice(0, MAX_CHARS_PER_FILE) + "\n...[truncated]";
        return `\n\n[Attached file: ${name}]\n${content}`;
      }
      if (a?.isImage) {
        return `\n\n[Attached image: ${name} — shared but not visually analyzable with the current text-only model]`;
      }
      return `\n\n[Attached file: ${name} — format not readable as text yet]`;
    }).join("");
    enrichedMessage = `${enrichedMessage}${blocks}`;
  }

  const T = userTitle || "Sir";

  // ── -1. Pending Jarvis Agent confirmation (shell command / typed text) ──
  // If the last thing Jarvis said was "want me to run X, say yes to
  // confirm", this message might be that yes/no — check it before
  // anything else gets a chance to reinterpret "yes" as something else.
  const pendingResolution = await resolvePendingAgentAction(message, T, sessionId);
  if (pendingResolution) return res.json(pendingResolution);

  // ── -0.5. Daily briefing (ask about a goal only if asked; never launches
  //      the old full-screen experience) ──
  const briefingResolution = await routeDailyBriefing(message, T, sessionId, userName, userTimezone);
  if (briefingResolution) return res.json(briefingResolution);


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

  // ── 0.5 Mute / unmute toggle — instant, no AI round-trip needed.
  //      Checked as a safety net so it always works even if Groq is
  //      unconfigured/down; the mute_jarvis/unmute_jarvis tools below
  //      handle any other phrasing Groq recognizes. ──
  if (MUTE_OFF.test(message)) {
    return res.json({ reply: `Unmuted, ${T}.`, action: "MUTE_OFF", intent: "mute" });
  }
  if (MUTE_ON.test(message)) {
    return res.json({ reply: `Muted, ${T}.`, action: "MUTE_ON", intent: "mute" });
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

  // ── 1.1 Drafting table / blueprint mode — routes into Build Mode ──
  if (/\b(blueprint|blue print|drafting table|design table|engineering bay|cad mode|let'?s design|sketch (out|something)|draft something|design something)\b/i.test(message)) {
    return res.json(handleHologramOpen(message, T));
  }

  // ── 1.2 Floating boards — regex safety net (Groq's tool-calling
  //      stage below handles these too, in any phrasing; this just
  //      keeps boards working even if Groq is unconfigured/down) ──
  {
    const makeBoardMatch = message.match(/\bmake\s+(?:me\s+)?a\s+board\s+(?:on|about|for|of)\s+(.+)/i)
                        || message.match(/\bboard\s+(?:on|about)\s+(.+)/i);
    if (makeBoardMatch) {
      return res.json(await handleMakeBoard(makeBoardMatch[1], T));
    }
    const showBoardMatch = message.match(/\b(?:pull up|bring up|bring back|show me|open|show)\s+(?:the|that|our|my)?\s*board\s*(?:we made\s+)?(?:on|about)?\s*(.*)/i);
    if (showBoardMatch) {
      return res.json(handleShowBoard(showBoardMatch[1], T));
    }
    if (/\bwhat boards\b|\blist (?:my |the )?boards\b/i.test(message)) {
      return res.json(handleListBoards(T));
    }
    const forgetBoardMatch = message.match(/\b(?:delete|forget|remove|get rid of)\s+(?:the|that)?\s*board\s*(?:on|about)?\s*(.*)/i);
    if (forgetBoardMatch) {
      return res.json(handleForgetBoard(forgetBoardMatch[1], T));
    }
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

  // NOTE: local PC control ("open VS Code", "open notepad", etc.) used to
  // be intercepted HERE via regex, before Groq ever saw the message. That
  // broke compound requests like "open VS Code and type a flappy bird
  // script" — the regex matched on "open VS Code" and returned immediately,
  // so "...and type a flappy bird script" was silently dropped and never
  // reached Groq at all. Now open_on_computer is a real Groq tool (see
  // hermes-engine.js's TOOLS + executeAssistantTool below), so Groq can
  // call it ALONGSIDE type_text in the same response and actually handle
  // the whole request. The old regex path still exists as a fallback
  // further down, for when Groq is unconfigured or its call throws.

  // ── 2.4 Comms — Teams/WhatsApp calls, messages, meetings ──
  // MUST run before the AI tool-calling block below. chatWithTools
  // has no "place a call" tool of its own — when it doesn't recognize
  // something as one of its registered tools, it just answers in
  // plain text (e.g. claiming it can't place calls and offering to
  // draft a message to the clipboard instead), and that text reply
  // short-circuits the whole handler before Comms.tryRoute — which
  // does the real vision-guided Teams call — ever gets a turn. This
  // used to sit after the AI block, which meant it was effectively
  // unreachable for almost any "call X on teams" phrasing.
  let commsResult = null;
  try {
    commsResult = await Comms.tryRoute(message, { T, ownerName: userName });
  } catch (err) {
    console.error("[COMMS] tryRoute failed:", err.message);
  }
  if (commsResult) {
    if (commsResult.action === "CALL_AND_SPEAK") {
      // Fire-and-forget: the reply below ("Calling X now...") already
      // goes back to the user immediately. Speaking into the call
      // happens in the background once it (hopefully) connects.
      handleCallAndSpeak(commsResult.meta).catch((err) =>
        console.error("[COMMS] speak-into-call failed:", err.message)
      );
    } else if (commsResult.action === "JOIN_LINK_AND_SPEAK") {
      handleJoinLinkAndSpeak(commsResult.meta).catch((err) =>
        console.error("[COMMS] speak-into-meeting failed:", err.message)
      );
    }
    return res.json(commsResult);
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
        executeTool: (name, args) => executeAssistantTool(name, args, { T, userTimezone, userName, moodContext, sessionId }),
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

  // ── 2.6 Daily schedule / healthy routine / agenda / mood-based opens ──
  const scheduleResult = Schedule.route(message, T, userTimezone, sessionId);
  if (scheduleResult) {
    return res.json(scheduleResult);
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
    if (hardCommandType === "wireframe") {
      return res.json(handleWireframeRender(message, T));
    }
    if (hardCommandType === "changeModel") {
      return res.json(handleChangeModel(T));
    }
    if (hardCommandType === "openOnPC") {
      return res.json(await handleOpenOnPC(message, T));
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
        case "gmail":    return res.json(await handleGmailFetch(message, T, userName, sessionId));
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
    if (action === "LOGOUT") {
      // Pass the original phrase along so the client can tell a real
      // "shut down"/"power off"/"goodbye" apart from a plain
      // "log out"/"sign out" — only the former should quit the whole
      // desktop app when running as local software; a plain log out
      // should just lock the screen, same as always.
      return res.json({ reply, action, intent, meta: { ...meta, query: message } });
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
      case "gmail":    return res.json(await handleGmailFetch(message, T, userName, sessionId));
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

    // ── PROACTIVE INBOX TRIAGE: background sweep ──────────────────
    // Runs while the server is up. Each pass is a no-op for any user
    // already triaged today, so it's cheap to run often — this just
    // makes sure it happens as early as possible for whoever's connected,
    // without them ever having to ask. (If the host spins the server down
    // overnight, the on-demand fallback in GET /api/inbox-briefing/:user
    // still covers it the moment the app is next opened.)
    if (Google.isConfigured()) {
      const runSweep = () => {
        InboxTriage.runOvernightSweep().catch(e => console.error("[inbox-triage] sweep error:", e.message));
      };
      runSweep();                              // once shortly after boot
      setInterval(runSweep, 15 * 60 * 1000);   // then every 15 minutes
    }
  });
}

boot();
