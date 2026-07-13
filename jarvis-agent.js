"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Jarvis Agent (Groq-powered, LOCAL-ONLY)
//
// Replaces the old hermes-agent.js. That version reasoned about
// "open X" requests with a real local LLM (Hermes 3 via Ollama) —
// which meant installing Ollama and pulling a multi-GB model before
// any of this worked. This version asks Groq's cloud API instead
// (same API hermes-engine.js already talks to for the main chat
// brain), so there's nothing to install and nothing to pull. The
// ONLY thing this file does locally is the last step: actually
// executing the open/launch command on this machine.
//
// That execution step only makes sense when Jarvis is running ON
// your own computer. If Jarvis is deployed to Render (or any other
// cloud host), there's no "your PC" for it to reach — so this whole
// agent auto-disables the moment it detects a cloud/Render
// environment. Nothing downstream needs to remember to check that;
// isEnabled() is checked internally on every call, same pattern as
// the file it replaces.
//
// This file lives in the same repo/codebase as everything else —
// it is NOT a separate project, NOT a separate process you have to
// run, and NOT something that connects over the network. It's just
// a module that server.js requires locally, and its execution path
// only ever runs on the machine Jarvis itself is running on.
// ═══════════════════════════════════════════════════════════════

const { exec } = require("child_process");
const os       = require("os");
const fs       = require("fs");
const path     = require("path");

// ── CONFIG ──────────────────────────────────────────────────────
// Reuses the exact same GROQ_API_KEY / model conventions as
// hermes-engine.js. GROQ_AGENT_MODEL lets you pin a different
// (e.g. faster/cheaper) model for this small classification task
// than whatever the main chat brain uses, but defaults to a sane
// Groq model if unset.
const GROQ_API_KEY   = process.env.GROQ_API_KEY || "";
const GROQ_API_URL   = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_AGENT_MODEL = process.env.GROQ_AGENT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

// ── ENVIRONMENT DETECTION ──────────────────────────────────────
// Render sets RENDER=true (and other RENDER_* vars) on every
// instance automatically — no config needed on our end. This is
// the ONLY thing that decides whether the agent is allowed to
// actually execute anything on this machine.
function isRenderEnv() {
  return !!(
    process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.RENDER_INSTANCE_ID
  );
}

function isEnabled() {
  return !isRenderEnv();
}

function isConfigured() {
  return !!GROQ_API_KEY;
}

// ── REASONING: ask Groq what "open X" means ─────────────────────
const SYSTEM_PROMPT =
  "You are the local-control reasoning module for a voice assistant called J.A.R.V.I.S. " +
  "The user will describe something they want opened on their own computer — an application, " +
  "a file, a folder, or a URL. Reply with ONLY a JSON object, no prose, no markdown fences, in " +
  'the exact shape {"target": "<string>"}. The target should be the shortest thing an OS-level ' +
  '"open" command would understand: an app name ("notepad", "Google Chrome"), a file/folder path ' +
  'exactly as given, or a full URL. If you truly cannot tell what they want opened, reply ' +
  '{"target": null}.';

async function askGroq(userMessage) {
  if (!GROQ_API_KEY) throw new Error("GROQ_API_KEY not set in .env");

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_AGENT_MODEL,
      response_format: { type: "json_object" },
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
    }),
    // Groq is fast, but give real headroom for a cold connection /
    // transient slowness rather than failing fast and confusing the
    // "open X" flow with a network blip.
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq request failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const raw = data?.choices?.[0]?.message?.content || "{}";
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  return parsed.target || null;
}

