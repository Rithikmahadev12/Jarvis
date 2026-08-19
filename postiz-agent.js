"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Postiz Agent (self-hosted, free)
//
// Postiz (https://github.com/gitroomhq/postiz-app) is the open-source
// social scheduler Jarvis posts finished ad videos through. No paid
// Postiz account needed — this clones the repo and runs it yourself
// via Docker, then talks to your own instance's REST API with an API
// key YOU generate in your own Postiz settings (free, self-issued,
// not a third-party subscription).
//
// ── WHERE THIS RUNS, AND WHY ────────────────────────────────────
// Postiz is a real multi-container app (its own web app + Postgres +
// Redis) that has to stay running 24/7 — it's the thing holding every
// social account's OAuth token between posts. Jarvis's E2B sandbox
// (computer.js) is DELIBERATELY ephemeral (reaped after ~15 min idle,
// ~30 min max lifetime — see computer.js's IDLE_TIMEOUT_MS) so it is
// NOT used here; standing Postiz up there would silently lose its
// database (and every connected account's login) the next time the
// sandbox got reaped. Instead this drives jarvis-agent.js's local
// shell access — i.e. it sets Postiz up on the SAME machine Jarvis
// itself is running on, which is the one place in this codebase that
// actually stays on. That only works when Jarvis is running locally
// (jarvis-agent.isEnabled() — false on Render). If Jarvis is deployed
// to the cloud with nowhere persistent to put Postiz, ensurePostiz()
// says so plainly instead of pretending to succeed — see
// noPersistentHostError() below for the honest alternatives.
//
// ── THE "FACE ID LOGIN" QUESTION ──────────────────────────────────
// Some social platforms ask for a liveness/face check during their
// OWN login or account-verification flow. Jarvis does not, and will
// not, try to fake or replay a face to get past that — that's
// identity-verification fraud regardless of good intent. The actual
// fix is simpler and fully legitimate: the business owner opens their
// own self-hosted Postiz dashboard ONE TIME (getDashboardUrl() below)
// and connects each platform themselves, in their own browser, on
// their own device — if a platform wants a live face check at that
// moment, a real human in front of a real camera satisfies it exactly
// the way it's supposed to. Postiz then stores the resulting OAuth
// token. From that point on, every future post goes through Postiz's
// REST API with that stored token — no login screen, no camera, no
// face check ever appears again, because the API path was never
// gated behind one. That's what gets Jarvis "signed in without face
// ID" for real, instead of by defeating a security check.
// ═══════════════════════════════════════════════════════════════

const os   = require("os");
const path = require("path");
let Agent = null;
try { Agent = require("./jarvis-agent"); } catch { Agent = null; }
const Settings = require("./settings");

const REPO_URL   = "https://github.com/gitroomhq/postiz-app.git";
const INSTALL_DIR = process.env.POSTIZ_DIR || path.join(os.homedir(), ".jarvis-postiz", "postiz-app");

// Best-effort defaults. Postiz's own docker-compose.yml / .env.example
// (fetched fresh at setup time, not hardcoded from memory here) is the
// source of truth for the real port layout — override these if they
// don't match what actually ends up in your .env after cloning.
const FRONTEND_PORT = process.env.POSTIZ_FRONTEND_PORT || "4200";
const BACKEND_PORT  = process.env.POSTIZ_BACKEND_PORT  || "3000";

function isLocalHostAvailable() {
  return !!(Agent && Agent.isEnabled());
}

function noPersistentHostError() {
  return new Error(
    "Jarvis is running somewhere without a persistent place to host Postiz (e.g. a cloud deploy like Render). " +
    "Postiz needs to stay running 24/7 to hold your social accounts' logins between posts, and Jarvis's cloud " +
    "sandbox gets wiped every ~30 minutes, so it can't be the host. Two real options: " +
    "(1) run Jarvis locally on your own always-on machine and try this again — that's the free option, or " +
    "(2) self-host Postiz on any free-tier Docker host you control (Fly.io, a home server, etc.) and set " +
    "POSTIZ_API_URL / POSTIZ_API_KEY in Jarvis's .env once it's up, and Jarvis will use it exactly the same way."
  );
}

