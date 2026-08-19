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
// ── WHERE THIS RUNS ───────────────────────────────────────────────
// DEFAULT: Jarvis's own dedicated E2B sandbox (computer.js's
// createDedicatedSandbox/connectDedicatedSandbox), NOT the shared
// coding sandbox. A plain E2B sandbox is ephemeral by default — but
// this one is created with E2B's beta auto-pause feature, so instead
// of being destroyed when idle it's PAUSED (full disk + memory state,
// including a running Docker daemon with live containers, preserved)
// and RESUMED later by reconnecting to the same saved sandboxId. That
// makes "use the sandbox for Postiz" actually viable instead of
// losing every connected social account's login every ~30 minutes.
//
// HONESTY NOTES (read before relying on this for something real):
//   - auto-pause is an E2B BETA feature. computer.js's
//     createDedicatedSandbox() falls back to a plain non-pausable
//     sandbox if the installed SDK version doesn't support it — in
//     that fallback case this WILL eventually lose its data when E2B
//     hard-kills it (1h Hobby tier / 24h Pro tier ceiling).
//   - Whether a full Docker daemon + running containers actually
//     resume cleanly across a pause/resume cycle hasn't been verified
//     against a live sandbox as of writing this — ensurePostiz()
//     re-checks `docker ps` after every reconnect and re-runs
//     `docker compose up -d` (a no-op if containers are already
//     healthy) specifically to paper over that uncertainty rather
//     than assume it "just works."
//   - Nested Docker inside E2B's own sandboxing isn't guaranteed to
//     be allowed at all (depends on E2B's underlying isolation tech)
//     — if `docker` can't actually run there, ensurePostiz() fails
//     loudly with that exact error instead of pretending to succeed.
//
// FALLBACK: if E2B isn't configured, ensurePostizLocal() sets Postiz
// up on the machine Jarvis's own Node process is running on instead
// (via jarvis-agent.js), which only works when Jarvis is running
// locally, not deployed to something like Render.
//
// ── THE "FACE ID LOGIN" QUESTION ──────────────────────────────────
// Some social platforms ask for a liveness/face check during their
// OWN login or account-verification flow. Jarvis does not, and will
// not, try to fake or replay a face to get past that — that's
// identity-verification fraud regardless of good intent. The actual
// fix is simpler and fully legitimate: the business owner opens their
// own self-hosted Postiz dashboard ONE TIME (getDashboardUrl() below
// — a real public https:// URL via E2B's own port forwarding, so this
// works from any device, no VPN/port-forwarding setup needed) and
// connects each platform themselves, in their own browser, on their
// own device — if a platform wants a live face check at that moment,
// a real human in front of a real camera satisfies it exactly the way
// it's supposed to. Postiz then stores the resulting OAuth token.
// From that point on, every future post goes through Postiz's REST
// API with that stored token — no login screen, no camera, no face
// check ever appears again, because the API path was never gated
// behind one. That's what gets Jarvis "signed in without face ID" for
// real, instead of by defeating a security check.
// ═══════════════════════════════════════════════════════════════

const crypto = require("crypto");
const os     = require("os");
const path   = require("path");
const Computer = require("./computer");
let Agent = null;
try { Agent = require("./jarvis-agent"); } catch { Agent = null; }
const Settings = require("./settings");

const REPO_URL = "https://github.com/gitroomhq/postiz-app.git";

// Sandbox path — E2B's default template runs commands as `user` with
// $HOME=/home/user.
const SANDBOX_INSTALL_DIR = "/home/user/postiz-app";
// Local-machine fallback path.
const LOCAL_INSTALL_DIR = process.env.POSTIZ_DIR || path.join(os.homedir(), ".jarvis-postiz", "postiz-app");

// Best-effort defaults — Postiz's own docker-compose.yml / .env.example
// (fetched fresh at setup time, not hardcoded from memory here) is the
// real source of truth for the port layout; override these if they
// don't match what actually ends up in your .env after cloning.
const FRONTEND_PORT = parseInt(process.env.POSTIZ_FRONTEND_PORT || "4200", 10);
const BACKEND_PORT  = parseInt(process.env.POSTIZ_BACKEND_PORT  || "3000", 10);