// ── APP NAME → REAL LAUNCH COMMAND ───────────────────────────────
// Groq is good at figuring out WHAT the user means ("vs code", "the
// browser", "my file explorer") but the OS doesn't recognize
// human-friendly names like that — "start vs code" does nothing on
// Windows because there's no app literally called "vs code"; the
// real command is "code". This table maps common friendly names
// (and their variants) to the actual command/protocol/app-name each
// OS expects. Anything not in here falls through to the OS's
// generic opener, which handles file paths, folder paths, and URLs
// correctly on its own.
const APP_ALIASES = {
  win32: {
    "vs code": "code", "vscode": "code", "visual studio code": "code", "code editor": "code",
    notepad: "notepad", calculator: "calc", calc: "calc",
    "file explorer": "explorer", explorer: "explorer", finder: "explorer",
    paint: "mspaint", terminal: "wt", "command prompt": "cmd", cmd: "cmd",
    powershell: "powershell", chrome: "chrome", "google chrome": "chrome",
    firefox: "firefox", edge: "msedge", browser: "msedge",
    spotify: "spotify:", word: "winword", excel: "excel",
    settings: "ms-settings:",
  },
  darwin: {
    "vs code": "Visual Studio Code", "vscode": "Visual Studio Code",
    "visual studio code": "Visual Studio Code", "code editor": "Visual Studio Code",
    notepad: "TextEdit", calculator: "Calculator", calc: "Calculator",
    "file explorer": "Finder", finder: "Finder", explorer: "Finder",
    terminal: "Terminal", chrome: "Google Chrome", "google chrome": "Google Chrome",
    firefox: "Firefox", edge: "Microsoft Edge", safari: "Safari", browser: "Safari",
    spotify: "Spotify", word: "Microsoft Word", excel: "Microsoft Excel",
    settings: "System Settings",
  },
  linux: {
    "vs code": "code", "vscode": "code", "visual studio code": "code", "code editor": "code",
    "file explorer": "xdg-open .", finder: "xdg-open .", explorer: "xdg-open .",
    calculator: "gnome-calculator", calc: "gnome-calculator",
    terminal: "x-terminal-emulator", chrome: "google-chrome",
    "google chrome": "google-chrome", firefox: "firefox",
    spotify: "spotify", browser: "xdg-open about:blank",
  },
};

// ── OS EXECUTION ──────────────────────────────────────────────
// Once Groq has told us WHAT to open, this is HOW: the actual OS
// command that opens it, per-platform. Known apps go through
// APP_ALIASES so they resolve to something the OS actually
// recognizes; anything else is treated as a literal file/folder
// path or URL and handed to the OS's generic opener.
function buildCommand(target) {
  const platform = os.platform(); // 'win32' | 'darwin' | 'linux'
  const clean = String(target || "").trim();
  if (!clean) return null;

  const alias = (APP_ALIASES[platform] || {})[clean.toLowerCase()];

  if (platform === "win32") {
    // "start" needs an explicit empty title ("") before the real
    // target whenever the target itself is quoted. "/B" tells it to
    // launch without opening a new console window.
    return `start "" /B "${alias || clean}"`;
  }
  if (platform === "darwin") {
    // Known apps: launch by app name. Anything else: treat as a
    // file/folder path or URL, which plain "open" already handles.
    return alias ? `open -a "${alias}"` : `open "${clean}"`;
  }
  // linux + any other *nix
  return alias || `xdg-open "${clean}"`;
}

function runCommand(command) {
  return new Promise((resolve, reject) => {
    // windowsHide matters here specifically: some app launchers (like VS
    // Code's "code" command) are actually .cmd batch files, not real .exe
    // binaries. Windows briefly pops a console window to run those unless
    // we explicitly tell Node to hide it.
    exec(command, { windowsHide: true }, (err) => err ? reject(err) : resolve());
  });
}

// ── MAIN ENTRY POINT ────────────────────────────────────────────
// Takes the user's raw instruction (e.g. "open my resume on my
// computer" or "launch chrome"), asks Groq what that actually
// means, then executes it locally. Resolves with
// { target, command }. Rejects with a clear reason otherwise.
//
// NOTE ON RELIABILITY: Windows' "start" (and macOS/Linux's "open"/
// "xdg-open" to a lesser extent) hand off asynchronously and report
// success even if the target couldn't actually be launched (e.g. an
// app isn't installed, or isn't on PATH). So a resolved promise here
// means "the OS accepted the request", not a hard guarantee the
// window actually appeared.
async function openOnComputer(userMessage) {
  if (!isEnabled()) {
    throw new Error(
      "Jarvis agent is disabled here — this instance is running on Render, " +
      "not on your own computer, so there's nothing local for it to open."
    );
  }
  if (!isConfigured()) {
    throw new Error("GROQ_API_KEY isn't set in .env, so the Jarvis agent can't reason about what to open yet.");
  }

  const target = await askGroq(userMessage);
  if (!target) throw new Error("Couldn't figure out what you want opened.");

  const command = buildCommand(target);
  await runCommand(command);
  return { target, command };
}

