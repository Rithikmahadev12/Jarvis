"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Poller  (v3 — 409/429 proof)
//
// Root cause of the 409/429 storm:
//   - Flat 5s retry on ALL errors meant 409 (duplicate session) and
//     429 (rate limit) were hammered at the same rate as network blips.
//   - No per-account request lock → concurrent polls on same key → 409.
//   - Render deploy spawns a fresh process BEFORE killing the old one,
//     so both pollers hit /updates simultaneously → instant 409 war.
//
// Fixes applied:
//   - Per-account IN-FLIGHT LOCK: only one GET /updates outstanding at
//     a time per key. Zero concurrent requests = zero 409 from us.
//   - 409 → 30s cooldown (let the old process fully die on Render).
//   - 429 → 60s cooldown (rate-limit window reset).
//   - Other errors → exponential backoff: 5s → 10s → 20s … cap 60s.
//   - On 204 (empty long-poll) or 200 → re-poll immediately (server
//     already held the socket 25s, no extra sleep needed).
//   - Crash auto-restart bumped to 30s (was 15s) to give Render time
//     to drain the old connection before the new one opens.
// ═══════════════════════════════════════════════════════════════

const Manager    = require("./whatsapp-manager");
const Sender     = require("./whatsapp-send");
const SetupFlow  = require("./whatsapp-setup-flow");
const EarnReport = require("./whatsapp-earn-reporter");

// ── lazy-load heavy modules (avoid circular requires at boot) ─────
let _Groq = null;
function getGroq() {
  if (!_Groq) _Groq = require("./hermes-engine");
  return _Groq;
}

let _WalletSetup = null;
function getWalletSetup() {
  if (!_WalletSetup) _WalletSetup = require("./wallet-setup");
  return _WalletSetup;
}

let _SolanaWallet = null;
function getSolanaWallet() {
  if (!_SolanaWallet) _SolanaWallet = require("./solana-wallet");
  return _SolanaWallet;
}

let _EarnBrain = null;
function getEarnBrain() {
  if (!_EarnBrain) _EarnBrain = require("./earn-brain");
  return _EarnBrain;
}

// ── per-user conversation sessions ───────────────────────────────
const sessions = new Map(); // userKey -> { history: [], pendingFaceFor: null }

function getSession(userKey) {
  if (!sessions.has(userKey)) {
    sessions.set(userKey, { history: [], pendingFaceFor: null });
  }
  return sessions.get(userKey);
}

function pushHistory(userKey, role, content) {
  const sess = getSession(userKey);
  sess.history.push({ role, content });
  if (sess.history.length > 20) sess.history.splice(0, sess.history.length - 20);
}

// ── sleep ─────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── owner command parser ──────────────────────────────────────────
const ADD_USER_RE    = /(?:add|set up|create|register)\s+(?:user\s+|account\s+(?:called\s+)?)?(.+?),?\s+(?:api\s*key|key)\s*[:=\s]+([A-Za-z0-9\-_\.]+)/i;
const REMOVE_USER_RE = /(?:remove|delete|kick)\s+(?:user\s+)?(.+)/i;
const LIST_USERS_RE  = /list\s+(?:all\s+)?users?/i;
const ADD_FACE_RE    = /add\s+face\s+(?:for\s+)?(.+)/i;

