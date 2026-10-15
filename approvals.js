"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Approvals ("tell me before you do it")
//
// One place that knows about everything Jarvis is waiting on you for,
// and everything it's been doing. The UI pill (public/approval-pill.js)
// and the Electron overlay both talk to the routes mounted here.
//
//   • Pending cards: Allow / Deny / Always, or a multiple-choice question.
//   • Live feed: short "what Jarvis is doing" steps over SSE.
//   • Always-allow rules: saved to data/approval-rules.json.
//
// SAFETY: "Always" is only ever offered where the caller opts in with a
// ruleKey (right now: exact shell commands that are already in the
// "confirm" tier). Commands in the "never" tier are blocked before they
// ever reach this module, so no rule can unlock them. Typed text, threat
// neutralizing and phone calls never get an Always button.
//
// Existing voice/chat "yes"/"no" keeps working: the chat flow settles
// the same card when it clears the pending action.
// ═══════════════════════════════════════════════════════════════

const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");

const DATA_DIR   = path.join(__dirname, "data");
const RULES_FILE = path.join(DATA_DIR, "approval-rules.json");

const DEFAULT_TTL_MS = 2 * 60 * 1000;   // matches jarvis-agent PENDING_TTL_MS
const PHONE_TTL_MS   = 5 * 60 * 1000;
const QUESTION_TTL_MS = 5 * 60 * 1000;
const MAX_FEED = 100;
const MAX_DETAIL = 800;

const clients = new Set();          // SSE responses
const entries = new Map();          // id -> entry (pending + recently settled)
const feed = [];                    // newest last

// ── RULES ────────────────────────────────────────────────────────
function loadRules() {
  try { return JSON.parse(fs.readFileSync(RULES_FILE, "utf8")) || {}; }
  catch { return {}; }
}
function saveRules(rules) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(RULES_FILE, JSON.stringify(rules, null, 2), "utf8");
  } catch (e) { console.warn("[APPROVALS] couldn't save rules:", e.message); }
}
function isAlwaysAllowed(kind, key) {
  if (!kind || !key) return false;
  const list = loadRules()[kind];
  return Array.isArray(list) && list.includes(String(key));
}
function addRule(kind, key) {
  const rules = loadRules();
  const list = Array.isArray(rules[kind]) ? rules[kind] : [];
  if (!list.includes(String(key))) list.push(String(key));
  rules[kind] = list;
  saveRules(rules);
}
function removeRule(kind, key) {
  const rules = loadRules();
  if (Array.isArray(rules[kind])) rules[kind] = rules[kind].filter(k => k !== String(key));
  saveRules(rules);
}

// ── BROADCAST ────────────────────────────────────────────────────
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch { clients.delete(res); } }
}

function publicEntry(e) {
  return {
    id: e.id, kind: e.kind, title: e.title, detail: e.detail, risk: e.risk,
    canAlways: !!e.canAlways, options: e.options || null, status: e.status,
    createdAt: e.createdAt, expiresAt: e.expiresAt,
  };
}

function snapshot() {
  return {
    pending: [...entries.values()].filter(e => e.status === "pending").map(publicEntry),
    feed: feed.slice(-30),
    rules: loadRules(),
  };
}

// ── LIVE FEED ────────────────────────────────────────────────────
// status: "info" | "running" | "done" | "error"
function step(title, detail = "", status = "info") {
  const item = {
    id: crypto.randomBytes(4).toString("hex"),
    at: Date.now(),
    title: String(title || "").slice(0, 160),
    detail: String(detail || "").slice(0, MAX_DETAIL),
    status,
  };
  feed.push(item);
  if (feed.length > MAX_FEED) feed.shift();
  broadcast("step", item);
  return item;
}

// ── PENDING CARDS ────────────────────────────────────────────────
function settle(id, status, extra = {}) {
  const e = entries.get(id);
  if (!e || e.status !== "pending") return false;
  e.status = status;
  if (e.timer) clearTimeout(e.timer);
  broadcast("resolved", { id, status, ...extra });
  // keep settled entries briefly so late clicks get a clear answer
  setTimeout(() => entries.delete(id), 60 * 1000).unref?.();
  return true;
}

function settleBySession(sessionId, status = "resolved") {
  if (!sessionId) return;
  for (const e of entries.values()) {
    if (e.status === "pending" && e.sessionId === sessionId) settle(e.id, status);
  }
}