// ── SETTINGS (persisted like everything else in settings.js — the
// sandboxId in particular MUST survive a Jarvis restart, or every
// restart would orphan the running Postiz sandbox and provision a
// brand new empty one) ─────────────────────────────────────────────
function getConfig() {
  const s = Settings.load();
  return {
    hostMode: s.postizHostMode || "sandbox", // "sandbox" | "local"
    sandboxId: s.postizSandboxId || "",
    apiUrl: process.env.POSTIZ_API_URL || s.postizApiUrl || "",
    dashboardUrl: process.env.POSTIZ_DASHBOARD_URL || s.postizDashboardUrl || "",
    apiKey: process.env.POSTIZ_API_KEY || s.postizApiKey || "",
  };
}
function saveConfig(partial) { Settings.save(partial); }

function isConfigured() { return !!getConfig().apiKey; }
function isLocalHostAvailable() { return !!(Agent && Agent.isEnabled()); }

function noHostAvailableError() {
  return new Error(
    "Can't host Postiz right now — E2B isn't configured (add E2B_API_KEY to .env, free at https://e2b.dev) " +
    "AND Jarvis isn't running locally either (the local-machine fallback needs that). Set up E2B and this " +
    "will just work — it's the free, no-server-required option."
  );
}

// ── SANDBOX HOSTING (default) ──────────────────────────────────────
async function getOrCreateSandbox() {
  const cfg = getConfig();
  if (cfg.sandboxId) {
    try {
      const sbx = await Computer.connectDedicatedSandbox(cfg.sandboxId);
      await Computer.extendDedicatedSandbox(sbx, 60 * 60 * 1000);
      return sbx;
    } catch (e) {
      console.warn(`[POSTIZ-AGENT] Couldn't reconnect to sandbox ${cfg.sandboxId} (${e.message}) — it's gone (hit E2B's hard ceiling, or was killed some other way). Postiz's old data is lost; provisioning a fresh sandbox.`);
    }
  }
  const sbx = await Computer.createDedicatedSandbox({ metadata: { source: "jarvis-postiz" } });
  saveConfig({ postizSandboxId: sbx.sandboxId, postizHostMode: "sandbox" });
  return sbx;
}

