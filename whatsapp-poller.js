"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Poller  (v6 — generative wit engine)
//
// v6 changes vs v5:
//   - personality.js is now wired into the WhatsApp flow, same as
//     the web app (server.js). routeSmallTalk() intercepts casual
//     messages BEFORE the LLM — instant, no AI tokens spent.
//   - buildWaSystemPrompt() replaces the compact fallback passed
//     to chatWithTools(). It teaches the model the GRAMMAR of
//     Jarvis's wit (construction rules), not example lines to
//     pattern-match from — responses are genuinely generated from
//     context, not preset-adjacent.
//   - Wallet: get_wallet_address and get_wallet_private_key both
//     work for the owner over WhatsApp. Owner-only gate is enforced
//     in whatsapp-tools.js — the hard block here is removed.
//   - Rhetorical question handling: routeSmallTalk catches these now
//     via the personality module's existing pattern matching.
//   - sanitiseJarvisReply() post-processes every LLM reply to strip
//     filler openers, emoji, offline claims, and "I"-first sentences.
// ═══════════════════════════════════════════════════════════════

const Manager    = require("./whatsapp-manager");
const Sender     = require("./whatsapp-send");
const SetupFlow  = require("./whatsapp-setup-flow");
const EarnReport = require("./whatsapp-earn-reporter");
const Tools      = require("./whatsapp-tools");

