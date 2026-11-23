"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Poller  (v4 — boot delay + 409 proof)
//
// Root cause of the persistent 409 on first poll:
//   Render deploys by spawning the NEW process BEFORE killing the OLD one.
//   The gap between new process start and old process death is typically
//   15-45 seconds. The previous version had a 30s 409 backoff but it only
//   kicked in AFTER the first failed poll — meaning we still hammered the
//   endpoint immediately on boot while the old session was live.
//
// Fix:
//   BOOT_DELAY_MS (35s) — poller waits before firing its very first
//   GET /updates request. By then the old Render process is dead and
//   its session released. No 409 storm, clean first poll.
//
//   409 backoff is kept as a safety net: 30s → 60s → 120s → 240s → 300s
//   cap in case WhatsApp's server holds the session longer than expected.
//
//   dupCount resets on first successful poll.
// ═══════════════════════════════════════════════════════════════

const Manager    = require("./whatsapp-manager");
const Sender     = require("./whatsapp-send");
const SetupFlow  = require("./whatsapp-setup-flow");
const EarnReport = require("./whatsapp-earn-reporter");

// ── lazy-load heavy modules ───────────────────────────────────────
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

// ── config ────────────────────────────────────────────────────────
// How long to wait after boot before firing the FIRST poll request.
// Render's old process is guaranteed dead within 30s of a new deploy —
// we give 35s to be safe. Applies per-account, once per process lifetime.
const BOOT_DELAY_MS  = 35_000;

// When was this process born?
const PROCESS_START  = Date.now();

// Has this process already waited out its boot delay?
// We track it globally — if multiple accounts boot at the same time,
// they all share the same 35s window, not 35s each.
let _bootDelayDone   = false;

// ── sleep ─────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── per-user conversation sessions ───────────────────────────────
const sessions = new Map();

function getSession(userKey) {
  if (!sessions.has(userKey)) sessions.set(userKey, { history: [], pendingFaceFor: null });
  return sessions.get(userKey);
}

function pushHistory(userKey, role, content) {
  const sess = getSession(userKey);
  sess.history.push({ role, content });
  if (sess.history.length > 20) sess.history.splice(0, sess.history.length - 20);
}

// ── owner command parser ──────────────────────────────────────────
const ADD_USER_RE    = /(?:add|set up|create|register)\s+(?:user\s+|account\s+(?:called\s+)?)?(.+?),?\s+(?:api\s*key|key)\s*[:=\s]+([A-Za-z0-9\-_\.]+)/i;
const REMOVE_USER_RE = /(?:remove|delete|kick)\s+(?:user\s+)?(.+)/i;
const LIST_USERS_RE  = /list\s+(?:all\s+)?users?/i;
const ADD_FACE_RE    = /add\s+face\s+(?:for\s+)?(.+)/i;

