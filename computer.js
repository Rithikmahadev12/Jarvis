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
//   - "Jarvis, show pc" — opens a second, separate kind of sandbox
//     (@e2b/desktop instead of @e2b/code-interpreter): a real Ubuntu
//     + XFCE desktop with a live VNC stream, so you can actually SEE
//     it and click/type into it from the browser, not just read back
//     stdout. See the DESKTOP SANDBOX section below. This is a fully
//     separate sandbox instance from the code/command one above —
//     different E2B product, spun up and billed independently, only
//     created the first time "show pc" is actually used.
//   - Anything else that benefits from "run it somewhere safe first,
//     not directly on the user's machine and not just as a guess."
//
// SETUP:
//   1. Sign up free at https://e2b.dev, grab an API key from the
//      dashboard.
//   2. Add to .env:  E2B_API_KEY=e2b_xxxxxxxxxxxx
//   3. npm install (pulls in @e2b/code-interpreter and @e2b/desktop).
//   That's it — no template building required. Everything here uses
//   E2B's default sandbox templates and installs whatever extra tools
//   a given task needs (e.g. Playwright for browsing) on demand,
//   the first time they're needed, inside the sandbox itself.
//
// isConfigured() / isDesktopConfigured() are checked by every caller
// (server.js, instagram.js) before this is used, and every exported
// function fails soft with a plain { error: "..." } / thrown Error
// rather than crashing — same "never take the whole assistant down"
// rule as everything else in this codebase (see server.js's CRASH
// GUARD comment).
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

// ── DEDICATED (non-shared) SANDBOXES ───────────────────────────────
// getSandbox()/runCommand() above are a single shared, aggressively
// idle-reaped instance meant for quick "run this code" tasks. Some
// features need their OWN sandbox with its own independent lifecycle
// — postiz-agent.js is the reason this exists: sharing the coding
// singleton would mean an unrelated "test this" idle-killing it
// mid-Postiz-run, or Postiz's own Docker load slowing down unrelated
// code tasks, and either way a Postiz sandbox getting reaped wipes
// its Postgres database (every connected social account's login,
// gone) exactly the same way the shared sandbox already gets reaped
// on purpose.
//
// The fix is E2B's beta auto-pause feature: instead of being killed
// on timeout, the sandbox (full disk AND memory state — a running
// Docker daemon with live containers included) is paused, and
// resumed later via connectDedicatedSandbox(id) picking up exactly
// where it left off. A caller (postiz-agent.js) persists the
// returned sandboxId itself (survives a Jarvis restart, unlike
// activeSandbox above) and reconnects to the SAME sandbox instead of
// creating a new empty one every time.
//
// BETA / HONESTY NOTE: auto-pause is an E2B beta feature as of this
// writing (Sandbox.betaCreate({autoPause:true})). If the installed
// @e2b/code-interpreter version doesn't expose betaCreate, this
// transparently falls back to a plain create() with a long timeout
// instead of silently pretending pause support exists — in that
// fallback case the sandbox WILL eventually be hard-killed by E2B
// (1h max on the Hobby tier, 24h on Pro; see sandbox.setTimeout()'s
// own docs) and whatever's running inside it (e.g. Postiz's Docker
// containers) is lost at that point, same as before this existed.
async function createDedicatedSandbox(opts = {}) {
  if (!isConfigured()) throw notConfiguredError();
  const timeoutMs = opts.timeoutMs || 60 * 60 * 1000; // matches E2B's own Hobby-tier ceiling — no point asking for more than that will ever be honored anyway
  if (typeof SandboxCtor.betaCreate === "function") {
    try {
      return await SandboxCtor.betaCreate({
        timeoutMs,
        autoPause: true,
        apiKey: E2B_API_KEY,
        metadata: opts.metadata || { source: "jarvis" },
      });
    } catch (e) {
      console.warn(`[COMPUTER] betaCreate({autoPause:true}) failed (${e.message}) — falling back to a plain sandbox without pause support.`);
    }
  }
  return await SandboxCtor.create({ apiKey: E2B_API_KEY, timeoutMs, metadata: opts.metadata || { source: "jarvis" } });
}

