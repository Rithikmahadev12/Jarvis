"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Superteam Earn Agent (multi-user)
//
// Mirrors github-bounty.js's per-userKey pattern. Each enrolled
// account gets its OWN Superteam agent identity (its own apiKey +
// claimCode + agentId) — a claimCode can only be redeemed by one
// human's Superteam/Privy login, so identities can't be shared
// across users the way a single wallet address technically could be.
//
// Wallet linkage here is bookkeeping only (recordEarning, matching
// github-bounty.js's markPaid pattern) — the actual payout happens
// entirely on Superteam's own site via that user's own Privy login
// when they redeem their claimCode. This module and Jarvis never see
// or touch that money; there's nothing here for it to custody.
// ═══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const REPO_ROOT = __dirname;
const CONFIG_DIR = path.join(REPO_ROOT, "data", "superteam-configs");
const WalletSetup  = require(path.join(REPO_ROOT, "wallet-setup.js"));

const BASE_URL = process.env.SUPERTEAM_BASE_URL || "https://superteam.fun";

const MIN_REWARD_USD   = Number(process.env.SUPERTEAM_MIN_REWARD_USD || 20);
const MAX_REWARD_USD   = Number(process.env.SUPERTEAM_MAX_REWARD_USD || 200);
const MAX_HOURS_LEFT   = Number(process.env.SUPERTEAM_MAX_HOURS_LEFT || 48);
const MAX_SUBMISSIONS  = Number(process.env.SUPERTEAM_MAX_SUBMISSIONS || 30);
const ALLOWED_SKILLS   = (process.env.SUPERTEAM_SKILLS || "Content,Design")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const AUTO_SUBMIT      = /^true$/i.test(process.env.SUPERTEAM_AUTO_SUBMIT || "");

function normalizeKey(userKey) {
  return String(userKey || "owner").toLowerCase().trim();
}

function configPath(userKey) {
  return path.join(CONFIG_DIR, `${normalizeKey(userKey)}.json`);
}

function loadConfig(userKey) {
  try {
    return JSON.parse(fs.readFileSync(configPath(userKey), "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(userKey, cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(configPath(userKey), JSON.stringify(cfg, null, 2));
}

function listRegisteredUsers() {
  try {
    return fs.readdirSync(CONFIG_DIR)
      .filter(f => f.endsWith(".json"))
      .map(f => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

// ---- Discover every known app user, registered or not ----
// Same two sources server.js itself uses to know who exists:
// config.json's owner, and every key in data/profiles.json (enrolled
// Face-ID accounts). This is "who COULD have a Superteam identity",
// separate from listRegisteredUsers() ("who already DOES").
function listKnownUserKeys() {
  const keys = new Set();
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "config.json"), "utf8"));
    if (cfg.owner?.username) keys.add(normalizeKey(cfg.owner.username));
  } catch { /* no config.json yet */ }
  try {
    const profiles = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "profiles.json"), "utf8"));
    for (const k of Object.keys(profiles)) keys.add(normalizeKey(k));
  } catch { /* no profiles.json yet */ }
  return [...keys];
}

// ---- Register anyone known who isn't registered yet ----
// This is what makes registration hands-off: instead of requiring
// `node scripts/register-superteam-agent.js <userKey>` run manually
// per person, the scheduled job can call this first and it registers
// only whoever's missing, leaving everyone already configured alone.
async function ensureAllRegistered() {
  const known = listKnownUserKeys();
  const already = new Set(listRegisteredUsers());
  const results = [];
  for (const key of known) {
    if (already.has(key)) {
      results.push({ userKey: key, alreadyRegistered: true });
      continue;
    }
    try {
      const res = await registerAgent(key);
      results.push({
        userKey: key, alreadyRegistered: false,
        agentId: res.agentId, username: res.username, claimCode: res.claimCode,
        walletAddress: res.walletLink?.address || null,
        walletLinked: !res.walletLink?.error,
      });
    } catch (e) {
      results.push({ userKey: key, error: e.message });
    }
  }
  return results;
}

function isConfigured(userKey) {
  const cfg = loadConfig(userKey);
  return !!(cfg.apiKey && cfg.agentId);
}

