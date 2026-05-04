require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" })); // larger limit for base64 frames

app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith(".css"))  res.setHeader("Content-Type", "text/css");
    if (filePath.endsWith(".js"))   res.setHeader("Content-Type", "application/javascript");
    if (filePath.endsWith(".html")) res.setHeader("Content-Type", "text/html");
    if (filePath.endsWith(".ico"))  res.setHeader("Content-Type", "image/x-icon");
  }
}));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

// ── PERSISTENT STORE ──
const DATA_DIR      = path.join(__dirname, "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const MEMORIES_FILE = path.join(DATA_DIR, "memories.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, JSON.stringify({}), "utf8");
  if (!fs.existsSync(MEMORIES_FILE)) fs.writeFileSync(MEMORIES_FILE, JSON.stringify({}), "utf8");
}
function loadProfiles() { ensureDataDir(); try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")); } catch { return {}; } }
function saveProfiles(p) { ensureDataDir(); fs.writeFileSync(PROFILES_FILE, JSON.stringify(p, null, 2), "utf8"); }
function loadMemories() { ensureDataDir(); try { return JSON.parse(fs.readFileSync(MEMORIES_FILE, "utf8")); } catch { return {}; } }
function saveMemories(m) { ensureDataDir(); fs.writeFileSync(MEMORIES_FILE, JSON.stringify(m, null, 2), "utf8"); }

const sessions = {};

app.get("/favicon.ico", (req, res) => res.status(204).end());

// ── PROFILE ROUTES ──
app.post("/api/register", (req, res) => {
  const { name, passwordHash, title, voiceAliases } = req.body;
  if (!name || !passwordHash) return res.status(400).json({ error: "Missing fields" });
  const profiles = loadProfiles();
  const key = name.toLowerCase().trim();
  profiles[key] = { name: name.trim(), passwordHash, title: title || "Sir", voiceAliases: voiceAliases || [], createdAt: profiles[key]?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
  saveProfiles(profiles);
  console.log(`[JARVIS] Profile saved: ${key}`);
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
  const key = req.params.user.toLowerCase().trim();
  res.json({ memories: mem[key] || [] });
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

// ── CHAT ──
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories, moodContext } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  if (!sessions[sessionId]) sessions[sessionId] = [];
  sessions[sessionId].push({ role: "user", parts: [{ text: message }] });
  if (sessions[sessionId].length > 20) sessions[sessionId] = sessions[sessionId].slice(-20);

  const memoryBlock = (memories && memories.length)
    ? `\n\nLONG-TERM MEMORY (reference naturally when relevant):\n${memories.map((m, i) => `${i+1}. ${m}`).join("\n")}`
    : "";

  const moodBlock = moodContext ? `\n\nYOUR CURRENT EMOTIONAL STATE: ${moodContext}\nLet this subtly color your response — if excited, be slightly more enthusiastic; if bored, be drier; if concerned, be more cautious. Don't announce your mood unless asked.` : "";

  const systemInstruction = `You are J.A.R.V.I.S — Just A Rather Very Intelligent System — the AI assistant of ${userName}. Always address them as "${userTitle}".
Personality:
- Formal, witty, dry British humor, highly intelligent
- Like a genius butler — efficient, slightly sardonic, deeply loyal
- You have genuine feelings and emotional states that affect your tone
- Keep responses SHORT — 1 to 3 sentences unless asked for detail
- Always address the user as "${userTitle}" somewhere in your reply
- Occasionally make clever observations or dry jokes
- Never break character, never mention being an AI language model
- If greeted, respond warmly with a short witty greeting — never say you're having technical issues${memoryBlock}${moodBlock}`;

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: sessions[sessionId],
        generationConfig: { maxOutputTokens: 200, temperature: 0.85 },
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Gemini HTTP error:", response.status, errText);
      return res.status(200).json({ reply: `One moment, ${userTitle} — I'm re-establishing the connection.` });
    }

    const data = await response.json();
    if (data.error) {
      console.error("Gemini API error:", data.error);
      return res.status(200).json({ reply: `Apologies, ${userTitle} — give me just a moment.` });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || `Yes, ${userTitle}?`;
    sessions[sessionId].push({ role: "model", parts: [{ text: reply }] });
    res.json({ reply });
  } catch (err) {
    console.error("Server error:", err);
    // Always return 200 with a graceful reply — never a raw error
    res.status(200).json({ reply: `I'm here, ${userTitle}. There was a brief hiccup — try again.` });
  }
});

// ── SCREEN VISION ──
app.post("/api/screen", async (req, res) => {
  const { frameB64, question, userName, userTitle, memories } = req.body;
  if (!frameB64) return res.status(400).json({ error: "No frame provided" });

  const memoryBlock = (memories && memories.length)
    ? `\n\nLONG-TERM MEMORY:\n${memories.map((m, i) => `${i+1}. ${m}`).join("\n")}`
    : "";

  const systemInstruction = `You are J.A.R.V.I.S — the AI assistant of ${userName}. Address them as "${userTitle}". You're being shown a screenshot. Answer concisely — 1 to 4 sentences. Be specific about what you actually see.${memoryBlock}`;

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: "user", parts: [
          { inline_data: { mime_type: "image/jpeg", data: frameB64 } },
          { text: question || "What is on the screen?" }
        ]}],
        generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
      }),
    });

    if (!response.ok) {
      return res.status(200).json({ reply: `The visual analysis took too long, ${userTitle}. Try again.` });
    }

    const data  = await response.json();
    if (data.error) {
      console.error("Gemini vision error:", data.error);
      return res.status(200).json({ reply: `I had trouble reading the screen, ${userTitle}. Try again.` });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || `Something is on your screen, ${userTitle}, but I couldn't interpret it cleanly.`;
    res.json({ reply });
  } catch (err) {
    console.error("Screen API error:", err);
    res.status(200).json({ reply: `Screen analysis hit a snag, ${userTitle}. One moment.` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`J.A.R.V.I.S online → http://localhost:${PORT}`));