async function handleOwnerCommand(text, account, photoBase64 = null) {
  const sess = getSession(account.userKey);

  if (sess.pendingFaceFor && photoBase64) {
    const targetName = sess.pendingFaceFor;
    sess.pendingFaceFor = null;
    const target = Manager.getAccount(targetName);
    if (!target) return `No account found for "${targetName}".`;
    Manager.setFaceImage(target.userKey, photoBase64);
    return `Face image updated for ${target.name}. ✅ They can now log in with face ID on the site.`;
  }

  const addMatch = text && text.match(ADD_USER_RE);
  if (addMatch) {
    const name    = addMatch[1].trim();
    const apiKey  = addMatch[2].trim();
    const faceImg = photoBase64 || null;

    const { created } = Manager.registerAccount({
      name, whatsappApiKey: apiKey, faceImageBase64: faceImg, role: "user",
    });

    let walletMsg = "";
    try {
      const ws  = getWalletSetup();
      const res = await ws.ensureUserWallet(Manager.toKey(name));
      if (res?.address) {
        Manager.setWalletAddress(Manager.toKey(name), res.address);
        try { getSolanaWallet().setWalletForUser(Manager.toKey(name), res.address); } catch {}
        walletMsg = `\n💰 Solana wallet ready: \`${res.address}\``;
      } else if (res?.error) {
        walletMsg = `\n⚠️ Wallet: ${res.error}`;
      }
    } catch (e) {
      walletMsg = `\n⚠️ Wallet setup: ${e.message}`;
    }

    try { getEarnBrain().startScheduler(); } catch {}

    const newAccount = Manager.getAccount(Manager.toKey(name));
    if (newAccount) startPollingForAccount(newAccount);

    const faceMsg = faceImg
      ? "\n🪪 Face image saved for site login."
      : `\nNo face photo — send one with: "Jarvis add face for ${name}"`;

    return `✅ ${created ? "Created" : "Updated"} account for *${name}*${walletMsg}${faceMsg}\n\nAll Jarvis features and earn strategies are now active for them.`;
  }

  const removeMatch = text && text.match(REMOVE_USER_RE);
  if (removeMatch) {
    const name    = removeMatch[1].trim();
    const removed = Manager.removeAccount(name);
    if (removed) onAccountRemoved(Manager.toKey(name));
    return removed
      ? `✅ Account for "${name}" removed.`
      : `No account found for "${name}".`;
  }

  if (text && LIST_USERS_RE.test(text)) {
    const all = Manager.getAllAccounts().filter(a => a.role !== "owner");
    if (!all.length) return "No users registered yet.";
    const lines = all.map(a =>
      `• *${a.name}* — wallet: ${a.walletAddress ? a.walletAddress.slice(0, 8) + "…" : "none"} — earn: ${a.earnEnabled ? "✅" : "❌"} — active: ${a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleDateString() : "never"}`
    );
    return `*Users (${all.length}):*\n${lines.join("\n")}`;
  }

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

  return null;
}

// ── process one incoming message ─────────────────────────────────
async function processMessage(apiKey, account, text, photoBase64 = null, incomingMsgId = null) {
  const { userKey, name, role } = account;
  Manager.touchActive(userKey);

  if (text) {
    const earnReply = await EarnReport.processEarnReply(account, text);
    if (earnReply) return earnReply;
    if (role === "owner") {
      const ownerApproval = await EarnReport.processOwnerEarnApproval(account, text);
      if (ownerApproval) return ownerApproval;
    }
  }

  if (role === "owner" && text) {
    const cmd = await handleOwnerCommand(text, account, photoBase64);
    if (cmd) return cmd;
  }

  const Groq = getGroq();
  if (!Groq.isConfigured()) return "Groq isn't configured — check GROQ_API_KEY in .env.";

  const sess        = getSession(userKey);
  const userContent = photoBase64
    ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } },
        { type: "text", text: text || "What is this?" },
      ]
    : (text || "");

  pushHistory(userKey, "user", userContent);

  if (incomingMsgId) await Sender.sendTypingIndicator(apiKey, incomingMsgId).catch(() => {});

  let reply;
  try {
    const result = await Groq.chatWithTools({
      message:             text || "describe this image",
      userTitle:           name,
      memories:            [],
      context:             role === "owner" ? "(Owner account — full access)" : "",
      conversationHistory: sess.history.slice(0, -1),
      executeTool:         async (n, args) => {
        if (args && typeof args === "object") args._userKey = userKey;
        return null;
      },
      tz: "America/New_York",
    });
    reply = result?.reply || "…";
  } catch (e) {
    reply = `Sorry, hit an error: ${e.message}`;
  }

  pushHistory(userKey, "assistant", reply);
  return reply;
}

// ── poll loop ─────────────────────────────────────────────────────
const activeLoops = new Map(); // userKey → true
const pollLocks   = new Map(); // userKey → true (request in-flight)