async function handleOwnerCommand(text, account, photoBase64 = null) {
  const sess = getSession(account.userKey);

  // ── pending face registration ─────────────────────────────────
  if (sess.pendingFaceFor && photoBase64) {
    const targetName = sess.pendingFaceFor;
    sess.pendingFaceFor = null;
    const target = Manager.getAccount(targetName);
    if (!target) return `No account found for "${targetName}".`;
    Manager.setFaceImage(target.userKey, photoBase64);
    return `Face image updated for ${target.name}. ✅ They can now log in with face ID on the site.`;
  }

  // ── add user ──────────────────────────────────────────────────
  const addMatch = text && text.match(ADD_USER_RE);
  if (addMatch) {
    const name    = addMatch[1].trim();
    const apiKey  = addMatch[2].trim();
    const faceImg = photoBase64 || null;

    const { created } = Manager.registerAccount({
      name,
      whatsappApiKey:  apiKey,
      faceImageBase64: faceImg,
      role:            "user",
    });

    // Provision Solana wallet
    let walletMsg = "";
    try {
      const ws  = getWalletSetup();
      const res = await ws.ensureUserWallet(Manager.toKey(name));
      if (res && res.address) {
        Manager.setWalletAddress(Manager.toKey(name), res.address);
        try { getSolanaWallet().setWalletForUser(Manager.toKey(name), res.address); } catch {}
        walletMsg = `\n💰 Solana wallet ready: \`${res.address}\``;
      } else if (res && res.error) {
        walletMsg = `\n⚠️ Wallet: ${res.error}`;
      }
    } catch (e) {
      walletMsg = `\n⚠️ Wallet setup: ${e.message}`;
    }

    // Kick earn brain
    try { getEarnBrain().startScheduler(); } catch {}

    // Start polling their account immediately
    const newAccount = Manager.getAccount(Manager.toKey(name));
    if (newAccount) startPollingForAccount(newAccount);

    const faceMsg = faceImg
      ? "\n🪪 Face image saved for site login."
      : `\nNo face photo — send one with: "Jarvis add face for ${name}"`;

    return `✅ ${created ? "Created" : "Updated"} account for *${name}*${walletMsg}${faceMsg}\n\nAll Jarvis features and earn strategies are now active for them.`;
  }

  // ── remove user ───────────────────────────────────────────────
  const removeMatch = text && text.match(REMOVE_USER_RE);
  if (removeMatch) {
    const name    = removeMatch[1].trim();
    const removed = Manager.removeAccount(name);
    if (removed) onAccountRemoved(Manager.toKey(name));
    return removed
      ? `✅ Account for "${name}" removed.`
      : `No account found for "${name}".`;
  }

  // ── list users ────────────────────────────────────────────────
  if (text && LIST_USERS_RE.test(text)) {
    const all = Manager.getAllAccounts().filter(a => a.role !== "owner");
    if (!all.length) return "No users registered yet.";
    const lines = all.map(a =>
      `• *${a.name}* — wallet: ${a.walletAddress ? a.walletAddress.slice(0, 8) + "…" : "none"} — earn: ${a.earnEnabled ? "✅" : "❌"} — active: ${a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleDateString() : "never"}`
    );
    return `*Users (${all.length}):*\n${lines.join("\n")}`;
  }

  // ── add face for X ────────────────────────────────────────────
  const faceMatch = text && text.match(ADD_FACE_RE);
  if (faceMatch) {
    const targetName = faceMatch[1].trim();
    const target = Manager.getAccount(targetName);
    if (!target) return `No account found for "${targetName}". Add them first.`;
    if (photoBase64) {
      Manager.setFaceImage(target.userKey, photoBase64);
      return `Face image updated for ${target.name}. ✅`;
    }
    sess.pendingFaceFor = targetName;
    return `Send the photo for ${targetName} in your next message.`;
  }

  return null; // not an owner command — fall through to AI
}

// ── build Jarvis tool executor for WhatsApp context ───────────────
function buildExecuteTool(account) {
  return async (name, args) => {
    console.log(`[WA-TOOL] ${account.userKey} → ${name}`, args);
    if (args && typeof args === "object") args._userKey = account.userKey;
    return null;
  };
}

