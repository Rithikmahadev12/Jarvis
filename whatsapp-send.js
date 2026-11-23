"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Send
//
// Sends messages back to a user through their WhatsApp Agent API key.
// WhatsApp's native Agent API: each user's API key lets you POST to
// their agent chat directly — no Meta Cloud API, no Business API,
// no credit card. Just their key.
//
// Supports:
//   - Text messages
//   - Audio notes (base64 TTS audio → voice note)
//   - Typing indicator simulation (delay before reply)
// ═══════════════════════════════════════════════════════════════

const https = require("https");
const http  = require("http");

const WA_API_BASE = process.env.WA_API_BASE || "https://api.whatsapp.com/v1";

// ── low-level POST ────────────────────────────────────────────────
function postJson(apiKey, endpoint, body) {
  return new Promise((resolve, reject) => {
    const payload  = JSON.stringify(body);
    const url      = new URL(`${WA_API_BASE}${endpoint}`);
    const lib      = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (url.protocol === "https:" ? 443 : 80),
        path:     url.pathname + url.search,
        method:   "POST",
        headers: {
          "Content-Type":  "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode, body: data }); }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// ── simulate typing delay (makes Jarvis feel less robotic) ────────
function typingDelay(text) {
  const words = (text || "").split(/\s+/).length;
  const ms    = Math.min(Math.max(words * 60, 400), 3000);
  return new Promise((r) => setTimeout(r, ms));
}

// ── send text ─────────────────────────────────────────────────────
/**
 * @param {string} apiKey  - user's WhatsApp Agent API key
 * @param {string} text    - message to send
 */
async function sendText(apiKey, text) {
  await typingDelay(text);
  const result = await postJson(apiKey, "/messages", {
    type: "text",
    text: { body: text },
  });
  if (result.status >= 400) {
    throw new Error(`WhatsApp send failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return result;
}

// ── send audio note (voice message) ───────────────────────────────
/**
 * @param {string} apiKey        - user's WhatsApp Agent API key
 * @param {string} audioBase64   - base64-encoded audio (mp3 or ogg)
 * @param {string} [mimeType]    - default "audio/ogg; codecs=opus"
 */
async function sendAudio(apiKey, audioBase64, mimeType = "audio/ogg; codecs=opus") {
  const result = await postJson(apiKey, "/messages", {
    type: "audio",
    audio: {
      data: audioBase64,
      mime_type: mimeType,
    },
  });
  if (result.status >= 400) {
    throw new Error(`WhatsApp audio send failed (${result.status}): ${JSON.stringify(result.body)}`);
  }
  return result;
}

// ── poll for new incoming messages ───────────────────────────────
/**
 * Long-polls the WhatsApp Agent API for new messages.
 * Returns array of message objects (may be empty).
 * @param {string} apiKey
 * @param {number} [offset] - message offset for pagination
 */
async function pollMessages(apiKey, offset = 0) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${WA_API_BASE}/messages?offset=${offset}&limit=20`);
    const lib = url.protocol === "https:" ? https : http;

    const req = lib.request(
      {
        hostname: url.hostname,
        port:     url.port || (url.protocol === "https:" ? 443 : 80),
        path:     url.pathname + url.search,
        method:   "GET",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed.messages || parsed.result || []);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.setTimeout(30000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

module.exports = { sendText, sendAudio, pollMessages };