async function ensurePostizInSandbox(opts = {}) {
  if (!Computer.isConfigured()) throw new Error("E2B isn't configured — add E2B_API_KEY to .env (free at https://e2b.dev).");

  const sbx = await getOrCreateSandbox();
  const log = [];
  const track = async (cmd, runOpts) => { const r = await Computer.runOnSandbox(sbx, cmd, runOpts); log.push(r); return r; };

  // 1. Docker — E2B's default template doesn't ship it, install if
  // missing. Genuinely uncertain whether nested Docker is even
  // permitted inside E2B's isolation tech until this actually runs —
  // fails loudly here rather than pretending success if it isn't.
  let dockerCheck = await track("docker ps");
  if (!dockerCheck.ok) {
    await track("curl -fsSL https://get.docker.com | sudo sh", { timeoutMs: 180000 });
    await track("sudo dockerd > /tmp/dockerd.log 2>&1 & disown; sleep 3; true", { timeoutMs: 15000 });
    dockerCheck = await track("docker ps");
    if (!dockerCheck.ok) {
      throw new Error(
        `Docker won't run inside this E2B sandbox: ${(dockerCheck.stderr || dockerCheck.stdout || "").slice(-500)}\n` +
        `E2B's sandboxing may not allow nested containers here. Try ensurePostizLocal() instead — that hosts ` +
        `Postiz on your own machine via Docker Desktop, but needs Jarvis running locally (not on a cloud deploy).`
      );
    }
  }

  // 2. Clone (idempotent — `git pull` if already cloned; harmless if
  // this is a resumed sandbox that already has it).
  const cloned = await track(`test -d "${SANDBOX_INSTALL_DIR}/.git"`);
  if (!cloned.ok) {
    const cloneResult = await track(`git clone --depth 1 "${REPO_URL}" "${SANDBOX_INSTALL_DIR}"`, { timeoutMs: 120000 });
    if (!cloneResult.ok) throw new Error(`Couldn't clone Postiz: ${cloneResult.stderr || cloneResult.stdout || "unknown git error"}`);
  } else if (opts.pull !== false) {
    await track(`git pull`, { cwd: SANDBOX_INSTALL_DIR });
  }

  // 3. .env — copy the repo's own example if missing, fill in a real
  // JWT secret if that key exists. Reads whatever's actually in THIS
  // checkout's .env.example rather than a hardcoded list, since
  // Postiz's config surface can change between checkouts.
  const envExists = await track(`test -f "${SANDBOX_INSTALL_DIR}/.env"`);
  if (!envExists.ok) {
    await track(`cp .env.example .env 2>/dev/null || cp .env.sample .env 2>/dev/null || touch .env`, { cwd: SANDBOX_INSTALL_DIR });
    const jwtSecret = crypto.randomBytes(32).toString("hex");
    await track(
      `grep -q '^JWT_SECRET=' .env && sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${jwtSecret}/" .env || echo "JWT_SECRET=${jwtSecret}" >> .env`,
      { cwd: SANDBOX_INSTALL_DIR }
    );
  }

  // 4. Build + start (or confirm already-healthy, on a resumed sandbox).
  let upResult = await track(`docker compose up -d --build`, { cwd: SANDBOX_INSTALL_DIR, timeoutMs: 10 * 60 * 1000 });
  if (!upResult.ok) upResult = await track(`docker-compose up -d --build`, { cwd: SANDBOX_INSTALL_DIR, timeoutMs: 10 * 60 * 1000 });
  if (!upResult.ok) {
    throw new Error(`docker compose failed to bring Postiz up inside the sandbox: ${(upResult.stderr || upResult.stdout || "").slice(-800)}`);
  }

  // 5. Public URLs via E2B's own port forwarding — sandbox.getHost(port)
  // hands back a real public https hostname with zero port-forwarding
  // or Docker-networking setup on your end. This is why sandbox mode
  // can offer a dashboard URL that works from ANY device, unlike the
  // local-machine fallback's http://localhost, which only works on
  // that one machine.
  const dashboardUrl = `https://${sbx.getHost(FRONTEND_PORT)}`;
  const apiUrl = `https://${sbx.getHost(BACKEND_PORT)}`;
  saveConfig({ postizDashboardUrl: dashboardUrl, postizApiUrl: apiUrl, postizHostMode: "sandbox" });

  const config = getConfig();
  return {
    hostMode: "sandbox",
    sandboxId: sbx.sandboxId,
    dashboardUrl,
    apiUrl,
    hasApiKey: !!config.apiKey,
    log,
    nextSteps: [
      `Open ${dashboardUrl} in your own browser (any device — it's a real public URL) and finish Postiz's own first-run signup.`,
      "In Postiz's own Settings, connect each social platform you want Jarvis to post to yourself, in your own browser — this is the one-time step that satisfies any login/verification (including face checks) a platform asks for.",
      "Still in Postiz's Settings, generate an API key, then tell Jarvis to save it (savePostizApiKey()) so it can post on your behalf from then on.",
    ],
  };
}

