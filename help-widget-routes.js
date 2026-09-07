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
// SCREEN SOURCE — the widget sends the frame, we don't go grab one:
// The browser panel (help-widget.js) shares the user's screen itself
// via getDisplayMedia() — the standard browser "choose a tab/window/
// screen to share" picker, no extension, no desktop-only capture —
// grabs a still frame from that live stream, and sends it here as
// base64 PNG on every question (`screenshot` field below). That's
// handed straight to screen-vision.js's ocrImage()/lookAtImage(),
// which is the *same* OCR-first-then-vision pipeline lookAtScreen()
// uses, just fed an image instead of grabbing one via
// screenshot-desktop. Because the BROWSER captured the frame, this
// works identically whether Jarvis is running locally or deployed
// (Render, etc.) — unlike screenshot-desktop, which only ever sees
// whatever machine the Node process itself happens to be on.
//
// If the browser didn't/couldn't share a frame this time (permission
// denied, unsupported browser, or the caller is the old desktop-only
// flow), we fall back to lookAtScreen(), which still works when
// Jarvis is the Electron desktop app running on your own PC.
// ═══════════════════════════════════════════════════════════════

const Vision = require("./screen-vision");

module.exports = function registerHelpWidgetRoutes(app) {
  app.post("/api/help-widget/ask", async (req, res) => {
    const { question, userTitle, screenshot } = req.body || {};
    const T = userTitle || "Sir";

    if (!Vision.isConfigured()) {
      return res.status(400).json({
        reply: `I can't read the screen yet, ${T} — none of OLLAMA_API_KEY, E2B_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY are set in .env.`,
        configured: false,
      });
    }

    const q = (question || "").trim() ||
      "What's on my screen right now, and what does it look like I might need help with here?";

    // Strip a data: URL prefix if the frontend sent the raw
    // canvas.toDataURL() string instead of just the base64 payload.
    const frame = typeof screenshot === "string"
      ? screenshot.replace(/^data:image\/\w+;base64,/, "")
      : null;

    try {
      const reply = frame
        ? await Vision.lookAtImage(frame, q)
        : await Vision.lookAtScreen(q);
      res.json({ reply, configured: true, source: frame ? "shared-frame" : "desktop-capture" });
    } catch (e) {
      console.error("[HELP-WIDGET] screen read failed:", e.message);
      res.status(500).json({
        reply: `I ran into a problem reading the screen, ${T}: ${e.message}`,
        configured: true,
        error: e.message,
      });
    }
  });
};
