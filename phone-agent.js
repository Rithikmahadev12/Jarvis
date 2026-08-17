"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Phone Agent v2.0
//
// "Hey Jarvis, call the mechanic shop and ask their oil-change
// price" behavior, wired to a live widget on the frontend via
// call-session.js instead of just blocking silently until the whole
// call is over.
//
// NOTE: outbound calls go through phone-provider.js, which tries the
// real, legitimate PSTN backends only — AgentPhone (agentphone.js)
// first, falling back to Twilio (twilio-call.js) if AgentPhone isn't
// configured or every AgentPhone account is exhausted. See
// phone-provider.js's own header for how the fallback decision works.
// The `AgentPhone` name below is kept only because it matches that
// module's exported function shape 1:1 (placeOutboundCall/getCall/
// waitForCallCompletion) — everything from here down is unchanged.
//
// FLOW:
//   1. proposeCall(): looks up the number, emits "preparing" then
//      "confirm" on the call's CallSession stream, and stores a
//      pending confirmation keyed by the CHAT sessionId (mirrors
//      jarvis-agent.js's proposeAction/getPendingAction pattern).
//      Nothing is dialed yet.
//   2. server.js's resolvePendingPhoneCall() catches the user's next
//      yes/no ("do it" / "cancel") and calls confirmPendingCall() or
//      cancelPendingCall().
//   3. confirmPendingCall() kicks off _runCall() in the background
//      (NOT awaited by the caller — the chat reply comes back
//      instantly) which emits "dialing" -> "on_call" -> "ended" as
//      the real call progresses, polling AgentPhone for status.
//   4. If the business couldn't do the requested time but offered an
//      alternative, that's stashed in pendingAltTime (same shape as
//      before) so a plain "yes book that" / "no" reply routes to
//      confirmPendingAppointment()/cancelPendingAppointment() and
//      places a SECOND call locking in the new time. This part is
//      unchanged from v1 — no live widget on the callback call, it's
//      quick and single-purpose.
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
// ── RECONNAISSANCE VS. BOOKING ────────────────────────────────────
// Most real calls aren't "book this exact slot" — they're "find out
// their price / earliest opening / hours, don't commit to anything."
// Pass `purpose` for that (free text — "ask their oil-change price
// and earliest slot"). Only pass `commit: true` when the user has
// actually authorized Jarvis to book on the spot; otherwise the call
// is reconnaissance-only regardless of whether requestedTime is set.
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
// If neither has it, proposeCall() returns a NEEDS_NUMBER result
// asking the owner for it — it never guesses a phone number.
// ═══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
// OUTBOUND calls ("Jarvis, call the mechanic shop") go through
// phone-provider.js: AgentPhone (real PSTN, paid) first, Twilio
// (also real PSTN, paid) as an automatic fallback if AgentPhone isn't
// configured or runs out of usable accounts. Same
// placeOutboundCall/getCall/waitForCallCompletion shape either way,
// so nothing below this line had to change. INBOUND calling (people
// calling Jarvis's own number) is a separate feature and still goes
// through agentphone.js directly — see server.js.
const AgentPhone = require("./phone-provider");
const GroqKeys = require("./groq-keys");
const CallSession = require("./call-session");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_AGENT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

// NOTE: the shipped known-businesses.json lives at the repo root, not
// under data/ — check both so an existing root file is actually found,
// but always WRITE to the root path to match what's already there.
const KNOWN_BUSINESSES_PATH = path.join(__dirname, "known-businesses.json");
const KNOWN_BUSINESSES_PATH_LEGACY = path.join(__dirname, "data", "known-businesses.json");

// One pending call-confirmation, and one pending alt-time confirmation,
// at a time per (chat) session — mirrors jarvis-agent.js's
// proposeAction/getPendingAction singleton pattern.
const pendingCalls = new Map();    // chatSessionId -> { callSessionId, ...details }
const pendingAltTime = new Map();  // chatSessionId -> { ...details, alternativeTime }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Call statuses that mean "still ringing/connecting" — anything else
// (that isn't completed/failed) is treated as "answered, in progress"
// so the widget can flip to ON THE CALL. AgentPhone's exact status
// vocabulary isn't guaranteed, so this errs toward a short allowlist
// rather than guessing every possible "connected" string.
const CONNECTING_STATUSES = new Set(["queued", "created", "initiated", "ringing", "dialing", "pending"]);