// Reconnects to (and, if it was paused, resumes) a previously created
// dedicated sandbox by id. Throws if E2B says it no longer exists
// (e.g. it hit the hard ceiling in the non-beta fallback case above,
// or was manually killed) — the caller should treat that as "start
// over," not retry blindly.
async function connectDedicatedSandbox(sandboxId) {
  if (!isConfigured()) throw notConfiguredError();
  return await SandboxCtor.connect(sandboxId, { apiKey: E2B_API_KEY });
}

// Pushes a dedicated sandbox's pause/kill clock back out — call this
// at the start of any real work on it so a slow docker build doesn't
// get cut off mid-way by a timeout that was set for a previous, much
// shorter, task.
async function extendDedicatedSandbox(sbx, timeoutMs) {
  if (sbx && typeof sbx.setTimeout === "function") {
    try { await sbx.setTimeout(timeoutMs || 60 * 60 * 1000); }
    catch (e) { console.warn(`[COMPUTER] Couldn't extend dedicated sandbox timeout: ${e.message}`); }
  }
}

// Same reliable command-execution shape as runCommand() above
// (including the CommandExitError-swallows-the-result workaround),
// just parameterized on an arbitrary sandbox instance instead of the
// shared singleton, so a dedicated sandbox gets the exact same
// battle-tested error handling.
async function runOnSandbox(sbx, cmd, opts = {}) {
  let result;
  try {
    result = await sbx.commands.run(cmd, { timeoutMs: opts.timeoutMs || 120000, cwd: opts.cwd || undefined, background: !!opts.background, envs: opts.envs || undefined });
  } catch (e) {
    if (typeof e.exitCode === "number" || typeof e.stdout === "string" || typeof e.stderr === "string") {
      result = { stdout: e.stdout || "", stderr: e.stderr || "", exitCode: e.exitCode };
    } else {
      throw e;
    }
  }
  return {
    command: cmd,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : (result.exitCode ?? 0),
    ok: (result.exitCode ?? 0) === 0,
  };
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
  let result;
  try {
    result = await sbx.commands.run(cmd, {
      timeoutMs: opts.timeoutMs || 120000,
      cwd: opts.cwd || undefined,
    });
  } catch (e) {
    // Same CommandExitError-swallows-the-result issue as
    // desktopRunCommand below — see the comment there for why.
    if (typeof e.exitCode === "number" || typeof e.stdout === "string" || typeof e.stderr === "string") {
      result = { stdout: e.stdout || "", stderr: e.stderr || "", exitCode: e.exitCode };
    } else {
      throw e;
    }
  }
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

// ═══════════════════════════════════════════════════════════════
// ── DESKTOP SANDBOX — "Jarvis, show pc" ─────────────────────────
//
// A completely separate E2B product (@e2b/desktop) from the plain
// code-interpreter sandbox above: a real Ubuntu + XFCE desktop with
// a live VNC stream, so it can be embedded directly in the browser
// and clicked/typed into, instead of only ever reporting back text.
// Same lazy-singleton-with-idle-reap shape as the sandbox above, but
// tracked completely separately (own timers, own instance) since the
// two are different E2B sandbox types under the hood.
// ═══════════════════════════════════════════════════════════════

let DesktopSandboxCtor = null;
let desktopLoadError = null;
try {
  ({ Sandbox: DesktopSandboxCtor } = require("@e2b/desktop"));
} catch (e) {
  desktopLoadError = e;
}

const DESKTOP_IDLE_TIMEOUT_MS = parseInt(process.env.E2B_DESKTOP_IDLE_MS || "", 10) || 10 * 60 * 1000;
const DESKTOP_SANDBOX_LIFETIME_MS = parseInt(process.env.E2B_DESKTOP_LIFETIME_MS || "", 10) || 30 * 60 * 1000;
const DESKTOP_RESOLUTION = (() => {
  const raw = process.env.E2B_DESKTOP_RESOLUTION || "1280x800";
  const [w, h] = raw.split("x").map((n) => parseInt(n, 10));
  return (w && h) ? [w, h] : [1280, 800];
})();

function isDesktopConfigured() {
  return !!(E2B_API_KEY && DesktopSandboxCtor);
}

function notDesktopConfiguredError() {
  if (!DesktopSandboxCtor) {
    return new Error(
      `The @e2b/desktop package isn't installed${desktopLoadError ? ` (${desktopLoadError.message})` : ""} — run \`npm install\` and restart Jarvis.`
    );
  }
  return new Error(
    "E2B isn't configured yet — grab a free API key at https://e2b.dev and add E2B_API_KEY to .env, then restart Jarvis."
  );
}

let activeDesktop = null;
let desktopIdleTimer = null;
let streamStarted = false;
let cachedAuthKey = null;

function armDesktopIdleTimer() {
  if (desktopIdleTimer) clearTimeout(desktopIdleTimer);
  desktopIdleTimer = setTimeout(() => { killDesktopSandbox().catch(() => {}); }, DESKTOP_IDLE_TIMEOUT_MS);
  if (desktopIdleTimer.unref) desktopIdleTimer.unref();
}

async function getDesktop() {
  if (!isDesktopConfigured()) throw notDesktopConfiguredError();

  if (activeDesktop) {
    armDesktopIdleTimer();
    return activeDesktop;
  }

  activeDesktop = await DesktopSandboxCtor.create({
    resolution: DESKTOP_RESOLUTION,
    dpi: 96,
    timeoutMs: DESKTOP_SANDBOX_LIFETIME_MS,
    metadata: { source: "jarvis" },
  });
  streamStarted = false;
  cachedAuthKey = null;
  armDesktopIdleTimer();
  return activeDesktop;
}

async function killDesktopSandbox() {
  if (desktopIdleTimer) { clearTimeout(desktopIdleTimer); desktopIdleTimer = null; }
  const d = activeDesktop;
  activeDesktop = null;
  streamStarted = false;
  cachedAuthKey = null;
  if (d) {
    try { await d.kill(); } catch { /* already gone — fine */ }
  }
}

function isDesktopRunning() {
  return !!activeDesktop;
}

// Starts (or reuses) the VNC stream and hands back a ready-to-embed,
// auth-keyed URL. Safe to call repeatedly — only actually starts the
// stream once per sandbox instance.
async function ensureDesktopStream() {
  const desktop = await getDesktop();

  if (!streamStarted) {
    await desktop.stream.start({ requireAuth: true });
    cachedAuthKey = await desktop.stream.getAuthKey();
    streamStarted = true;
  }

  const url = desktop.stream.getUrl({ authKey: cachedAuthKey });
  return { url, resolution: DESKTOP_RESOLUTION };
}

async function stopDesktopStream() {
  if (activeDesktop && streamStarted) {
    try { await activeDesktop.stream.stop(); } catch { /* best effort */ }
    streamStarted = false;
  }
}

// Launches a GUI app inside the desktop (e.g. "firefox", "google-chrome").
// uri is optional — for browsers, E2B opens it directly (e.g. launch
// ("firefox", "https://textnow.com")) instead of a blank window you'd
// then have to navigate yourself.
async function desktopLaunch(app, uri) {
  const desktop = await getDesktop();
  await desktop.launch(app, uri);
  return { app, uri: uri || null };
}

// ── DESKTOP CONTROL PRIMITIVES ────────────────────────────────────
// Thin passthroughs onto the live desktop sandbox, for anything that
// needs to actually DRIVE the GUI programmatically (not just stream
// it for a human to watch/click) — e.g. textnow-call.js reading the
// screen with a vision model and clicking through TextNow's web
// dialer on its own. Each of these calls getDesktop() itself (arming
// the idle timer), so callers never manage the sandbox directly.
async function desktopScreenshot() {
  const desktop = await getDesktop();
  const bytes = await desktop.screenshot();
  return Buffer.from(bytes).toString("base64");
}

async function desktopMoveMouse(x, y) {
  const desktop = await getDesktop();
  return desktop.moveMouse(x, y);
}

async function desktopClick(x, y, opts = {}) {
  const desktop = await getDesktop();
  if (opts.double) return desktop.doubleClick(x, y);
  if (opts.right) return desktop.rightClick(x, y);
  return desktop.leftClick(x, y);
}

// Press-and-hold a point for a given duration, then release — for
// "press and hold to verify you are human" style captcha widgets
// (e.g. TextNow's login page as of Aug 2026), which a normal click
// doesn't satisfy. Underlying E2B desktop SDK exposes mousePress()/
// mouseRelease() as separate calls specifically for this.
async function desktopHoldClick(x, y, holdMs = 4000) {
  const desktop = await getDesktop();
  await desktop.moveMouse(x, y);
  await desktop.mousePress("left");
  await new Promise((r) => setTimeout(r, holdMs));
  await desktop.mouseRelease("left");
}

async function desktopType(text, opts = {}) {
  const desktop = await getDesktop();
  return desktop.write(text, opts);
}

async function desktopPress(key) {
  const desktop = await getDesktop();
  return desktop.press(key);
}

// Runs a shell command INSIDE the desktop sandbox (as opposed to
// runCommand() above, which runs in the separate plain code sandbox).
// Needed for things the GUI-automation API doesn't cover — installing
// a browser, setting up PulseAudio virtual devices, curl-ing a file
// down, etc.
async function desktopRunCommand(cmd, opts = {}) {
  const desktop = await getDesktop();
  let result;
  try {
    result = await desktop.commands.run(cmd, {
      timeoutMs: opts.timeoutMs || 60000,
      background: !!opts.background,
    });
  } catch (e) {
    // E2B's SDK throws CommandExitError on ANY non-zero exit instead
    // of returning it — which meant every caller's own `if (!res.ok)`
    // handling (with its actually-useful error messages) never ran;
    // the caller just saw a bare, contentless "exit status 1" instead.
    // A non-zero exit is routine here (grep matching nothing yet in a
    // polling loop, `which` not finding a not-yet-installed binary,
    // etc.) — not a reason to lose stdout/stderr, so normalize it back
    // into the same result shape rather than letting it throw raw.
    if (typeof e.exitCode === "number" || typeof e.stdout === "string" || typeof e.stderr === "string") {
      result = { stdout: e.stdout || "", stderr: e.stderr || "", exitCode: e.exitCode };
    } else {
      throw e; // a genuinely different failure (timeout, connection lost, etc.) — don't mask it
    }
  }
  if (opts.background) return { command: cmd, background: true, handle: result };
  return {
    command: cmd,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    exitCode: typeof result.exitCode === "number" ? result.exitCode : (result.exitCode ?? 0),
    ok: (result.exitCode ?? 0) === 0,
  };
}

// Writes a local Buffer/string up into the desktop sandbox's
// filesystem (e.g. dropping a synthesized TTS audio clip in before
// playing it with `paplay`).
async function desktopWriteFile(filePath, data) {
  const desktop = await getDesktop();
  return desktop.files.write(filePath, data);
}

// Reads a file back out of the desktop sandbox (e.g. pulling down a
// `parec`-captured audio clip to hand to stt.js).
async function desktopReadFile(filePath) {
  const desktop = await getDesktop();
  return desktop.files.read(filePath, { format: "bytes" });
}

// ═══════════════════════════════════════════════════════════════
// ── SELF-HOSTED OLLAMA (VISION) — hosted inside the desktop sandbox
//
// Jarvis's own "computer" (the E2B desktop sandbox above) can host a
// small vision-capable model itself, via Ollama: no external API, no
// key, nothing that can run out of credits or rate-limit — the true
// last-resort-that-never-actually-fails tier. This started out living
// only in textnow-call.js (its tier-3 fallback for reading TextNow's
// own UI), duplicated there because nothing else needed it yet. It's
// pulled up here now so ANY caller — screen-vision.js's "look at my
// screen" / "find this button" included — can install it once, run
// it once, and reuse the same running Ollama server for every vision
// call after that, instead of each module reinventing the "install +
// serve + query Ollama in the sandbox" dance on its own.
//
// COST/LATENCY NOTE: the very first call in a given sandbox session
// pays for installing Ollama (~seconds) and pulling the model
// (~minutes, one-time) — ensureOllama() below is idempotent per
// sandbox instance (tracked by ollamaReady) so every call after that
// is just a local HTTP round trip inside the sandbox. Callers that
// want this tried FIRST, ahead of paid/quota'd cloud vision APIs,
// should account for that first-call cost; callers that want it as a
// pure last resort (the original textnow-call.js use) pay it rarely,
// since cloud tiers usually succeed first.
//
// Also depends on isDesktopConfigured() (E2B_API_KEY + @e2b/desktop
// installed) — callers should check that before relying on this, or
// just call ollamaVision() and handle the thrown error like any other
// vision-tier failure.
// ═══════════════════════════════════════════════════════════════
const SANDBOX_OLLAMA_VISION_MODEL =
  process.env.SANDBOX_OLLAMA_VISION_MODEL ||
  process.env.TEXTNOW_SELFHOST_VISION_MODEL || // back-compat with the old textnow-only env var
  "moondream";

let ollamaReady = false;

// Installs Ollama in the desktop sandbox if it's not there yet, starts
// `ollama serve` if it's not already running, and pulls the requested
// model if it's not already pulled. Safe to call before every request
// — after the first successful run this is a single no-op check.
async function ensureOllama(model = SANDBOX_OLLAMA_VISION_MODEL) {
  if (!isDesktopRunning()) ollamaReady = false; // sandbox was reaped/killed since last time — re-verify everything
  if (ollamaReady) return;

  console.log(`[COMPUTER] Setting up self-hosted Ollama ("${model}") on the sandbox computer...`);

  const check = await desktopRunCommand("which ollama", { timeoutMs: 10000 });
  if (!check.ok || !check.stdout.trim()) {
    const install = await desktopRunCommand("curl -fsSL https://ollama.com/install.sh | sh", { timeoutMs: 180000 });
    if (!install.ok) throw new Error(`Couldn't install Ollama on the sandbox: ${install.stderr || "unknown error"}`);
  }

  const running = await desktopRunCommand("curl -s -m 2 http://127.0.0.1:11434/api/tags", { timeoutMs: 5000 });
  if (!running.ok || !running.stdout.trim()) {
    await desktopRunCommand("nohup ollama serve > /tmp/ollama-serve.log 2>&1 & disown; sleep 2; true", { timeoutMs: 15000 });
  }

  const pulled = await desktopRunCommand(`ollama list | grep -qi "${model}"`, { timeoutMs: 10000 });
  if (!pulled.ok) {
    console.log(`[COMPUTER] Pulling self-hosted vision model "${model}" on the sandbox (first time only, can take a few minutes)...`);
    const pull = await desktopRunCommand(`ollama pull ${model}`, { timeoutMs: 10 * 60 * 1000 });
    if (!pull.ok) throw new Error(`Couldn't pull "${model}" on the sandbox: ${pull.stderr || "unknown error"}`);
  }

  ollamaReady = true;
}

function isOllamaReady() {
  return ollamaReady;
}

// Text-only sibling of SANDBOX_OLLAMA_VISION_MODEL — a small, fast
// model for plain chat turns (no image), used as the true last-resort
// tier for live phone-call turns (agentphone-voice-routes.js /
// twilio-voice-routes.js) once Ollama Cloud, Gemini, AND Groq have
// all failed. Defaults to the same model local-llm.js uses for local
// dev mode (llama3.2:3b) so there's only one model name to remember,
// but is independently overridable since this one runs inside the
// E2B sandbox, not necessarily the user's own machine.
const SANDBOX_OLLAMA_TEXT_MODEL =
  process.env.SANDBOX_OLLAMA_TEXT_MODEL ||
  process.env.OLLAMA_MODEL || // back-compat / share local-llm.js's choice if the user already set one
  "llama3.2:3b";

// Sends one vision request (image + prompt) to the sandbox's own
// Ollama server. The server is only reachable FROM INSIDE the sandbox
// (this Node process isn't in there), so the request itself has to
// run as a shell command via desktopRunCommand — the JSON body is
// written to a file first rather than inlined on the command line,
// since a base64 screenshot is way too large/escape-unsafe for that.
async function ollamaVision(base64Image, prompt, opts = {}) {
  const model = opts.model || SANDBOX_OLLAMA_VISION_MODEL;
  await ensureOllama(model);

  const body = JSON.stringify({
    model,
    stream: false,
    messages: [{ role: "user", content: prompt, images: [base64Image] }],
  });
  const reqPath = `/tmp/jarvis_ollama_req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
  await desktopWriteFile(reqPath, body);
  const res = await desktopRunCommand(
    `curl -s -X POST http://127.0.0.1:11434/api/chat -H "Content-Type: application/json" -d @${reqPath}`,
    { timeoutMs: opts.timeoutMs || 90000 }
  );
  if (!res.ok || !res.stdout) throw new Error("Self-hosted Ollama request failed inside the sandbox.");

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error("Self-hosted Ollama returned unparseable output.");
  }
  return parsed?.message?.content || "";
}

