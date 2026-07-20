"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Comms Router v2.0
//
// Routes natural-language comms requests to teams-control.js
// (real Teams desktop app, vision-guided — no Graph API) and
// jarvis-agent.js (for plain "open X" launches like WhatsApp).
//
// Call tryRoute(text, opts) from server.js BEFORE other routing —
// if it returns null, the message wasn't a comms request and the
// caller should fall through to normal handling.
//
// opts.ownerName: the person Jarvis is speaking for, used in the
// "hey this is Jarvis, X's personal assistant" intro when messaging
// or calling someone. Defaults to config.json's owner.username.
// ═══════════════════════════════════════════════════════════════

const teams = require("./teams-control");
const agent = require("./jarvis-agent");
const { craftAgentIntro } = require("./personality");

let ownerNameCache = null;
function defaultOwnerName() {
  if (ownerNameCache) return ownerNameCache;
  try {
    ownerNameCache = require("./config.json")?.owner?.username || "the owner";
  } catch {
    ownerNameCache = "the owner";
  }
  return ownerNameCache;
}

// Pull a spoken availability note ("tell him I'll be back shortly",
// "let her know I'm not available") out of a command, if present.
function extractNote(text) {
  const m = /(?:and\s+)?tell\s+(?:him|her|them)\s+(.+)$/i.exec(text) ||
            /(?:and\s+)?(?:let\s+(?:him|her|them)\s+know)\s+(.+)$/i.exec(text);
  return m ? m[1].trim().replace(/[.!]+$/, "") : null;
}

