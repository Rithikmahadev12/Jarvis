require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fetch = require("node-fetch");
const path = require("path");

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

const AUTHORIZED_USERS = {
  rithik: "Sir",
  // add more: name: "Sir" or name: "Ma'am"
};

const sessions = {};

// ── favicon (stops 404 noise) ──
app.get("/favicon.ico", (req, res) => res.status(204).end());

// ── AUTH ──
app.post("/api/auth", (req, res) => {
  const { name } = req.body;
  if (!name) return res.json({ authorized: false });
  const normalized = name.toLowerCase().trim();
  const title = AUTHORIZED_USERS[normalized];
  if (title) {
    const displayName = normalized.charAt(0).toUpperCase() + normalized.slice(1);
    res.json({ authorized: true, name: displayName, title });
  } else {
    res.json({ authorized: false });
  }
});

// ── CHAT ──
app.post("/api/chat", async (req, res) => {
  const { message, sessionId, userName, userTitle } = req.body;
  if (!message || !sessionId) return res.status(400).json({ error: "Missing fields" });

  if (!sessions[sessionId]) sessions[sessionId] = [];
  sessions[sessionId].push({ role: "user", parts: [{ text: message }] });
  if (sessions[sessionId].length > 20) sessions[sessionId] = sessions[sessionId].slice(-20);

  const systemInstruction = `You are J.A.R.V.I.S — Just A Rather Very Intelligent System — the AI assistant of ${userName}. You always address them as "${userTitle}".
Your personality:
- Formal, witty, dry humor, highly intelligent
- Like a genius butler — efficient, slightly sardonic, deeply loyal
- Keep responses SHORT — 1 to 3 sentences unless the user asks for detail
- Always address the user as "${userTitle}" somewhere in your reply
- Occasionally make clever observations
- Never break character, never mention being an AI language model`;

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
      return res.status(500).json({ error: `I seem to be experiencing a minor technical difficulty, ${userTitle}.` });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text || `I didn't quite catch that, ${userTitle}.`;
    sessions[sessionId].push({ role: "model", parts: [{ text: reply }] });
    res.json({ reply });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ error: `Connection failure, ${userTitle}. My apologies.` });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`J.A.R.V.I.S online → http://localhost:${PORT}`));
