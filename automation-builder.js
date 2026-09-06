"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Automation Builder (Make.com)
//
// Two separate jobs, kept deliberately separate:
//
//   1. DRAFTING — turn a plain-English description of what a client
//      wants automated into a structured, human-readable spec (which
//      apps, trigger, steps, field mappings, edge cases). Goes
//      through hermes-engine.js's codeChat(), which already tries
//      Jarvis's own self-hosted Ollama (running on its E2B sandbox
//      computer — see computer.js's ensureOllama/ollamaChat) BEFORE
//      ever touching Groq. Groq is only hit as a true last resort if
//      every other tier fails — see hermes-engine.js's
//      groqFetchRawWithFallback() for the exact order.
//
//   2. BUILDING — thin wrappers around Make.com's real REST API
//      (api.{zone}/v2/scenarios) to actually create/inspect/activate
//      a scenario in a connected Make.com account.
//
// WHY THESE AREN'T ONE STEP: Make's scenario "blueprint" is a fairly
// specific internal JSON schema that differs per app/module and isn't
// publicly, fully documented per-app. Having a model freehand a
// complete blueprint from scratch is unreliable — it's the kind of
// thing that LOOKS right and then fails silently in a client's real
// business (wrong field mapping, dropped filter, etc). So this module
// never asks a model to invent a full blueprint out of thin air.
// Instead: draftAutomationPlan() gives you (or the client) a clear,
// reviewable spec; createScenario() takes an ACTUAL blueprint you
// already have — hand-built in Make's UI and exported, or adapted
// from an existing working scenario/template — and creates it via
// the API. That's a real, reliable division of labor instead of
// pretending full end-to-end autonomy that isn't actually solid yet.
//
// SAFETY: every scenario this creates is INACTIVE by default. Nothing
// runs against a client's real business data until a human explicitly
// calls activateScenario() — same "draft first, human flips the
// switch" pattern as bounty-coder.js's draft PRs.
//
// ── SETUP ──────────────────────────────────────────────────────
//   1. Log into the target Make.com account (yours, or the client's,
//      whichever account the scenario should live in).
//   2. Profile icon (top right) → Profile → API tab → Add token.
//      Give it the scenarios:read / scenarios:write scopes.
//   3. Note your zone from the URL you're logged in at — e.g.
//      https://eu1.make.com or https://us1.make.com.
//   4. Add to .env:
//        MAKE_API_KEY="..."
//        MAKE_ZONE="eu1.make.com"      (no https://, just the host)
//        MAKE_TEAM_ID="..."            (Team ID — visible in the
//                                        team's URL/settings; scenarios
//                                        are created under a team)
// ═══════════════════════════════════════════════════════════════

const Hermes = require("./hermes-engine");

const MAKE_API_KEY = process.env.MAKE_API_KEY || "";
const MAKE_ZONE    = process.env.MAKE_ZONE    || "";
const MAKE_TEAM_ID = process.env.MAKE_TEAM_ID || "";

function isConfigured() {
  return !!(MAKE_API_KEY && MAKE_ZONE);
}

function apiBase() {
  return `https://${MAKE_ZONE}/api/v2`;
}

