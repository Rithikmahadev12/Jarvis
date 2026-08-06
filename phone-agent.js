"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Phone Agent v1.0
//
// This is the actual "Hey Jarvis, call Great Clips and book me a
// 10am" behavior, built on top of agentphone.js.
//
// FLOW (exactly the one you described):
//   1. bookAppointment(): Jarvis calls the business, asks for the
//      requested time. If it's free, books it and we're done in one
//      call. If NOT free, Jarvis asks what IS available, then ends
//      the call WITHOUT committing to anything — real businesses
//      don't want an assistant booking a slot the owner hasn't
//      actually agreed to.
//   2. If an alternative time came back, that's returned to the
//      caller (server.js) as a "needs owner decision" result, along
//      with a pending confirmation stored in memory here.
//   3. Your server.js code reports that to the owner ("they can't do
//      10, but 11:30 is open — want that instead?") and waits for a
//      yes/no, same as any other pending-confirmation flow already
//      in this codebase (see jarvis-agent.js's proposeAction/
//      getPendingAction, schedule.js's setPendingConfirm).
//   4. On "yes", call confirmPendingAppointment() — this places a
//      SECOND call back to the same business confirming the new
//      time. On "no", call cancelPendingAppointment() — no second
//      call is made, nothing is booked.
//   5. Whoever handles the confirmed result should offer to add it
//      to the calendar (schedule.js / google.js) — this file only
//      handles the phone side, not the calendar side.
//
// ── SPECIAL NOTES ────────────────────────────────────────────────
// "also tell them his personal number is X, call him at that number
// if they need to talk to him" — pass that as specialNote and it's
// woven verbatim into the call's systemPrompt as an instruction, not
// spoken automatically on every call; the AI on the call decides
// when it's actually relevant to bring up, same as a human assistant
// would.
//
// ── FINDING THE BUSINESS'S NUMBER ─────────────────────────────────
// Jarvis has no phone-number lookup service wired in by default. Two
// ways a number gets found, in order:
//   1. The caller already knows it (e.g. the user said the number,
//      or the LLM tool-call already carries it from earlier context).
//   2. data/known-businesses.json — a tiny local phone book you (or
//      Jarvis, once you tell it a number) can add entries to, keyed
//      by name, so you only ever have to give a number once. See
//      the file for the format.
// If neither has it, bookAppointment() returns a NEEDS_NUMBER result
// asking the owner for it — it never guesses a phone number.
// ═══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const AgentPhone = require("./agentphone");
const GroqKeys = require("./groq-keys");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_AGENT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

const KNOWN_BUSINESSES_PATH = path.join(__dirname, "data", "known-businesses.json");

// One pending confirmation at a time per session — mirrors the same
// sessionId-keyed singleton pattern jarvis-agent.js's proposeAction/
// getPendingAction already uses, so the LLM tool-call for confirming
// never needs to know or pass around an id.
const pending = new Map(); // sessionId -> { ...details }

// ── BUSINESS PHONE BOOK ───────────────────────────────────────────
function loadKnownBusinesses() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_BUSINESSES_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveKnownBusiness(name, number) {
  const book = loadKnownBusinesses();
  book[name.trim().toLowerCase()] = number.trim();
  try {
    fs.mkdirSync(path.dirname(KNOWN_BUSINESSES_PATH), { recursive: true });
    fs.writeFileSync(KNOWN_BUSINESSES_PATH, JSON.stringify(book, null, 2));
  } catch (e) {
    console.error("[PHONE-AGENT] Could not save business number:", e.message);
  }
}

function lookupBusinessNumber(name) {
  const book = loadKnownBusinesses();
  return book[name.trim().toLowerCase()] || null;
}

