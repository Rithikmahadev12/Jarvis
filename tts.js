"use strict";

const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL || "http://localhost:5050";

let _ready = false;

async function checkReady() {
  try {
    const res = await fetch(`${VOICE_SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    _ready = !!data.ready;
  } catch {
    _ready = false;
  }
  return _ready;
}

// Poll on startup so isReady() is accurate without blocking
checkReady();
setInterval(checkReady, 10000);

function isReady() {
  return _ready;
}

function cleanText(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g,   "$1")
    .replace(/[`#*_~]/g,     "")
    .replace(/→|⬡|●|◈|▲|◌|◯|⚡|🎙|📱|💻|🖥|📺|🖨|📡|🎮|🔊|📹|💾|🔌|💡/g, "")
    .replace(/\s+/g,         " ")
    .trim()
    .slice(0, 500);
}

async function synthesize(text) {
  const clean = cleanText(text);
  if (!clean || clean.length < 2) return null;

  try {
    const res = await fetch(`${VOICE_SERVER_URL}/synthesize`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text: clean }),
      signal:  AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      console.error(`[TTS] Voice server returned ${res.status}`);
      return null;
    }
    const buf = await res.arrayBuffer();
    return Buffer.from(buf);
  } catch (e) {
    console.error("[TTS] Voice server error:", e.message);
    return null;
  }
}

module.exports = { synthesize, isReady, cleanText };
