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
  let t = String(text || "").trim();
  const ownerName = opts.ownerName || defaultOwnerName();

  // ── COMPOUND: "open teams and <do something>" ─────────────────
  // Every branch below already opens Teams itself (via
  // openChatWith -> openTeams()), so if the message is "open teams"
  // PLUS a trailing instruction, strip that leading "open teams
  // and/," off and keep routing on what's left instead of stopping
  // dead after just opening the app. teamsImplied tracks that we did
  // this, so the call/message/check-chat matchers below know they
  // can accept the leftover text even without an explicit "on teams"
  // in it (e.g. "message rithik hi" instead of "message rithik on
  // teams: hi").
  let teamsImplied = false;
  const openPrefix = /^(?:open|launch|start)\s+teams\b\s*(?:and\s+|,\s*|\s+)?(.*)$/i.exec(t);
  if (openPrefix && openPrefix[1] && openPrefix[1].trim()) {
    t = openPrefix[1].trim();
    teamsImplied = true;
  }
  const lower = t.toLowerCase();

  // ── OPEN APPS (bare — nothing else was asked) ──────────────────
  if (!teamsImplied && /^(open|launch|start)\s+teams\b/i.test(lower)) {
    await teams.openTeams();
    return { reply: `Teams is open, ${opts.T || "Sir"}.`, action: "OPEN_TEAMS" };
  }
  if (/^(open|launch|start)\s+whatsapp\b/i.test(lower)) {
    await teams.openWhatsApp();
    return { reply: `WhatsApp is open, ${opts.T || "Sir"}.`, action: "OPEN_WHATSAPP" };
  }

  // ── JOIN A MEETING VIA A LINK ─────────────────────────────────
  // "join this meeting link https://... and say I'll be there in 5"
  // "join https://meet.google.com/xyz-abcd" (no message — just join)
  // Checked BEFORE the calendar-based "join the meeting" check below
  // — a URL in the message means this is the link flow regardless of
  // whether "the meeting" also happens to appear in the sentence.
  {
    const urlMatch = /https?:\/\/\S+/i.exec(t);
    if (urlMatch && /\bjoin\b/i.test(t)) {
      const url = urlMatch[0].replace(/[.,)\]]+$/, ""); // trim trailing sentence punctuation
      const sayMatch = /\b(?:and\s+)?(?:say|tell them|tell the meeting)\s*[:,]?\s*(.+)$/i.exec(t);
      const lineToSpeak = sayMatch
        ? sayMatch[1].trim().replace(/^["']|["']$/g, "").replace(/[.!]+$/, "")
        : null;

      await teams.joinMeetingByLink(url);

      if (lineToSpeak) {
        return {
          reply: `Joined, ${opts.T || "Sir"}. Once things settle I'll say: "${lineToSpeak}"`,
          action: "JOIN_LINK_AND_SPEAK",
          meta: { url, lineToSpeak },
        };
      }
      return { reply: `Joined the meeting, ${opts.T || "Sir"}.`, action: "JOIN_LINK", meta: { url } };
    }
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
  // — plus, when teamsImplied, the bare "check chat with rithik" left
  // over after stripping "open teams and ".
  let m = /check\s+teams\s+(?:if\s+(?:i\s+have\s+)?(?:a\s+)?chat|for\s+(?:messages|chats))\s+(?:with|from)\s+(\w[\w .'-]*)/i.exec(t)
       || /(?:any\s+)?messages?\s+from\s+(\w[\w .'-]*)\s+on\s+teams/i.exec(t)
       || /check\s+(?:my\s+)?teams\s+chat\s+with\s+(\w[\w .'-]*)/i.exec(t)
       || (teamsImplied && /^check\s+(?:if\s+(?:i\s+have\s+)?(?:a\s+)?)?chat\s+with\s+(\w[\w .'-]*)/i.exec(t));
  if (m) {
    const person = m[1].trim();
    const summary = await teams.checkChatWith(person);
    return { reply: summary, action: "CHECK_CHAT", meta: { person } };
  }

  // ── CALL SOMEONE ON TEAMS ────────────────────────────────────
  // "call rithik on teams and tell him to get on fortnite, I'll be
  // back shortly" / "video call sarah on teams" — plus, when
  // teamsImplied, "call rithik" / "call rithik and tell him ..."
  // left over after stripping "open teams and ".
  m = /(video\s+)?call\s+(\w[\w .'-]*?)\s+on\s+teams\b(.*)$/i.exec(t)
    || (teamsImplied && /^(video\s+)?call\s+(\w[\w .'-]*?)((?:\s+(?:and\s+)?tell\s+.+)|(?:\s+(?:and\s+)?let\s+(?:him|her|them)\s+know\s+.+))?$/i.exec(t));
  if (m) {
    const isVideo = !!m[1];
    const person = m[2].trim();
    const rest = m[3] || "";
    const note = extractNote(rest);
    const { status } = noteToStatus(note, ownerName);

    const matchedName = await teams.callOnTeams(person, isVideo ? "video" : "audio");
    // openChatWith's closest-match fallback means matchedName can differ
    // from what was actually asked for (nickname, misspelling, etc.) —
    // flag that in the reply so it's not silently calling the wrong person.
    const matchNote = matchedName.toLowerCase() !== person.toLowerCase()
      ? ` (closest match to "${person}" I found was "${matchedName}")`
      : "";

    // If there's something to relay, hand off to call-voice.js
    // (real TTS spoken into the live call) rather than texting it —
    // per the "talk, don't just message" preference.
    if (note) {
      const line = craftAgentIntro({ ownerName, status });
      return {
        reply: `Calling ${matchedName} now${matchNote}, ${opts.T || "Sir"}. Once they pick up I'll tell them: "${line}"`,
        action: "CALL_AND_SPEAK",
        meta: { person: matchedName, lineToSpeak: line, callType: isVideo ? "video" : "audio" },
      };
    }
    return { reply: `Calling ${matchedName} on Teams now${matchNote}, ${opts.T || "Sir"}.`, action: "CALL", meta: { person: matchedName, callType: isVideo ? "video" : "audio" } };
  }

  // ── MESSAGE (TEXT) SOMEONE ON TEAMS ──────────────────────────
  // "message rithik on teams: get on fortnite" — the explicit,
  // still-supported texting path — plus, when teamsImplied, the
  // bare "message rithik hi" / "message rithik: hi" / "message
  // rithik, hi" left over after stripping "open teams and ". The
  // bare form only captures a single-word name before the message
  // body (no unambiguous delimiter otherwise) — use a colon or comma
  // after the name if it's more than one word.
  m = /message\s+(\w[\w .'-]*?)\s+on\s+teams\s*[:,]?\s*(.+)$/i.exec(t)
    || (teamsImplied && (
         /^message\s+(\w[\w .'-]*?)\s*[:,]\s*(.+)$/i.exec(t) ||
         /^message\s+(\w[\w'-]*)\s+(.+)$/i.exec(t)
       ));
  if (m) {
    const person = m[1].trim();
    const body = m[2].trim();
    const matchedName = await teams.messageOnTeams(person, body);
    const matchNote = matchedName.toLowerCase() !== person.toLowerCase()
      ? ` (closest match to "${person}" I found was "${matchedName}")`
      : "";
    return { reply: `Sent to ${matchedName} on Teams${matchNote}, ${opts.T || "Sir"}.`, action: "MESSAGE", meta: { person: matchedName, body } };
  }

  // Bare "open teams and" with nothing recognizable after it still
  // opens Teams rather than falling through as "not a comms request".
  if (teamsImplied) {
    await teams.openTeams();
    return { reply: `Teams is open, ${opts.T || "Sir"}.`, action: "OPEN_TEAMS" };
  }

  return null; // not a comms request — caller falls through to normal routing
}

module.exports = { tryRoute, extractNote, noteToStatus, defaultOwnerName };
