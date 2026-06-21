"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Custom Voice Clone TTS (XTTS-v2 server)
// ═══════════════════════════════════════════════════════════════

const VOICE_SERVER_URL = process.env.VOICE_SERVER_URL || "http://localhost:5050";

let _ready = false;

async function checkReady() {
  try {
    const res = await fetch(`${VOICE_SERVER_URL}/health`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return false;
    const data = await res.json();
    _ready = !!data.ready;
    return _ready;
  } catch {
    _ready = false;
    return false;
  }
}

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
    console.error("[TTS] Voice server request failed:", e.message);
    return null;
  }
}

// Poll readiness on boot, then periodically until it's up
checkReady();
const _pollInterval = setInterval(async () => {
  if (await checkReady()) clearInterval(_pollInterval);
}, 5000);

module.exports = { synthesize, isReady, cleanText };
