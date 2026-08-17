"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — AgentPhone Client v2.0
//
// Thin wrapper around the AgentPhone API (https://agentphone.ai —
// YC-backed, api.agentphone.ai/v1). This is what gives Jarvis an
// actual real phone number that can dial real businesses over the
// real phone network (PSTN) — completely separate from call-voice.js
// / teams-control.js, which only ever talked to Microsoft Teams.
//
// ── COST, HONESTLY ────────────────────────────────────────────
// This is a paid, metered API (number rental + per-minute usage).
// There is no such thing as free-forever real telephone calling —
// see the .env comment above AGENTPHONE_API_KEY for the numbers.
// You already have credits, so this just spends down your balance
// per call; check usage any time at agentphone.ai (Usage & Billing).
//
// ── WHY "HOSTED" VOICE MODE ───────────────────────────────────
// AgentPhone supports two voice modes:
//   - "webhook": AgentPhone POSTs the live transcript to a public
//     URL on YOUR server for every turn, and you return what to say.
//   - "hosted": you give AgentPhone a systemPrompt once, and their
//     own built-in LLM runs the entire live conversation itself.
// Jarvis normally runs on your own PC, which usually has no public
// HTTPS endpoint the internet can reach — so "webhook" mode would
// require you to stand up and expose a server just for this. Hosted
// mode needs nothing exposed: we place the call with instructions,
// then poll for the finished transcript afterward. That's the mode
// this file uses everywhere. (If you later run Jarvis somewhere
// with a public URL, webhook mode would let phone-agent.js react
// mid-call instead of only after — worth revisiting then.)
//
// ── MULTIPLE ACCOUNTS / BACKUP NUMBERS ────────────────────────
// AgentPhone is metered — a busy day of real calls can run an
// account's balance to zero mid-use. Rather than just failing at
// that point, Jarvis can hold several AgentPhone accounts (each
// its own API key, own agent, own phone number) and automatically
// fail over to the next one the moment the current one stops
// working (out of balance, invalid/revoked key, rate-limited).
//
// Set these up in .env exactly like the GEMINI_API_KEY(2,3...)
// pattern already used elsewhere in this project:
//   AGENTPHONE_API_KEY / AGENTPHONE_AGENT_ID / AGENTPHONE_NUMBER_ID
//     → account #1 (primary)
//   AGENTPHONE_API_KEY2 / AGENTPHONE_AGENT_ID2 / AGENTPHONE_NUMBER_ID2
//     → account #2 (first backup)
//   AGENTPHONE_API_KEY3 / AGENTPHONE_AGENT_ID3 / AGENTPHONE_NUMBER_ID3
//     → account #3 (second backup)
//   ...and so on, as many as you want. Only the *_API_KEY is
// required per account — the matching *_AGENT_ID / *_NUMBER_ID are
// optional the same way they are for the primary: leave them blank
// and Jarvis auto-creates (and then caches) an agent + buys a number
// on that account the first time it's ever actually needed.
//
// Whichever account is currently "active" is the one real callers
// actually dial. When Jarvis fails over, THE PHONE NUMBER CHANGES —
// anyone who only has the old number won't reach this Jarvis anymore
// on that old number. See consumeSwitchNotice()/getStatus() below:
// phone-agent.js and the get_phone_status tool both surface this out
// loud ("switched to backup, the new number is ...") so you actually
// hear about it instead of silently losing calls.
//
// ── STATE ──────────────────────────────────────────────────────
// The very first call on each account auto-creates one AgentPhone
// "agent" + buys it one phone number, then caches the ids per-account
// in data/agentphone-state.json so Jarvis doesn't buy a new number
// every time it restarts. Delete that file (or the ids inside it) if
// you ever want a fresh number.
// ═══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const API_BASE = process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.ai/v1";
const STATE_PATH = path.join(__dirname, "data", "agentphone-state.json");