// Text-chat sibling of ollamaVision() above — same "install/serve/pull
// once, then plain HTTP inside the sandbox" mechanism, just a normal
// {role, content} messages array instead of an image+prompt. Used as
// the true last-resort tier once every cloud provider (Ollama Cloud,
// Gemini, Groq) has failed on a live call — Jarvis installs and hosts
// its own tiny model on its own sandbox computer rather than just
// giving up and hanging up.
//
// Supports tool-calling (opts.tools / opts.tool_choice) since
// hermes-engine.js's brain needs this tier to be able to carry
// TOOLS/tool_calls just like every other tier, not just plain chat.
// Returns the FULL message object ({role, content, tool_calls?}) —
// same shape local-llm.js's ollamaChat() returns — not just a string,
// so callers that need tool_calls can see them. Callers that only
// want plain text should use ollamaText() below instead.
async function ollamaChat(messages, opts = {}) {
  const model = opts.model || SANDBOX_OLLAMA_TEXT_MODEL;
  await ensureOllama(model);

  const body = {
    model,
    stream: false,
    messages,
    options: { temperature: opts.temperature ?? 0.4 },
  };
  if (opts.tools && opts.tools.length) {
    body.tools = opts.tools;
    // Ollama's native /api/chat doesn't document a tool_choice field the
    // way OpenAI/Groq do — included anyway since it's harmless if the
    // server just ignores it, and picked up for free if a future Ollama
    // version (or a specific model's template) does support it.
    if (opts.tool_choice) body.tool_choice = opts.tool_choice;
  }

  const reqPath = `/tmp/jarvis_ollama_chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.json`;
  await desktopWriteFile(reqPath, JSON.stringify(body));
  const res = await desktopRunCommand(
    `curl -s -X POST http://127.0.0.1:11434/api/chat -H "Content-Type: application/json" -d @${reqPath}`,
    { timeoutMs: opts.timeoutMs || 90000 }
  );
  if (!res.ok || !res.stdout) throw new Error("Self-hosted Ollama chat request failed inside the sandbox.");

  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    throw new Error("Self-hosted Ollama returned unparseable output.");
  }
  const msg = parsed?.message || {};
  const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length;
  if (!msg.content && !hasToolCalls) throw new Error("Self-hosted Ollama returned no content.");
  return msg;
}

