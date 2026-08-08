"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Computer (E2B cloud sandbox)
//
// This gives Jarvis an actual computer of its own — a real, isolated
// Linux VM in the cloud (via e2b.dev) that Jarvis can run commands
// on, install packages in, write/execute code in, and drive a real
// headless browser in. It's separate from jarvis-agent.js, which
// only ever touches the machine Jarvis itself happens to be running
// on (your PC, if you're running it locally) and is disabled outright
// the moment Jarvis is deployed somewhere like Render. This module
// works everywhere, always, because e2b.dev — not your PC — is the
// "computer" in question.
//
// USES:
//   - "try this on your computer" / "test this out on your computer"
//     / "run this on your pc" — write + execute code or a whole
//     little backend, see if it actually works, THEN hand you the
//     result instead of just guessing it's right.
//   - instagram.js uses browsePage() to open a real Chromium browser
//     inside the sandbox and load an Instagram profile, the same way
//     a person would — this renders JS, follows redirects, and looks
//     like an ordinary browser, so it succeeds a lot more often than
//     a plain fetch() at getting past Instagram's login wall for a
//     public profile.
//   - Anything else that benefits from "run it somewhere safe first,
//     not directly on the user's machine and not just as a guess."
//
// SETUP:
//   1. Sign up free at https://e2b.dev, grab an API key from the
//      dashboard.
//   2. Add to .env:  E2B_API_KEY=e2b_xxxxxxxxxxxx
//   3. npm install (pulls in @e2b/code-interpreter).
//   That's it — no template building required. Everything here uses
//   E2B's default sandbox template and installs whatever extra tools
//   a given task needs (e.g. Playwright for browsing) on demand,
//   the first time they're needed, inside the sandbox itself.
//
// isConfigured() is checked by every caller (server.js, instagram.js)
// before this is used, and every exported function fails soft with
// a plain { error: "..." } / thrown Error rather than crashing —
// same "never take the whole assistant down" rule as everything
// else in this codebase (see server.js's CRASH GUARD comment).
// ═══════════════════════════════════════════════════════════════

const path = require("path");

let SandboxCtor = null;
let loadError = null;
try {
  ({ Sandbox: SandboxCtor } = require("@e2b/code-interpreter"));
} catch (e) {
  loadError = e;
}

const E2B_API_KEY = process.env.E2B_API_KEY || "";

// How long an idle sandbox is kept warm before Jarvis kills it off to
// stop paying for it. Reused across consecutive requests in that
// window so e.g. "test this" followed by "now also add a test for X"
// shares the same filesystem/installed packages instead of a cold
// start every single message. 15 min covers a normal back-and-forth;
// tune with E2B_SANDBOX_IDLE_MS if you want it shorter/longer.
const IDLE_TIMEOUT_MS = parseInt(process.env.E2B_SANDBOX_IDLE_MS || "", 10) || 15 * 60 * 1000;

// Upper bound E2B itself enforces on total sandbox lifetime per
// session — passed as timeoutMs on creation. Kept generous (30 min)
// since a slow `npm install` + test run can eat a couple minutes on
// its own; the idle timer above is what actually reclaims it early.
const SANDBOX_LIFETIME_MS = parseInt(process.env.E2B_SANDBOX_LIFETIME_MS || "", 10) || 30 * 60 * 1000;

function isConfigured() {
  return !!(E2B_API_KEY && SandboxCtor);
}

function notConfiguredError() {
  if (!SandboxCtor) {
    return new Error(
      `The @e2b/code-interpreter package isn't installed${loadError ? ` (${loadError.message})` : ""} — run \`npm install\` and restart Jarvis.`
    );
  }
  return new Error(
    "E2B isn't configured yet — grab a free API key at https://e2b.dev and add E2B_API_KEY to .env, then restart Jarvis."
  );
}

// ── SANDBOX LIFECYCLE (lazy singleton, idle-reaped) ────────────────
let activeSandbox = null;
let idleTimer = null;
let playwrightInstalled = false; // per-sandbox-instance flag, reset on kill/recreate

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { killSandbox().catch(() => {}); }, IDLE_TIMEOUT_MS);
  if (idleTimer.unref) idleTimer.unref(); // never keep the process alive just for this
}