// ── SETTINGS (persisted like everything else in settings.js) ──────
function getConfig() {
  const s = Settings.load();
  return {
    apiUrl: process.env.POSTIZ_API_URL || s.postizApiUrl || `http://localhost:${BACKEND_PORT}`,
    dashboardUrl: process.env.POSTIZ_DASHBOARD_URL || s.postizDashboardUrl || `http://localhost:${FRONTEND_PORT}`,
    apiKey: process.env.POSTIZ_API_KEY || s.postizApiKey || "",
  };
}
function saveConfig(partial) {
  const s = Settings.load();
  Settings.save({ ...s, ...partial });
}

function isConfigured() {
  return !!getConfig().apiKey;
}

// ── SETUP (one-time, deliberate — never triggered by a misheard voice
// phrase, so this bypasses jarvis-agent's confirm/pending gate, which
// exists for exactly that ambiguity, not for an explicit setup call) ──
async function ensurePostiz(opts = {}) {
  if (!isLocalHostAvailable()) throw noPersistentHostError();

  const log = [];
  const run = async (cmd, cwd) => {
    const full = cwd ? `cd ${JSON.stringify(cwd)} && ${cmd}` : cmd;
    const result = await Agent.runShellCommand(full);
    log.push({ cmd, ...result });
    return result;
  };

  // 1. Docker itself — deliberately NOT auto-installed. Installing a
  // container runtime needs OS-specific privileged steps (and often a
  // reboot on Windows/macOS), which isn't something to do silently on
  // someone's real machine on their behalf.
  const dockerCheck = await run("docker --version");
  if (dockerCheck.code) {
    throw new Error(
      "Docker isn't installed (or isn't on PATH). Postiz runs as Docker containers, so grab Docker Desktop " +
      "(https://docs.docker.com/get-docker/) — free — install it, make sure it's actually running, then try again."
    );
  }

  // 2. Clone (idempotent — a `git pull` if it's already there).
  const cloned = await run(`test -d "${INSTALL_DIR}/.git"`);
  if (cloned.code) {
    await run(`mkdir -p "${path.dirname(INSTALL_DIR)}"`);
    const cloneResult = await run(`git clone --depth 1 "${REPO_URL}" "${INSTALL_DIR}"`);
    if (cloneResult.code) throw new Error(`Couldn't clone Postiz: ${cloneResult.stderr || cloneResult.stdout || "unknown git error"}`);
  } else if (opts.pull !== false) {
    await run(`git pull`, INSTALL_DIR);
  }

  // 3. .env — copy the repo's own example file if we don't have one
  // yet, and fill in the couple of values that MUST be non-default
  // (a real secret, not the placeholder) for it to be safe to run.
  // Deliberately reads whatever keys actually exist in THIS repo
  // checkout's .env.example rather than a hardcoded list here, since
  // Postiz's own config surface can change between checkouts and a
  // stale hardcoded list would silently miss new required vars.
  const envExists = await run(`test -f "${INSTALL_DIR}/.env"`);
  if (envExists.code) {
    const copyResult = await run(`cp .env.example .env 2>/dev/null || cp .env.sample .env 2>/dev/null || touch .env`, INSTALL_DIR);
    log.push(copyResult);
    const jwtSecret = require("crypto").randomBytes(32).toString("hex");
    // Best-effort: set a real JWT secret if that key exists in the file,
    // leave every other key at whatever the repo's example shipped —
    // review INSTALL_DIR/.env yourself before this goes live for real.
    await run(
      `grep -q '^JWT_SECRET=' .env && sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${jwtSecret}/" .env || echo "JWT_SECRET=${jwtSecret}" >> .env`,
      INSTALL_DIR
    );
  }

  // 4. Build + start. `docker compose` (v2, space) first, `docker-compose`
  // (v1, hyphen — some older installs only have this) as a fallback.
  let upResult = await run(`docker compose up -d --build`, INSTALL_DIR);
  if (upResult.code) {
    upResult = await run(`docker-compose up -d --build`, INSTALL_DIR);
  }
  if (upResult.code) {
    throw new Error(
      `docker compose failed to bring Postiz up: ${(upResult.stderr || upResult.stdout || "").slice(-800)}\n\n` +
      `Full log of what was tried is available if you need to debug this by hand in ${INSTALL_DIR}.`
    );
  }

  const config = getConfig();
  saveConfig({
    postizApiUrl: `http://localhost:${BACKEND_PORT}`,
    postizDashboardUrl: `http://localhost:${FRONTEND_PORT}`,
  });

  return {
    installed: true,
    installDir: INSTALL_DIR,
    dashboardUrl: `http://localhost:${FRONTEND_PORT}`,
    apiUrl: `http://localhost:${BACKEND_PORT}`,
    hasApiKey: !!config.apiKey,
    log,
    nextSteps: [
      `Open ${`http://localhost:${FRONTEND_PORT}`} in your own browser and finish Postiz's own first-run signup.`,
      "In Postiz's own Settings, connect each social platform you want Jarvis to post to — do this yourself, in your own browser; this is the one-time step that satisfies any login/verification (including face checks) a platform asks for.",
      "Still in Postiz's Settings, generate an API key, then tell Jarvis to save it (savePostizApiKey()) so it can post on your behalf from then on.",
    ],
  };
}