function register(opts) {
  const ttl = opts.ttlMs || DEFAULT_TTL_MS;
  const e = {
    id: crypto.randomBytes(6).toString("hex"),
    kind: opts.kind || "action",
    sessionId: opts.sessionId || null,
    title: String(opts.title || "Jarvis needs your OK").slice(0, 160),
    detail: String(opts.detail || "").slice(0, MAX_DETAIL),
    risk: opts.risk || "medium",
    canAlways: !!(opts.canAlways && opts.ruleKey),
    ruleKey: opts.ruleKey || null,
    options: Array.isArray(opts.options) ? opts.options.slice(0, 6).map(String) : null,
    resolver: opts.resolver || null,
    status: "pending",
    createdAt: Date.now(),
    expiresAt: Date.now() + ttl,
    timer: null,
  };
  // one pending card per chat session: a new proposal replaces the old one
  if (e.sessionId) settleBySession(e.sessionId, "superseded");
  e.timer = setTimeout(() => {
    if (settle(e.id, "expired") && e.resolver) { try { e.resolver("deny"); } catch {} }
  }, ttl);
  e.timer.unref?.();
  entries.set(e.id, e);
  broadcast("approval", publicEntry(e));
  return e;
}

// Hook for jarvis-agent.js proposeAction(): turns a pending agent action
// (shell / type / neutralize) into a card.
function registerAgentAction(sessionId, kind, payload = {}) {
  if (kind === "shell") {
    return register({
      kind, sessionId, risk: "medium",
      title: "Run a command on your computer",
      detail: `$ ${payload.command || ""}`,
      canAlways: true, ruleKey: String(payload.command || ""),
    });
  }
  if (kind === "type") {
    return register({
      kind, sessionId, risk: "high",
      title: payload.newFile ? "Type this into a new file" : "Type this into the focused window",
      detail: payload.text || "",
    });
  }
  if (kind === "neutralize") {
    return register({
      kind, sessionId, risk: "high",
      title: "Neutralize a suspected threat",
      detail: payload.label || (payload.pid ? `Process ${payload.pid}` : payload.filePath || ""),
    });
  }
  return register({ kind, sessionId, title: `Approve: ${kind}`, detail: JSON.stringify(payload).slice(0, MAX_DETAIL) });
}

function registerPhoneCall(sessionId, pending = {}) {
  const who = pending.businessName || pending.businessNumber || "someone";
  const bits = [];
  if (pending.businessNumber) bits.push(pending.businessNumber);
  if (pending.purpose) bits.push(pending.purpose);
  if (pending.requestedTime) bits.push(`time: ${pending.requestedTime}`);
  return register({
    kind: "phone", sessionId, risk: "high", ttlMs: PHONE_TTL_MS,
    title: `Place a call to ${who}`, detail: bits.join(" · "),
  });
}

// ── GENERIC API for future features (self-update, env vars, deploys, email) ──
// await Approvals.request({ title, detail, risk, ruleKey? })
//   → "allow" | "always" | "deny"   (denied automatically on timeout)
// If ruleKey is given and the user has said "Always" for that exact key,
// it resolves "allow" immediately without showing a card.
// HEADLESS MODE (JARVIS_HEADLESS=1, set by the GitHub Action runner): there is
// no screen to tap, so cards are decided by fixed policy instead of timing out.
//   browse      → allow  (read-only page load inside the e2b sandbox)
//   code-update → allow  (earn-lab then opens a PULL REQUEST and does NOT merge;
//                         merging it yourself is the real approval)
//   everything else (transfers, wallet policy, shell, calls…) → deny
const HEADLESS_ALLOW = new Set(["browse", "code-update"]);
function isHeadless() { return process.env.JARVIS_HEADLESS === "1"; }

function request({ kind = "action", title, detail, risk = "medium", ruleKey = null, ttlMs = DEFAULT_TTL_MS }) {
  if (isHeadless()) {
    const ok = HEADLESS_ALLOW.has(kind);
    step(`${ok ? "Auto-approved (headless)" : "Auto-denied (headless)"}: ${title}`, detail, ok ? "info" : "error");
    return Promise.resolve(ok ? "allow" : "deny");
  }
  if (ruleKey && isAlwaysAllowed(kind, ruleKey)) {
    step(`Auto-approved: ${title}`, detail, "info");
    return Promise.resolve("allow");
  }
  return new Promise(resolve => {
    register({ kind, title, detail, risk, ttlMs, canAlways: !!ruleKey, ruleKey, resolver: resolve });
  });
}

