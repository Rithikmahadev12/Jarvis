"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Setup Flow
//
// Handles the FIRST-EVER message on the owner's WhatsApp API key.
// Flow:
//   1. Jarvis asks: "What's your name?"
//   2. Owner replies with their name
//   3. Jarvis checks if that name matches config.json owner.username
//   4. If yes → registers as owner, greets: "Welcome back, [name] (Owner)"
//   5. Never asks again — flag stored in whatsapp-accounts.json
//
// For non-owner first contact (users already registered by owner):
//   - Jarvis greets: "Welcome back, [name]" and dives straight in
//
// For unknown users (not registered):
//   - Jarvis replies: "You're not set up yet. Contact the owner."
// ═══════════════════════════════════════════════════════════════

const fs      = require("fs");
const path    = require("path");
const Manager = require("./whatsapp-manager");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

// Pending name-collection: apiKey -> true (waiting for name input)
const awaitingName = new Map();

/**
 * Called from the poller BEFORE the AI processes any message.
 * Returns:
 *   { handled: true, reply: "..." }   — setup step handled, send this reply
 *   { handled: false }                — not in setup flow, process normally
 *   { handled: true, reply: "...", account: {...} } — setup complete, account ready
 */
async function handleSetupFlow(apiKey, text) {
  // ── is this a known owner key? ────────────────────────────────
  const existingAccount = Manager.getAccountByApiKey(apiKey);

  // Already registered and onboarded — no setup needed
  if (existingAccount && !awaitingName.has(apiKey)) {
    return { handled: false };
  }

  const config = loadConfig();
  const ownerName = (config.owner?.username || "").toLowerCase().trim();

  // ── step 1: first-ever message on a key we don't know ────────
  // This key is not registered yet — it MUST be the owner setting up
  if (!existingAccount && !awaitingName.has(apiKey)) {
    awaitingName.set(apiKey, true);
    return {
      handled: true,
      reply: "Hey — I'm Jarvis. What's your name?",
    };
  }

  // ── step 2: they replied with their name ─────────────────────
  if (awaitingName.has(apiKey)) {
    awaitingName.delete(apiKey);
    const inputName = (text || "").trim();
    const inputKey  = inputName.toLowerCase().replace(/\s+/g, "_");

    if (!inputName) {
      awaitingName.set(apiKey, true); // ask again
      return {
        handled: true,
        reply: "Didn't catch that — what's your name?",
      };
    }

    // Check if this is the owner
    if (inputKey === ownerName || inputName.toLowerCase() === ownerName) {
      const { created } = Manager.registerAccount({
        name:          config.owner.username,
        whatsappApiKey: apiKey,
        role:          "owner",
      });

      // Start polling immediately for owner
      try {
        const Poller = require("./whatsapp-poller");
        Poller.onAccountAdded(Manager.toKey(config.owner.username));
      } catch { /* poller may not be started yet */ }

      return {
        handled:  true,
        reply:    `Welcome back, *${config.owner.username}* (Owner). 👋\n\nYour WhatsApp is now linked to Jarvis. Text me anything — I'm your personal AI.\n\nTo add users: "Jarvis add user [name], api key: [key]"`,
        account:  Manager.getAccount(config.owner.username),
      };
    }

    // Not the owner name — unknown person trying to access
    return {
      handled: true,
      reply:   `Sorry, I don't have an account for "${inputName}". Contact the owner to get set up.`,
    };
  }

  return { handled: false };
}

/**
 * First-contact handler for already-registered non-owner users.
 * Returns welcome message on first contact, null otherwise.
 */
function getWelcomeIfNew(account) {
  // We track whether they've been welcomed via lastActiveAt
  if (!account.lastActiveAt) {
    return `Welcome, *${account.name}*! 👋 I'm Jarvis — your personal AI. I'm here 24/7. What do you need?`;
  }
  return null;
}

module.exports = { handleSetupFlow, getWelcomeIfNew };
