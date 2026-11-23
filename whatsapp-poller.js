"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Poller  (v5 — session probe + passive wait)
//
// Why 409 persisted across v3/v4:
//   The old session WhatsApp holds isn't just "30 seconds" — on Render
//   it can persist for 3-5 MINUTES after the old process dies, because
//   WhatsApp's server keeps the long-poll connection open server-side
//   until its own 25s timeout fires, then needs another cycle to fully
//   release the session. Meanwhile our new process hammers it every
//   30s, resetting the "attempt 1" counter on each restart.
//
// Fix — session probe + passive wait:
//   On boot, instead of jumping straight into the poll loop, we fire
//   ONE short probe (timeout=1s). If it comes back clean → start the
//   normal loop immediately. If it's 409 → enter PASSIVE WAIT:
//   sleep 5 minutes, probe again. Keep probing every 5 minutes until
//   the session clears. No hammering, no log spam, one line per probe.
//
//   Normal poll loop is completely unchanged — this is only the
//   startup gate. If a 409 appears mid-run (network blip, re-deploy
//   during active session) it still uses the exponential backoff.
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
const BOOT_DELAY_MS    = 35_000;   // wait after process start before first probe
const PASSIVE_WAIT_MS  = 5 * 60_000; // 5 min between probes when session is stuck
const PROCESS_START    = Date.now();
let   _bootDelayDone   = false;    // shared across all accounts — wait once

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

// ── session probe — fires ONE short poll to check if session is free ──
// Returns true if session is clean (200 or 204), false if 409 still active.
async function probeSession(apiKey, userKey) {
  try {
    // Short timeout probe — we don't want to hold open a 25s long poll
    // just to check if we're 409. Use timeout=1 so the server responds
    // almost immediately with either 200/204 (clean) or 409 (blocked).
    await Sender.pollMessages(apiKey, 0, 1, 1);
    return true; // 200 or 204 — session is ours
  } catch (err) {
    const msg   = String(err?.message || "");
    const is409 = msg.includes("409") || msg.includes("1752041") || msg.toLowerCase().includes("duplicate");
    if (is409) return false; // session still held by old process
    // Any other error (network, 429) — treat as "not 409", proceed normally
    // The main loop has its own backoff for those cases
    return true;
  }
}

// ── poll loop — the actual message receive loop ───────────────────
const activeLoops = new Map();
const pollLocks   = new Map();

async function pollLoop(account) {
  const { userKey, whatsappApiKey } = account;
  let offset     = null;
  let errorCount = 0;
  let dupCount   = 0;

  // ── BOOT DELAY (global, shared) ──────────────────────────────
  if (!_bootDelayDone) {
    const remaining = BOOT_DELAY_MS - (Date.now() - PROCESS_START);
    if (remaining > 0) {
      console.log(`[WA-POLLER] Boot delay: waiting ${Math.ceil(remaining / 1000)}s before probing...`);
      await sleep(remaining);
    }
    _bootDelayDone = true;
  }

  // ── SESSION PROBE GATE ────────────────────────────────────────
  // Before entering the main loop, confirm the session is ours.
  // If 409, wait PASSIVE_WAIT_MS (5 min) and probe again.
  // This runs ONCE at startup — after that the main loop handles 409s.
  let probeAttempt = 0;
  while (activeLoops.get(userKey)) {
    probeAttempt++;
    const clean = await probeSession(whatsappApiKey, userKey);
    if (clean) {
      if (probeAttempt > 1) {
        console.log(`[WA-POLLER] ✅ Session cleared for ${userKey} after ${probeAttempt} probe(s) — starting poll loop.`);
      } else {
        console.log(`[WA-POLLER] ✅ Session clean for ${userKey} — starting poll loop.`);
      }
      break; // session is ours — enter main loop
    }
    console.warn(`[WA-POLLER] 🔒 Session still held by old process for ${userKey} (probe ${probeAttempt}) — waiting ${PASSIVE_WAIT_MS / 60000} min before retry.`);
    await sleep(PASSIVE_WAIT_MS);
  }

  // ── MAIN POLL LOOP ────────────────────────────────────────────
  while (activeLoops.get(userKey)) {

    if (pollLocks.get(userKey)) {
      await sleep(500);
      continue;
    }

    pollLocks.set(userKey, true);
    let waitAfter = 0;

    try {
      const result = await Sender.pollMessages(whatsappApiKey, offset ?? 0, 50, 25);
      if (result?.messages?.length) console.log(`[WA-POLLER] ${userKey}: ${result.messages.length} update(s)`);

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

        console.log(`[WA-POLLER] Message for ${userKey}: "${String(text).slice(0, 40)}"`);

        // Setup flow must run BEFORE the account lookup: the bootstrap
        // listener has no registered account yet, so the old early-break
        // silently dropped every message.
        const setup = await SetupFlow.handleSetupFlow(whatsappApiKey, text);
        if (setup.handled) {
          if (setup.reply) {
            await Sender.sendText(whatsappApiKey, setup.reply).catch(() => {});
          }
          if (setup.account && userKey === "__bootstrap_owner__") {
            // Owner is registered now; a real loop was started for them.
            // Stop the bootstrap loop so two pollers don't fight (409).
            stopPollingForAccount(userKey);
          }
          continue;
        }

        const freshAccount = Manager.getAccount(userKey);
        if (!freshAccount) continue;

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

      waitAfter = 0;

    } catch (err) {
      errorCount++;
      const msg   = String(err?.message || "");
      const is409 = msg.includes("409") || msg.includes("1752041") || msg.toLowerCase().includes("duplicate");
      const is429 = msg.includes("429") || msg.includes("130429")  || msg.toLowerCase().includes("exceeded");

      if (is409) {
        // Mid-run 409 — another deploy happened, go passive again
        dupCount++;
        waitAfter = Math.min(PASSIVE_WAIT_MS * dupCount, 15 * 60_000); // 5m → 10m → 15m cap
        console.warn(`[WA-POLLER] 🔒 Mid-run 409 for ${userKey} (${dupCount}) — another deploy? Waiting ${waitAfter / 60000} min.`);
      } else if (is429) {
        waitAfter  = 60_000;
        errorCount = 0;
        console.warn(`[WA-POLLER] 429 for ${userKey} — rate limited, waiting 60s.`);
      } else {
        waitAfter = Math.min(5_000 * Math.pow(2, errorCount - 1), 60_000);
        console.warn(`[WA-POLLER] Error #${errorCount} for ${userKey}: ${msg} — waiting ${waitAfter / 1000}s.`);
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
  console.log(`[WA-POLLER] ▶ Queued ${account.name} (${userKey}) — will probe after boot delay.`);
  pollLoop(account).catch(e => {
    activeLoops.delete(userKey);
    console.error(`[WA-POLLER] Loop crashed for ${userKey}:`, e.message);
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