// await Approvals.ask({ title, detail, options: ["A", "B"] }) → chosen string | null
function ask({ title, detail, options, ttlMs = QUESTION_TTL_MS }) {
  if (isHeadless()) {
    const first = Array.isArray(options) && options.length ? String(options[0]) : null;
    step(`Auto-answered (headless): ${title}`, first || "", "info");
    return Promise.resolve(first);
  }
  return new Promise(resolve => {
    register({
      kind: "question", title, detail, risk: "low", options, ttlMs,
      resolver: choice => resolve(choice === "deny" ? null : choice),
    });
  });
}

// ── ROUTES ───────────────────────────────────────────────────────
// hooks.runDecision(entry, "allow"|"deny") → result object. Provided by
// server.js for the kinds whose execution logic lives there.
const SENSITIVE_KINDS = new Set(["transfer", "code-update", "wallet-policy"]);
function mount(app, hooks = {}) {
  const express = require("express");
  const router = express.Router();

  router.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
    clients.add(res);
    const ka = setInterval(() => { try { res.write(": ka\n\n"); } catch {} }, 25000);
    req.on("close", () => { clearInterval(ka); clients.delete(res); });
  });

  router.get("/", (_req, res) => res.json(snapshot()));

  router.post("/:id/decide", async (req, res) => {
    const e = entries.get(String(req.params.id));
    if (!e || e.status !== "pending") return res.status(404).json({ ok: false, error: "That request already expired or was handled." });
    let decision = String(req.body?.decision || "");
    if (!["allow", "deny", "always"].includes(decision)) return res.status(400).json({ ok: false, error: "decision must be allow, deny or always" });
    if (e.options) return res.status(400).json({ ok: false, error: "This is a question — use /answer." });

    // Money moves, code pushes and wallet-policy changes need the owner
    // passcode to APPROVE (denying is always free).
    if (decision !== "deny" && SENSITIVE_KINDS.has(e.kind) && !(hooks.checkOwner && hooks.checkOwner(req))) {
      return res.status(403).json({ ok: false, needPasscode: true, error: "Owner passcode required to approve this." });
    }

    const original = decision;
    if (decision === "always") {
      if (!e.canAlways || !e.ruleKey) return res.status(400).json({ ok: false, error: "Always isn't available for this kind of action." });
      addRule(e.kind, e.ruleKey);
      decision = "allow";
    }

    settle(e.id, decision === "allow" ? "approved" : "denied");

    if (e.resolver) {
      try { e.resolver(original); } catch {}
      return res.json({ ok: true });
    }

    try {
      const result = hooks.runDecision ? await hooks.runDecision(e, decision) : null;
      const reply = result?.reply || "";
      step(decision === "allow" ? `Approved: ${e.title}` : `Denied: ${e.title}`, reply, decision === "allow" ? "done" : "info");
      res.json({ ok: true, result: result || null });
    } catch (err) {
      step(`Failed: ${e.title}`, err.message, "error");
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  router.post("/:id/answer", (req, res) => {
    const e = entries.get(String(req.params.id));
    if (!e || e.status !== "pending" || !e.options) return res.status(404).json({ ok: false, error: "That question is no longer open." });
    const choice = String(req.body?.choice || "");
    if (!e.options.includes(choice)) return res.status(400).json({ ok: false, error: "Not one of the options." });
    settle(e.id, "answered", { choice });
    try { e.resolver && e.resolver(choice); } catch {}
    res.json({ ok: true });
  });

  router.get("/rules", (_req, res) => res.json(loadRules()));
  router.delete("/rules", (req, res) => {
    const { kind, key } = req.body || {};
    if (!kind || !key) return res.status(400).json({ ok: false, error: "kind and key required" });
    removeRule(String(kind), String(key));
    res.json({ ok: true, rules: loadRules() });
  });

  app.use("/api/approvals", router);
}

module.exports = {
  mount, step, register, registerAgentAction, registerPhoneCall,
  request, ask, settle, settleBySession,
  isAlwaysAllowed, addRule, removeRule, snapshot,
};
