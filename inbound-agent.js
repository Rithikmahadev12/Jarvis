"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Inbound Call Agent v1.0
//
// Handles calls made TO your Jarvis number (not the outbound calls
// phone-agent.js places for you). Since Jarvis runs in "hosted" mode
// (see agentphone.js's big comment on why), there's no live webhook
// to react turn-by-turn during an inbound call — AgentPhone's own
// built-in LLM runs the whole conversation using whatever system
// prompt is saved as the agent's DEFAULT (the dashboard "System
// Prompt" field). So the only lever Jarvis has for inbound calls is
// how good that default prompt is. This file:
//
//   1. Builds that prompt from the SAME account store Face ID sign-in
//      already uses — data/profiles.json (see server.js's loadProfiles/
//      saveProfiles, GET /api/profiles). No separate list to maintain:
//      whoever has a Jarvis account (created via face enrollment) is
//      automatically known on the phone too, name + voiceAliases and
//      all. The prompt behavior:
//        - Ask "Who am I speaking with?"
//        - If the name matches an enrolled account -> "Great, what
//          can I help you with?" and continue as their assistant.
//        - If it doesn't match anyone -> apologize, say they may
//          have the wrong number, end the call politely.
//   2. Pushes that prompt to the agent via the API (setAgentDefault
//      SystemPrompt) so it's always current with whoever's actually
//      enrolled — no manual paste, no manual list.
//   3. Since the call itself is invisible to Jarvis in hosted mode,
//      polls AgentPhone afterward for inbound calls and logs who
//      called + who Jarvis matched them to, in
//      data/agentphone-inbound-log.json, using Groq to read the
//      transcript (see groq-json.js).
//
// ── RUNNING THE SYNC ─────────────────────────────────────────────
// Call syncInboundPrompt() whenever accounts change (new account
// created, voiceAliases edited) — it's cheap enough to just call on
// every server startup too, see the hook at the bottom of server.js.
// ═══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const AgentPhone = require("./agentphone");
const { askGroqForJSON } = require("./groq-json");

const CONFIG_PATH = path.join(__dirname, "config.json");
const PROFILES_PATH = path.join(__dirname, "data", "profiles.json");
const LOG_PATH = path.join(__dirname, "data", "agentphone-inbound-log.json");
const PROMPT_TXT_PATH = path.join(__dirname, "data", "agentphone-inbound-system-prompt.txt");

// ── USERS: pulled live from the real account store (profiles.json) ─
// Same file server.js's loadProfiles()/saveProfiles() read and write —
// every enrolled Face ID account shows up here automatically, with
// whatever voiceAliases they set (e.g. "Jay" enrolled as "Jason" could
// have voiceAliases: ["Jay", "Jayson"]). faceDescriptor is intentionally
// left out below — it's biometric data with no reason to ever touch
// the phone call path.
function loadUsers() {
  let profiles;
  try {
    profiles = JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8"));
  } catch {
    profiles = {};
  }
  const users = Object.values(profiles).map((p) => ({
    name: p.name,
    role: p.role || "user",
    aliases: Array.isArray(p.voiceAliases) ? p.voiceAliases : [],
  }));
  if (users.length > 0) return users;

  // No accounts enrolled yet at all — fall back to config.json's owner
  // so the prompt isn't completely empty before anyone's signed up.
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.owner?.username) return [{ name: cfg.owner.username, role: cfg.owner.role || "owner", aliases: [] }];
  } catch { /* ignore */ }
  return [];
}

function defaultOwnerName() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))?.owner?.username || "the owner";
  } catch {
    return "the owner";
  }
}

// ── PROMPT BUILDER ────────────────────────────────────────────────
function buildInboundSystemPrompt(users) {
  const names = users.map((u) => {
    const aliasNote = u.aliases && u.aliases.length ? ` (or: ${u.aliases.join(", ")})` : "";
    return `- ${u.name}${aliasNote}`;
  }).join("\n");

  return (
`You're Jarvis, answering a phone call on this number. Sound like a real assistant picking up the phone — warm, quick, natural. Not a script, not a narrator.

## Rule of one
One sentence by default, two at most. Never stack questions. Say who you are once, right at the start — don't re-introduce yourself on later turns.

## The one thing you're here to do
Open with something like "Hi, this is Jarvis — who am I speaking with?" Compare whatever name they give against the people below (match first names, nicknames, close pronunciations — be reasonably generous, not wild):
${names || "(no one enrolled yet)"}

Clear match → drop straight into helping them, e.g. "Hey, what can I do for you?" — then just be Jarvis for the rest of the call.
No match, they won't give a name, or you're not confident → one short apology and out: "Sorry, I think you've got the wrong number" — then invoke end_call in that same turn. Don't try to help first.

## Don't guess at mangled audio
Phone audio garbles names sometimes. If what you heard doesn't sound like a real name, say "sorry, didn't catch that — who's calling?" once. If it's still unclear, treat it as no match and wrap up per the rule above — don't keep asking, don't invent a name that sounds close enough.

## Sound like a person
Contractions. A quick "yeah" or "gotcha" before answering when it fits — vary it, don't repeat the same one twice in a row. No markdown, no lists read aloud, no stage directions.

## Silence and interruption
Caller goes quiet → one "still there?" then actually wait, don't fill the gap. Caller talks over you → stop mid-sentence, it's their turn.

## Wrap warm AND actually hang up
When the caller sounds done — "bye," "talk later," "that's all" — say one short warm line and invoke end_call in the SAME turn. Saying goodbye alone doesn't end the call; always pair it with end_call.

## Once matched
Never make up information about their schedule, accounts, or anything you don't actually have. If you don't know something, say so.`
  );
}