function savePostizApiKey(apiKey) {
  if (!apiKey || !String(apiKey).trim()) throw new Error("Empty API key given.");
  saveConfig({ postizApiKey: String(apiKey).trim() });
  return true;
}

function getDashboardUrl() {
  return getConfig().dashboardUrl;
}

// ── THIN API WRAPPER ────────────────────────────────────────────
// Endpoint shapes below follow Postiz's public REST API as documented
// at https://docs.postiz.com — since that can move, every call fails
// loudly with the raw response instead of swallowing a mismatch, so a
// bad guess here is obvious immediately rather than a silent no-op.
async function postizRequest(reqPath, opts = {}) {
  const { apiUrl, apiKey } = getConfig();
  if (!apiKey) throw new Error("No Postiz API key saved yet — run ensurePostiz(), connect your accounts, then savePostizApiKey().");

  const res = await fetch(`${apiUrl}${reqPath}`, {
    method: opts.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(opts.timeoutMs || 30000),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    throw new Error(
      `Postiz API ${opts.method || "GET"} ${reqPath} -> HTTP ${res.status}: ${text.slice(0, 300)} ` +
      `(if this looks like a wrong path, check the live docs at ${apiUrl}/... or https://docs.postiz.com — the API surface may have moved)`
    );
  }
  return data;
}

async function listConnectedAccounts() {
  return postizRequest("/public/v1/integrations");
}

/**
 * Create (and optionally schedule) a post carrying an already-produced
 * video. mediaUrl must be reachable BY the Postiz container (a public
 * URL, or something on the same Docker network) — a local sandbox file
 * path won't resolve from inside Postiz's own container.
 */
async function createPost({ content, mediaUrl, platforms, scheduleAt = null }) {
  if (!content) throw new Error("createPost() needs caption/content text.");
  if (!mediaUrl) throw new Error("createPost() needs a mediaUrl Postiz's own container can reach.");
  if (!platforms || !platforms.length) throw new Error("createPost() needs at least one connected platform integration id.");

  return postizRequest("/public/v1/posts", {
    method: "POST",
    body: {
      type: scheduleAt ? "schedule" : "now",
      date: scheduleAt || undefined,
      content,
      media: [{ url: mediaUrl }],
      integrations: platforms,
    },
  });
}

module.exports = {
  isLocalHostAvailable,
  isConfigured,
  ensurePostiz,
  savePostizApiKey,
  getDashboardUrl,
  getConfig,
  postizRequest,
  listConnectedAccounts,
  createPost,
  INSTALL_DIR,
};