// ── GROQ: turn a finished call transcript into a structured outcome ─
async function summarizeCallOutcome({ transcripts, requestedTime, businessName }) {
  if (!GroqKeys.hasGroqKey()) {
    // No Groq configured — fall back to a dumb heuristic rather than
    // crashing the whole flow.
    const joined = (transcripts || []).map((t) => `${t.transcript} ${t.response}`).join(" ").toLowerCase();
    const booked = joined.includes(String(requestedTime).toLowerCase()) && (joined.includes("booked") || joined.includes("confirmed") || joined.includes("all set"));
    return { booked, alternativeTime: null, summary: "Groq not configured — could not analyze the call precisely.", raw: joined.slice(0, 500) };
  }

  const convo = (transcripts || [])
    .map((t) => `Caller (business): ${t.transcript}\nJarvis: ${t.response}`)
    .join("\n");

  const systemPrompt =
    "You analyze a transcript of a phone call Jarvis (an AI assistant) placed to a business to book an appointment. " +
    `The requested time was "${requestedTime}" at "${businessName}". ` +
    "Reply with ONLY a JSON object, no prose, no markdown fences, in this exact shape: " +
    '{"booked": boolean, "bookedTime": string|null, "alternativeTimeOffered": string|null, "summary": string}. ' +
    '"booked" is true only if the business explicitly confirmed a specific appointment. ' +
    '"alternativeTimeOffered" is the next available time the business mentioned, if the requested time was not available and Jarvis did NOT book on the spot. ' +
    '"summary" is one short sentence a human would want to hear, in plain language.';

  const doFetch = (key) => fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: convo || "(no transcript captured)" },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });

  const totalKeys = GroqKeys.groqKeyCount();
  let res, lastError = null;
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = GroqKeys.currentGroqKey();
    const isLastKey = attempt === totalKeys - 1;
    try {
      res = await doFetch(key);
    } catch (e) {
      lastError = e;
      if (isLastKey) throw new Error(`Could not reach Groq: ${e.message}`);
      GroqKeys.rotateGroqKey();
      continue;
    }
    if (!res.ok && (res.status === 429 || res.status >= 500) && !isLastKey) {
      GroqKeys.rotateGroqKey();
      continue;
    }
    break;
  }
  if (!res.ok) throw new Error(`Groq analysis failed (${res.status})`);

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  try {
    return JSON.parse(raw);
  } catch {
    return { booked: false, alternativeTimeOffered: null, summary: "Couldn't parse the call outcome cleanly — check the transcript directly.", raw };
  }
}

// ── SYSTEM PROMPT BUILDER ──────────────────────────────────────────
function buildSystemPrompt({ ownerName, businessName, requestedTime, specialNote, confirmMode, confirmedTime }) {
  const intro = `You are Jarvis, ${ownerName}'s personal AI assistant, calling ${businessName || "this business"} on ${ownerName}'s behalf. ` +
    `Start the call by clearly identifying yourself: "Hi, this is Jarvis, ${ownerName}'s personal assistant." Be brief, polite, and businesslike.`;

  let task;
  if (confirmMode) {
    task = `${ownerName} has confirmed the appointment time of ${confirmedTime}. Your ONLY job on this call is to confirm that exact time with them and get a clear yes. ` +
      `Once they confirm, thank them and end the call politely. Do not renegotiate the time.`;
  } else {
    task = `Ask if they can book an appointment at ${requestedTime}. ` +
      `If YES, confirm it clearly out loud (repeat the time back) and end the call — you're done, do not keep talking. ` +
      `If NO, ask them what the next available time is, get a clear specific answer, THEN politely say you'll check with ${ownerName} and get back to them, and end the call. ` +
      `Do NOT book any time other than the exact one requested without checking back first — you are not authorized to accept alternative times on this call.`;
  }

  const note = specialNote
    ? `\n\nAdditional instruction from ${ownerName}, use your judgment on when it's actually relevant to mention: ${specialNote}`
    : "";

  return `${intro}\n\n${task}${note}`;
}