async function makeFetch(pathAndQuery, { method = "GET", body } = {}) {
  if (!isConfigured()) return { error: "MAKE_API_KEY / MAKE_ZONE not set in .env — see the setup notes at the top of automation-builder.js." };

  const res = await fetch(`${apiBase()}${pathAndQuery}`, {
    method,
    headers: {
      "Authorization": `Token ${MAKE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });

  let data;
  try { data = await res.json(); } catch { data = {}; }

  if (!res.ok) {
    return { error: `Make API error ${res.status}: ${data?.message || res.statusText}` };
  }
  return data;
}

// ── 1. DRAFTING ───────────────────────────────────────────────
// Produces a structured spec, NOT a Make blueprint. Meant to be
// shown to the client for sign-off (or used in a gig proposal) before
// anyone builds anything for real.
const PLAN_SYSTEM_PROMPT = `You are drafting an automation SPEC for a Make.com workflow, based on a client's plain-English description of what they want automated. Do NOT invent Make.com's internal blueprint JSON — that's a separate, more specific step. Instead return ONLY this JSON shape, no prose, no markdown fences:

{
  "summary": "one sentence describing what this automation does",
  "apps_needed": ["App A", "App B"],
  "trigger": { "app": "...", "event": "e.g. New row added", "notes": "..." },
  "steps": [
    { "app": "...", "action": "e.g. Send message", "field_mappings": ["Field X <- trigger.FieldY", "..."], "notes": "..." }
  ],
  "filters_or_conditions": ["e.g. Only if status = 'won'"],
  "edge_cases_to_flag_for_client": ["e.g. What happens on a duplicate row?", "..."],
  "estimated_build_complexity": "simple" | "moderate" | "complex"
}
Be concrete about field mappings even if you have to guess plausible field names — the client/builder will correct specifics, but a vague spec isn't useful. Flag genuine ambiguities in edge_cases_to_flag_for_client rather than silently guessing on anything that changes behavior materially.`;

async function draftAutomationPlan(description, userTitle = "Sir") {
  if (!description || !description.trim()) return { error: "Missing a description of what to automate." };

  const { reply } = await Hermes.codeChat(
    `Client's request, verbatim:\n"${description.trim()}"\n\nReturn the JSON spec described in your instructions.`,
    { userTitle, context: PLAN_SYSTEM_PROMPT }
  );

  const cleaned = reply.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { error: "Model didn't return valid JSON for the plan.", raw: reply };
  }
}

// Turns a drafted plan into gig-listing copy for Upwork/Fiverr —
// separate from the plan itself since the plan is technical/internal
// and this is client-facing marketing copy.
async function draftGigListing(plan, platform = "upwork") {
  if (!plan || plan.error) return { error: "Need a valid plan (from draftAutomationPlan) first." };

  const { reply } = await Hermes.chat(
    `Write a short, concrete ${platform === "fiverr" ? "Fiverr gig description" : "Upwork proposal"} for building this Make.com automation. Be specific about what it does, not generic automation-agency fluff. Plan:\n${JSON.stringify(plan, null, 2)}`,
    { userTitle: "Sir", skipCache: true, autoLearn: false }
  );
  return { text: reply };
}

// ── 2. BUILDING (real Make.com API) ─────────────────────────────
// Every function below is a thin, honest wrapper — no magic. You
// supply a real blueprint (Make.com's own JSON scenario format,
// obtained by building/exporting a scenario in Make's UI, or reusing
// a known-good template's blueprint and editing it).

async function listScenarios() {
  if (!MAKE_TEAM_ID) return { error: "MAKE_TEAM_ID not set — required to list scenarios for a team." };
  return makeFetch(`/scenarios?teamId=${encodeURIComponent(MAKE_TEAM_ID)}`);
}

async function getScenario(scenarioId) {
  if (!scenarioId) return { error: "Missing scenarioId." };
  return makeFetch(`/scenarios/${encodeURIComponent(scenarioId)}`);
}

async function getScenarioBlueprint(scenarioId) {
  if (!scenarioId) return { error: "Missing scenarioId." };
  return makeFetch(`/scenarios/${encodeURIComponent(scenarioId)}/blueprint`);
}

// Creates a scenario from a real blueprint. ALWAYS created inactive —
// Make scenarios are inactive by default on creation via the API, and
// this deliberately never flips that on. See activateScenario() below,
// which is the one place that ever happens, and only on explicit call.
async function createScenario(name, blueprint, { folderId } = {}) {
  if (!name || !blueprint) return { error: "Missing name or blueprint." };
  if (!MAKE_TEAM_ID) return { error: "MAKE_TEAM_ID not set — required to create a scenario under a team." };

  const body = {
    name,
    teamId: MAKE_TEAM_ID,
    blueprint: typeof blueprint === "string" ? blueprint : JSON.stringify(blueprint),
  };
  if (folderId) body.folderId = folderId;

  const result = await makeFetch(`/scenarios`, { method: "POST", body });
  if (result.error) return result;
  return { ...result, note: "Created INACTIVE. Review it in Make's UI, then call activateScenario() (or flip it on manually) once you/the client are ready to go live." };
}

async function updateScenarioBlueprint(scenarioId, blueprint) {
  if (!scenarioId || !blueprint) return { error: "Missing scenarioId or blueprint." };
  return makeFetch(`/scenarios/${encodeURIComponent(scenarioId)}`, {
    method: "PATCH",
    body: { blueprint: typeof blueprint === "string" ? blueprint : JSON.stringify(blueprint) },
  });
}

// The ONLY function in this file that can make a scenario live. Never
// called automatically by anything else here — always an explicit,
// separate human action.
async function activateScenario(scenarioId) {
  if (!scenarioId) return { error: "Missing scenarioId." };
  return makeFetch(`/scenarios/${encodeURIComponent(scenarioId)}/start`, { method: "POST" });
}

async function deactivateScenario(scenarioId) {
  if (!scenarioId) return { error: "Missing scenarioId." };
  return makeFetch(`/scenarios/${encodeURIComponent(scenarioId)}/stop`, { method: "POST" });
}

async function deleteScenario(scenarioId) {
  if (!scenarioId) return { error: "Missing scenarioId." };
  return makeFetch(`/scenarios/${encodeURIComponent(scenarioId)}`, { method: "DELETE" });
}

module.exports = {
  isConfigured,
  draftAutomationPlan,
  draftGigListing,
  listScenarios,
  getScenario,
  getScenarioBlueprint,
  createScenario,
  updateScenarioBlueprint,
  activateScenario,
  deactivateScenario,
  deleteScenario,
};