// ── ACCOUNT CONFIG (read from .env, numbered like GEMINI_API_KEY) ──
// Index 0 = primary (AGENTPHONE_API_KEY, no suffix). Index 1 = first
// backup (AGENTPHONE_API_KEY2), and so on. Stops at the first gap.
function loadAccountConfigs() {
  const list = [];
  const primary = String(process.env.AGENTPHONE_API_KEY || "").trim();
  if (primary) {
    list.push({
      apiKey: primary,
      agentIdEnv: (process.env.AGENTPHONE_AGENT_ID || "").trim() || null,
      numberIdEnv: (process.env.AGENTPHONE_NUMBER_ID || "").trim() || null,
    });
  }
  for (let i = 2; ; i++) {
    const raw = process.env[`AGENTPHONE_API_KEY${i}`];
    if (!raw) break;
    const trimmed = String(raw).trim();
    if (!trimmed) break;
    list.push({
      apiKey: trimmed,
      agentIdEnv: (process.env[`AGENTPHONE_AGENT_ID${i}`] || "").trim() || null,
      numberIdEnv: (process.env[`AGENTPHONE_NUMBER_ID${i}`] || "").trim() || null,
    });
  }
  return list;
}

function isConfigured() {
  return loadAccountConfigs().length > 0;
}
function accountCount() {
  return loadAccountConfigs().length;
}

// Kept for the one legacy internal use-case (request() with no
// explicit key) — everywhere else now passes an explicit per-account
// key, since which account is "current" can change mid-run.
function apiKey() {
  const key = String(process.env.AGENTPHONE_API_KEY || "").trim();
  if (!key) throw new Error("AGENTPHONE_API_KEY not set in .env — get one at agentphone.ai/settings after signing up.");
  return key;
}

// ── STATE FILE (per-account agent/number cache + active pointer) ───
// Shape: { accounts: { "0": {agentId,numberId,phoneNumber}, ... },
//          activeIndex: 0, lastSwitch: {...} | null }
// Transparently migrates the old v1.0 flat shape
// ({agentId,numberId,phoneNumber}) into accounts["0"] the first time
// this loads, so nobody has to manually touch the file on upgrade.
function loadState() {
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    raw = null;
  }
  if (!raw) return { accounts: {}, activeIndex: 0, lastSwitch: null, webhooks: {} };
  if (raw.accounts) {
    return { accounts: raw.accounts, activeIndex: raw.activeIndex || 0, lastSwitch: raw.lastSwitch || null, webhooks: raw.webhooks || {} };
  }
  // Old v1.0 flat shape — migrate in memory (saved back on next write).
  const accounts = {};
  if (raw.agentId || raw.numberId || raw.phoneNumber) {
    accounts["0"] = { agentId: raw.agentId || null, numberId: raw.numberId || null, phoneNumber: raw.phoneNumber || null };
  }
  return { accounts, activeIndex: 0, lastSwitch: null, webhooks: {} };
}

function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
  } catch (e) {
    console.error("[AGENTPHONE] Could not persist state:", e.message);
  }
}

function accountState(state, index) {
  return state.accounts[String(index)] || {};
}