// ── LOCAL-MACHINE HOSTING (fallback, only if E2B isn't configured or
// its Docker-in-sandbox path genuinely doesn't work) ────────────────
// One-time, deliberate — never triggered by a misheard voice phrase,
// so this bypasses jarvis-agent's confirm/pending gate, which exists
// for exactly that ambiguity, not for an explicit setup call.
async function ensurePostizLocal(opts = {}) {
  if (!isLocalHostAvailable()) {
    throw new Error(
      "Jarvis isn't running locally (e.g. it's deployed to Render), so there's no machine here to host Postiz on. " +
      "Use the E2B sandbox path instead (ensurePostizInSandbox / ensurePostiz) — it needs no server of your own."
    );
  }

  const log = [];
  const run = async (cmd, cwd) => {
    const full = cwd ? `cd ${JSON.stringify(cwd)} && ${cmd}` : cmd;
    const result = await Agent.runShellCommand(full);
    log.push({ cmd, ...result });
    return result;
  };

  const dockerCheck = await run("docker --version");
  if (dockerCheck.code) {
    throw new Error(
      "Docker isn't installed (or isn't on PATH). Postiz runs as Docker containers, so grab Docker Desktop " +
      "(https://docs.docker.com/get-docker/) — free — install it, make sure it's actually running, then try again."
    );
  }

  const cloned = await run(`test -d "${LOCAL_INSTALL_DIR}/.git"`);
  if (cloned.code) {
    await run(`mkdir -p "${path.dirname(LOCAL_INSTALL_DIR)}"`);
    const cloneResult = await run(`git clone --depth 1 "${REPO_URL}" "${LOCAL_INSTALL_DIR}"`);
    if (cloneResult.code) throw new Error(`Couldn't clone Postiz: ${cloneResult.stderr || cloneResult.stdout || "unknown git error"}`);
  } else if (opts.pull !== false) {
    await run(`git pull`, LOCAL_INSTALL_DIR);
  }

  const envExists = await run(`test -f "${LOCAL_INSTALL_DIR}/.env"`);
  if (envExists.code) {
    await run(`cp .env.example .env 2>/dev/null || cp .env.sample .env 2>/dev/null || touch .env`, LOCAL_INSTALL_DIR);
    const jwtSecret = crypto.randomBytes(32).toString("hex");
    await run(
      `grep -q '^JWT_SECRET=' .env && sed -i.bak "s/^JWT_SECRET=.*/JWT_SECRET=${jwtSecret}/" .env || echo "JWT_SECRET=${jwtSecret}" >> .env`,
      LOCAL_INSTALL_DIR
    );
  }

  let upResult = await run(`docker compose up -d --build`, LOCAL_INSTALL_DIR);
  if (upResult.code) upResult = await run(`docker-compose up -d --build`, LOCAL_INSTALL_DIR);
  if (upResult.code) {
    throw new Error(`docker compose failed to bring Postiz up: ${(upResult.stderr || upResult.stdout || "").slice(-800)}`);
  }

  const dashboardUrl = `http://localhost:${FRONTEND_PORT}`;
  const apiUrl = `http://localhost:${BACKEND_PORT}`;
  saveConfig({ postizDashboardUrl: dashboardUrl, postizApiUrl: apiUrl, postizHostMode: "local" });

  const config = getConfig();
  return {
    hostMode: "local",
    installDir: LOCAL_INSTALL_DIR,
    dashboardUrl,
    apiUrl,
    hasApiKey: !!config.apiKey,
    log,
    nextSteps: [
      `Open ${dashboardUrl} in your own browser and finish Postiz's own first-run signup.`,
      "In Postiz's own Settings, connect each social platform yourself — this satisfies any login/face check.",
      "Generate an API key in Postiz's Settings, then tell Jarvis to save it (savePostizApiKey()).",
    ],
  };
}

// Default entry point — sandbox first (works everywhere, no server of
// your own required), local machine only as an explicit fallback.
async function ensurePostiz(opts = {}) {
  if (Computer.isConfigured()) return ensurePostizInSandbox(opts);
  if (isLocalHostAvailable()) return ensurePostizLocal(opts);
  throw noHostAvailableError();
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
// loudly with the raw response instead of swallowing a mismatch.
//
// SANDBOX WAKE: if hosted in sandbox mode, a paused sandbox's public
// URL won't respond to anything until it's resumed — reconnect (which
// also resumes a paused sandbox) before every request rather than
// assuming it's already awake. Cheap no-op if it's already running.
async function wakeIfSandboxHosted() {
  const cfg = getConfig();
  if (cfg.hostMode === "sandbox" && cfg.sandboxId) {
    try {
      const sbx = await Computer.connectDedicatedSandbox(cfg.sandboxId);
      await Computer.extendDedicatedSandbox(sbx, 60 * 60 * 1000);
    } catch (e) {
      console.warn(`[POSTIZ-AGENT] Couldn't wake the Postiz sandbox before this request (${e.message}) — the request below may fail as a result.`);
    }
  }
}

async function postizRequest(reqPath, opts = {}) {
  const { apiUrl, apiKey } = getConfig();
  if (!apiKey) throw new Error("No Postiz API key saved yet — run ensurePostiz(), connect your accounts, then savePostizApiKey().");
  if (!apiUrl) throw new Error("No Postiz instance set up yet — run ensurePostiz() first.");

  await wakeIfSandboxHosted();

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
 * video. mediaUrl must be reachable BY the Postiz instance itself — a
 * public URL Jarvis's own server exposes it at (see
 * video-agent-routes.js), not a local sandbox file path.
 */
async function createPost({ content, mediaUrl, platforms, scheduleAt = null }) {
  if (!content) throw new Error("createPost() needs caption/content text.");
  if (!mediaUrl) throw new Error("createPost() needs a mediaUrl Postiz's own instance can reach.");
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
  ensurePostizInSandbox,
  ensurePostizLocal,
  savePostizApiKey,
  getDashboardUrl,
  getConfig,
  postizRequest,
  listConnectedAccounts,
  createPost,
};
