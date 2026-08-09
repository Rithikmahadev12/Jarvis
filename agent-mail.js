"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — AgentMail Integration
// Gives Jarvis real, disposable-but-persistent email inboxes it can
// hand out when signing up for things on the user's behalf, plus the
// ability to read whatever lands in them (welcome emails, 6-digit
// OTP codes, "confirm your email" links, etc).
//
// This module is intentionally just the PLUMBING: create an inbox,
// remember it per-service, list/search its messages, pull a
// verification code/link out of the latest one, and (via
// sendMessage) send ordinary transactional email from an inbox
// Jarvis already owns. It does NOT go fill out signup forms on
// websites by itself — pair it with the existing computer/
// UI-automation tools (computer.js, ui-automation.js) if you wire up
// an actual "sign up for X" flow later. And it never creates
// accounts on OTHER services by itself either — see the note in
// helio-store.js for why that stays a manual, one-time human step
// for anything involving money.
//
// Docs: https://www.agentmail.to/docs
// Get a free API key at: https://www.agentmail.to (console → API Keys)
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const API_KEY  = process.env.AGENTMAIL_API_KEY  || "";
const DOMAIN   = process.env.AGENTMAIL_DOMAIN   || ""; // optional — defaults to agentmail.to on their side
const BASE_URL = "https://api.agentmail.to/v0";

const DATA_DIR   = path.join(__dirname, "data");
const STORE_PATH = path.join(DATA_DIR, "agentmail-inboxes.json");

function isConfigured() {
  return !!API_KEY;
}

// ── LOCAL STORE: remember which inbox we used for which service ──
// so "sign up for X" reuses the same address instead of minting a
// new one every time, and so later "check my X verification email"
// knows which inbox to look at.
function loadStore() {
  try {
    if (!fs.existsSync(STORE_PATH)) return {};
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8") || "{}");
  } catch {
    return {};
  }
}
function saveStore(store) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error("[agentmail] failed to save inbox store:", e.message);
  }
}