function noteToStatus(note, ownerName = "the owner") {
  if (!note) return { status: "back_shortly" };

  // "tell him I'll be back shortly" / "let her know I'm not available" —
  // these ARE the availability line, not a separate note on top of one.
  if (/\bi('ll| will)\s+be\s+back\s+shortly\b|\bback\s+shortly\b|\bback\s+soon\b|\bbe\s+right\s+back\b/i.test(note)) {
    return { status: "back_shortly" };
  }
  if (/\bnot\s+avail|\bunavailable|\bcan'?t\s+(talk|come)|\bbusy\b/i.test(note)) {
    return { status: "unavailable" };
  }

  // "tell him to get on fortnite" — extractNote captures "to get on
  // fortnite" (an instruction FOR the recipient), not a statement about
  // the owner. Frame it as a request, not first-person speech.
  if (/^to\s+/i.test(note)) {
    return { status: `${ownerName} wants you ${note}.` };
  }

  // Anything else ("I'll be there in a sec") is a genuine statement to
  // relay — personalize into third person, since Jarvis is speaking
  // ABOUT the owner, not AS the owner.
  const personalized = note
    .replace(/^i('ll| will)\b/i, `${ownerName} will`)
    .replace(/^i('m| am)\b/i, `${ownerName} is`)
    .replace(/^i\b(?!'ll|'m)/i, ownerName);
  const capitalized = personalized.charAt(0).toUpperCase() + personalized.slice(1);
  return { status: `${ownerName} wanted me to let you know: ${capitalized}.` };
}

async function tryRoute(text, opts = {}) {
  const t = String(text || "").trim();
  const lower = t.toLowerCase();
  const ownerName = opts.ownerName || defaultOwnerName();

  // ── OPEN APPS ────────────────────────────────────────────────
  if (/^(open|launch|start)\s+teams\b/i.test(lower)) {
    await teams.openTeams();
    return { reply: `Teams is open, ${opts.T || "Sir"}.`, action: "OPEN_TEAMS" };
  }
  if (/^(open|launch|start)\s+whatsapp\b/i.test(lower)) {
    await teams.openWhatsApp();
    return { reply: `WhatsApp is open, ${opts.T || "Sir"}.`, action: "OPEN_WHATSAPP" };
  }

  // ── JOIN A MEETING ───────────────────────────────────────────
  if (/\bjoin\s+(the\s+)?meeting\b/i.test(lower)) {
    const hintMatch = /join\s+(?:the\s+)?meeting\s*(?:called|named|for|with)?\s*(.*)$/i.exec(t);
    const hint = hintMatch && hintMatch[1] ? hintMatch[1].trim() : null;
    await teams.joinMeeting(hint);
    return { reply: `Joining now, ${opts.T || "Sir"}.`, action: "JOIN_MEETING" };
  }

  // ── ACCEPT / DECLINE INCOMING CALL ───────────────────────────
  if (/\b(accept|answer)\s+the\s+call\b/i.test(lower)) {
    await teams.respondToIncomingCall(true);
    return { reply: `Answering now, ${opts.T || "Sir"}.`, action: "ACCEPT_CALL" };
  }
  if (/\bdecline\s+the\s+call\b|\bhang\s+up\s+on\s+(the\s+)?call\b/i.test(lower)) {
    await teams.respondToIncomingCall(false);
    return { reply: `Declined, ${opts.T || "Sir"}.`, action: "DECLINE_CALL" };
  }

  // ── CHECK A CHAT ─────────────────────────────────────────────
  // "check teams if I have a chat with rithik" / "check teams if I
  // have any messages from rithik" / "any messages from rithik on teams"
  let m = /check\s+teams\s+(?:if\s+(?:i\s+have\s+)?(?:a\s+)?chat|for\s+(?:messages|chats))\s+(?:with|from)\s+(\w[\w .'-]*)/i.exec(t)
       || /(?:any\s+)?messages?\s+from\s+(\w[\w .'-]*)\s+on\s+teams/i.exec(t)
       || /check\s+(?:my\s+)?teams\s+chat\s+with\s+(\w[\w .'-]*)/i.exec(t);
  if (m) {
    const person = m[1].trim();
    const summary = await teams.checkChatWith(person);
    return { reply: summary, action: "CHECK_CHAT", meta: { person } };
  }

  // ── CALL SOMEONE ON TEAMS ────────────────────────────────────
  // "call rithik on teams and tell him to get on fortnite, I'll be
  // back shortly" / "video call sarah on teams"
  m = /(video\s+)?call\s+(\w[\w .'-]*?)\s+on\s+teams\b(.*)$/i.exec(t);
  if (m) {
    const isVideo = !!m[1];
    const person = m[2].trim();
    const rest = m[3] || "";
    const note = extractNote(rest);
    const { status } = noteToStatus(note, ownerName);

    await teams.callOnTeams(person, isVideo ? "video" : "audio");

    // If there's something to relay, hand off to call-voice.js
    // (real TTS spoken into the live call) rather than texting it —
    // per the "talk, don't just message" preference.
    if (note) {
      const line = craftAgentIntro({ ownerName, status });
      return {
        reply: `Calling ${person} now, ${opts.T || "Sir"}. Once they pick up I'll tell them: "${line}"`,
        action: "CALL_AND_SPEAK",
        meta: { person, lineToSpeak: line, callType: isVideo ? "video" : "audio" },
      };
    }
    return { reply: `Calling ${person} on Teams now, ${opts.T || "Sir"}.`, action: "CALL", meta: { person, callType: isVideo ? "video" : "audio" } };
  }

  // ── MESSAGE (TEXT) SOMEONE ON TEAMS ──────────────────────────
  // "message rithik on teams: get on fortnite" — the explicit,
  // still-supported texting path (calls no longer default to this).
  m = /message\s+(\w[\w .'-]*?)\s+on\s+teams\s*[:,]?\s*(.+)$/i.exec(t);
  if (m) {
    const person = m[1].trim();
    const body = m[2].trim();
    await teams.messageOnTeams(person, body);
    return { reply: `Sent to ${person} on Teams, ${opts.T || "Sir"}.`, action: "MESSAGE", meta: { person, body } };
  }

  return null; // not a comms request — caller falls through to normal routing
}

module.exports = { tryRoute, extractNote, noteToStatus, defaultOwnerName };