// ── BUSINESS PHONE BOOK ───────────────────────────────────────────
function loadKnownBusinesses() {
  try {
    return JSON.parse(fs.readFileSync(KNOWN_BUSINESSES_PATH, "utf8"));
  } catch {
    try {
      return JSON.parse(fs.readFileSync(KNOWN_BUSINESSES_PATH_LEGACY, "utf8"));
    } catch {
      return {};
    }
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
    const booked = !!requestedTime && joined.includes(String(requestedTime).toLowerCase()) && (joined.includes("booked") || joined.includes("confirmed") || joined.includes("all set"));
    return { booked, alternativeTimeOffered: null, summary: "Groq not configured — could not analyze the call precisely.", raw: joined.slice(0, 500) };
  }

  const convo = (transcripts || [])
    .map((t) => {
      // Defensive against field-name variants, since AgentPhone's
      // actual per-turn shape was never confirmed (see the caller in
      // phone-agent.js) — try the plausible names before giving up
      // and showing the raw object so it's at least visible.
      const businessSaid = t.transcript ?? t.callerText ?? t.text ?? t.content ?? (t.role === "user" ? t.message : null);
      const jarvisSaid = t.response ?? t.assistantText ?? t.reply ?? (t.role === "assistant" ? t.message : null);
      if (businessSaid == null && jarvisSaid == null) {
        console.warn(`[PHONE-AGENT] Unrecognized transcript-turn shape — none of the expected fields matched. Raw turn: ${JSON.stringify(t).slice(0, 500)}`);
        return `(unrecognized turn shape: ${JSON.stringify(t).slice(0, 200)})`;
      }
      return `Caller (business): ${businessSaid ?? ""}\nJarvis: ${jarvisSaid ?? ""}`;
    })
    .join("\n");

  const systemPrompt =
    "You analyze a transcript of a phone call Jarvis (an AI assistant) placed to a business on the owner's behalf. " +
    `The goal of the call was: "${requestedTime || "gather information"}" at "${businessName}". ` +
    "Reply with ONLY a JSON object, no prose, no markdown fences, in this exact shape: " +
    '{"booked": boolean, "bookedTime": string|null, "alternativeTimeOffered": string|null, "summary": string}. ' +
    '"booked" is true only if the business explicitly confirmed a specific appointment. ' +
    '"alternativeTimeOffered" is the next available time the business mentioned, if a requested time was not available and Jarvis did NOT book on the spot. ' +
    '"summary" is one or two short sentences a human would want to hear as a spoken report — plain language, specific numbers/times/prices if any were given, and end by saying what (if anything) still needs a decision. Address the owner directly, do not use their name (it will be appended separately).';

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
function buildSystemPrompt({ ownerName, businessName, requestedTime, purpose, specialNote, confirmMode, confirmedTime, commit }) {
  const intro = `You are Jarvis, ${ownerName}'s personal AI assistant, calling ${businessName || "this business"} on ${ownerName}'s behalf. ` +
    `Start the call by clearly identifying yourself: "Hi, this is Jarvis, ${ownerName}'s personal assistant." Be brief, polite, and businesslike.`;

  let task;
  if (confirmMode) {
    task = `You (Jarvis) already spoke with them earlier${requestedTime ? ` about booking at ${requestedTime}` : ""}, and they offered ${confirmedTime} instead. ` +
      `${ownerName} has now confirmed ${confirmedTime} works. Start by briefly reminding them you spoke earlier today, then confirm you'd like to lock in ${confirmedTime}. ` +
      `Get a clear yes, thank them, and end the call politely. Do not renegotiate the time.`;
  } else if (commit && requestedTime) {
    task = `Ask if they can book an appointment at ${requestedTime}. ` +
      `If YES, confirm it clearly out loud (repeat the time back) and end the call — you're done, do not keep talking. ` +
      `If NO, ask them what the next available time is, get a clear specific answer, THEN politely say you'll check with ${ownerName} and get back to them, and end the call. ` +
      `Do NOT book any time other than the exact one requested without checking back first — you are not authorized to accept alternative times on this call.`;
  } else {
    const goal = purpose || (requestedTime ? `ask about availability around ${requestedTime}` : "ask a couple of quick questions and report back");
    task = `Your goal on this call: ${goal}. This is reconnaissance only — do NOT book, confirm, pay for, or commit ${ownerName} to anything on this call. ` +
      `Get clear, specific answers (prices, times, hours, availability — whatever is relevant), thank them, and end the call politely once you have what you need.`;
  }

  // ── DON'T TREAT A VAGUE ACKNOWLEDGEMENT AS AN ANSWER ─────────────
  // Without this, the model on the call tends to hear a filler word
  // like "okay" or "sure" from the other side and move on as if the
  // actual question had been answered, leaving the transcript (and
  // the owner's report) with no real information in it. Applies to
  // every branch above, so it's appended once here rather than
  // repeated in each task string.
  const noVagueAnswers = `\n\nImportant: a filler acknowledgement like "okay," "sure," "yeah," or "got it" from the other side is NOT an answer to whatever you just asked — it just means they heard you. If you ask a direct question (a price, a time, availability, a yes/no), do not move on or treat it as resolved until they actually give you the specific information. If they respond with only a vague acknowledgement, politely ask the question again in a slightly different way before continuing.`;

  const note = specialNote
    ? `\n\nAdditional instruction from ${ownerName}, use your judgment on when it's actually relevant to mention: ${specialNote}`
    : "";

  return `${intro}\n\n${task}${noVagueAnswers}${note}`;
}

// ── CONFIRM-STEP COPY ────────────────────────────────────────────
function buildConfirmMessage({ ownerName, businessName, toNumber, requestedTime, purpose, commit }) {
  const label = businessName || "them";
  let goal;
  if (commit && requestedTime) goal = `ask about booking an appointment for ${requestedTime}`;
  else if (purpose) goal = purpose.replace(/[.\s]+$/, "");
  else if (requestedTime) goal = `ask about availability around ${requestedTime}`;
  else goal = "ask a couple of quick questions";
  const commitNote = commit ? "" : " — no commitment, just gathering information";
  return `I'll ring ${label} to ${goal}${commitNote}. Shall I ring them, ${ownerName}? I'll call ${toNumber}.`;
}

// ── SWITCH NOTICE HELPER ────────────────────────────────────────
// Prepends a one-time "switched to backup, new number is X" line
// (see agentphone.js's consumeSwitchNotice()) to whatever reply is
// about to be shown/said, so the owner actually hears about a
// failover instead of it happening silently in the background.
function withSwitchNotice(reply) {
  let notice;
  try {
    notice = AgentPhone.consumeSwitchNotice();
  } catch {
    notice = null;
  }
  if (!notice) return reply;
  const line = `Quick heads up — I had to switch to a backup phone account${notice.newNumber ? `, the number's now ${notice.newNumber}` : ""}. `;
  return line + reply;
}

// ── STEP 1: propose the call, wait for the owner's go-ahead ────────
function proposeCall({ callSessionId, sessionId, ownerName, businessName, businessNumber, requestedTime, purpose, specialNote, commit }) {
  CallSession.emit(callSessionId, "preparing", { businessName: businessName || null, businessNumber: businessNumber || null });

  const toNumber = businessNumber || lookupBusinessNumber(businessName || "");
  if (!toNumber) {
    CallSession.emit(callSessionId, "needs_number", { businessName: businessName || null });
    return {
      status: "NEEDS_NUMBER",
      reply: withSwitchNotice(businessName
        ? `I don't have a phone number on file for ${businessName}, ${ownerName} — what's their number?`
        : `What number should I call, ${ownerName}?`),
    };
  }

  const confirmMsg = withSwitchNotice(buildConfirmMessage({ ownerName, businessName, toNumber, requestedTime, purpose, commit }));
  CallSession.emit(callSessionId, "confirm", {
    businessName: businessName || "them",
    businessNumber: toNumber,
    message: confirmMsg,
  });

  pendingCalls.set(sessionId, {
    sessionId,
    callSessionId,
    ownerName,
    businessName: businessName || null,
    businessNumber: toNumber,
    requestedTime: requestedTime || null,
    purpose: purpose || null,
    specialNote: specialNote || null,
    commit: !!commit,
    createdAt: Date.now(),
  });

  return { status: "CONFIRM", reply: confirmMsg, callSessionId };
}

function getPendingCall(sessionId) {
  return pendingCalls.get(sessionId) || null;
}

function cancelPendingCall(sessionId) {
  const p = pendingCalls.get(sessionId);
  pendingCalls.delete(sessionId);
  if (p) CallSession.emit(p.callSessionId, "cancelled", {});
  return { status: "CANCELLED", reply: p ? `No problem — I won't call ${p.businessName || "them"}.` : "Nothing to cancel." };
}

// ── STEP 2: owner said "do it" — dial in the background ────────────
// Deliberately NOT awaited by callers: the chat reply needs to come
// back instantly so the widget can open, and everything past this
// point streams over CallSession events instead of a return value.
function confirmPendingCall(sessionId) {
  const p = pendingCalls.get(sessionId);
  pendingCalls.delete(sessionId);
  if (!p) return { status: "NOT_FOUND", reply: "I don't have a call queued up anymore — want me to try again?" };

  if (p.businessNumber && p.businessName) saveKnownBusiness(p.businessName, p.businessNumber);

  _runCall(p).catch((e) => {
    console.error("[PHONE-AGENT] Call run failed:", e.message);
    CallSession.emit(p.callSessionId, "ended", { ok: false, summary: `Something went wrong on that call, ${p.ownerName} — ${e.message}` });
  });

  return { status: "DIALING", reply: withSwitchNotice(`Ringing ${p.businessName || "them"} now, ${p.ownerName}.`), callSessionId: p.callSessionId };
}

// ── THE ACTUAL CALL: dial, poll for pickup, poll for completion ────
async function _runCall(p) {
  const { callSessionId, ownerName, businessName, businessNumber, requestedTime, purpose, specialNote, commit } = p;
  const label = businessName || "them";

  CallSession.emit(callSessionId, "dialing", { businessName: label, businessNumber });

  const systemPrompt = buildSystemPrompt({ ownerName, businessName, requestedTime, purpose, specialNote, commit, confirmMode: false });

  let call;
  try {
    call = await AgentPhone.placeOutboundCall({
      toNumber: businessNumber,
      systemPrompt,
      initialGreeting: `Hi, this is Jarvis, ${ownerName}'s personal assistant.`,
      ownerName,
    });
  } catch (e) {
    CallSession.emit(callSessionId, "ended", { ok: false, summary: withSwitchNotice(`I couldn't get the call to ${label} to go through, ${ownerName} — ${e.message}`) });
    return;
  }

  // placeOutboundCall may have transparently failed over to a backup
  // AgentPhone account to actually get this call out — surface that
  // now rather than let it go unnoticed.
  const dialNotice = withSwitchNotice("");
  if (dialNotice) CallSession.emit(callSessionId, "dialing", { businessName: label, businessNumber, note: dialNotice.trim() });

  let seenConnected = false;
  let finished = null;
  const start = Date.now();
  const timeoutMs = 5 * 60 * 1000;

  while (Date.now() - start < timeoutMs) {
    let current;
    try {
      current = await AgentPhone.getCall(call.id);
    } catch {
      await sleep(3000);
      continue;
    }
    if (!seenConnected && current.status && !CONNECTING_STATUSES.has(current.status) && current.status !== "completed" && current.status !== "failed") {
      seenConnected = true;
      CallSession.emit(callSessionId, "on_call", { businessName: label, businessNumber });
    }
    if (current.status === "completed" || current.status === "failed") { finished = current; break; }
    await sleep(3000);
  }

  if (!finished) {
    CallSession.emit(callSessionId, "ended", { ok: false, summary: withSwitchNotice(`The call to ${label} didn't wrap up in time, ${ownerName} — it may still go through.`), callId: call.id });
    return;
  }
  if (!seenConnected) CallSession.emit(callSessionId, "on_call", { businessName: label, businessNumber });

  if (finished.status === "failed") {
    CallSession.emit(callSessionId, "ended", { ok: false, summary: withSwitchNotice(`The call to ${label} didn't connect, ${ownerName}.`), callId: call.id });
    return;
  }

  let outcome;
  try {
    // Stop guessing at field names — just always print exactly what
    // AgentPhone sent back for this call, unconditionally, so it's
    // impossible to miss in the logs next time. Look for the line
    // starting "[PHONE-AGENT] RAW AgentPhone call response:".
    console.warn(`[PHONE-AGENT] RAW AgentPhone call response for ${call.id}: ${JSON.stringify(finished)}`);

    let rawTranscripts = finished.transcripts;
    if (!Array.isArray(rawTranscripts) || !rawTranscripts.length) {
      const alt = finished.transcript || finished.messages || finished.conversation || finished.turns || finished.history;
      if (Array.isArray(alt) && alt.length) rawTranscripts = alt;
    }

    outcome = await summarizeCallOutcome({
      transcripts: rawTranscripts,
      requestedTime: requestedTime || purpose || "",
      businessName: businessName || "the business",
    });
  } catch (e) {
    CallSession.emit(callSessionId, "ended", {
      ok: true,
      summary: withSwitchNotice(`The call with ${label} wrapped up, but I had trouble analyzing the transcript, ${ownerName} — ${e.message}`),
      recordingUrl: finished.recordingUrl || finished.recording_url || null,
      callId: call.id,
    });
    return;
  }

  const chips = [];
  if (outcome.booked) chips.push("booked");
  if (outcome.alternativeTimeOffered) chips.push("needs decision");
  if (!outcome.booked && !outcome.alternativeTimeOffered) chips.push("info gathered");

  if (outcome.alternativeTimeOffered) {
    pendingAltTime.set(p.sessionId, {
      ownerName,
      businessName,
      businessNumber,
      requestedTime,
      alternativeTime: outcome.alternativeTimeOffered,
      specialNote,
      createdAt: Date.now(),
    });
  }

  CallSession.emit(callSessionId, "ended", {
    ok: true,
    booked: !!outcome.booked,
    bookedTime: outcome.bookedTime || null,
    alternativeTime: outcome.alternativeTimeOffered || null,
    summary: withSwitchNotice(outcome.summary || (outcome.booked ? `Booked for ${outcome.bookedTime || requestedTime}.` : "Call finished.")),
    chips,
    recordingUrl: finished.recordingUrl || finished.recording_url || null,
    callId: call.id,
  });
}

// ── STEP 3a: owner said yes to the ALTERNATIVE time — call back ────
async function confirmPendingAppointment(sessionId) {
  const p = pendingAltTime.get(sessionId);
  if (!p) return { status: "NOT_FOUND", reply: "I don't have that pending appointment anymore — want me to call again from scratch?" };
  const label = p.businessName || "them";

  const systemPrompt = buildSystemPrompt({
    ownerName: p.ownerName,
    businessName: p.businessName,
    requestedTime: p.requestedTime,
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
    return { status: "CALL_FAILED", reply: withSwitchNotice(`The confirmation call to ${label} didn't go through, ${p.ownerName} — ${e.message}`) };
  }

  pendingAltTime.delete(sessionId);
  return {
    status: "CONFIRMED",
    reply: withSwitchNotice(`That works — ${label} has you down for ${p.alternativeTime}, ${p.ownerName}. Shall I put that in your calendar?`),
    businessName: p.businessName,
    time: p.alternativeTime,
  };
}

// ── STEP 3b: owner said no to the alternative ───────────────────────
function cancelPendingAppointment(sessionId) {
  const p = pendingAltTime.get(sessionId);
  pendingAltTime.delete(sessionId);
  return { status: "CANCELLED", reply: p ? `No problem — I won't book that with ${p.businessName || "them"}.` : "Nothing to cancel." };
}

function getPendingAppointment(sessionId) {
  return pendingAltTime.get(sessionId) || null;
}

module.exports = {
  proposeCall,
  getPendingCall,
  confirmPendingCall,
  cancelPendingCall,
  confirmPendingAppointment,
  cancelPendingAppointment,
  getPendingAppointment,
  saveKnownBusiness,
  lookupBusinessNumber,
};
