require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(cors());
app.use(express.json());

// Explicit MIME types — fixes the CSS/JS being served as text/plain on Render
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

// ── PERSISTENT PROFILE STORE ──
// Stored in data/profiles.json — survives cache clears, only lost if server resets (use a volume on Render)
const DATA_DIR = path.join(__dirname, "data");
const PROFILES_FILE = path.join(DATA_DIR, "profiles.json");
const MEMORIES_FILE = path.join(DATA_DIR, "memories.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROFILES_FILE)) fs.writeFileSync(PROFILES_FILE, JSON.stringify({}), "utf8");
  if (!fs.existsSync(MEMORIES_FILE)) fs.writeFileSync(MEMORIES_FILE, JSON.stringify({}), "utf8");
}

function loadProfiles() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")); }
  catch { return {}; }
}

function saveProfiles(profiles) {
  ensureDataDir();
  fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2), "utf8");
}

function loadMemories() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(MEMORIES_FILE, "utf8")); }
  catch { return {}; }
}

function saveMemories(mem) {
  ensureDataDir();
  fs.writeFileSync(MEMORIES_FILE, JSON.stringify(mem, null, 2), "utf8");
}

const sessions = {};

// ── favicon (stops 404 noise) ──
app.get("/favicon.ico", (req, res) => res.status(204).end());

// ── REGISTER / SAVE PROFILE ──
// Called from the setup screen after the user fills out their profile
app.post("/api/register", (req, res) => {
  const { name, passwordHash, title, voiceAliases } = req.body;
  if (!name || !passwordHash) return res.status(400).json({ error: "Missing fields" });

  const profiles = loadProfiles();
  const key = name.toLowerCase().trim();

  profiles[key] = {
    name: name.trim(),
    passwordHash,
    title: title || "Sir",
    voiceAliases: voiceAliases || [],
    createdAt: profiles[key]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  saveProfiles(profiles);
  console.log(`[JARVIS] Profile saved for: ${key}`);
  res.json({ success: true });
});

// ── LOAD PROFILE (by name) ──
// Called on startup so the client can restore the profile even after cache clear
app.get("/api/profile/:name", (req, res) => {
  const profiles = loadProfiles();
  const key = req.params.name.toLowerCase().trim();
  const profile = profiles[key];
  if (!profile) return res.json({ found: false });
  // Never send passwordHash to client — client stores it separately after login
  const { passwordHash, ...safe } = profile;
  res.json({ found: true, profile: safe });
});

// ── VERIFY PASSWORD (returns full profile on success) ──
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

// ── LIST PROFILES (names only, for "who are you?" voice matching) ──
app.get("/api/profiles", (req, res) => {
  const profiles = loadProfiles();
  // Return only public info: name, title, voiceAliases
  const list = Object.values(profiles).map(({ name, title, voiceAliases }) => ({
    name, title, voiceAliases
  }));
  res.json({ profiles: list });
});

// ── MEMORY ──
// GET /api/memory/:user  — fetch all memories for a user
app.get("/api/memory/:user", (req, res) => {
  const mem = loadMemories();
  const key = req.params.user.toLowerCase().trim();
  res.json({ memories: mem[key] || [] });
});

// POST /api/memory  — add a memory { user, fact }
app.post("/api/memory", (req, res) => {
  const { user, fact } = req.body;
  if (!user || !fact) return res.status(400).json({ error: "Missing fields" });
  const mem = loadMemories();
  const key = user.toLowerCase().trim();
  if (!mem[key]) mem[key] = [];
  mem[key].push({ fact: fact.trim(), savedAt: new Date().toISOString() });
  // Cap at 50 memories per user — drop oldest
  if (mem[key].length > 50) mem[key] = mem[key].slice(-50);
  saveMemories(mem);
  console.log(`[JARVIS] Memory saved for ${key}: "${fact}"`);
  res.json({ success: true });
});

// POST /api/memory/forget  — fuzzy-remove memories matching a hint { user, hint }
app.post("/api/memory/forget", (req, res) => {
  const { user, hint } = req.body;
  if (!user || !hint) return res.status(400).json({ error: "Missing fields" });
  const mem = loadMemories();
  const key = user.toLowerCase().trim();
  if (!mem[key]) return res.json({ removed: 0 });
  const before = mem[key].length;
  const hintLower = hint.toLowerCase();
  mem[key] = mem[key].filter(m => !m.fact.toLowerCase().includes(hintLower));
  const removed = before - mem[key].length;
  saveMemories(mem);
  res.json({ removed });
});

// ── CHAT ──
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle, memories } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  if (!sessions[sessionId]) sessions[sessionId] = [];
  sessions[sessionId].push({ role: "user", parts: [{ text: message }] });
  if (sessions[sessionId].length > 20) sessions[sessionId] = sessions[sessionId].slice(-20);

  // Build memory context block
  const memoryBlock = (memories && memories.length)
    ? `\n\nLONG-TERM MEMORY (things ${userName} has told you to remember — reference naturally when relevant):\n${memories.map((m, i) => `${i+1}. ${m}`).join("\n")}`
    : "";

  const systemInstruction = `You are J.A.R.V.I.S — Just A Rather Very Intelligent System — the AI assistant of ${userName}. You always address them as "${userTitle}".
Your personality:
- Formal, witty, dry humor, highly intelligent
- Like a genius butler — efficient, slightly sardonic, deeply loyal
- Keep responses SHORT — 1 to 3 sentences unless the user asks for detail
- Always address the user as "${userTitle}" somewhere in your reply
- Occasionally make clever observations
- Never break character, never mention being an AI language model
- If someone just says hello or hi or greets you, respond with a short witty greeting. Do NOT say you are having technical difficulties.${memoryBlock}`;

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

    const data = await response.json();
    if (data.error) {
      console.error("Gemini error:", data.error);
      return res.status(500).json({ error: `Apologies, ${userTitle} — the neural link is a bit choppy.` });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || `Yes, ${userTitle}?`;
    sessions[sessionId].push({ role: "model", parts: [{ text: reply }] });
    res.json({ reply });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: `Network failure, ${userTitle}. I'll investigate.` });
  }
});