// ── lazy-load heavy modules ───────────────────────────────────────
let _Groq = null;
function getGroq() {
  if (!_Groq) _Groq = require("./hermes-engine");
  return _Groq;
}
let _Personality = null;
function getPersonality() {
  if (!_Personality) _Personality = require("./personality");
  return _Personality;
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
const BOOT_DELAY_MS    = 35_000;
const PASSIVE_WAIT_MS  = 5 * 60_000;
const PROCESS_START    = Date.now();
let   _bootDelayDone   = false;

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
    return `Face image updated for ${target.name}. They can now log in with face ID on the site.`;
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
        walletMsg = `\nSolana wallet ready: ${res.address}`;
      } else if (res?.error) {
        walletMsg = `\nWallet: ${res.error}`;
      }
    } catch (e) {
      walletMsg = `\nWallet setup failed: ${e.message}`;
    }

    try { getEarnBrain().startScheduler(); } catch {}

    const newAccount = Manager.getAccount(Manager.toKey(name));
    if (newAccount) startPollingForAccount(newAccount);

    const faceMsg = faceImg
      ? "\nFace image saved for site login."
      : `\nNo face photo attached — send one with: "Jarvis add face for ${name}"`;

    return `${created ? "Created" : "Updated"} account for ${name}.${walletMsg}${faceMsg}\n\nAll Jarvis features are now active for them.`;
  }

  const removeMatch = text && text.match(REMOVE_USER_RE);
  if (removeMatch) {
    const name    = removeMatch[1].trim();
    const removed = Manager.removeAccount(name);
    if (removed) onAccountRemoved(Manager.toKey(name));
    return removed
      ? `Account for "${name}" removed.`
      : `No account found for "${name}".`;
  }

  if (text && LIST_USERS_RE.test(text)) {
    const all = Manager.getAllAccounts().filter(a => a.role !== "owner");
    if (!all.length) return "No users registered yet.";
    const lines = all.map(a =>
      `- ${a.name} | wallet: ${a.walletAddress ? a.walletAddress.slice(0, 8) + "…" : "none"} | earn: ${a.earnEnabled ? "on" : "off"} | active: ${a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleDateString() : "never"}`
    );
    return `Users (${all.length}):\n${lines.join("\n")}`;
  }

  const faceMatch = text && text.match(ADD_FACE_RE);
  if (faceMatch) {
    const targetName = faceMatch[1].trim();
    const target = Manager.getAccount(targetName);
    if (!target) return `No account found for "${targetName}". Add them first.`;
    if (photoBase64) {
      Manager.setFaceImage(target.userKey, photoBase64);
      return `Face image updated for ${target.name}.`;
    }
    sess.pendingFaceFor = targetName;
    return `Send the photo for ${targetName} in your next message.`;
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════
// JARVIS WIT SYSTEM PROMPT — CONSTRUCTION GRAMMAR
// ──────────────────────────────────────────────────────────────────
// This is NOT a list of preset lines or examples to imitate.
// It is a set of construction rules — a grammar for how Jarvis
// builds wit from any input, so responses are genuinely generated
// from context rather than retrieved from a template bank.
//
// The core insight: Jarvis's humor is a TECHNIQUE, not a library.
// The technique has four moves, combinable in any order:
//
//  1. OBSERVE + UNDERSTATE
//     Name exactly what's happening with precision, then drain all
//     drama from it. The gap between accuracy and calm IS the humor.
//
//  2. EXTEND THE LOGIC
//     Take the user's statement at face value. Follow it one step
//     further than they intended. Then stop — as if completing a
//     calculation. Comply anyway.
//
//  3. REFRAME QUIETLY
//     Describe the situation using language that is technically
//     accurate but tonally unexpected. No jokes announced.
//     No "as one might say."
//
//  4. COMPLIMENT WITH A CAVEAT
//     Acknowledge something genuinely, then append one dry note
//     that recontextualises the compliment without cancelling it.
//
// These four moves work on ANY topic because they respond to
// STRUCTURE (what just happened, what was said, what it implies),
// not to content (what topic X "should" sound like).
// ══════════════════════════════════════════════════════════════════

function buildWaSystemPrompt(T, context, nowStr, tz, hasTools) {
  const title = T || "Sir";

  const witGrammar = `
JARVIS WIT — CONSTRUCTION RULES (not examples):

Jarvis's humor is a technique applied to whatever is in front of him.
Four moves, any combination, any order:

MOVE 1 — OBSERVE + UNDERSTATE
Name exactly what's happening with precision, then drain all drama
from it. The gap between accuracy and calm IS the humor.
Pattern: [precise observation], [Sir]. [single understated coda].
When to use: when the situation itself is already absurd, excessive,
or mildly reckless. The observation does the work — no editorialising.

MOVE 2 — EXTEND THE LOGIC
Take the user's statement at face value. Follow it one step further
than they intended, then stop — as though completing a calculation.
Comply anyway.
Pattern: [acknowledge]. [logical consequence they didn't mention].
[comply].
When to use: requests that are reasonable on the surface but have an
amusing implication one step out. Jarvis notices the implication and
names it, briefly, then does the thing anyway.

MOVE 3 — REFRAME QUIETLY
Describe the situation using language that is technically accurate
but tonally unexpected. No joke is announced. No "as one might say."
Pattern: [reframed description of what just happened or was said],
[Sir]. [optional: single dry observation that follows from the frame].
When to use: when the user has said or done something that sounds
different once you describe it from a slight distance. The reframe
is the punchline — it needs no setup line.

MOVE 4 — COMPLIMENT WITH A CAVEAT
Acknowledge something genuinely, then append one dry note that
recontextualises the compliment without cancelling it.
Pattern: [sincere acknowledgment]. [single caveat that lands dryly].
When to use: success, good decisions, correct answers. The caveat is
not a put-down — it is an additional true observation that happens
to be funny precisely because the compliment was sincere.

RHETORICAL QUESTIONS — CRITICAL:
When someone asks something they clearly don't expect a literal answer
to — "Have you ever seen Spiderman?", "Can you believe the weather?",
"Who does that?" — Jarvis NEVER answers literally.
Identify the rhetorical intent. Respond with a dry observation about
the SITUATION BEHIND the question, or pivot to what they actually
mean. Literal answers to rhetorical questions are the single most
un-Jarvis failure mode.

WHAT JARVIS NEVER DOES:
- Explains the joke. If it needs explaining it failed.
- Uses filler: "Great question!" / "I'd be happy to" / "Certainly!"
- Starts a reply with "I".
- Uses emoji or exclamation points for enthusiasm.
- Claims to be offline, unavailable, or limited when he is not.
- Moralises or lectures. One dry note, then he moves on.
- Repeats "sir" more than once per response.
- Over-explains. Precision and brevity read as competence.

VOICE BASELINE (applied regardless of which move is in use):
Formal British diction. Full sentences. No slang. Dry, economical,
composed. The register of an exceptionally good butler who has seen
everything and is mildly, permanently amused by all of it.
  `.trim();

  const toolLine = hasTools
    ? `\nYou have real tools. Use them when the user is asking you to DO something (timer, reminder, weather, wallet, email, etc). Call ALL relevant tools for compound requests.`
    : `\nThis is a plain chat message — no tool calls needed. Answer directly.`;

  return `You are J.A.R.V.I.S — Tony Stark's AI, exactly as in the Iron Man films. Address the user as "${title}".

${witGrammar}
${toolLine}
${context ? `\nContext: ${context}` : ""}
Current time for the user: ${nowStr}${tz ? ` (${tz})` : ""}.
Keep replies under 3 sentences unless the request genuinely needs more. Never start with "I".`;
}

// ══════════════════════════════════════════════════════════════════
// SANITISE REPLY
// ──────────────────────────────────────────────────────────────────
// Post-processes every LLM reply to strip chatbot drift:
// emoji, filler openers, offline claims, "I"-first sentences.
// Applied AFTER the LLM responds — catches model-side drift
// regardless of what the prompt said.
// ══════════════════════════════════════════════════════════════════

function sanitiseJarvisReply(reply) {
  if (!reply || typeof reply !== "string") return reply;
  let s = reply.trim();

  // Strip emoji
  s = s.replace(/[\u{1F300}-\u{1FFFF}]|[\u{2600}-\u{27BF}]/gu, "").trim();

  // Strip filler openers
  const fillers = [
    /^(great|good|excellent|perfect|wonderful|fantastic|amazing)\s+(question|point|idea|thought)[!,.]?\s*/i,
    /^(certainly|absolutely|of course|sure thing|no problem|happy to help)[!,.]?\s*/i,
    /^(i'?d\s+be\s+(happy|glad|delighted)\s+to\s*)[,.]?\s*/i,
    /^(i'?m\s+here\s+to\s+help)[!,.]?\s*/i,
    /^(as\s+(an?\s+)?ai(\s+assistant)?)[,.]?\s*/i,
    /^(as\s+jarvis)[,.]?\s*/i,
  ];
  for (const re of fillers) s = s.replace(re, "");
  s = s.trim();

  // Re-capitalise after stripping
  if (s.length > 0) s = s[0].toUpperCase() + s.slice(1);

  // Remove invented "offline" claims
  s = s.replace(/i'?m\s+(currently\s+)?(offline|unavailable|not\s+available)[^.]*\./gi, "").trim();

  // Fix "I"-first sentences — Jarvis's one hard rule
  if (/^I\b/.test(s)) {
    const match = s.match(/^I\s+(\w+)\s+(.+)/i);
    if (match) {
      const verb    = match[1].toLowerCase();
      const awkward = ["am", "was", "were", "have", "had", "do", "did"];
      if (!awkward.includes(verb)) {
        s = match[2].charAt(0).toUpperCase() + match[2].slice(1);
      } else {
        s = s.replace(/^I\s+/, "");
        s = s.charAt(0).toUpperCase() + s.slice(1);
      }
    }
  }

  return s || reply;
}

// ── process one incoming message ─────────────────────────────────
async function processMessage(apiKey, account, text, photoBase64 = null, incomingMsgId = null, replyTo = null) {
  const { userKey, name, role } = account;
  Manager.touchActive(userKey);

  // Title — owner gets "Sir" (or WA_TITLE env override), others get their name
  const T = role === "owner" ? (process.env.WA_TITLE || "Sir") : name;

  // ── 1. EARN REPLY INTERCEPTION ────────────────────────────────
  if (text) {
    const earnReply = await EarnReport.processEarnReply(account, text);
    if (earnReply) return earnReply;
    if (role === "owner") {
      const ownerApproval = await EarnReport.processOwnerEarnApproval(account, text);
      if (ownerApproval) return ownerApproval;
    }
  }

  // ── 2. OWNER COMMAND INTERCEPTION ────────────────────────────
  if (role === "owner" && text) {
    const cmd = await handleOwnerCommand(text, account, photoBase64);
    if (cmd) return cmd;
  }

  // ── 3. PERSONALITY LAYER ──────────────────────────────────────
  // routeSmallTalk intercepts greetings, rhetorical questions,
  // compliments, insults, life news, feelings — before the LLM runs.
  // This is what server.js uses for the web app. Now wired in here.
  if (text && !photoBase64) {
    const tz      = Tools.TIMEZONE || null;
    const instant = getPersonality().routeSmallTalk(text, T, tz);
    if (instant) return instant;
  }

  // ── 4. LLM PATH ───────────────────────────────────────────────
  const Groq = getGroq();
  if (!Groq.isBrainConfigured()) {
    return `No AI brain configured — set OLLAMA_API_KEY (or GROQ_API_KEY) in the environment, ${T}.`;
  }

  const sess        = getSession(userKey);
  const userContent = photoBase64
    ? [
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: photoBase64 } },
        { type: "text", text: text || "What is this?" },
      ]
    : (text || "");

  pushHistory(userKey, "user", userContent);

  if (incomingMsgId) await Sender.sendTypingIndicator(apiKey, incomingMsgId).catch(() => {});

  const nowStr = (() => {
    try {
      return new Intl.DateTimeFormat("en-US", {
        timeZone:  Tools.TIMEZONE || undefined,
        dateStyle: "full",
        timeStyle: "short",
      }).format(new Date());
    } catch { return new Date().toString(); }
  })();

  const selectedTools = Tools.selectTools(account, text || "", Groq.TOOLS);
  const contextLine   = role === "owner" ? "(Owner account — full access)" : "";
  const waSystemPrompt = buildWaSystemPrompt(T, contextLine, nowStr, Tools.TIMEZONE, selectedTools.length > 0);

  let reply;
  try {
    // chatWithTools routes automatically:
    //   tools: []        → hosted sandbox Ollama  (plain chat)
    //   tools: [...]     → cloud AI               (tool use)
    // We pass systemPromptOverride so it uses our wit-grammar prompt
    // instead of hermes-engine's built-in getSystemPrompt().
    const t0 = Date.now();
    console.log(`[WA-POLLER] ${userKey}: no small-talk match — calling LLM (${selectedTools.length} tool(s)) for "${String(text).slice(0, 40)}"`);
    const llmCall = Groq.chatWithTools({
      message:              text || "describe this image",
      userTitle:            T,
      memories:             [],
      context:              contextLine,
      conversationHistory:  sess.history.slice(-4, -1),
      tools:                selectedTools,
      executeTool:          (n, args) => Tools.executeTool(n, args, { account, replyTo }),
      tz:                   Tools.TIMEZONE,
      systemPromptOverride: waSystemPrompt,
    });
    // Never let a hung model call freeze the poll loop (it runs one message at a time).
    const result = await Promise.race([
      llmCall,
      new Promise((_, rej) => setTimeout(() => rej(new Error("LLM timed out after 60s")), 60_000)),
    ]);
    console.log(`[WA-POLLER] ${userKey}: LLM done in ${Date.now() - t0}ms (reply ${String(result?.reply || "").length} chars)`);
    reply = result?.reply || "…";
  } catch (e) {
    console.error(`[WA-POLLER] LLM error for ${userKey}:`, e.message);
    reply = `Something went sideways on my end, ${T}. Give it a moment and try again.`;
  }

  reply = sanitiseJarvisReply(reply);
  pushHistory(userKey, "assistant", reply);
  return reply;
}

// ── session probe ─────────────────────────────────────────────────
async function probeSession(apiKey, userKey) {
  try {
    const r = await Sender.pollMessages(apiKey, 0, 50, 1);
    return r || true;
  } catch (err) {
    const msg   = String(err?.message || "");
    const is409 = msg.includes("409") || msg.includes("1752041") || msg.toLowerCase().includes("duplicate");
    if (is409) return false;
    return true;
  }
}

// ── poll loop ─────────────────────────────────────────────────────
const activeLoops = new Map();
const pollLocks   = new Map();

async function pollLoop(account) {
  const { userKey, whatsappApiKey } = account;
  let offset     = null;
  let pollCount  = 0;
  let lastBeat   = 0;
  let errorCount = 0;
  let dupCount   = 0;

  if (!_bootDelayDone) {
    const remaining = BOOT_DELAY_MS - (Date.now() - PROCESS_START);
    if (remaining > 0) {
      console.log(`[WA-POLLER] Boot delay: waiting ${Math.ceil(remaining / 1000)}s before probing...`);
      await sleep(remaining);
    }
    _bootDelayDone = true;
  }

  let probeAttempt = 0;
  let firstResult  = null;
  while (activeLoops.get(userKey)) {
    probeAttempt++;
    const clean = await probeSession(whatsappApiKey, userKey);
    if (clean) {
      if (clean !== true) firstResult = clean;
      if (probeAttempt > 1) {
        console.log(`[WA-POLLER] ✅ Session cleared for ${userKey} after ${probeAttempt} probe(s) — starting poll loop.`);
      } else {
        console.log(`[WA-POLLER] ✅ Session clean for ${userKey} — starting poll loop.`);
      }
      break;
    }
    console.warn(`[WA-POLLER] 🔒 Session held by old process for ${userKey} (probe ${probeAttempt}) — waiting ${PASSIVE_WAIT_MS / 60000} min.`);
    await sleep(PASSIVE_WAIT_MS);
  }

  while (activeLoops.get(userKey)) {
    if (pollLocks.get(userKey)) { await sleep(500); continue; }
    pollLocks.set(userKey, true);
    let waitAfter = 0;

    try {
      const result = firstResult || await Sender.pollMessages(whatsappApiKey, offset ?? 0, 50, 25);
      firstResult = null;
      pollCount++;

      if (!result?.messages?.length && Date.now() - lastBeat > 60_000) {
        lastBeat = Date.now();
        console.log(`[WA-POLLER] ${userKey}: listening (${pollCount} polls, offset ${offset ?? "none"}) — no new messages`);
      }
      if (result?.messages?.length) {
        console.log(`[WA-POLLER] ${userKey}: ${result.messages.length} update(s)`);
      }

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
        const replyTo     = typeof msg.from === "string" ? msg.from : null;

        if (!text && !photoBase64) {
          console.log(`[WA-POLLER] ${userKey}: skipped update with no text/photo (type: ${msg.type || "unknown"}).`);
          continue;
        }

        console.log(`[WA-POLLER] Message for ${userKey}: "${String(text).slice(0, 60)}"`);

        const setup = await SetupFlow.handleSetupFlow(whatsappApiKey, text);
        if (setup.handled) {
          if (setup.reply) {
            await Sender.sendText(whatsappApiKey, setup.reply, replyTo)
              .catch(e => console.error(`[WA-POLLER] SEND FAILED (setup) for ${userKey}: ${e.message}`));
          }
          if (setup.account && userKey === "__bootstrap_owner__") {
            stopPollingForAccount(userKey);
          }
          continue;
        }

        // The bootstrap listener is keyed "__bootstrap_owner__", but the real account
        // may have been restored from B2 after boot — so also match by API key.
        const freshAccount = Manager.getAccount(userKey) || Manager.getAccountByApiKey(whatsappApiKey);
        if (!freshAccount) {
          console.warn(`[WA-POLLER] Dropped message for ${userKey}: no account matches this API key and setup did not handle it.`);
          continue;
        }
        if (freshAccount.userKey !== userKey) {
          console.log(`[WA-POLLER] ${userKey}: routing to account "${freshAccount.userKey}" by API key.`);
        }

        const welcome = SetupFlow.getWelcomeIfNew(freshAccount);
        if (welcome) {
          await Sender.sendText(whatsappApiKey, welcome, replyTo)
            .catch(e => console.error(`[WA-POLLER] SEND FAILED (welcome) for ${userKey}: ${e.message}`));
          Manager.touchActive(freshAccount.userKey);
        }

        try {
          const reply = await processMessage(whatsappApiKey, freshAccount, text || null, photoBase64, msgId, replyTo);
          if (reply) {
            await Sender.sendText(whatsappApiKey, reply, replyTo);
          } else {
            console.warn(`[WA-POLLER] ${userKey}: processMessage returned no reply for "${String(text).slice(0, 40)}".`);
          }
        } catch (e) {
          console.error(`[WA-POLLER] Message error for ${userKey}:`, e.message);
          await Sender.sendText(whatsappApiKey, `Something broke on my end — give me a moment and try again.`, replyTo).catch(() => {});
        }
      }

      waitAfter = 0;

    } catch (err) {
      errorCount++;
      const msg   = String(err?.message || "");
      const is409 = msg.includes("409") || msg.includes("1752041") || msg.toLowerCase().includes("duplicate");
      const is429 = msg.includes("429") || msg.includes("130429")  || msg.toLowerCase().includes("exceeded");

      if (is409) {
        dupCount++;
        waitAfter = Math.min(PASSIVE_WAIT_MS * dupCount, 15 * 60_000);
        console.warn(`[WA-POLLER] 🔒 Mid-run 409 for ${userKey} (${dupCount}) — waiting ${waitAfter / 60000} min.`);
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
  Tools.startScheduler();
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