// ── STEP 1: the negotiating call ───────────────────────────────────
async function bookAppointment({ sessionId, ownerName, businessName, businessNumber, requestedTime, specialNote }) {
  const toNumber = businessNumber || lookupBusinessNumber(businessName || "");
  if (!toNumber) {
    return {
      status: "NEEDS_NUMBER",
      reply: `I don't have a phone number on file for ${businessName}, ${ownerName} — what's their number?`,
    };
  }
  if (businessNumber && businessName) saveKnownBusiness(businessName, businessNumber);

  const systemPrompt = buildSystemPrompt({ ownerName, businessName, requestedTime, specialNote, confirmMode: false });

  let call;
  try {
    call = await AgentPhone.placeOutboundCall({
      toNumber,
      systemPrompt,
      initialGreeting: `Hi, this is Jarvis, ${ownerName}'s personal assistant.`,
      ownerName,
    });
  } catch (e) {
    return { status: "CALL_FAILED", reply: `I couldn't get the call to ${businessName} to go through, ${ownerName} — ${e.message}` };
  }

  let finished;
  try {
    finished = await AgentPhone.waitForCallCompletion(call.id);
  } catch (e) {
    return { status: "CALL_FAILED", reply: `The call to ${businessName} didn't wrap up cleanly, ${ownerName} — ${e.message}`, callId: call.id };
  }

  if (finished.status === "failed") {
    return { status: "CALL_FAILED", reply: `The call to ${businessName} didn't connect, ${ownerName}.`, callId: call.id };
  }

  const outcome = await summarizeCallOutcome({
    transcripts: finished.transcripts,
    requestedTime,
    businessName,
  });

  if (outcome.booked) {
    return {
      status: "BOOKED",
      reply: `Done, ${ownerName} — ${businessName} confirmed you for ${outcome.bookedTime || requestedTime}. Want me to put that on your calendar?`,
      outcome,
      callId: call.id,
    };
  }

  if (outcome.alternativeTimeOffered) {
    pending.set(sessionId, {
      ownerName,
      businessName,
      businessNumber: toNumber,
      alternativeTime: outcome.alternativeTimeOffered,
      specialNote,
      createdAt: Date.now(),
    });
    return {
      status: "NEEDS_OWNER_DECISION",
      reply: `${businessName} can't do ${requestedTime}, ${ownerName} — but ${outcome.alternativeTimeOffered} is open. Want me to call back and lock that in?`,
      outcome,
      callId: call.id,
    };
  }

  return {
    status: "UNCLEAR",
    reply: `I called ${businessName}, ${ownerName}, but I'm not fully sure how it landed: ${outcome.summary}`,
    outcome,
    callId: call.id,
  };
}

// ── STEP 2a: owner said yes — call back and confirm ─────────────────
async function confirmPendingAppointment(sessionId) {
  const p = pending.get(sessionId);
  if (!p) return { status: "NOT_FOUND", reply: "I don't have that pending appointment anymore — want me to call again from scratch?" };

  const systemPrompt = buildSystemPrompt({
    ownerName: p.ownerName,
    businessName: p.businessName,
    specialNote: p.specialNote,
    confirmMode: true,
    confirmedTime: p.alternativeTime,
  });

  let call;
  try {
    call = await AgentPhone.placeOutboundCall({
      toNumber: p.businessNumber,
      systemPrompt,
      initialGreeting: `Hi, this is Jarvis, ${p.ownerName}'s personal assistant, calling back.`,
      ownerName: p.ownerName,
    });
    await AgentPhone.waitForCallCompletion(call.id);
  } catch (e) {
    return { status: "CALL_FAILED", reply: `The confirmation call to ${p.businessName} didn't go through, ${p.ownerName} — ${e.message}` };
  }

  pending.delete(sessionId);
  return {
    status: "CONFIRMED",
    reply: `That works — ${p.businessName} has you down for ${p.alternativeTime}, ${p.ownerName}. Shall I put that in your calendar?`,
    businessName: p.businessName,
    time: p.alternativeTime,
  };
}

// ── STEP 2b: owner said no ────────────────────────────────────────
function cancelPendingAppointment(sessionId) {
  const p = pending.get(sessionId);
  pending.delete(sessionId);
  return { status: "CANCELLED", reply: p ? `No problem — I won't book that with ${p.businessName}.` : "Nothing to cancel." };
}

function getPending(sessionId) {
  return pending.get(sessionId) || null;
}

module.exports = {
  bookAppointment,
  confirmPendingAppointment,
  cancelPendingAppointment,
  getPending,
  saveKnownBusiness,
  lookupBusinessNumber,
};