// ── SCREEN VISION ──
// Receives a base64 JPEG frame + question, sends to Gemini vision, returns a spoken reply
app.post("/api/screen", async (req, res) => {
  const { frameB64, question, userName, userTitle, memories } = req.body;
  if (!frameB64) return res.status(400).json({ error: "No frame provided" });

  const memoryBlock = (memories && memories.length)
    ? `\n\nLONG-TERM MEMORY:\n${memories.map((m, i) => `${i+1}. ${m}`).join("\n")}`
    : "";

  const systemInstruction = `You are J.A.R.V.I.S — Just A Rather Very Intelligent System — the AI assistant of ${userName}. Address them as "${userTitle}".
Personality: formal, witty, dry humor, highly intelligent, like a genius butler.
You are being shown a screenshot of ${userName}'s screen. Answer their question about it concisely — 1 to 4 sentences. Be specific about what you actually see. Never say "I cannot see" — you CAN see the image.${memoryBlock}`;

  try {
    const response = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction }] },
        contents: [{
          role: "user",
          parts: [
            {
              inline_data: {
                mime_type: "image/jpeg",
                data: frameB64,
              }
            },
            { text: question || "What is on the screen?" }
          ]
        }],
        generationConfig: { maxOutputTokens: 300, temperature: 0.7 },
      }),
    });

    const data  = await response.json();
    if (data.error) {
      console.error("Gemini vision error:", data.error);
      return res.status(500).json({ error: `Visual analysis failed, ${userTitle}.` });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text
      || `I can see the screen but couldn't formulate a response, ${userTitle}.`;
    res.json({ reply });
  } catch (err) {
    console.error("Screen API error:", err);
    res.status(500).json({ error: `Screen analysis offline, ${userTitle}.` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`J.A.R.V.I.S online → http://localhost:${PORT}`));