async function getSandbox() {
  if (!isConfigured()) throw notConfiguredError();

  if (activeSandbox) {
    armIdleTimer();
    return activeSandbox;
  }

  activeSandbox = await SandboxCtor.create({
    apiKey: E2B_API_KEY,
    timeoutMs: SANDBOX_LIFETIME_MS,
    metadata: { source: "jarvis" },
  });
  playwrightInstalled = false;
  armIdleTimer();
  return activeSandbox;
}

// Explicitly tear the sandbox down — called on idle timeout, and
// exposed for "close your computer" / server shutdown.
async function killSandbox() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  const sbx = activeSandbox;
  activeSandbox = null;
  playwrightInstalled = false;
  if (sbx) {
    try { await sbx.kill(); } catch { /* already gone — fine */ }
  }
}

function isRunning() {
  return !!activeSandbox;
}

// ── SHELL COMMANDS ──────────────────────────────────────────────
// General-purpose "run this on your computer" — npm install, run a
// script, curl something, git clone, ls, whatever. Never throws for
// a command that ran-but-failed (non-zero exit): that comes back as
// a normal result so the caller can decide what to do with it. Only
// throws for infrastructure problems (not configured, sandbox failed
// to start, timeout).
async function runCommand(cmd, opts = {}) {
  const sbx = await getSandbox();
  const result = await sbx.commands.run(cmd, {
    timeoutMs: opts.timeoutMs || 120000,
    cwd: opts.cwd || undefined,
  });
  return {
    command: cmd,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : (result.exitCode ?? 0),
    ok: (result.exitCode ?? 0) === 0,
  };
}

// Runs several commands in sequence, stopping early if one fails
// (unless opts.continueOnError). Returns the full log either way —
// useful for "install deps, then run tests" style multi-step checks.
async function runCommands(cmds, opts = {}) {
  const log = [];
  for (const cmd of cmds) {
    const r = await runCommand(cmd, opts);
    log.push(r);
    if (!r.ok && !opts.continueOnError) break;
  }
  return log;
}

// ── QUICK CODE EXECUTION (Python/JS snippets, via the Code
// Interpreter's runCode — rich output: stdout/stderr, return value,
// even charts/images if the snippet produces any) ──────────────────
async function runCode(code, opts = {}) {
  const sbx = await getSandbox();
  const execution = await sbx.runCode(code, { language: opts.language || "python" });
  const stdout = (execution.logs && execution.logs.stdout ? execution.logs.stdout.join("") : "") || "";
  const stderr = (execution.logs && execution.logs.stderr ? execution.logs.stderr.join("") : "") || "";
  return {
    stdout,
    stderr,
    error: execution.error ? `${execution.error.name}: ${execution.error.value}` : null,
    text: execution.text || "",
    ok: !execution.error,
  };
}

// ── FILES ───────────────────────────────────────────────────────
async function writeFile(filePath, content) {
  const sbx = await getSandbox();
  await sbx.files.write(filePath, content);
  return { path: filePath };
}

async function writeFiles(baseDir, files) {
  const sbx = await getSandbox();
  await runCommand(`mkdir -p ${shellQuote(baseDir)}`);
  for (const f of files) {
    const fullPath = path.posix.join(baseDir, f.path);
    const dir = path.posix.dirname(fullPath);
    if (dir && dir !== ".") await runCommand(`mkdir -p ${shellQuote(dir)}`);
    await sbx.files.write(fullPath, f.content);
  }
  return { baseDir, count: files.length };
}