// ── LOW-LEVEL REQUEST ──────────────────────────────────────────
// apiKeyOverride lets callers pick WHICH account's key to use, since
// "current account" can change mid-run via failover — see below.
async function request(method, urlPath, body, apiKeyOverride) {
  const key = apiKeyOverride || apiKey();
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });

  const text = await res.text().catch(() => "");
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }

  if (!res.ok) {
    // json?.error (or .message) can be a string OR a nested object/array
    // (e.g. {message, field} or a list of field errors) depending on
    // which AgentPhone endpoint rejected the request — stringify
    // properly instead of letting a template literal collapse it to
    // the useless "[object Object]".
    const raw = json?.error ?? json?.message ?? text ?? null;
    const msg = raw == null
      ? `HTTP ${res.status}`
      : (typeof raw === "string" ? raw : JSON.stringify(raw));
    const err = new Error(`AgentPhone ${method} ${urlPath} failed (${res.status}): ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ── FAILURE CLASSIFICATION ──────────────────────────────────────
// Decides whether an error means "this account is done, move to the
// backup" (out of balance, dead/revoked key, rate-limited) vs. a
// one-off blip that failing over wouldn't fix anyway (bad request,
// number genuinely unreachable, etc.) — those just get thrown as-is.
function isAccountExhaustedError(err) {
  const status = err && err.status;
  if (status === 402 || status === 429 || status === 401 || status === 403) return true;
  const msg = String((err && err.message) || "").toLowerCase();
  return /insufficient|balance|out of funds|payment required|no funds|credit|quota|exhausted|invalid api key|expired|revoked|unauthorized/.test(msg);
}

// ── ONE-TIME SETUP: agent + number for ONE account, cached after ──
// the first run on that account. index defaults to whichever account
// is currently marked active in state.
async function ensureAgentAndNumber(ownerName, index) {
  const cfgs = loadAccountConfigs();
  if (!cfgs.length) throw new Error("AGENTPHONE_API_KEY not set in .env — get one at agentphone.ai/settings after signing up.");

  const state = loadState();
  const idx = (index == null) ? Math.min(state.activeIndex || 0, cfgs.length - 1) : index;
  const cfg = cfgs[idx];
  if (!cfg) throw new Error(`No AgentPhone account configured at index ${idx} (only ${cfgs.length} configured).`);

  let acc = accountState(state, idx);

  // .env is the source of truth when it specifies an agent/number id —
  // the cache below exists only to remember an id that AgentPhone
  // auto-created because .env had none (see the create-on-demand logic
  // further down). Without this check, changing AGENTPHONE_AGENT_ID /
  // AGENTPHONE_NUMBER_ID in .env silently did nothing once the old
  // values were already cached: this returned the stale cached account
  // and never even looked at the new env vars, which is exactly the
  // "I updated .env but it's still using the old agent ID" bug.
  const envOverridesCache =
    (cfg.agentIdEnv && cfg.agentIdEnv !== acc.agentId) ||
    (cfg.numberIdEnv && cfg.numberIdEnv !== acc.numberId);

  if (acc.agentId && acc.numberId && !envOverridesCache) {
    return { ...acc, apiKey: cfg.apiKey, index: idx };
  }

  if (envOverridesCache) {
    console.log(`[AGENTPHONE] Account #${idx + 1}: .env agent/number id differs from what's cached — using .env and updating the cache.`);
  }

  const label = idx === 0 ? "primary account" : `backup account #${idx + 1}`;

  let agentId = cfg.agentIdEnv || acc.agentId;
  let numberId = cfg.numberIdEnv || acc.numberId;
  // If the number id itself changed, the cached phoneNumber string
  // belongs to the OLD number and would otherwise be carried over
  // under the new id — clear it so it gets re-fetched below instead
  // of silently mislabeling the new number with the old one.
  let phoneNumber = (cfg.numberIdEnv && cfg.numberIdEnv !== acc.numberId) ? null : (acc.phoneNumber || null);

  if (!agentId) {
    console.log(`[AGENTPHONE] ${label}: no agent on file yet — creating one...`);
    const agent = await request("POST", "/agents", {
      name: `${ownerName || "Jarvis"}'s Assistant${idx > 0 ? ` (backup ${idx + 1})` : ""}`,
    }, cfg.apiKey);
    agentId = agent.id;
  }

  if (!numberId) {
    // Before buying anything new, check whether this agent already
    // has a number attached (e.g. one you provisioned by hand in the
    // dashboard) — only buy a new one if it genuinely has none.
    console.log(`[AGENTPHONE] ${label}: no number ID on file — checking whether the agent already has one attached...`);
    const existing = await request("GET", `/agents/${agentId}/numbers`, null, cfg.apiKey);
    const list = Array.isArray(existing) ? existing : (existing?.data || []);

    if (list.length > 0) {
      numberId = list[0].id;
      phoneNumber = list[0].phoneNumber || phoneNumber;
      console.log(`[AGENTPHONE] ${label}: found existing number already attached (${phoneNumber || numberId}) — using it, nothing purchased.`);
    } else {
      console.log(`[AGENTPHONE] ${label}: agent has no number attached — buying one (this spends a small amount of THAT account's balance)...`);
      const number = await request("POST", "/numbers", {}, cfg.apiKey);
      numberId = number.id;
      phoneNumber = number.phoneNumber || phoneNumber;
      await request("POST", `/agents/${agentId}/numbers`, { numberId }, cfg.apiKey);
    }
  }

  const newAcc = { agentId, numberId, phoneNumber: phoneNumber || acc.phoneNumber || null };
  state.accounts[String(idx)] = newAcc;
  saveState(state);
  return { ...newAcc, apiKey: cfg.apiKey, index: idx };
}

