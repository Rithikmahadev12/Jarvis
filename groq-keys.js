"use strict";
// ═══════════════════════════════════════════════════════════════
// Shared Groq API key pool — used by hermes-engine.js, jarvis-agent.js,
// and screen-vision.js so all three fail over the same way instead of
// each reimplementing it slightly differently.
//
// Mirrors the GEMINI_API_KEY(2,3...) pattern already used elsewhere in
// this project (see screen-vision.js). Reads GROQ_API_KEY (required —
// can also be a comma-separated list of keys) plus any GROQ_API_KEY2,
// GROQ_API_KEY3, ... found in .env. Only GROQ_API_KEY is required; add
// more only if you have extra Groq accounts/keys and want Jarvis to
// automatically switch to one when the current key times out, errors,
// or hits its rate limit.
// ═══════════════════════════════════════════════════════════════

function loadGroqKeys() {
  const keys = [];
  const primary = process.env.GROQ_API_KEY || "";
  for (const k of primary.split(",")) {
    const trimmed = k.trim();
    if (trimmed) keys.push(trimmed);
  }
  for (let i = 2; ; i++) {
    const k = process.env[`GROQ_API_KEY${i}`];
    if (!k) break;
    const trimmed = k.trim();
    if (trimmed) keys.push(trimmed);
  }
  return keys;
}

const GROQ_API_KEYS = loadGroqKeys();

// Sticky rotating index — stays on whichever key is "current" across
// calls instead of resetting to key 0 every time, so a key that just
// got rate-limited/timed out stays skipped until it naturally rotates
// back around, rather than getting hit first again on the very next
// request.
let keyIndex = 0;
function currentGroqKey() {
  return GROQ_API_KEYS[keyIndex % GROQ_API_KEYS.length];
}
function rotateGroqKey() {
  keyIndex = (keyIndex + 1) % GROQ_API_KEYS.length;
}
function groqKeyCount() { return GROQ_API_KEYS.length; }
function hasGroqKey() { return GROQ_API_KEYS.length > 0; }

module.exports = { GROQ_API_KEYS, currentGroqKey, rotateGroqKey, groqKeyCount, hasGroqKey };