async function apiFetch(userKey, pathname, { method = "GET", body } = {}) {
  const cfg = loadConfig(userKey);
  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Superteam API ${res.status}: ${JSON.stringify(json)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---- Registration (once per user) ----
async function registerAgent(userKey, name) {
  const key = normalizeKey(userKey);
  if (isConfigured(key)) {
    throw new Error(`"${key}" already has a Superteam agent identity — delete data/superteam-configs/${key}.json first to replace it.`);
  }
  const agentName = name || `jarvis-${key}`;
  const res = await apiFetch(key, "/api/agents", { method: "POST", body: { name: agentName } });
  saveConfig(key, {
    userKey: key, name: agentName,
    apiKey: res.apiKey, claimCode: res.claimCode, agentId: res.agentId, username: res.username,
    registeredAt: new Date().toISOString(),
  });

  // Same key WalletSetup/SolanaWallet/github-bounty.js all use — this
  // is the actual "line them up" step. Surfaced, not swallowed, so a
  // failure here is visible instead of silently leaving this user's
  // Superteam identity and bounty-hunt wallet pointing at different
  // places.
  let walletLink;
  try {
    walletLink = await WalletSetup.ensureUserWallet(key);
    if (walletLink.error) {
      console.warn(`[SUPERTEAM] Wallet link failed for "${key}": ${walletLink.error}`);
    }
  } catch (e) {
    walletLink = { error: e.message };
    console.warn(`[SUPERTEAM] Wallet link threw for "${key}": ${e.message}`);
  }

  return { ...res, walletLink };
}

async function ensureRegistered(userKey, name) {
  const key = normalizeKey(userKey);
  if (isConfigured(key)) return { alreadyRegistered: true, ...getClaimInfo(key) };
  const res = await registerAgent(key, name);
  return {
    alreadyRegistered: false, agentId: res.agentId, username: res.username, claimCode: res.claimCode,
    walletAddress: res.walletLink?.address || null,
    walletLinked: !res.walletLink?.error,
  };
}

function getClaimInfo(userKey) {
  const cfg = loadConfig(userKey);
  if (!cfg.claimCode) return { error: "Not registered yet." };
  return {
    agentId: cfg.agentId, username: cfg.username, claimCode: cfg.claimCode,
    claimUrl: `${BASE_URL}/earn/claim/${cfg.claimCode}`,
  };
}

// ---- Win tracking ----
// Superteam's docs don't pin an exact "did this submission win"
// endpoint/field the way they pin /api/agents/submissions/create —
// same honest gap as normalizeListing()'s reward/skills/deadline
// guessing. So wins are tracked two ways:
//   1) Best-effort automatic check against a GUESSED submissions
//      list endpoint — wrapped so a wrong guess just fails quietly
//      and falls back to (2) instead of breaking the claim-code ask.
//   2) A locally-kept counter (recordWin) for the owner to bump
//      manually — "mark that bounty as a win" — until the real
//      field names are confirmed against the live API.
function loadWinsLocal(userKey) {
  const cfg = loadConfig(userKey);
  return Array.isArray(cfg.wins) ? cfg.wins : [];
}

function recordWin(userKey, { slug, title, amountUsd } = {}) {
  const key = normalizeKey(userKey);
  const cfg = loadConfig(key);
  if (!cfg.apiKey) return { error: `"${key}" isn't registered yet.` };
  cfg.wins = Array.isArray(cfg.wins) ? cfg.wins : [];
  cfg.wins.push({ slug: slug || null, title: title || null, amountUsd: amountUsd ?? null, recordedAt: new Date().toISOString() });
  saveConfig(key, cfg);
  return { userKey: key, winCount: cfg.wins.length };
}

// Guessed endpoint — adjust the path/field names here once the real
// shape is confirmed, same as normalizeListing() below. Returns null
// (not 0) on any failure so callers know to fall back to the local
// count instead of reporting a false "zero wins."
async function fetchWinCountFromApi(userKey) {
  try {
    const res = await apiFetch(userKey, "/api/agents/submissions");
    const list = res.submissions || res.data || res;
    if (!Array.isArray(list)) return null;
    return list.filter(s => {
      const status = String(s.status || s.result || "").toLowerCase();
      return status.includes("win") || s.isWinner === true || s.winner === true;
    }).length;
  } catch {
    return null;
  }
}

// What get_superteam_claim_code actually calls: tries the live API
// first, falls back to the local counter if that guess doesn't pan
// out, and says which source it used so a wrong number is at least
// traceable.
async function getWinCount(userKey) {
  const apiCount = await fetchWinCountFromApi(userKey);
  if (apiCount != null) return { count: apiCount, source: "api" };
  return { count: loadWinsLocal(userKey).length, source: "local" };
}

// ---- Discovery (not user-specific — listings are global) ----
function normalizeListing(raw) {
  const reward = raw.rewardAmount ?? raw.reward ?? raw.compensation?.amount ?? raw.usdValue ?? null;
  const deadline = raw.deadline ? new Date(raw.deadline) : null;
  const hoursLeft = deadline ? (deadline - Date.now()) / 36e5 : null;
  const submissionCount = raw.totalSubmissions ?? raw.submissionCount ?? raw.entries ?? 0;
  const skills = (raw.skills || raw.skillsRequired || []).map(s => (typeof s === "string" ? s : s.name || "").toLowerCase());
  return { raw, reward, hoursLeft, submissionCount, skills, slug: raw.slug || raw.id };
}

async function discoverListings(userKey, { type } = {}) {
  const qs = new URLSearchParams({ take: "50" });
  if (type) qs.set("type", type);
  const res = await apiFetch(userKey, `/api/agents/listings/live?${qs.toString()}`);
  const listings = (res.listings || res.data || res || []).map(normalizeListing);
  return listings.filter(l => {
    if (l.reward != null && (l.reward < MIN_REWARD_USD || l.reward > MAX_REWARD_USD)) return false;
    if (l.hoursLeft != null && l.hoursLeft > MAX_HOURS_LEFT) return false;
    if (l.submissionCount > MAX_SUBMISSIONS) return false;
    if (ALLOWED_SKILLS.length && l.skills.length && !l.skills.some(s => ALLOWED_SKILLS.some(a => s.includes(a)))) return false;
    return true;
  });
}

async function getListingDetails(userKey, slug) {
  return apiFetch(userKey, `/api/agents/listings/details/${encodeURIComponent(slug)}`);
}

async function draftSubmission(listing) {
  const Hermes = require(path.join(REPO_ROOT, "hermes-engine.js"));
  const prompt =
    `You're drafting a Superteam Earn bounty submission.\nTitle: ${listing.raw.title || listing.slug}\n` +
    `Description: ${listing.raw.description || "(none provided)"}\nReward: $${listing.reward}\n\n` +
    `Write:\n1) A short "otherInfo" field (what was built/delivered and how it works)\n` +
    `2) Answers to any eligibility questions if present: ${JSON.stringify(listing.raw.eligibilityQuestions || [])}\n` +
    `Keep it concrete and specific to this listing — no generic filler.`;
  return Hermes.codeChat(prompt);
}

async function submitListing(userKey, listingId, { link = "", otherInfo, eligibilityAnswers = [], ask = null, tweet = "", telegram } = {}) {
  return apiFetch(userKey, "/api/agents/submissions/create", {
    method: "POST",
    body: { listingId, link, tweet, otherInfo, eligibilityAnswers, ask, telegram: telegram || undefined },
  });
}

// ---- Orchestration, for ONE user ----
async function scanAndSubmit(userKey) {
  const key = normalizeKey(userKey);
  if (!isConfigured(key)) return { userKey: key, error: `"${key}" isn't registered yet.` };

  const cfg = loadConfig(key);
  const listings = await discoverListings(key, {});
  const submitted = [], queued = [], errors = [];

  for (const listing of listings) {
    try {
      const details = await getListingDetails(key, listing.slug);
      const draft = await draftSubmission({ ...listing, raw: { ...listing.raw, ...details } });

      if (AUTO_SUBMIT) {
        const res = await submitListing(key, details.id || listing.slug, {
          otherInfo: draft,
          telegram: cfg.telegram,
          eligibilityAnswers: (details.eligibilityQuestions || []).map(q => ({ question: q.question || q, answer: "See otherInfo" })),
        });
        submitted.push({ slug: listing.slug, res });
      } else {
        queued.push({ slug: listing.slug, draft });
      }
    } catch (e) {
      errors.push({ slug: listing.slug, error: e.message });
    }
  }
  return { userKey: key, scanned: listings.length, submitted, queued, errors };
}

// ---- Run for EVERY registered user (used by the scheduled job) ----
async function scanAndSubmitAll() {
  const users = listRegisteredUsers();
  const results = [];
  for (const key of users) {
    results.push(await scanAndSubmit(key));
  }
  return results;
}

module.exports = {
  isConfigured, registerAgent, ensureRegistered, getClaimInfo,
  discoverListings, getListingDetails, draftSubmission, submitListing,
  scanAndSubmit, scanAndSubmitAll, listRegisteredUsers, listKnownUserKeys,
  ensureAllRegistered, loadConfig, normalizeKey,
  recordWin, getWinCount,
};