// ── LOW-LEVEL API HELPER ───────────────────────────────────────
async function api(pathSuffix, { method = "GET", body } = {}) {
  if (!isConfigured()) {
    return { error: "AgentMail isn't configured yet. Add AGENTMAIL_API_KEY to your .env file (get one free at agentmail.to)." };
  }
  try {
    const res = await fetch(`${BASE_URL}${pathSuffix}`, {
      method,
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      return { error: data?.message || data?.error || `AgentMail API returned ${res.status}` };
    }
    return data;
  } catch (e) {
    return { error: `Network error talking to AgentMail: ${e.message}` };
  }
}

// ── CREATE / REUSE AN INBOX FOR A GIVEN LABEL (e.g. a service name) ──
// label examples: "notion-signup", "spotify", "newsletter-github"
async function getOrCreateInbox(label, { forceNew = false, displayName } = {}) {
  const key = String(label || "default").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const store = loadStore();

  if (!forceNew && store[key]?.inbox_id) {
    return { ...store[key], reused: true };
  }

  const body = {};
  if (DOMAIN) body.domain = DOMAIN;
  if (displayName) body.display_name = displayName;
  // Let AgentMail randomly generate the username if we don't have a
  // clean one — avoids collisions across services/users.
  if (key && key !== "default") body.username = `jarvis-${key}`.slice(0, 60);

  const result = await api("/inboxes", { method: "POST", body });
  if (result.error) return result;

  const record = {
    inbox_id: result.inbox_id || result.id,
    email:    result.address || result.email,
    label:    key,
    created:  new Date().toISOString(),
  };
  store[key] = record;
  saveStore(store);
  return { ...record, reused: false };
}

async function listInboxes() {
  return api("/inboxes");
}

// ── MESSAGES ────────────────────────────────────────────────────
async function listMessages(inboxId, { limit = 10 } = {}) {
  if (!inboxId) return { error: "Missing inboxId." };
  return api(`/inboxes/${encodeURIComponent(inboxId)}/messages?limit=${limit}`);
}

async function getMessage(inboxId, messageId) {
  if (!inboxId || !messageId) return { error: "Missing inboxId or messageId." };
  return api(`/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(messageId)}`);
}

async function searchMessages(inboxId, query, { limit = 10 } = {}) {
  if (!inboxId) return { error: "Missing inboxId." };
  const q = encodeURIComponent(query || "");
  return api(`/inboxes/${encodeURIComponent(inboxId)}/messages?query=${q}&limit=${limit}`);
}

// ── VERIFICATION CODE / LINK EXTRACTION ───────────────────────
function extractVerificationCode(text) {
  if (!text) return null;
  // Common patterns: "123456", "code: 123-456", "Your OTP is 4821"
  const codeMatch = text.match(/\b(\d{3}[\s-]?\d{3}|\d{4,8})\b/);
  return codeMatch ? codeMatch[1].replace(/[\s-]/g, "") : null;
}
function extractVerificationLink(text) {
  if (!text) return null;
  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+(?:verify|confirm|activate|token|otp)[^\s"'<>]*/i)
                 || text.match(/https?:\/\/[^\s"'<>]+/i);
  return urlMatch ? urlMatch[0] : null;
}

// ── WAIT FOR A NEW EMAIL TO LAND (e.g. right after triggering a signup) ──
async function waitForMessage(inboxId, { fromContains, subjectContains, timeoutMs = 60000, pollMs = 3000 } = {}) {
  if (!inboxId) return { error: "Missing inboxId." };
  const deadline = Date.now() + timeoutMs;
  let seenIds = new Set();

  // Snapshot what's already there so we only react to NEW mail.
  const initial = await listMessages(inboxId, { limit: 20 });
  if (!initial.error && Array.isArray(initial.messages)) {
    seenIds = new Set(initial.messages.map(m => m.message_id || m.id));
  }

  while (Date.now() < deadline) {
    const list = await listMessages(inboxId, { limit: 20 });
    if (!list.error && Array.isArray(list.messages)) {
      const candidate = list.messages.find(m => {
        const id = m.message_id || m.id;
        if (seenIds.has(id)) return false;
        if (fromContains && !(m.from || "").toLowerCase().includes(fromContains.toLowerCase())) return false;
        if (subjectContains && !(m.subject || "").toLowerCase().includes(subjectContains.toLowerCase())) return false;
        return true;
      });
      if (candidate) {
        const full = await getMessage(inboxId, candidate.message_id || candidate.id);
        if (!full.error) {
          const bodyText = full.extracted_text || full.text || full.html || "";
          return {
            message: full,
            code: extractVerificationCode(bodyText) || extractVerificationCode(full.subject || ""),
            link: extractVerificationLink(bodyText),
          };
        }
      }
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
  return { error: `No matching email arrived within ${Math.round(timeoutMs / 1000)}s.` };
}

// ── SEND A MESSAGE ─────────────────────────────────────────────
// For ordinary transactional email FROM an inbox Jarvis already
// owns — e.g. delivering a purchased digital product after a Helio
// payment (see helio-store.js / store-routes.js). This is a normal
// "send an email" action, not a signup: it doesn't create any new
// account or agree to anything on Jarvis's behalf.
// attachments: [{ filename, content /* base64 */, contentType }]
async function sendMessage(inboxId, { to, subject, text, html, attachments } = {}) {
  if (!inboxId) return { error: "Missing inboxId." };
  if (!to || !subject || (!text && !html)) {
    return { error: "to, subject, and text or html are required." };
  }
  return api(`/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
    method: "POST",
    body: { to, subject, text, html, attachments },
  });
}

// ── HIGH-LEVEL HELPER: "give me an email to sign up for X" ────
async function signupAddressFor(serviceName) {
  const inbox = await getOrCreateInbox(serviceName, { displayName: `Jarvis (${serviceName})` });
  if (inbox.error) return inbox;
  return { email: inbox.email, inbox_id: inbox.inbox_id, reused: !!inbox.reused };
}

// ── HIGH-LEVEL HELPER: "check the X inbox for a verification code" ──
async function checkVerificationFor(serviceName, opts = {}) {
  const store = loadStore();
  const key = String(serviceName || "default").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const record = store[key];
  if (!record?.inbox_id) {
    return { error: `No inbox on file for "${serviceName}" yet — call signupAddressFor first.` };
  }
  return waitForMessage(record.inbox_id, opts);
}

module.exports = {
  isConfigured,
  getOrCreateInbox,
  listInboxes,
  listMessages,
  getMessage,
  searchMessages,
  sendMessage,
  waitForMessage,
  extractVerificationCode,
  extractVerificationLink,
  signupAddressFor,
  checkVerificationFor,
};