// ── process one incoming message ─────────────────────────────────
async function processMessage(apiKey, account, text, photoBase64 = null, incomingMsgId = null) {
  const { userKey, name, role } = account;
  Manager.touchActive(userKey);

  // ── earn reply intercept ──────────────────────────────────────
  if (text) {
    const earnReply = await EarnReport.processEarnReply(account, text);
    if (earnReply) return earnReply;

    if (role === "owner") {
      const ownerApproval = await EarnReport.processOwnerEarnApproval(account, text);
      if (ownerApproval) return ownerApproval;
    }
  }

  // ── owner commands ────────────────────────────────────────────
  if (role === "owner" && text) {
    const cmd = await handleOwnerCommand(text, account, photoBase64);
    if (cmd) return cmd;
  }

  // ── full AI brain ─────────────────────────────────────────────
  const Groq = getGroq();
  if (!Groq.isConfigured()) {
    return "Groq isn't configured — check GROQ_API_KEY in .env.";
  }

  const sess        = getSession(userKey);
  const userContent = photoBase64
    ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } },
        { type: "text", text: text || "What is this?" },
      ]
    : (text || "");

  pushHistory(userKey, "user", userContent);

  // Show typing indicator while thinking
  if (incomingMsgId) {
    await Sender.sendTypingIndicator(apiKey, incomingMsgId).catch(() => {});
  }

  let reply;
  try {
    const result = await Groq.chatWithTools({
      message:             text || "describe this image",
      userTitle:           name,
      memories:            [],
      context:             role === "owner" ? "(Owner account — full access)" : "",
      conversationHistory: sess.history.slice(0, -1),
      executeTool:         buildExecuteTool(account),
      tz:                  "America/New_York",
    });
    reply = result?.reply || "…";
  } catch (e) {
    reply = `Sorry, hit an error: ${e.message}`;
  }

  pushHistory(userKey, "assistant", reply);
  return reply;
}

// ── poll loop — ONE request in-flight per account at all times ────
const activeLoops = new Map(); // userKey -> true (loop running)
const pollLocks   = new Map(); // userKey -> true (request in-flight)

