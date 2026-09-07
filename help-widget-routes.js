"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Help Widget (backend)
//
// Backs the small floating "Sir, tell me what you need help with"
// panel (public/help-widget.js). Deliberately does NOT duplicate any
// screen-reading logic — it's a thin wrapper around the exact same
// screen-vision.js pipeline every other "look at my screen" feature
// in this repo already uses:
//
//   OCR (free, local) -> text answered via Gemini/Groq
//   -------- falls back to --------
//   Vision model, tried in this order:
//     1. Ollama Cloud            (OLLAMA_API_KEY)
//     2. Self-hosted Ollama running inside Jarvis's own E2B desktop
//        sandbox (E2B_API_KEY)  <-- this is the "Ollama on its own
//                                    computer" piece
//     3. Gemini (GEMINI_API_KEY)
//     4. Groq (GROQ_API_KEY)
//
// IMPORTANT — screenshot-desktop (used by screen-vision.js) captures
// whatever machine THIS NODE PROCESS is running on. That means:
//   - Running as the Electron desktop app on your own PC -> it reads
//     YOUR actual screen. This is the mode this widget is built for.
//   - Running as the plain Render web deployment -> it would be
//     reading Render's headless container, not your screen, and will
//     fail/return nothing useful. Run the desktop app for this
//     feature to do anything.
// ═══════════════════════════════════════════════════════════════

const Vision = require("./screen-vision");

module.exports = function registerHelpWidgetRoutes(app) {
  app.post("/api/help-widget/ask", async (req, res) => {
    const { question, userTitle } = req.body || {};
    const T = userTitle || "Sir";

    if (!Vision.isConfigured()) {
      return res.status(400).json({
        reply: `I can't read the screen yet, ${T} — none of OLLAMA_API_KEY, E2B_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY are set in .env.`,
        configured: false,
      });
    }

    const q = (question || "").trim() ||
      "What's on my screen right now, and what does it look like I might need help with here?";

    try {
      const reply = await Vision.lookAtScreen(q);
      res.json({ reply, configured: true });
    } catch (e) {
      console.error("[HELP-WIDGET] lookAtScreen failed:", e.message);
      res.status(500).json({
        reply: `I ran into a problem reading the screen, ${T}: ${e.message}`,
        configured: true,
        error: e.message,
      });
    }
  });
};