// ── SHOW IT ON SCREEN TOO ────────────────────────────────────────
// Whenever the agent answers something with actual data behind it
// (disk space, a command's output, etc.), this writes that data to a
// small local text file and opens it with the OS's default text
// viewer — so whatever Jarvis just said out loud, the user can also
// SEE on screen, not just hear a spoken summary of. Best-effort: if
// this fails for any reason, it's swallowed rather than breaking the
// spoken answer, since the voice reply is the part that actually
// matters.
function showTextResult(title, content) {
  try {
    const safeName = String(title || "jarvis-result").replace(/[^a-z0-9-_]/gi, "_").slice(0, 60) || "jarvis-result";
    const filePath = path.join(os.tmpdir(), `${safeName}-${Date.now()}.txt`);
    fs.writeFileSync(filePath, String(content ?? ""), "utf8");
    const command = buildCommand(filePath);
    return runCommand(command).then(() => filePath).catch(() => filePath);
  } catch {
    return Promise.resolve(null);
  }
}

// ── DISK SPACE ────────────────────────────────────────────────────
// Cross-platform "how much space do I have on my computer" check.
// Windows uses PowerShell (Get-PSDrive) since it's present on every
// modern Windows box with no extra installs; macOS/Linux both have
// `df` built in.
function getDiskSpace() {
  const platform = os.platform();
  const cmd = platform === "win32"
    ? `powershell -NoProfile -Command "Get-PSDrive -PSProvider FileSystem | Where-Object {$_.Free -ne $null} | Select-Object Name,@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}},@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}} | ConvertTo-Json"`
    : "df -k /";

  return new Promise((resolve, reject) => {
    exec(cmd, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
      if (err) return reject(new Error("Couldn't read disk space."));
      try {
        if (platform === "win32") {
          const parsed = JSON.parse(stdout);
          const drives = Array.isArray(parsed) ? parsed : [parsed];
          resolve(drives.map(d => ({ drive: d.Name, usedGB: d.UsedGB, freeGB: d.FreeGB })));
        } else {
          // df -k output: "Filesystem 1K-blocks Used Available Capacity Mounted on"
          const line = stdout.trim().split("\n")[1];
          const cols = line.trim().split(/\s+/);
          const totalKB = Number(cols[1]), usedKB = Number(cols[2]), freeKB = Number(cols[3]);
          resolve([{
            drive: "/",
            totalGB: +(totalKB / 1048576).toFixed(1),
            usedGB:  +(usedKB  / 1048576).toFixed(1),
            freeGB:  +(freeKB  / 1048576).toFixed(1),
            percentUsed: cols[4],
          }]);
        }
      } catch {
        reject(new Error("Couldn't parse disk space output."));
      }
    });
  });
}

// Opens the OS's native storage/disk-usage view, best-effort. This is
// purely a visual bonus on top of the spoken disk-space answer — if
// the specific app name has drifted on a given OS version, it just
// silently no-ops rather than surfacing an error for a nice-to-have.
function openDiskSpaceViewer() {
  const platform = os.platform();
  const cmd = platform === "win32"
    ? `start "" /B ms-settings:storagesense`
    : platform === "darwin"
      ? `open "x-apple.systempreferences:com.apple.preference.storage"`
      : `xdg-open . `;
  return runCommand(cmd).catch(() => {});
}

// ── SHELL COMMANDS (tiered: auto / confirm / never) ─────────────
// Auto: a short allowlist of read-only, informational commands —
// nothing here can change or delete anything, so it's safe to just
// run and show the result.
// Confirm: everything else. Proposed, not run, until the user says
// yes — see the pending-confirmation store below.
// Never: patterns that are always blocked outright, even with an
// explicit "yes" — destructive, irreversible, or credential-touching
// commands don't get a shortcut around confirmation, they get
// refused entirely, since a single misheard "yes" is enough to do
// real damage otherwise.
const NEVER_PATTERNS = [
  /\brm\s+-rf\b/i, /\bdel\s+\/[a-z]*[fsq]/i, /\bformat\b/i, /\bmkfs\b/i,
  /\bdiskpart\b/i, /\bshutdown\b/i, /\breg\s+delete\b/i, /\bsudo\b/i,
  /\bchmod\s+-R\s+777\b/i, /\bgit\s+push\b.*--force/i,
  /\b(ssh|gpg|aws|az|gcloud)\b.*\b(key|secret|credential|token)\b/i,
];
const AUTO_ALLOWLIST = [
  /^df(\s|$)/i, /^du\s/i, /^dir(\s|$)/i, /^ls(\s|$)/i, /^pwd$/i,
  /^whoami$/i, /^hostname$/i, /^date$/i, /^uptime$/i,
  /^git\s+(status|log)\b/i, /^systeminfo$/i, /^sw_vers$/i, /^uname\b/i,
];