async function pollLoop(account) {
  const { userKey, whatsappApiKey } = account;
  // null = "new only" on first call (omits offset per the manual)
  let offset        = null;
  let errorCount    = 0;
  let dupCount      = 0;  // separate counter for 409s — exponential backoff independent of other errors

  while (activeLoops.get(userKey)) {

    // ── LOCK GUARD: skip turn if a request is already in-flight ──
    // This is the primary defense against 409. Only one outstanding
    // GET /updates per key at any time, period.
    if (pollLocks.get(userKey)) {
      await sleep(500);
      continue;
    }

    pollLocks.set(userKey, true);
    let waitAfter = 0; // extra sleep AFTER this poll (default 0 — server already held 25s)

    try {
      const result = await Sender.pollMessages(whatsappApiKey, offset ?? 0, 50, 25);

      // ✅ Success — reset all error/backoff state
      errorCount = 0;
      dupCount   = 0;

      if (result && result.nextOffset !== undefined && result.nextOffset !== null) {
        offset = result.nextOffset;
      }

      for (const msg of (result?.messages ?? [])) {
        // Skip own replies / status updates / outbound messages
        if (msg.fromAgent || msg.from_me || msg.isBot) continue;

        const text        = msg.text?.body || msg.message || msg.content || msg.text || "";
        const photoBase64 = msg.image?.data || msg.media?.data || msg.photo?.data || null;
        const msgId       = msg.id || msg.message_id || null;

        if (!text && !photoBase64) continue;

        // Reload account fresh each message (may have been updated mid-loop)
        const freshAccount = Manager.getAccount(userKey);
        if (!freshAccount) break; // account was removed

        // ── setup flow: first-ever message on owner's key ────────
        const setup = await SetupFlow.handleSetupFlow(whatsappApiKey, text);
        if (setup.handled) {
          if (setup.reply) {
            await Sender.sendText(whatsappApiKey, setup.reply).catch(() => {});
            if (setup.account) activeLoops.set(setup.account.userKey, true);
          }
          continue;
        }

        // ── welcome message on first contact ─────────────────────
        const welcome = SetupFlow.getWelcomeIfNew(freshAccount);
        if (welcome) {
          await Sender.sendText(whatsappApiKey, welcome).catch(() => {});
          Manager.touchActive(userKey);
        }

        try {
          const reply = await processMessage(whatsappApiKey, freshAccount, text || null, photoBase64, msgId);
          if (reply) await Sender.sendText(whatsappApiKey, reply);
        } catch (e) {
          console.error(`[WA-POLLER] Message error for ${userKey}:`, e.message);
          await Sender.sendText(whatsappApiKey, "I hit an error — give me a moment and try again.").catch(() => {});
        }
      }

      // 204 or empty → re-poll immediately (server held connection 25s already)
      waitAfter = 0;

    } catch (err) {
      errorCount++;
      const msg   = String(err?.message || "");
      const is409 = msg.includes("409") || msg.includes("1752041") || msg.toLowerCase().includes("duplicate");
      const is429 = msg.includes("429") || msg.includes("130429")  || msg.toLowerCase().includes("exceeded");

      if (is409) {
        // Another session is active on this key (old Render deploy lingering).
        // WhatsApp holds sessions open well past 30s — use exponential backoff:
        // 30s → 60s → 120s → 240s → 300s cap.
        // Once we successfully poll, dupCount resets to 0.
        dupCount++;
        waitAfter = Math.min(30_000 * Math.pow(2, dupCount - 1), 300_000);
        console.warn(`[WA-POLLER] 409 on ${userKey} (attempt ${dupCount}) — waiting ${waitAfter / 1000}s for old session to die`);
      } else if (is429) {
        // Rate limited — back off a full 60s to let the window reset.
        waitAfter  = 60_000;
        errorCount = 0;
        console.warn(`[WA-POLLER] 429 on ${userKey} — waiting 60s`);
      } else {
        // Unknown error — exponential backoff capped at 60s.
        // 5s → 10s → 20s → 40s → 60s → 60s …
        waitAfter = Math.min(5_000 * Math.pow(2, errorCount - 1), 60_000);
        console.warn(`[WA-POLLER] Poll error #${errorCount} for ${userKey}: ${msg} — waiting ${waitAfter / 1000}s`);
      }
    } finally {
      // Always release the lock before sleeping so the loop can check
      // activeLoops and bail out cleanly if stopPollingForAccount was called.
      pollLocks.delete(userKey);
    }

    if (waitAfter > 0) await sleep(waitAfter);
  }

  console.log(`[WA-POLLER] Loop ended for ${userKey}`);
}

// ── start / stop ──────────────────────────────────────────────────
function startPollingForAccount(account) {
  const { userKey } = account;
  if (activeLoops.get(userKey)) return; // already running
  if (!account.whatsappApiKey) {
    console.warn(`[WA-POLLER] ${userKey} has no API key — skipping.`);
    return;
  }
  activeLoops.set(userKey, true);
  console.log(`[WA-POLLER] ▶ Started polling for ${account.name} (${userKey})`);
  pollLoop(account).catch(e => {
    activeLoops.delete(userKey);
    console.error(`[WA-POLLER] Loop crashed for ${userKey}:`, e.message);
    // 30s before restart — gives Render time to fully drain old connections
    setTimeout(() => {
      const refreshed = Manager.getAccount(userKey);
      if (refreshed) startPollingForAccount(refreshed);
    }, 30_000);
  });
}

function stopPollingForAccount(userKey) {
  activeLoops.delete(userKey);
}

function startAll() {
  const accounts = Manager.getAllAccounts();
  if (!accounts.length) {
    console.log("[WA-POLLER] No WhatsApp accounts registered yet. Waiting for owner first-message setup.");
    return;
  }
  for (const account of accounts) {
    startPollingForAccount(account);
  }
}

function onAccountAdded(userKey) {
  const account = Manager.getAccount(userKey);
  if (account) startPollingForAccount(account);
}

function onAccountRemoved(userKey) {
  stopPollingForAccount(userKey);
}

module.exports = {
  startAll,
  onAccountAdded,
  onAccountRemoved,
  startPollingForAccount,
  stopPollingForAccount,
};