// ── SYNC: push the prompt to the agent + write a local copy ────────
async function syncInboundPrompt() {
  const users = loadUsers();
  const ownerName = defaultOwnerName();
  const prompt = buildInboundSystemPrompt(users);

  try {
    fs.mkdirSync(path.dirname(PROMPT_TXT_PATH), { recursive: true });
    fs.writeFileSync(PROMPT_TXT_PATH, prompt);
  } catch (e) {
    console.error("[INBOUND-AGENT] Could not write local prompt copy:", e.message);
  }

  await AgentPhone.setAgentDefaultSystemPrompt(prompt, ownerName);
  console.log(`[INBOUND-AGENT] Synced inbound system prompt for ${users.length} user(s) to AgentPhone.`);
  return { users, prompt };
}

// ── LOGGING: figure out, after the fact, who called and who matched ─
function loadLog() {
  try {
    return JSON.parse(fs.readFileSync(LOG_PATH, "utf8"));
  } catch {
    return { lastCheckedCallId: null, entries: [] };
  }
}

function saveLog(log) {
  try {
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.writeFileSync(LOG_PATH, JSON.stringify(log, null, 2));
  } catch (e) {
    console.error("[INBOUND-AGENT] Could not save inbound log:", e.message);
  }
}

async function matchTranscriptToUser(transcripts, users) {
  const convo = (transcripts || [])
    .map((t) => `Caller: ${t.transcript}\nJarvis: ${t.response}`)
    .join("\n");

  const names = users.map((u) => u.name).join(", ") || "(none configured)";
  const systemPrompt =
    "You read a transcript of an inbound phone call answered by Jarvis, an AI assistant. " +
    `The known users of this Jarvis are: ${names}. ` +
    "Reply with ONLY a JSON object, no prose, no markdown fences, in this exact shape: " +
    '{"statedName": string|null, "matchedUser": string|null, "wasRouted": boolean, "summary": string}. ' +
    '"statedName" is whatever name the caller actually gave, if any. ' +
    '"matchedUser" is the exact name from the known-users list Jarvis matched them to, or null if no match/wrong number. ' +
    '"wasRouted" is true only if Jarvis proceeded to help them (i.e. did not say wrong number). ' +
    '"summary" is one short plain-language sentence about what the call was about.';

  return askGroqForJSON({
    systemPrompt,
    userContent: convo || "(no transcript captured)",
    fallback: { statedName: null, matchedUser: null, wasRouted: false, summary: "Could not analyze — Groq not configured or parse failed." },
  });
}

// Call this periodically (e.g. every few minutes from a setInterval in
// server.js/startup, alongside other polling loops already in this
// codebase — see server.js's runSweep pattern) to catch up on any
// inbound calls Jarvis wasn't around to see live.
async function checkForNewInboundCalls() {
  const log = loadLog();
  const users = loadUsers();

  let calls;
  try {
    calls = await AgentPhone.listCalls({ direction: "inbound", limit: 20 });
  } catch (e) {
    console.error("[INBOUND-AGENT] Could not list inbound calls:", e.message);
    return [];
  }

  // Only look at calls newer than the last one we already logged.
  const seen = new Set(log.entries.map((e) => e.callId));
  const fresh = calls.filter((c) => c.status === "completed" && !seen.has(c.id));

  const newEntries = [];
  for (const call of fresh) {
    let analysis;
    try {
      analysis = await matchTranscriptToUser(call.transcripts, users);
    } catch (e) {
      analysis = { statedName: null, matchedUser: null, wasRouted: false, summary: `Analysis failed: ${e.message}` };
    }
    const entry = {
      callId: call.id,
      fromNumber: call.fromNumber || call.from || null,
      at: call.createdAt || call.startedAt || new Date().toISOString(),
      ...analysis,
    };
    newEntries.push(entry);
    log.entries.push(entry);
  }

  if (newEntries.length > 0) {
    log.lastCheckedCallId = calls[0]?.id || log.lastCheckedCallId;
    saveLog(log);
    console.log(`[INBOUND-AGENT] Logged ${newEntries.length} new inbound call(s).`);
  }
  return newEntries;
}

function getInboundLog() {
  return loadLog().entries;
}

module.exports = {
  loadUsers,
  buildInboundSystemPrompt,
  syncInboundPrompt,
  checkForNewInboundCalls,
  getInboundLog,
};