function classifyShellTier(command) {
  const c = String(command || "").trim();
  if (!c) return "never";
  if (NEVER_PATTERNS.some(rx => rx.test(c))) return "never";
  if (AUTO_ALLOWLIST.some(rx => rx.test(c))) return "auto";
  return "confirm";
}

function runShellCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, { windowsHide: true, timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      // A non-zero exit code still has useful stdout/stderr to show
      // (e.g. a command that "fails" but prints a helpful message) —
      // only reject outright when we got nothing at all back.
      if (err && !stdout && !stderr) return reject(err);
      resolve({ stdout: stdout || "", stderr: stderr || "", code: err ? err.code : 0 });
    });
  });
}

// ── TYPE TEXT ─────────────────────────────────────────────────────
// Simulates keystrokes into whatever window currently has focus.
// This is deliberately NOT auto-tier — it types into whatever the
// user is currently looking at, so a misheard phrase could type the
// wrong thing into the wrong place. Always goes through the
// confirm/pending flow in server.js.
function typeText(text) {
  const platform = os.platform();
  const clean = String(text || "");
  if (!clean) return Promise.reject(new Error("No text given to type."));

  if (platform === "darwin") {
    const escaped = clean.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return runCommand(`osascript -e 'tell application "System Events" to keystroke "${escaped}"'`);
  }
  if (platform === "win32") {
    // SendKeys treats +^%~(){} as special characters — escape them by
    // wrapping in braces so they're typed literally.
    const escaped = clean.replace(/'/g, "''").replace(/([{}()\[\]+^%~])/g, "{$1}");
    return runCommand(`powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; Start-Sleep -Milliseconds 300; [System.Windows.Forms.SendKeys]::SendWait('${escaped}')"`);
  }
  // linux — requires xdotool to be installed
  const escaped = clean.replace(/'/g, `'\\''`);
  return runCommand(`xdotool type --delay 20 '${escaped}'`);
}

// ── PENDING CONFIRMATIONS ─────────────────────────────────────────
// Shell commands (outside the small auto-allowlist) and typed text
// are powerful enough that they should never run on a misheard voice
// command alone. Instead of running immediately, they're proposed
// here and only actually executed once the user's next message
// confirms it — server.js drives that yes/no exchange and calls
// confirmPendingAction()/clearPendingAction() accordingly.
const PENDING_ACTIONS = new Map(); // sessionId -> { kind, payload, expiresAt }
const PENDING_TTL_MS = 2 * 60 * 1000; // must be confirmed within 2 minutes

function proposeAction(sessionId, kind, payload) {
  if (!sessionId) return;
  PENDING_ACTIONS.set(sessionId, { kind, payload, expiresAt: Date.now() + PENDING_TTL_MS });
}
function getPendingAction(sessionId) {
  if (!sessionId) return null;
  const rec = PENDING_ACTIONS.get(sessionId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) { PENDING_ACTIONS.delete(sessionId); return null; }
  return rec;
}
function clearPendingAction(sessionId) {
  PENDING_ACTIONS.delete(sessionId);
}

module.exports = {
  isRenderEnv,
  isEnabled,
  isConfigured,
  askGroq,
  buildCommand,
  runCommand,
  openOnComputer,
  showTextResult,
  getDiskSpace,
  openDiskSpaceViewer,
  classifyShellTier,
  runShellCommand,
  typeText,
  proposeAction,
  getPendingAction,
  clearPendingAction,
  GROQ_AGENT_MODEL,
};
