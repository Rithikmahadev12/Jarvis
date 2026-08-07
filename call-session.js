"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Call Session (live phone-call widget bus)
//
// phone-agent.js places real phone calls that take anywhere from a
// few seconds (dialing) to a few minutes (the actual conversation).
// The chat endpoint answers instantly (see server.js), so the only
// way the frontend's little "calling..." widget can show live
// progress — preparing / confirm / dialing / on the call / ended —
// is a side-channel it can subscribe to right after the chat reply
// comes back. This is that side-channel: one SSE stream per call,
// keyed by a callSessionId handed to the frontend in the chat
// reply's meta.
//
// Events are buffered (not just broadcast) because there's a real
// race: the chat POST returns, the frontend reads meta.callSessionId
// and opens an EventSource — but phone-agent.js may have already
// fired "preparing"/"confirm" before that connection lands. Every
// new subscriber gets the full backlog replayed first, so it never
// misses the opening state.
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");

const sessions = new Map(); // id -> { events, clients, meta, createdAt }
const MAX_EVENTS = 40;
const CLEANUP_MS = 10 * 60 * 1000; // reap finished sessions 10 min after they end
const TERMINAL_EVENTS = new Set(["ended", "cancelled", "failed", "needs_number"]);

function create(meta) {
  const id = crypto.randomBytes(8).toString("hex");
  sessions.set(id, { events: [], clients: new Set(), meta: meta || {}, createdAt: Date.now() });
  return id;
}

function get(id) {
  return sessions.get(id) || null;
}

function emit(id, type, data) {
  const s = sessions.get(id);
  if (!s) return;
  const evt = { type, data: data || {} };
  s.events.push(evt);
  if (s.events.length > MAX_EVENTS) s.events.shift();
  for (const res of s.clients) {
    try { res.write(`event: ${type}\ndata: ${JSON.stringify(evt.data)}\n\n`); } catch { /* client gone */ }
  }
  if (TERMINAL_EVENTS.has(type)) {
    setTimeout(() => sessions.delete(id), CLEANUP_MS);
  }
}

function subscribe(id, res) {
  const s = sessions.get(id);
  if (!s) return false;
  s.clients.add(res);
  for (const evt of s.events) {
    try { res.write(`event: ${evt.type}\ndata: ${JSON.stringify(evt.data)}\n\n`); } catch { /* ignore */ }
  }
  return true;
}

function unsubscribe(id, res) {
  const s = sessions.get(id);
  if (s) s.clients.delete(res);
}

module.exports = { create, get, emit, subscribe, unsubscribe };
