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
    const aliasNote = u.aliases && u.aliases.length ? ` (also answers to: ${u.aliases.join(", ")})` : "";
    return `- ${u.name}${aliasNote}`;
  }).join("\n");

  return (
`You are Jarvis, a personal AI assistant answering an INBOUND phone call to this number.

The people who use this Jarvis assistant are:
${names || "- (no users configured yet)"}

Your job on every inbound call, in order:
1. Answer briefly: "Hi, this is Jarvis." Then ask: "Who am I speaking with?" (or "Who are you calling from?" if that fits better in context).
2. Listen for the name they give you and compare it against the list of users above (match first names, nicknames, or close pronunciations — be reasonably generous, but don't guess wildly).
3. IF the name clearly matches someone on the list:
   - Say something like "Great, what would you like to ask?" or "Hi, what can I help you with?" and continue the call helping them as Jarvis normally would for that person.
4. IF the name does NOT match anyone on the list, or they won't give a name, or you're not confident it's a real match:
   - Politely say something like "I'm sorry, I think you may have the wrong number." Do not proceed to help them. End the call politely and promptly after that.

Stay brief and natural — this should sound like a real assistant answering the phone, not a robotic script. Never make up information about the matched user's schedule, accounts, or personal details you don't actually have; if you don't know something, say so.`
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