// ── FAILOVER WRAPPER ──────────────────────────────────────────────
// Runs fn(account) against the currently-active account. If it fails
// in a way isAccountExhaustedError() recognizes AND there's another
// configured account left to try, switches to it (persisting the
// switch + queuing a spoken notice for consumeSwitchNotice()) and
// retries, working through every configured account before finally
// giving up. Used by every real API action (placing calls, pushing
// the inbound prompt) so the failover behavior is in exactly one
// place instead of duplicated per call-site.
async function withAccountFailover(ownerName, fn) {
  const cfgs = loadAccountConfigs();
  if (!cfgs.length) throw new Error("AGENTPHONE_API_KEY not set in .env — get one at agentphone.ai/settings after signing up.");

  let idx = Math.min(loadState().activeIndex || 0, cfgs.length - 1);
  let lastErr = null;

  for (let attempt = 0; attempt < cfgs.length; attempt++) {
    let account;
    try {
      account = await ensureAgentAndNumber(ownerName, idx);
    } catch (e) {
      // This account can't even be set up (e.g. dead key) — treat it
      // the same as a failed call and move straight to the next one.
      lastErr = e;
      console.error(`[AGENTPHONE] Account #${idx + 1} could not be set up: ${e.message}`);
      idx = (idx + 1) % cfgs.length;
      continue;
    }

    // If this account is the destination of a pending, not-yet-
    // announced switch, backfill the new number now that we actually
    // have it — this is what consumeSwitchNotice() reports.
    {
      const s = loadState();
      if (s.lastSwitch && !s.lastSwitch.announced && s.lastSwitch.toIndex === idx && !s.lastSwitch.newNumber) {
        s.lastSwitch.newNumber = account.phoneNumber || null;
        saveState(s);
      }
    }

    try {
      const result = await fn(account, idx);
      const s = loadState();
      if (s.activeIndex !== idx) { s.activeIndex = idx; saveState(s); }
      return result;
    } catch (e) {
      lastErr = e;
      const hasNext = attempt < cfgs.length - 1;
      const shouldFailover = isAccountExhaustedError(e) && hasNext;
      console.error(`[AGENTPHONE] Account #${idx + 1} failed: ${e.message}`);
      if (!shouldFailover) throw e;

      const fromIdx = idx;
      const fromNumber = account.phoneNumber || null;
      idx = (idx + 1) % cfgs.length;

      const s = loadState();
      s.activeIndex = idx;
      s.lastSwitch = {
        at: new Date().toISOString(),
        fromIndex: fromIdx,
        toIndex: idx,
        fromNumber,
        newNumber: null, // filled in above once the new account resolves
        reason: e.message,
        announced: false,
      };
      saveState(s);
      console.warn(`[AGENTPHONE] Account #${fromIdx + 1} ran out — switching to backup account #${idx + 1}.`);
    }
  }
  throw new Error(`All ${cfgs.length} AgentPhone account(s) are unavailable. Last error: ${lastErr ? lastErr.message : "unknown"}`);
}

// ── STATUS / SWITCH NOTICES ─────────────────────────────────────
// Non-destructive peek at current account/number + whatever the last
// switch was (already-announced or not).
function getStatus() {
  const cfgs = loadAccountConfigs();
  const state = loadState();
  const idx = cfgs.length ? Math.min(state.activeIndex || 0, cfgs.length - 1) : 0;
  const acc = accountState(state, idx);
  return {
    totalAccounts: cfgs.length,
    activeIndex: idx,
    isBackup: idx > 0,
    phoneNumber: acc.phoneNumber || null,
    lastSwitch: state.lastSwitch || null,
  };
}

// Returns the pending switch notice (if any switch has happened that
// hasn't been spoken yet) and marks it announced so it's only ever
// spoken once. Call this anywhere a reply is about to be shown/said
// to the owner — see phone-agent.js and the get_phone_status tool.
function consumeSwitchNotice() {
  const state = loadState();
  if (!state.lastSwitch || state.lastSwitch.announced) return null;
  const notice = { ...state.lastSwitch };
  state.lastSwitch.announced = true;
  saveState(state);
  return notice;
}

// ── WEBHOOK MODE (our own AI drives every turn, instead of ────────
//    AgentPhone's hosted LLM) ─────────────────────────────────────
// Root cause of the "call ended after hearing 'okay'" bug: hosted
// mode hands AgentPhone's OWN LLM a systemPrompt once and just hopes
// it's followed for the entire live call — no way for Jarvis to
// intervene mid-call if it drifts. Webhook mode instead has AgentPhone
// POST every single turn to OUR server (see agentphone-voice-routes.js),
// so Jarvis's own Groq call — running the exact same tightened
// buildSystemPrompt() instructions from phone-agent.js — decides every
// line as the call happens. Same idea the Twilio fallback already
// uses (twilio-voice-routes.js), just for the AgentPhone backend too.
//
// Only usable when Jarvis has a public HTTPS URL for AgentPhone to
// call back into (same requirement Twilio calling already has — see
// twilio-call.js). Falls back to today's hosted behavior automatically
// when there's no public URL, so this is a no-op change for anyone
// running Jarvis purely on their own PC. Set AGENTPHONE_FORCE_HOSTED=true
// in .env to opt back into hosted mode even when a public URL exists.
function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.STORE_BASE_URL || "").trim().replace(/\/+$/, "");
}