// Plain-text convenience wrapper for callers that don't need tool
// calls (e.g. a live phone-call turn) — mirrors local-llm.js's
// ollamaText() wrapper around its own ollamaChat().
async function ollamaText(messages, opts = {}) {
  const msg = await ollamaChat(messages, opts);
  const text = (msg.content || "").trim();
  if (!text) throw new Error("Self-hosted Ollama returned no content.");
  return text;
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
  createDedicatedSandbox,
  connectDedicatedSandbox,
  extendDedicatedSandbox,
  runOnSandbox,
  // desktop sandbox ("show pc")
  isDesktopConfigured,
  isDesktopRunning,
  getDesktop,
  killDesktopSandbox,
  ensureDesktopStream,
  stopDesktopStream,
  desktopLaunch,
  desktopScreenshot,
  desktopMoveMouse,
  desktopClick,
  desktopHoldClick,
  desktopType,
  desktopPress,
  desktopRunCommand,
  desktopWriteFile,
  desktopReadFile,
  // self-hosted Ollama (vision), hosted inside the desktop sandbox
  ensureOllama,
  isOllamaReady,
  ollamaVision,
  ollamaChat,
  ollamaText,
  SANDBOX_OLLAMA_VISION_MODEL,
  SANDBOX_OLLAMA_TEXT_MODEL,
};
