"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Send  (corrected: real Agent API v1)
//
// Real base URL : https://api.whatsapp.com/agent/v1
// Real auth     : Authorization: Bearer <api_key>
// Send          : POST /messages
//                 { messaging_product:"whatsapp", to:"user:<id>",
//                   type:"text", text:{ body:"..." } }
// Poll          : GET  /updates?offset=N&limit=50&timeout=25
//                 → 200 { messages:[...], next_offset:N }
//                 → 204 (timeout, nothing — re-poll same offset)
// Typing/Read   : POST /statuses { messaging_product, status, message_id }
//
// Rate limits (rolling 60s per key):
//   messages:12  updates:15  statuses:12
// ═══════════════════════════════════════════════════════════════

const https = require("https");

const BASE_HOST = "api.whatsapp.com";
const BASE_PATH = "/agent/v1";

// ── low-level HTTP ────────────────────────────────────────────────
function apiRequest(apiKey, method, endpoint, body = null, queryParams = {}) {
  return new Promise((resolve, reject) => {
    const qStr = Object.entries(queryParams)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    const fullPath = `${BASE_PATH}${endpoint}${qStr ? "?" + qStr : ""}`;
    const payload  = body ? JSON.stringify(body) : null;

    const opts = {
      hostname: BASE_HOST,
      path:     fullPath,
      method,
      headers:  {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type":  "application/json",
      },
      // Long-poll GET /updates holds up to `timeout` seconds server-side
      timeout: method === "GET" ? 40_000 : 30_000,
    };
    if (payload) opts.headers["Content-Length"] = Buffer.byteLength(payload);

    const req = https.request(opts, (res) => {
      // 204 = long-poll timed out, nothing arrived — not an error
      if (res.statusCode === 204) return resolve({ status: 204, body: null });
      let raw = "";
      res.on("data", c => (raw += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    // Socket timeout on a long-poll isn't an error — treat as 204
    req.on("timeout", () => { req.destroy(); resolve({ status: 204, body: null }); });
    req.on("error",   (e) => reject(e));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── normalise recipient to user:<id> ─────────────────────────────
function toUserId(raw) {
  if (!raw) return null;
  return raw.startsWith("user:") ? raw : `user:${raw}`;
}

// ── simulate typing delay (makes Jarvis feel less robotic) ────────
function typingDelay(text) {
  const words = (text || "").split(/\s+/).length;
  const ms    = Math.min(Math.max(words * 60, 400), 3000);
  return new Promise(r => setTimeout(r, ms));
}

// ── typing indicator + read receipt ──────────────────────────────
async function sendTypingIndicator(apiKey, messageId) {
  if (!messageId) return;
  try {
    // Mark read first
    await apiRequest(apiKey, "POST", "/statuses", {
      messaging_product: "whatsapp",
      status:            "read",
      message_id:        messageId,
    });
    // Then typing
    await apiRequest(apiKey, "POST", "/statuses", {
      messaging_product: "whatsapp",
      status:            "typing",
      message_id:        messageId,
    });
  } catch { /* non-fatal */ }
}

// ── send text ─────────────────────────────────────────────────────
/**
 * @param {string} apiKey        - user's WhatsApp Agent API key
 * @param {string} text          - message body (max 4096 chars)
 * @param {string} [to]          - recipient user:<id>; omit to use WHATSAPP_USER_ID
 * @param {string} [replyToId]   - message_id to thread the reply onto
 */
async function sendText(apiKey, text, to = null, replyToId = null) {
  await typingDelay(text);

  const recipient = toUserId(to || process.env.WHATSAPP_USER_ID);
  const body      = (text || "").length > 4096 ? text.slice(0, 4093) + "…" : text;

  const payload = {
    messaging_product: "whatsapp",
    type: "text",
    text: { body },
  };
  if (recipient)  payload.to = recipient;
  if (replyToId)  payload.context = { message_id: replyToId };

  const res = await apiRequest(apiKey, "POST", "/messages", payload);
  if (res.status >= 400) {
    throw new Error(`WA send failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

// ── send audio voice note ─────────────────────────────────────────
/**
 * @param {string} apiKey       - user's WhatsApp Agent API key
 * @param {string} audioBase64  - base64-encoded audio (ogg/opus or mp3)
 * @param {string} [mimeType]
 * @param {string} [to]         - recipient user:<id>
 */
async function sendAudio(apiKey, audioBase64, mimeType = "audio/ogg; codecs=opus", to = null) {
  const recipient = toUserId(to || process.env.WHATSAPP_USER_ID);
  const payload   = {
    messaging_product: "whatsapp",
    type: "audio",
    audio: { data: audioBase64, mime_type: mimeType },
  };
  if (recipient) payload.to = recipient;

  const res = await apiRequest(apiKey, "POST", "/messages", payload);
  if (res.status >= 400) {
    throw new Error(`WA audio send failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

// ── poll for new incoming messages ────────────────────────────────
/**
 * One long-poll. Returns array of messages (may be empty on 204).
 * Caller MUST pass the SAME offset back on a 204 — do NOT advance.
 *
 * @param {string}      apiKey
 * @param {number}      offset   - 0 on first call; use next_offset from response after that
 * @param {number}      [limit]
 * @param {number}      [timeout] - server hold-time, max 25s per manual
 * @returns {Promise<{ messages: object[], nextOffset: number }>}
 */
let _shapeLogs = 0;

// The Agent API returns webhook-style payloads:
//   { object, entry: [ { changes: [ { field:"messages",
//       value: { messages:[ {from,id,type,text:{body}} ], statuses:[] } } ] } ],
//     next_offset }
// (confirmed from real logs). Older/simpler shapes are still accepted.
function extractMessages(data) {
  if (!data || typeof data !== "object") return [];
  const out = [];

  for (const entry of (Array.isArray(data.entry) ? data.entry : [])) {
    for (const change of (Array.isArray(entry?.changes) ? entry.changes : [])) {
      const msgs = change?.value?.messages;
      if (Array.isArray(msgs)) out.push(...msgs);
    }
  }
  if (out.length) return out;

  // fallbacks: first key that actually has items (an empty [] is truthy in JS)
  for (const k of ["messages", "updates", "events", "data", "results"]) {
    if (Array.isArray(data[k]) && data[k].length) {
      return data[k].map(m => (m && m.message && typeof m.message === "object") ? { ...m, ...m.message } : m);
    }
  }
  return [];
}

async function pollMessages(apiKey, offset = 0, limit = 50, timeout = 25) {
  // Offset 0 on first call means "omit offset" to get only NEW messages per the manual.
  const params = { limit, timeout };
  if (offset > 0) params.offset = offset;

  const res = await apiRequest(apiKey, "GET", "/updates", null, params);

  // 204 = nothing arrived, re-poll with same offset
  if (res.status === 204 || !res.body) {
    return { messages: [], nextOffset: offset };
  }
  if (res.status >= 400) {
    throw new Error(`WA poll failed (${res.status}): ${JSON.stringify(res.body)}`);
  }

  const data       = res.body;
  const nextOffset = data?.next_offset ?? data?.nextOffset ?? offset;

  // `a || b` treats an EMPTY array as a value, so a response like
  // { messages: [], updates: [ ...real data... ] } used to yield zero
  // messages. Take the first key that actually has items.
  const messages = extractMessages(data);

  // Diagnostics: if the server advanced the offset but we parsed nothing,
  // or the first few payloads we ever see, log the raw shape (truncated).
  if ((nextOffset !== offset && !messages.length) || _shapeLogs < 3) {
    if (_shapeLogs < 8) {
      _shapeLogs++;
      let preview = "";
      try { preview = JSON.stringify(data).slice(0, 700); } catch { preview = String(data).slice(0, 700); }
      console.log(`[WA-SEND] /updates payload (status ${res.status}, offset ${offset} -> ${nextOffset}, parsed ${messages.length}): ${preview}`);
    }
  }

  return { messages, nextOffset };
}

module.exports = { sendText, sendAudio, pollMessages, sendTypingIndicator, extractMessages };