async function pollLoop(account) {
  const { userKey, whatsappApiKey } = account;
  let offset     = null; // null = omit offset on first call → "new only"
  let errorCount = 0;
  let dupCount   = 0;    // separate 409 backoff counter

  // ── BOOT DELAY ──────────────────────────────────────────────────
  // Wait until BOOT_DELAY_MS has elapsed since process start, but only
  // once globally — if multiple accounts start simultaneously they share
  // the same countdown window.
  if (!_bootDelayDone) {
    const elapsed = Date.now() - PROCESS_START;
    const remaining = BOOT_DELAY_MS - elapsed;
    if (remaining > 0) {
      console.log(`[WA-POLLER] Boot delay: waiting ${Math.ceil(remaining / 1000)}s before first poll (letting old Render session die)...`);
      await sleep(remaining);
    }
    _bootDelayDone = true;
    console.log("[WA-POLLER] Boot delay done — starting polls.");
  }

  while (activeLoops.get(userKey)) {

    // ── LOCK GUARD ───────────────────────────────────────────────
    if (pollLocks.get(userKey)) {
      await sleep(500);
      continue;
    }

    pollLocks.set(userKey, true);
    let waitAfter = 0;

    try {
      const result = await Sender.pollMessages(whatsappApiKey, offset ?? 0, 50, 25);

      // ✅ Success
      errorCount = 0;
      dupCount   = 0;

      if (result?.nextOffset !== undefined && result.nextOffset !== null) {
        offset = result.nextOffset;
      }

      for (const msg of (result?.messages ?? [])) {
        if (msg.fromAgent || msg.from_me || msg.isBot) continue;

        const text        = msg.text?.body || msg.message || msg.content || msg.text || "";
        const photoBase64 = msg.image?.data || msg.media?.data || msg.photo?.data || null;
        const msgId       = msg.id || msg.message_id || null;

        if (!text && !photoBase64) continue;

        const freshAccount = Manager.getAccount(userKey);
        if (!freshAccount) break;

        const setup = await SetupFlow.handleSetupFlow(whatsappApiKey, text);
        if (setup.handled) {
          if (setup.reply) {
            await Sender.sendText(whatsappApiKey, setup.reply).catch(() => {});
            if (setup.account) activeLoops.set(setup.account.userKey, true);
          }
          continue;
        }

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

      waitAfter = 0; // 204 or empty → re-poll immediately

    } catch (err) {
      errorCount++;
      const msg   = String(err?.message || "");
      const is409 = msg.includes("409") || msg.includes("1752041") || msg.toLowerCase().includes("duplicate");
      const is429 = msg.includes("429") || msg.includes("130429")  || msg.toLowerCase().includes("exceeded");

      if (is409) {
        dupCount++;
        waitAfter = Math.min(30_000 * Math.pow(2, dupCount - 1), 300_000);
        console.warn(`[WA-POLLER] 409 on ${userKey} (attempt ${dupCount}) — old session still alive, waiting ${waitAfter / 1000}s`);
      } else if (is429) {
        waitAfter  = 60_000;
        errorCount = 0;
        console.warn(`[WA-POLLER] 429 on ${userKey} — rate limited, waiting 60s`);
      } else {
        waitAfter = Math.min(5_000 * Math.pow(2, errorCount - 1), 60_000);
        console.warn(`[WA-POLLER] Error #${errorCount} for ${userKey}: ${msg} — waiting ${waitAfter / 1000}s`);
      }
    } finally {
      pollLocks.delete(userKey);
    }

    if (waitAfter > 0) await sleep(waitAfter);
  }

  console.log(`[WA-POLLER] Loop ended for ${userKey}`);
}

// ── start / stop / boot ───────────────────────────────────────────
function startPollingForAccount(account) {
  const { userKey } = account;
  if (activeLoops.get(userKey)) return;
  if (!account.whatsappApiKey) {
    console.warn(`[WA-POLLER] ${userKey} has no API key — skipping.`);
    return;
  }
  activeLoops.set(userKey, true);
  console.log(`[WA-POLLER] ▶ Queued polling for ${account.name} (${userKey}) — boot delay active`);
  pollLoop(account).catch(e => {
    activeLoops.delete(userKey);
    console.error(`[WA-POLLER] Loop crashed for ${userKey}:`, e.message);
    // 30s before restart — gives Render time to drain old connections
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
  for (const account of accounts) startPollingForAccount(account);
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