function isWebhookModeAvailable() {
  if (String(process.env.AGENTPHONE_FORCE_HOSTED || "").trim().toLowerCase() === "true") return false;
  return !!publicBaseUrl();
}

// Registers (or re-registers, if the URL changed) OUR webhook against
// ONE account's agent, AND flips that agent's voiceMode to "webhook".
// Turns out omitting systemPrompt on the call alone isn't enough —
// a real test call proved AgentPhone still fell back to hosted mode
// (using the agent's stored default/inbound prompt) unless the agent
// itself is explicitly set to voiceMode: "webhook". Cached in state so
// this only actually calls AgentPhone's API again if the public URL
// changes or the agent was recreated — everyday calls just read the
// cached secret.
async function ensureWebhookForAccount(account, idx, ownerName) {
  const url = `${publicBaseUrl()}/agentphone/webhook`;
  const state = loadState();
  const existing = (state.webhooks || {})[String(idx)];
  const label = idx === 0 ? "primary account" : `backup account #${idx + 1}`;

  // Fully cached AND we've already confirmed voiceMode was flipped for
  // this exact registration -> nothing to do. This is the fix: records
  // saved by an older build (before voiceModeSet existed) don't match
  // this condition, so they fall through and get the PATCH applied
  // instead of being treated as "already done" forever.
  if (existing && existing.url === url && existing.agentId === account.agentId && existing.voiceModeSet === true) {
    return existing;
  }

  // Webhook itself already registered (same url/agentId) but we've never
  // confirmed voiceMode -> skip re-registering the webhook, just patch
  // voiceMode and update the cache. Covers accounts stuck from before
  // this fix existed.
  let secret = existing && existing.url === url && existing.agentId === account.agentId
    ? existing.secret
    : null;

  if (!secret) {
    console.log(`[AGENTPHONE] ${label}: registering per-turn webhook -> ${url}`);
    const res = await request("POST", `/agents/${account.agentId}/webhook`, { url, contextLimit: 20 }, account.apiKey);
    secret = res.secret;
  } else {
    console.log(`[AGENTPHONE] ${label}: webhook already registered, but voiceMode was never confirmed -> re-patching now`);
  }

  console.log(`[AGENTPHONE] ${label}: switching agent voiceMode to "webhook" so calls actually route here...`);
  await request("PATCH", `/agents/${account.agentId}`, { voiceMode: "webhook" }, account.apiKey);

  const rec = { url, agentId: account.agentId, secret, registeredAt: Date.now(), voiceModeSet: true };
  const s = loadState();
  s.webhooks = s.webhooks || {};
  s.webhooks[String(idx)] = rec;
  saveState(s);
  return rec;
}

// Looks up which account's webhook secret to verify an inbound
// delivery against, by the agentId AgentPhone stamps on every
// delivery — agentphone-voice-routes.js can't know the account index
// on its own, only what AgentPhone tells it.
function getWebhookSecretByAgentId(agentId) {
  const webhooks = loadState().webhooks || {};
  for (const idx of Object.keys(webhooks)) {
    if (webhooks[idx].agentId === agentId) return webhooks[idx].secret;
  }
  return null;
}

// ── PER-CALL TURN STATE (webhook mode only) ────────────────────────
// Keyed by AgentPhone's own call id. placeOutboundCall() below seeds
// one of these the instant a webhook-mode call is placed (before any
// turn has happened); agentphone-voice-routes.js reads/appends to it
// as the live call progresses, and deletes it once agent.call_ended
// arrives.
//
// Persisted to disk (not just an in-memory Map) on purpose: a call is
// placed, then AgentPhone posts each turn back over several seconds
// while the phone conversation happens. If the server process
// restarts in that window — a redeploy landing mid-call, a crash,
// Render recycling the instance — an in-memory-only Map loses the
// record. The next webhook turn for that same call then finds
// nothing, silently assumes it must be an INBOUND call, and starts
// the wrong script (the "who am I speaking with?" name-matching flow)
// mid-outbound-call. That's what produced the "sorry, you've got the
// wrong number" behavior on a call Jarvis itself placed. Reading/
// writing a small JSON file on every turn is cheap at this call
// volume and makes that failure mode structurally impossible instead
// of just less likely.
const WEBHOOK_CALLS_PATH = path.join(__dirname, "data", "agentphone-webhook-calls.json");