async function readFile(filePath, opts = {}) {
  const sbx = await getSandbox();
  return sbx.files.read(filePath, opts.binary ? { format: "bytes" } : undefined);
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

// ── PROJECT TEST HELPER ────────────────────────────────────────
// The main "build a backend and test it before giving it to me"
// primitive: drop a set of files into a fresh directory in the
// sandbox, run an install step, run a test/start step, and hand back
// everything that happened so Jarvis can actually read the output
// and know whether it worked — rather than just asserting it does.
//
//   files:      [{ path: "server.js", content: "..." }, ...]
//   installCmd: e.g. "npm install"  (optional)
//   testCmd:    e.g. "npm test"  or  "node server.js & sleep 2 && curl -s localhost:3000 && kill %1"
async function testProject({ files, installCmd, testCmd, baseDir } = {}) {
  if (!Array.isArray(files) || !files.length) throw new Error("testProject needs at least one file.");
  const dir = baseDir || `/home/user/jarvis-project-${Date.now()}`;

  await writeFiles(dir, files);

  const log = [];
  if (installCmd) {
    log.push({ step: "install", ...(await runCommand(installCmd, { cwd: dir, timeoutMs: 5 * 60 * 1000 })) });
  }
  if (testCmd && (!log.length || log[log.length - 1].ok)) {
    log.push({ step: "run", ...(await runCommand(testCmd, { cwd: dir, timeoutMs: 3 * 60 * 1000 })) });
  }

  return { dir, log, ok: log.every((s) => s.ok) };
}

// ── REAL BROWSER (Playwright + Chromium, installed on first use) ──
// Used for anything that needs actual JS-rendered output — Instagram
// profiles being the main case (see instagram.js), but usable for
// any URL. Installs Playwright + a Chromium build into the sandbox
// the first time it's called in a given sandbox session (~30-60s),
// then reuses it for the rest of that session.
async function ensureBrowser() {
  if (playwrightInstalled) return;
  const install = await runCommand(
    "npm ls playwright --prefix /home/user >/dev/null 2>&1 || npm install --no-save --prefix /home/user playwright > /tmp/pw-install.log 2>&1",
    { timeoutMs: 4 * 60 * 1000 }
  );
  if (!install.ok) throw new Error(`Couldn't install Playwright in the sandbox: ${(install.stderr || install.stdout).slice(0, 300)}`);

  const installBrowser = await runCommand(
    "cd /home/user && npx playwright install --with-deps chromium > /tmp/pw-browser-install.log 2>&1",
    { timeoutMs: 5 * 60 * 1000 }
  );
  if (!installBrowser.ok) throw new Error(`Couldn't install Chromium in the sandbox: ${(installBrowser.stderr || installBrowser.stdout).slice(0, 300)}`);

  playwrightInstalled = true;
}

// Navigates to a URL in a real headless Chromium instance inside the
// sandbox, waits for the page to settle, and returns a screenshot
// (base64 PNG) plus the rendered HTML and visible text. Runs as a
// one-off Node script written to the sandbox rather than a persistent
// browser session — simpler and plenty fast enough for "load this
// page and look at it" style calls.
async function browsePage(url, opts = {}) {
  await ensureBrowser();

  const waitMs = opts.waitMs || 2500;
  const scriptPath = "/home/user/_jarvis_browse.js";
  const outPath = "/home/user/_jarvis_browse_out.json";
  const shotPath = "/home/user/_jarvis_browse_shot.png";

  const script = `
const { chromium } = require('playwright');
const fs = require('fs');

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  let ok = true, errorMsg = null;
  try {
    await page.goto(${JSON.stringify(url)}, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(${waitMs});
  } catch (e) {
    ok = false; errorMsg = String(e && e.message || e);
  }
  let html = '', text = '';
  try { html = await page.content(); } catch {}
  try { text = await page.evaluate(() => document.body ? document.body.innerText : ''); } catch {}
  try { await page.screenshot({ path: ${JSON.stringify(shotPath)} }); } catch {}
  fs.writeFileSync(${JSON.stringify(outPath)}, JSON.stringify({ ok, errorMsg, html, text, finalUrl: page.url() }));
  await browser.close();
})();
`.trim();

  await writeFile(scriptPath, script);
  const run = await runCommand(`node ${shellQuote(scriptPath)}`, { timeoutMs: 30000 });

  let parsed = null;
  try {
    const raw = await readFile(outPath);
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: run.stderr || run.stdout || "Browse script produced no output." };
  }

  let screenshotBase64 = null;
  try {
    const bytes = await readFile(shotPath, { binary: true });
    screenshotBase64 = Buffer.from(bytes).toString("base64");
  } catch { /* screenshot may legitimately not exist if navigation failed hard */ }

  return {
    ok: parsed.ok,
    error: parsed.errorMsg || null,
    html: parsed.html || "",
    text: parsed.text || "",
    finalUrl: parsed.finalUrl || url,
    screenshotBase64,
  };
}

module.exports = {
  isConfigured,
  isRunning,
  getSandbox,
  killSandbox,
  runCommand,
  runCommands,
  runCode,
  writeFile,
  writeFiles,
  readFile,
  testProject,
  browsePage,
};