function loadWebhookCalls() {
  try {
    return JSON.parse(fs.readFileSync(WEBHOOK_CALLS_PATH, "utf8"));
  } catch {
    return {};
  }
}
function saveWebhookCallsFile(all) {
  try {
    fs.mkdirSync(path.dirname(WEBHOOK_CALLS_PATH), { recursive: true });
    fs.writeFileSync(WEBHOOK_CALLS_PATH, JSON.stringify(all, null, 2));
  } catch (e) {
    console.error("[AGENTPHONE] Could not persist webhook call state:", e.message);
  }
}

// AgentPhone's own inconsistency: the id POST /calls returns is
// prefixed ("ap_cmsxmm1nl..."), but the callId it sends back in each
// webhook delivery for that same call is NOT ("cmsxmm1nl..." — no
// "ap_"). A real test call proved this: registerWebhookCall() was
// storing the prefixed form while every webhook turn looked up the
// unprefixed form, so the lookup NEVER matched and every outbound
// call silently fell back to the inbound name-matching script. Strip
// the prefix on both sides so whichever form comes in, it maps to the
// same key.
function normalizeCallId(id) {
  return String(id || "").replace(/^ap_/, "");
}

function registerWebhookCall(callId, rec) {
  const all = loadWebhookCalls();
  all[normalizeCallId(callId)] = rec;
  saveWebhookCallsFile(all);
}
function getWebhookCall(callId) {
  const all = loadWebhookCalls();
  return all[normalizeCallId(callId)] || null;
}
// agentphone-voice-routes.js mutates the rec object it gets back from
// getWebhookCall() (pushing turns, bumping the turn count) — call this
// after each mutation to actually persist it, since disk reads/writes
// no longer share a live object reference the way the old Map did.
function updateWebhookCall(callId, rec) {
  const all = loadWebhookCalls();
  all[normalizeCallId(callId)] = rec;
  saveWebhookCallsFile(all);
}
function deleteWebhookCall(callId) {
  const all = loadWebhookCalls();
  delete all[normalizeCallId(callId)];
  saveWebhookCallsFile(all);
}

// ── PLACE AN OUTBOUND CALL ────────────────────────────────────────
// systemPrompt is always required from the caller's side (phone-agent.js
// still builds it the same way it always has) — but WHERE it ends up
// depends on the mode: hosted mode sends it straight to AgentPhone as
// before; webhook mode keeps it here instead and drives the call via
// agentphone-voice-routes.js, never sending systemPrompt to AgentPhone
// at all (that's what puts a given call into webhook mode — see
// isWebhookModeAvailable() above). Either way, automatically fails
// over to a backup account if the active one is out of balance / dead
// — the caller doesn't need to know or care which mode or account
// actually handled it.
async function placeOutboundCall({ toNumber, systemPrompt, initialGreeting, voice, ownerName }) {
  if (!toNumber) throw new Error("placeOutboundCall requires toNumber");
  if (!systemPrompt) throw new Error("placeOutboundCall requires systemPrompt");

  const useWebhook = isWebhookModeAvailable();

  return withAccountFailover(ownerName, async (account, idx) => {
    if (useWebhook) {
      try {
        await ensureWebhookForAccount(account, idx, ownerName);
      } catch (e) {
        console.error(`[AGENTPHONE] Couldn't register the webhook (falling back to hosted mode for this call only): ${e.message}`);
        return request("POST", "/calls", {
          agentId: account.agentId,
          toNumber,
          initialGreeting: initialGreeting || undefined,
          systemPrompt,
          voice: voice || undefined,
        }, account.apiKey);
      }

      const call = await request("POST", "/calls", {
        agentId: account.agentId,
        toNumber,
        initialGreeting: initialGreeting || undefined,
        voice: voice || undefined,
        // Deliberately NO systemPrompt here — its absence is what
        // puts THIS call into webhook mode on AgentPhone's side.
      }, account.apiKey);

      registerWebhookCall(call.id, {
        ownerName: ownerName || "my owner",
        systemPrompt,
        history: initialGreeting ? [{ role: "assistant", text: initialGreeting }] : [],
        turns: 0,
        createdAt: Date.now(),
      });
      return call;
    }

    return request("POST", "/calls", {
      agentId: account.agentId,
      toNumber,
      initialGreeting: initialGreeting || undefined,
      systemPrompt,
      voice: voice || undefined,
    }, account.apiKey);
  });
}

// ── PUSH A DEFAULT SYSTEM PROMPT TO THE AGENT RECORD ─────────────
// This is what an INBOUND call falls back to (someone dials your
// Jarvis number directly) since there's no per-call systemPrompt to
// inject the way there is for outbound calls. Updates the agent's
// default so you don't have to hand-paste it into the dashboard
// every time the prompt logic changes (e.g. when you add/remove a
// user in config.json's "users" list, or change the number code) —
// see inbound-agent.js.
//
// Pushes to the ACTIVE account (with the same failover as any other
// call) AND, best-effort, to every other configured backup account
// too — so the moment Jarvis ever fails over mid-outage, whichever
// backup number picks up the call already has the current, correct
// inbound behavior instead of a stale/default one.
async function setAgentDefaultSystemPrompt(systemPrompt, ownerName) {
  if (!systemPrompt) throw new Error("setAgentDefaultSystemPrompt requires systemPrompt");

  const active = await withAccountFailover(ownerName, async (account) => {
    await request("PATCH", `/agents/${account.agentId}`, { systemPrompt }, account.apiKey);
    return account;
  });

  const cfgs = loadAccountConfigs();
  for (let i = 0; i < cfgs.length; i++) {
    if (i === active.index) continue;
    try {
      const acc = await ensureAgentAndNumber(ownerName, i);
      await request("PATCH", `/agents/${acc.agentId}`, { systemPrompt }, acc.apiKey);
    } catch (e) {
      console.error(`[AGENTPHONE] Could not sync inbound prompt to backup account #${i + 1} (non-fatal): ${e.message}`);
    }
  }

  return { agentId: active.agentId };
}

// ── LIST RECENT CALLS (used to find inbound calls after the fact) ─
// Hosted mode has no live webhook, so Jarvis can't react mid-call —
// this is how inbound-agent.js finds out an inbound call happened at
// all, by polling after the fact instead of during the call. Only
// looks at the currently-ACTIVE account's number, since that's the
// one being given out/dialed right now.
async function listCalls({ direction, limit = 20 } = {}) {
  const cfgs = loadAccountConfigs();
  if (!cfgs.length) throw new Error("AGENTPHONE_API_KEY not set in .env.");
  const idx = Math.min(loadState().activeIndex || 0, cfgs.length - 1);
  const cfg = cfgs[idx];

  const qs = new URLSearchParams();
  if (direction) qs.set("direction", direction);
  if (limit) qs.set("limit", String(limit));
  const res = await request("GET", `/calls?${qs.toString()}`, null, cfg.apiKey);
  return Array.isArray(res) ? res : (res?.data || []);
}

// ── POLL A CALL UNTIL IT'S OVER ──────────────────────────────────
async function getCall(callId) {
  const cfgs = loadAccountConfigs();
  if (!cfgs.length) throw new Error("AGENTPHONE_API_KEY not set in .env.");
  const idx = Math.min(loadState().activeIndex || 0, cfgs.length - 1);
  const cfg = cfgs[idx];
  return request("GET", `/calls/${callId}`, null, cfg.apiKey);
}

async function waitForCallCompletion(callId, { pollMs = 4000, timeoutMs = 5 * 60 * 1000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const call = await getCall(callId);
    if (call.status === "completed" || call.status === "failed") return call;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`Timed out waiting for call ${callId} to finish (still ${(await getCall(callId)).status} after ${timeoutMs / 1000}s)`);
}

module.exports = {
  isConfigured,
  accountCount,
  ensureAgentAndNumber,
  placeOutboundCall,
  setAgentDefaultSystemPrompt,
  listCalls,
  getCall,
  waitForCallCompletion,
  getStatus,
  consumeSwitchNotice,
  // Webhook mode (agentphone-voice-routes.js)
  isWebhookModeAvailable,
  registerWebhookCall,
  getWebhookCall,
  updateWebhookCall,
  deleteWebhookCall,
  getWebhookSecretByAgentId,
};
