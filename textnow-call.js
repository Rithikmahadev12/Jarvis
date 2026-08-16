"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — TextNow Call Provider
//
// Places real outbound calls through TextNow's web app (textnow.com)
// running inside the E2B desktop sandbox (see computer.js), driven
// entirely by Jarvis itself: a vision model reads the screen to find
// and click the dial pad / number field / call button (TextNow has
// no API for this — the web UI is the only surface), and a pair of
// PulseAudio virtual devices set up inside the sandbox let Jarvis
// both "speak" into the call (TTS piped in as the browser's
// microphone) and "hear" the other side (the browser's own audio
// output, captured and transcribed).
//
// DROP-IN REPLACEMENT for agentphone.js's OUTBOUND calling only —
// same three functions phone-agent.js actually calls
// (placeOutboundCall / getCall / waitForCallCompletion), same call
// record shape ({ id, status, transcripts, recordingUrl }), same
// status vocabulary phone-agent.js already polls for
// (CONNECTING_STATUSES / "completed" / "failed"). Swap the require()
// in phone-agent.js and nothing else there needs to change.
// agentphone.js itself is untouched — inbound calling (people calling
// Jarvis's own number) still goes through it; this file only covers
// Jarvis calling OUT.
//
// ── WHY THIS EXISTS INSTEAD OF AGENTPHONE ─────────────────────────
// AgentPhone is a paid, metered PSTN API. TextNow gives you a real
// phone number and free calling in the US/Canada through its ordinary
// consumer web app instead — the tradeoff is there's no API for it,
// so Jarvis has to operate the web app the way a person would, which
// is what this file does.
//
// ── COST / RELIABILITY, HONESTLY ──────────────────────────────────
// Still needs an E2B account for the desktop sandbox (computer.js) —
// E2B has a free tier but it isn't unlimited. And this is meaningfully
// more fragile than a real API integration: it depends on TextNow's
// web UI not changing shape, the vision model reading the screen
// correctly, and the sandbox's virtual mic actually being what the
// browser sends — any of those can break a given call, especially the
// very first time you try it. Treat it as "good effort, not
// guaranteed," same fail-soft spirit as the rest of this codebase.
// TextNow is also built for a human clicking through its own app —
// automating it like this isn't something TextNow officially supports,
// so keep an eye on your account standing if you use this a lot.
//
// ── SETUP ──────────────────────────────────────────────────────────
//   1. E2B desktop sandbox already configured — E2B_API_KEY in .env
//      (see computer.js's own setup notes).
//   2. Account: pick ONE —
//        (a) AUTOMATIC (default) — add AGENTMAIL_API_KEY to .env
//            (free, agentmail.to). The first time Jarvis is ever
//            asked to place a call, it signs itself up for a brand
//            new TextNow account end-to-end (its own email inbox via
//            agent-mail.js, a generated password, email verification
//            handled automatically) and saves the result to
//            data/textnow-account.json — that account is then reused
//            forever, never recreated. See AUTO ACCOUNT CREATION
//            below for exactly how.
//        (b) MANUAL — add to .env:
//              TEXTNOW_EMAIL=you@example.com
//              TEXTNOW_PASSWORD=your-textnow-password
//            for an existing TextNow account of your own. This always
//            takes priority over (a) if both are present.
//   3. A vision-capable model to read the screen — reuses whatever
//      local-llm.js already has: OLLAMA_VISION_MODEL for a real local
//      Ollama install, or just OLLAMA_API_KEY for Ollama Cloud's free
//      qwen3-vl model (no local GPU needed). See local-llm.js.
//   4. TTS (tts.js / CAMB_API_KEY) and STT (stt.js), already used
//      elsewhere in this project, are reused as-is for the live
//      conversation loop — nothing extra to configure there.
//
// ── HOW A CALL ACTUALLY HAPPENS ───────────────────────────────────
//   1. ensureDesktopReady() — boots the E2B desktop sandbox if it
//      isn't already warm, sets up two PulseAudio virtual devices
//      (see AUDIO BRIDGE below), launches a browser, and logs into
//      TextNow if this is a fresh sandbox/session.
//   2. dialNumber() — vision loop: screenshot, ask the model where
//      the dial pad / number field / call button is, click it. Same
//      screenshot -> locate -> click pattern as screen-vision.js's
//      locateElement(), just pointed at the sandbox's screen instead
//      of the user's own.
//   3. Once TextNow's UI shows the call as connected, Jarvis speaks
//      initialGreeting, then runs a normal turn-taking loop: listen ->
//      transcribe -> decide a reply (Groq, using the per-call
//      systemPrompt + conversation so far) -> speak -> repeat, until
//      the call visibly ends or CALL_TIMEOUT_MS / MAX_TURNS is hit.
//   4. Every turn is logged into an in-memory call record that
//      getCall() / waitForCallCompletion() poll, exactly like
//      AgentPhone's real API, so phone-agent.js can't tell the
//      difference.
//
// ── AUDIO BRIDGE (PulseAudio, inside the sandbox only) ────────────
//   - "jarvis_mic": a null-sink. Jarvis's synthesized speech is
//     played INTO it with `paplay`. Its monitor is remapped into a
//     real SOURCE ("jarvis_mic_source") and set as the sandbox's
//     default input device, so the browser picks it up as "the
//     microphone" the moment TextNow asks for mic access — meaning
//     Jarvis's voice is what the person on the other end hears.
//   - Hearing THEM: captured straight off the sandbox's default
//     output sink's monitor with `parec`, in fixed-length windows
//     between Jarvis's own turns, each handed to stt.js. There's no
//     real voice-activity detection here — just a timed listen
//     window (LISTEN_WINDOW_MS) — which is the honest limitation of
//     doing this without a lower-level hook into TextNow's own
//     WebRTC stack. Good enough for a business call with normal
//     back-and-forth pauses; not as snappy as a real phone agent.
// ═══════════════════════════════════════════════════════════════

// ── AUTO ACCOUNT CREATION ──────────────────────────────────────────
// You don't need to make a TextNow account by hand anymore. If no
// TEXTNOW_EMAIL/TEXTNOW_PASSWORD are set in .env, Jarvis creates its
// own TextNow account the first time it ever needs to place a call:
//   1. Gets a real, persistent inbox from AgentMail (agent-mail.js) —
//      the same "give Jarvis an email to sign up for things" plumbing
//      used elsewhere in this project.
//   2. Generates a strong random password.
//   3. Fills out TextNow's signup form in the sandboxed browser
//      (vision-guided, same as everything else in this file) and
//      submits it.
//   4. Waits for TextNow's verification email to land in that inbox,
//      pulls out the code or link, and completes verification.
//   5. Saves the resulting { email, password } to
//      data/textnow-account.json — REMEMBERED FOREVER after that;
//      every future call reuses this exact account, it's never
//      recreated. Delete that file if you ever want a fresh one.
// Requires AGENTMAIL_API_KEY in .env (agent-mail.js). If you'd rather
// use your own existing TextNow account instead, just set
// TEXTNOW_EMAIL/TEXTNOW_PASSWORD in .env — that always takes priority
// over auto-signup and over anything in the saved state file.
//
// SETUP: really just E2B_API_KEY + AGENTMAIL_API_KEY (or your own
// TEXTNOW_EMAIL/TEXTNOW_PASSWORD) + a vision model for local-llm.js.
// Nothing else to do by hand — Jarvis takes care of the rest the
// first time it's actually asked to call someone.
// ═══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Computer = require("./computer");
const LocalLLM = require("./local-llm");
const AgentMail = require("./agent-mail");
const STT = require("./stt");
const TTS = require("./tts");
const GroqKeys = require("./groq-keys");

// Manual override — if set, always wins over auto-signup / the saved
// account file below.
const TEXTNOW_EMAIL_ENV    = process.env.TEXTNOW_EMAIL    || "";
const TEXTNOW_PASSWORD_ENV = process.env.TEXTNOW_PASSWORD || "";
const TEXTNOW_URL          = process.env.TEXTNOW_URL      || "https://www.textnow.com/web";
// As of Aug 2026 TextNow folded signup AND login into one passwordless
// "magic link" page at /login (there's no separate /signup form with
// a password field anymore — the homepage's "Web Messaging" button
// points here for both new and returning users). Kept overridable in
// case that changes again.
const TEXTNOW_SIGNUP_URL   = process.env.TEXTNOW_SIGNUP_URL || "https://www.textnow.com/login";
const TEXTNOW_LOGIN_URL    = process.env.TEXTNOW_LOGIN_URL  || "https://www.textnow.com/login";

// TextNow's browser signup flow (above) now defaults to a
// "scan this QR code with your phone" handoff with no visible email
// field, which a headless sandbox obviously can't satisfy. TextNow's
// desktop app is a real, separate signup surface (it's an Electron
// app — a bundled Chromium shell — not just the same web page), and
// desktop apps are typically NOT shown the phone-handoff prompt since
// there's no phone to hand off to. That's the bet this makes. There's
// no Linux build of it, so it runs through Wine. This is a genuine
// gamble that adds real setup time and risk (Wine + a real-time audio
// VoIP app is a rougher combination than a plain browser) — set
// TEXTNOW_USE_WINE_APP=false to skip straight to the browser flow.
const TEXTNOW_USE_WINE_APP        = process.env.TEXTNOW_USE_WINE_APP !== "false";
const TEXTNOW_ELECTRON_DOWNLOAD_URL = process.env.TEXTNOW_ELECTRON_DOWNLOAD_URL || "https://electron.textnow.com/downloads";
const WINE_PREFIX_DIR             = "/root/.wine"; // default WINEPREFIX inside the sandbox

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL   = process.env.GROQ_AGENT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

const CALL_TIMEOUT_MS  = parseInt(process.env.TEXTNOW_CALL_TIMEOUT_MS || "", 10) || 5 * 60 * 1000;
const LISTEN_WINDOW_MS = parseInt(process.env.TEXTNOW_LISTEN_MS || "", 10) || 6000;
const MAX_TURNS        = parseInt(process.env.TEXTNOW_MAX_TURNS || "", 10) || 20;

const DATA_DIR      = path.join(__dirname, "data");
const ACCOUNT_PATH  = path.join(DATA_DIR, "textnow-account.json");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ── SAVED ACCOUNT (auto-created, remembered forever) ───────────────
function loadSavedAccount() {
  try {
    if (!fs.existsSync(ACCOUNT_PATH)) return null;
    const data = JSON.parse(fs.readFileSync(ACCOUNT_PATH, "utf8"));
    // TextNow's login is passwordless (magic-link) as of Aug 2026, so
    // only email is required now. Older account files on disk may
    // still have a `password` field from before that change — it's
    // simply unused now, kept for reference rather than migrated out.
    return (data && data.email) ? data : null;
  } catch {
    return null;
  }
}

function saveAccount(email, password) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ACCOUNT_PATH, JSON.stringify({
      email,
      password: password || null, // unused post-Aug-2026 (passwordless magic-link login); kept for old records
      createdAt: new Date().toISOString(),
      source: "auto-signup",
    }, null, 2));
  } catch (e) {
    console.error("[TEXTNOW] Failed to save auto-created account to disk:", e.message);
  }
}

function generatePassword() {
  // 16 random bytes -> base64url, trimmed to a clean 20-char mixed
  // string, plus a guaranteed digit+symbol so it clears typical
  // signup-form password rules.
  const raw = crypto.randomBytes(16).toString("base64").replace(/[+/=]/g, "").slice(0, 18);
  return `${raw}!7`;
}

// Priority: explicit .env override > saved auto-created account >
// (nothing yet — triggers auto-signup).
function getCredentials() {
  if (TEXTNOW_EMAIL_ENV) {
    // TEXTNOW_PASSWORD_ENV is no longer required — TextNow login is
    // passwordless (magic-link) now — but still accepted/ignored if set,
    // so old .env files don't need editing.
    return { email: TEXTNOW_EMAIL_ENV, source: "env" };
  }
  const saved = loadSavedAccount();
  if (saved) return { email: saved.email, source: "saved" };
  return null; // needs auto-signup
}

function isConfigured() {
  if (!Computer.isDesktopConfigured()) return false;
  // Either a manual account is on file, or Jarvis can make one itself.
  return !!getCredentials() || AgentMail.isConfigured();
}

function notConfiguredError() {
  if (!Computer.isDesktopConfigured()) {
    return new Error("E2B desktop isn't configured — add E2B_API_KEY to .env (see computer.js).");
  }
  return new Error(
    "TextNow calling isn't configured — either add TEXTNOW_EMAIL to .env for your own account (TextNow login " +
    "is passwordless now, so TEXTNOW_PASSWORD isn't needed), or add AGENTMAIL_API_KEY to .env and Jarvis will " +
    "create its own TextNow account automatically the first time it's asked to call someone."
  );
}

// No multi-account failover concept for a single TextNow login — kept
// as harmless no-ops so phone-agent.js's withSwitchNotice() call and
// any accountCount() check keep working unmodified.
function consumeSwitchNotice() { return null; }
function accountCount() { return isConfigured() ? 1 : 0; }
function getStatus() {
  const creds = getCredentials();
  return { configured: isConfigured(), provider: "textnow", account: creds ? creds.email : null, source: creds ? creds.source : (AgentMail.isConfigured() ? "will-auto-signup" : null) };
}

// ── IN-MEMORY CALL REGISTRY (stands in for AgentPhone's real API) ──
const calls = new Map(); // id -> call record

function newCallId() {
  return "tn_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

// ══════════════════════════════════════════════════════════════════
// SANDBOX / AUDIO / BROWSER / ACCOUNT / LOGIN SETUP (per sandbox life)
// ══════════════════════════════════════════════════════════════════
let sandboxReady = false; // reset whenever a NEW desktop sandbox spins up
let loggedIn = false;

async function ensureDesktopReady() {
  // A brand-new sandbox instance means any audio devices / browser
  // session from a previous call are gone. computer.js tears down and
  // recreates the desktop transparently on idle-reap, so detect that
  // here rather than assume state carries over.
  if (!Computer.isDesktopRunning()) { sandboxReady = false; loggedIn = false; }

  if (!sandboxReady) {
    await setupVirtualAudio();
    await ensureBrowserInstalled();
    sandboxReady = true;
  }

  if (!loggedIn) {
    let creds = getCredentials();
    if (!creds) {
      if (!AgentMail.isConfigured()) throw notConfiguredError();
      console.log("[TEXTNOW] No TextNow account on file — creating one automatically via AgentMail...");
      creds = await signUpForTextNow();
      saveAccount(creds.email, creds.password);
      console.log(`[TEXTNOW] New TextNow account created and saved for good: ${creds.email}`);
    } else {
      await Computer.desktopLaunch("firefox", TEXTNOW_URL);
      await sleep(6000); // let the page actually load before we start looking at it
      await loginIfNeeded(creds);
    }
    loggedIn = true;
  }
}

async function setupVirtualAudio() {
  const steps = [
    "pulseaudio --start --exit-idle-time=-1 2>/dev/null; true",
    "pactl load-module module-null-sink sink_name=jarvis_mic sink_properties=device.description=jarvis_mic 2>/dev/null; true",
    "pactl load-module module-remap-source master=jarvis_mic.monitor source_name=jarvis_mic_source source_properties=device.description=jarvis_mic_source 2>/dev/null; true",
    "pactl set-default-source jarvis_mic_source",
    "pactl set-default-sink jarvis_mic",
  ];
  for (const cmd of steps) {
    const res = await Computer.desktopRunCommand(cmd, { timeoutMs: 20000 });
    if (!res.ok) console.warn(`[TEXTNOW] Audio setup step returned non-zero (continuing): ${cmd} — ${res.stderr}`);
  }
}

async function ensureBrowserInstalled() {
  const check = await Computer.desktopRunCommand("which firefox || which firefox-esr", { timeoutMs: 10000 });
  if (check.ok && check.stdout.trim()) return;
  console.log("[TEXTNOW] No browser found in the sandbox — installing Firefox (first call only, can take a minute)...");
  await Computer.desktopRunCommand(
    "sudo apt-get update -qq && sudo apt-get install -y -qq firefox-esr && sudo ln -sf \"$(which firefox-esr)\" /usr/local/bin/firefox",
    { timeoutMs: 180000 }
  );
}

// ── "PRESS AND HOLD" CAPTCHA ────────────────────────────────────────
// TextNow's /login page (both signup and login go through it as of
// Aug 2026) can gate the form behind a "press and hold to verify you
// are a human" widget before anything else shows up. A normal click
// doesn't satisfy it — it needs mouse-down, a real hold, then
// mouse-up — so this is checked for and cleared before looking for
// any form fields. Optional because it doesn't always appear (e.g.
// on a machine/session TextNow already trusts).
async function clearHoldCaptchaIfPresent() {
  const captcha = await locateOnDesktop(
    "a \"press and hold\" or \"verify you are a human\" button/circle captcha widget",
    {
      optional: true,
      goal: "find and identify the human-verification widget on this page, if one is showing, so it can be pressed and held",
    }
  );
  if (!captcha || !captcha.found) return false;

  console.log("[TEXTNOW] Press-and-hold captcha detected — holding for ~4.5s...");
  await Computer.desktopHoldClick(captcha.x, captcha.y, 4500);
  await sleep(2000);
  return true;
}

// ── MAGIC-LINK EMAIL ENTRY (shared by login + signup) ──────────────
// TextNow's login/signup is passwordless now — this fills in just the
// email, submits, and returns once the "check your email" state is
// reached. Caller is responsible for polling the inbox afterward.
async function submitEmailForMagicLink(email) {
  await clearHoldCaptchaIfPresent();

  const emailField = await locateOnDesktop("the email input field on TextNow's login/sign-up page");
  if (!emailField.found) throw new Error("Couldn't find TextNow's email input field — the page may not have loaded, TextNow changed its UI again, or a captcha wasn't cleared.");
  await Computer.desktopClick(emailField.x, emailField.y);
  await Computer.desktopType(email);

  const continueButton = await locateOnDesktop("the Continue / Log In / Sign Up submit button on this page", { optional: true });
  if (continueButton && continueButton.found) {
    await Computer.desktopClick(continueButton.x, continueButton.y);
  } else {
    await Computer.desktopPress("Return");
  }
  await sleep(3000);

  // A captcha can also appear AFTER submitting the email, not just before.
  await clearHoldCaptchaIfPresent();
}

// ── WINE-HOSTED TEXTNOW DESKTOP APP (Windows Electron app) ─────────
// Installed once per sandbox lifetime, cached after that. Each step
// below is genuinely uncertain (a NEW download page layout, whether
// the NSIS installer accepts a silent flag, where electron-builder
// puts the exe) — nothing here is hardcoded to a guessed path where
// avoidable; it finds things on disk instead. If ANY step fails, the
// caller falls back to the plain browser flow rather than hard-erroring.
let wineAppPath = null; // cached installed .exe path, once known

async function ensureWineInstalled() {
  const check = await Computer.desktopRunCommand("which wine || which wine64", { timeoutMs: 10000 });
  if (check.ok && check.stdout.trim()) return;

  console.log("[TEXTNOW] Installing Wine on the sandbox (first time only, can take a couple minutes)...");  const install = await Computer.desktopRunCommand(
    "sudo dpkg --add-architecture i386 2>/dev/null; sudo apt-get update -qq && " +
    "sudo apt-get install -y -qq wine wine64 winetricks 2>&1 | tail -20",
    { timeoutMs: 240000 }
  );
  if (!install.ok) throw new Error(`Couldn't install Wine on the sandbox: ${install.stderr || install.stdout || "unknown error"}`);

  // First launch of any kind initializes the wineprefix (~/.wine) —
  // do that now, non-interactively, rather than have it interrupt the
  // actual TextNow install with a first-run wizard.
  await Computer.desktopRunCommand("WINEDLLOVERRIDES=mscoree,mshtml= wineboot --init 2>&1 | tail -10", { timeoutMs: 90000 });

  // Nudge Wine toward its PulseAudio driver so calls route through the
  // same virtual mic/speaker setupVirtualAudio() already wired up for
  // Firefox. Modern Wine defaults to this when PulseAudio is running,
  // but it's a known flaky spot across distros — best-effort, and not
  // fatal if winetricks isn't available or this no-ops.
  await Computer.desktopRunCommand("winetricks sound=pulse 2>&1 | tail -5 || true", { timeoutMs: 60000 });
}

// Downloads the real installer straight from TextNow's own domain
// using the sandbox's actual browser (not a third-party mirror site —
// those are a trust risk this doesn't need to take), then finds
// whatever landed in ~/Downloads rather than assuming a filename.
async function downloadWindowsInstaller() {
  await Computer.desktopLaunch("firefox", TEXTNOW_ELECTRON_DOWNLOAD_URL);
  await sleep(5000);

  const downloadBtn = await locateOnDesktop(
    "a \"Download for Windows\" or \"Download\" button/link on this page for the Windows desktop app",
    { optional: true, goal: "find and click whatever starts downloading the Windows version of the app on this page" }
  );
  if (!downloadBtn || !downloadBtn.found) {
    throw new Error("Couldn't find a Windows download button on TextNow's Electron app download page.");
  }
  await Computer.desktopClick(downloadBtn.x, downloadBtn.y);
  await sleep(15000); // give the download time to actually land

  const find = await Computer.desktopRunCommand(
    "find ~/Downloads -maxdepth 1 -iname '*.exe' -newermt '-2 minutes' 2>/dev/null | head -1",
    { timeoutMs: 10000 }
  );
  const exePath = (find.stdout || "").trim();
  if (!exePath) throw new Error("Clicked the Windows download button but no .exe showed up in ~/Downloads within 15s — it may still be downloading, or the click missed.");
  return exePath;
}

// Runs the downloaded installer under Wine and clicks through it the
// same vision-driven way everything else in this file works, since
// there's no reliable silent-install flag to assume for an
// electron-builder NSIS installer without having seen it run.
async function runInstallerUnderWine(installerPath) {
  await Computer.desktopRunCommand(`wine "${installerPath}" &`, { timeoutMs: 5000, background: true });
  await sleep(6000);

  for (let i = 0; i < 6; i++) {
    const doneCheck = await Computer.desktopRunCommand(
      `find ${WINE_PREFIX_DIR} -iname 'TextNow*.exe' 2>/dev/null | grep -vi -e Downloads -e Temp | head -1; true`,
      { timeoutMs: 10000 }
    );
    if ((doneCheck.stdout || "").trim()) break; // installed exe already exists — installer finished

    const nextish = await locateOnDesktop(
      "a Next / Install / Finish / Launch button in the currently open installer wizard window",
      {
        optional: true,
        skipCache: true,
        goal: "get through whatever step of this software installer wizard is currently showing, choosing default options, until installation completes",
      }
    );
    if (nextish && nextish.found) {
      await Computer.desktopClick(nextish.x, nextish.y);
      await sleep(3000);
    } else {
      await sleep(3000);
    }
  }

  const final = await Computer.desktopRunCommand(
    `find ${WINE_PREFIX_DIR} -iname 'TextNow*.exe' 2>/dev/null | grep -vi -e Downloads -e Temp | head -1; true`,
    { timeoutMs: 10000 }
  );
  const installedPath = (final.stdout || "").trim();
  if (!installedPath) throw new Error("Ran the TextNow installer under Wine but couldn't find an installed TextNow.exe afterward — the install may have failed or landed somewhere unexpected.");
  return installedPath;
}

async function ensureWineTextNowApp() {
  if (wineAppPath) return wineAppPath;

  await ensureWineInstalled();
  const installerPath = await downloadWindowsInstaller();
  wineAppPath = await runInstallerUnderWine(installerPath);
  console.log(`[TEXTNOW] TextNow desktop app installed under Wine at: ${wineAppPath}`);
  return wineAppPath;
}

async function launchWineTextNowApp() {
  const exePath = await ensureWineTextNowApp();
  await Computer.desktopRunCommand(`wine "${exePath}" &`, { timeoutMs: 5000, background: true });
  await sleep(8000); // Electron cold-start under Wine is slower than a native browser tab
}

async function loginIfNeeded(creds) {
  const loggedInAlready = await locateOnDesktop(
    "the call/dialer icon in TextNow's left-hand navigation sidebar (only visible once logged in)",
    { optional: true }
  );
  if (loggedInAlready && loggedInAlready.found) return;

  if (!creds || !creds.email) throw notConfiguredError();

  let usingWineApp = false;
  if (TEXTNOW_USE_WINE_APP) {
    try {
      await launchWineTextNowApp();
      usingWineApp = true;
    } catch (e) {
      console.warn(`[TEXTNOW] Wine app launch failed (${e.message}) — falling back to the browser login flow.`);
      await Computer.desktopLaunch("firefox", TEXTNOW_LOGIN_URL);
      await sleep(5000);
    }
  } else {
    await Computer.desktopLaunch("firefox", TEXTNOW_LOGIN_URL);
    await sleep(5000);
  }
  await submitEmailForMagicLink(creds.email);

  // Passwordless means the rest of "logging in" is identical to the
  // email-verification step of signup — wait for the magic-link email
  // and open it. This always opens in Firefox (it's just a URL) even
  // when the Wine app initiated the request — the account gets
  // verified server-side either way; the Wine app is relaunched
  // afterward to pick up the now-verified session.
  const mail = await AgentMail.checkVerificationFor("textnow", {
    fromContains: "textnow",
    timeoutMs: 90000,
  });
  if (mail.error) {
    throw new Error(
      `TextNow sent a login link but Jarvis couldn't retrieve it from the inbox (${mail.error}) — ` +
      "this may need a one-time manual check via \"Jarvis, show pc\"."
    );
  }
  if (mail.link) {
    await Computer.desktopLaunch("firefox", mail.link);
    await sleep(5000);
  } else if (mail.code) {
    const codeField = await locateOnDesktop("the login/verification code input field", {
      optional: true,
      goal: "enter the login code we were sent and get past this verification step into TextNow's main app",
    });
    if (codeField && codeField.found) {
      await Computer.desktopClick(codeField.x, codeField.y);
      await Computer.desktopType(mail.code);
      await Computer.desktopPress("Return");
      await sleep(4000);
    }
  }

  if (usingWineApp) {
    // Bring the app back after verifying via the browser — most
    // Electron apps single-instance-lock and just refocus rather
    // than open a second window.
    await launchWineTextNowApp();
  }

  const confirm = await locateOnDesktop("the call/dialer icon in TextNow's left-hand navigation sidebar", { optional: true });
  if (!confirm || !confirm.found) {
    throw new Error("Logged into TextNow but couldn't confirm the app loaded — TextNow may be asking for an extra captcha/step that needs a human to clear once.");
  }
}

// ══════════════════════════════════════════════════════════════════
// AUTO SIGNUP — creates a brand new TextNow account end-to-end using
// an AgentMail inbox for verification, and returns the credentials
// (caller is responsible for persisting them via saveAccount()).
// ══════════════════════════════════════════════════════════════════
async function signUpForTextNow() {
  const inbox = await AgentMail.signupAddressFor("textnow");
  if (inbox.error) throw new Error(`Couldn't get a signup inbox from AgentMail: ${inbox.error}`);

  const email = inbox.email;
  // TextNow's login/signup went passwordless (magic-link) in Aug
  // 2026 — the same /login page handles brand-new emails and
  // existing ones, so "signing up" here is just submitting the email
  // and following the link TextNow emails back, same as login.
  // generatePassword() is kept around (unused) only so a manually
  // set TEXTNOW_PASSWORD in an old .env doesn't break anything else
  // that still references it.
  const password = generatePassword();

  let usingWineApp = false;
  if (TEXTNOW_USE_WINE_APP) {
    try {
      await launchWineTextNowApp();
      usingWineApp = true;
    } catch (e) {
      console.warn(`[TEXTNOW] Wine app signup path failed (${e.message}) — falling back to the browser signup flow (which currently hits TextNow's QR-code phone-handoff screen and will likely fail too).`);
      await Computer.desktopLaunch("firefox", TEXTNOW_SIGNUP_URL);
      await sleep(6000);
    }
  } else {
    await Computer.desktopLaunch("firefox", TEXTNOW_SIGNUP_URL);
    await sleep(6000);
  }
  await submitEmailForMagicLink(email);

  // ── EMAIL VERIFICATION ────────────────────────────────────────
  const mail = await AgentMail.checkVerificationFor("textnow", {
    fromContains: "textnow",
    timeoutMs: 90000,
  });
  if (!mail.error) {
    if (mail.code) {
      // A 6-digit-style code entered directly in the browser.
      const codeField = await locateOnDesktop("the verification code input field", {
        optional: true,
        goal: "enter the email verification code we were sent and get past this verification step into TextNow's main app",
      });
      if (codeField && codeField.found) {
        await Computer.desktopClick(codeField.x, codeField.y);
        await Computer.desktopType(mail.code);
        const verifyButton = await locateOnDesktop("the Verify / Confirm / Continue button", {
          optional: true,
          goal: "submit the verification code just entered so the account moves past this step",
        });
        if (verifyButton && verifyButton.found) await Computer.desktopClick(verifyButton.x, verifyButton.y);
        else await Computer.desktopPress("Return");
        await sleep(4000);
      }
    } else if (mail.link) {
      // A "click to confirm" link — open it directly in the same browser.
      await Computer.desktopLaunch("firefox", mail.link);
      await sleep(5000);
    }
  } else {
    console.warn(`[TEXTNOW] No verification email confirmed yet (${mail.error}) — continuing; TextNow may not require it, or it may need a manual check.`);
  }

  if (usingWineApp) {
    // Verification happened in the browser (it's just a link/code) —
    // bring the Wine app back so the onboarding-clearing loop below
    // is looking at the right window.
    await launchWineTextNowApp();
  }

  // ── CLEAR ANY "PICK YOUR NUMBER" / WELCOME ONBOARDING SCREENS ───
  // TextNow usually offers to let you choose an area code right after
  // signup — accept whatever's suggested rather than picking one, and
  // click through any other one-off welcome/tour modals that follow.
  for (let i = 0; i < 5; i++) {
    const dialerVisible = await locateOnDesktop(
      "the call/dialer icon in TextNow's left-hand navigation sidebar",
      { optional: true, skipCache: true }
    );
    if (dialerVisible && dialerVisible.found) break; // fully into the app now

    const nextish = await locateOnDesktop(
      "a Continue / Next / Confirm / Accept / Get Started / Skip button on the current onboarding or number-selection screen",
      {
        optional: true,
        skipCache: true,
        goal: "get through whatever onboarding, welcome, or phone-number-selection screen is currently showing and reach TextNow's main app (accept whatever number/defaults are suggested rather than customizing anything)",
      }
    );
    if (nextish && nextish.found) {
      await Computer.desktopClick(nextish.x, nextish.y);
      await sleep(2500);
    } else {
      break; // nothing recognizable left to click through
    }
  }

  const finalCheck = await locateOnDesktop("the call/dialer icon in TextNow's left-hand navigation sidebar", { optional: true, skipCache: true });
  if (!finalCheck || !finalCheck.found) {
    throw new Error(
      "Signed up for TextNow but couldn't confirm the account fully finished onboarding (e.g. it may be showing a " +
      "captcha or a screen this file doesn't recognize yet) — the account was still created " +
      `(${email}), so it may just need one manual \"show pc\" look to finish setup this one time.`
    );
  }

  return { email, password };
}

// ══════════════════════════════════════════════════════════════════
// VISION: locate a UI element on the SANDBOX's screen (not the user's
// own machine — see screen-vision.js for that local-PC equivalent).
//
// THREE-TIER FALLBACK, in this exact order:
//   1. Ollama Cloud (OLLAMA_API_KEY) — free, fast, tried first.
//   2. Gemini (GEMINI_API_KEY) — if Ollama Cloud is out of credits,
//      rate-limited, or otherwise fails. Groq is deliberately NOT
//      part of this chain.
//   3. Self-hosted Ollama, installed and run BY JARVIS ITSELF inside
//      the E2B desktop sandbox (its "computer") — the true last
//      resort when neither cloud option works at all. See
//      ensureSelfHostedOllama()/selfHostedVisionRequest() below.
//
// GOAL vs. DESCRIPTION: tiers 1-2 are genuinely strong vision models,
// so they're given a precise, specific element description to find
// ("the Verify button"). Tier 3's self-hosted model is whatever small
// model actually fits/runs well in the sandbox — much weaker — so
// feeding it that same hardcoded, possibly-wrong description risks
// it confidently clicking whatever superficially matches those words
// even if that guess was mistaken. Instead, when a caller provides
// opts.goal, tier 3 is told the higher-level GOAL of this step (e.g.
// "get past this verification screen") and asked to look at the
// actual screenshot and decide for itself what to click — it isn't
// steered toward a specific label that might not even be right.
// ══════════════════════════════════════════════════════════════════
const elementCache = new Map(); // "description@WxH" -> { x, y, ts }
const ELEMENT_CACHE_TTL_MS = 2 * 60 * 1000;

// ── TIER 2: GEMINI (self-contained here — same key-rotation shape as
// screen-vision.js, just not shared code, since that module is wired
// for the user's own local screen, not the sandbox's) ──
function loadGeminiKeys() {
  const keys = [];
  for (const k of (process.env.GEMINI_API_KEY || "").split(",")) {
    const t = k.trim();
    if (t) keys.push(t);
  }
  for (let i = 2; ; i++) {
    const raw = process.env[`GEMINI_API_KEY${i}`];
    if (!raw) break;
    const t = raw.trim();
    if (t) keys.push(t);
  }
  return keys;
}
const GEMINI_API_KEYS = loadGeminiKeys();
let geminiKeyIndex = 0;
function currentGeminiKey() { return GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length]; }
function rotateGeminiKey() { geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length; }
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
function geminiUrlFor(model) { return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`; }

async function geminiVision(base64Image, prompt) {
  if (!GEMINI_API_KEYS.length) throw new Error("No GEMINI_API_KEY configured.");
  let lastErr;
  for (let attempt = 0; attempt < GEMINI_API_KEYS.length; attempt++) {
    const key = currentGeminiKey();
    try {
      const res = await fetch(`${geminiUrlFor(GEMINI_MODEL)}?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: "image/png", data: base64Image } }] }],
        }),
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) {
        lastErr = new Error(`Gemini HTTP ${res.status}`);
        if (res.status === 429 || res.status >= 500) { rotateGeminiKey(); continue; }
        throw lastErr;
      }
      const data = await res.json();
      const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      if (!text) throw new Error("Gemini returned no text.");
      return text;
    } catch (e) {
      lastErr = e;
      rotateGeminiKey();
    }
  }
  throw lastErr || new Error("Gemini vision failed.");
}

// ── TIER 3: SELF-HOSTED OLLAMA, INSTALLED IN THE SANDBOX ──────────
// Jarvis's own last resort: if neither cloud vision option works,
// it installs Ollama on its own "computer" (the E2B desktop sandbox),
// pulls a small vision-capable model, runs the server itself, and
// queries it locally over the sandbox's own loopback address — no
// external API, no key, nothing that can run out of credits.
const SELF_HOST_VISION_MODEL = process.env.TEXTNOW_SELFHOST_VISION_MODEL || "moondream";
let selfHostReady = false;

async function ensureSelfHostedOllama() {
  if (!Computer.isDesktopRunning()) selfHostReady = false;
  if (selfHostReady) return;

  console.log("[TEXTNOW] Cloud vision options unavailable — Jarvis is installing and hosting Ollama on its own sandbox computer as a last resort...");

  const check = await Computer.desktopRunCommand("which ollama", { timeoutMs: 10000 });
  if (!check.ok || !check.stdout.trim()) {
    const install = await Computer.desktopRunCommand("curl -fsSL https://ollama.com/install.sh | sh", { timeoutMs: 180000 });
    if (!install.ok) throw new Error(`Couldn't install Ollama on the sandbox: ${install.stderr || "unknown error"}`);
  }

  const running = await Computer.desktopRunCommand("curl -s -m 2 http://127.0.0.1:11434/api/tags", { timeoutMs: 5000 });
  if (!running.ok || !running.stdout.trim()) {
    await Computer.desktopRunCommand("nohup ollama serve > /tmp/ollama-serve.log 2>&1 & disown; sleep 2; true", { timeoutMs: 15000 });
  }

  const pulled = await Computer.desktopRunCommand(`ollama list | grep -qi "${SELF_HOST_VISION_MODEL}"`, { timeoutMs: 10000 });
  if (!pulled.ok) {
    console.log(`[TEXTNOW] Pulling self-hosted vision model "${SELF_HOST_VISION_MODEL}" on the sandbox (first time only, can take a few minutes)...`);
    const pull = await Computer.desktopRunCommand(`ollama pull ${SELF_HOST_VISION_MODEL}`, { timeoutMs: 10 * 60 * 1000 });
    if (!pull.ok) throw new Error(`Couldn't pull "${SELF_HOST_VISION_MODEL}" on the sandbox: ${pull.stderr || "unknown error"}`);
  }

  selfHostReady = true;
}

// The sandbox's Ollama server is only reachable FROM INSIDE the
// sandbox (this Node process isn't in there), so the request itself
// has to run as a shell command via desktopRunCommand — write the
// JSON body to a file first rather than inlining it on the command
// line, since a base64 screenshot is way too large/escape-unsafe for
// that.
async function selfHostedVisionRequest(base64Image, prompt) {
  await ensureSelfHostedOllama();
  const body = JSON.stringify({
    model: SELF_HOST_VISION_MODEL,
    stream: false,
    messages: [{ role: "user", content: prompt, images: [base64Image] }],
  });
  const reqPath = `/tmp/jarvis_ollama_req_${Date.now()}.json`;
  await Computer.desktopWriteFile(reqPath, body);
  const res = await Computer.desktopRunCommand(
    `curl -s -X POST http://127.0.0.1:11434/api/chat -H "Content-Type: application/json" -d @${reqPath}`,
    { timeoutMs: 90000 }
  );
  if (!res.ok || !res.stdout) throw new Error("Self-hosted Ollama request failed inside the sandbox.");
  let parsed;
  try { parsed = JSON.parse(res.stdout); } catch { throw new Error("Self-hosted Ollama returned unparseable output."); }
  return parsed?.message?.content || "";
}

// ── THE ACTUAL 3-TIER DISPATCH ─────────────────────────────────────
async function visionLocate(base64, prompt, goalPrompt) {
  if (LocalLLM.hasCloudVisionModel()) {
    try {
      return await LocalLLM.ollamaCloudVision(base64, prompt);
    } catch (e) {
      console.warn(`[TEXTNOW] Ollama Cloud vision failed (${e.message}) — trying Gemini next.`);
    }
  }
  if (GEMINI_API_KEYS.length) {
    try {
      return await geminiVision(base64, prompt);
    } catch (e) {
      console.warn(`[TEXTNOW] Gemini vision failed (${e.message}) — falling back to self-hosted Ollama on the sandbox.`);
    }
  }
  // Last resort — use the goal-oriented prompt if the caller gave us
  // one, since it's a weaker model and shouldn't be steered by a
  // specific description that might just be wrong.
  return selfHostedVisionRequest(base64, goalPrompt || prompt);
}

async function locateOnDesktop(description, opts = {}) {
  const base64 = await Computer.desktopScreenshot();
  const dims = pngDimensions(Buffer.from(base64, "base64"));
  const cacheKey = `${description}@${dims.width}x${dims.height}`;

  if (!opts.skipCache) {
    const cached = elementCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < ELEMENT_CACHE_TTL_MS) {
      return { found: true, x: cached.x, y: cached.y, source: "cache" };
    }
  }

  const prompt =
    `This screenshot is exactly ${dims.width}x${dims.height} pixels — that is its real, full resolution. ` +
    `Find this UI element: "${description}". Reply with ONLY a JSON object, no prose, no markdown fences, in ` +
    `the exact shape {"found": true, "x": <int>, "y": <int>} with x/y being the pixel center of the element. ` +
    `If it genuinely isn't visible, reply {"found": false}.`;

  // Only built when the caller supplied opts.goal — see the header
  // comment above for why this is worded so differently from `prompt`.
  const goalPrompt = opts.goal
    ? `This screenshot is exactly ${dims.width}x${dims.height} pixels — that is its real, full resolution. ` +
      `Your goal right now: ${opts.goal}. Look at what's actually on screen and decide the SINGLE next UI ` +
      `element that needs clicking to make progress toward that goal — don't assume what it's called or looks ` +
      `like ahead of time, just judge from what's really there. Reply with ONLY a JSON object, no prose, no ` +
      `markdown fences, in the exact shape {"found": true, "x": <int>, "y": <int>} for that element's pixel ` +
      `center, or {"found": false} if nothing on screen looks like it helps reach the goal.`
    : null;

  let raw;
  try {
    raw = await visionLocate(base64, prompt, goalPrompt);
  } catch (e) {
    if (opts.optional) return { found: false };
    throw e;
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw || "").replace(/```json|```/g, "").trim());
  } catch {
    parsed = { found: false };
  }
  if (parsed && parsed.found) {
    elementCache.set(cacheKey, { x: parsed.x, y: parsed.y, ts: Date.now() });
  }
  return parsed;
}

// Reads a PNG's IHDR chunk directly — same trick screen-vision.js
// uses — so we know the screenshot's real pixel dimensions without
// pulling in an image-parsing dependency just for this.
function pngDimensions(buf) {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function findAndClick(description, opts = {}) {
  const loc = await locateOnDesktop(description, opts);
  if (!loc || !loc.found) throw new Error(`Couldn't find "${description}" on TextNow's screen.`);
  await Computer.desktopClick(loc.x, loc.y);
  return loc;
}

// ══════════════════════════════════════════════════════════════════
// DIALING
// ══════════════════════════════════════════════════════════════════
async function dialNumber(toNumber) {
  const digits = String(toNumber).replace(/[^\d+]/g, "");

  await findAndClick("the call/dialer icon in TextNow's left-hand navigation sidebar");
  await sleep(1000);
  const numberField = await locateOnDesktop("the phone number input field for placing a new call");
  if (numberField.found) await Computer.desktopClick(numberField.x, numberField.y);
  await Computer.desktopType(digits);
  await sleep(300);

  await findAndClick("the green call/dial button to place the call");
  await sleep(1500);
}

async function isCallConnected() {
  const loc = await locateOnDesktop(
    "the red hang-up / end-call button shown during an ACTIVE, already-connected call (not a ringing/connecting screen)",
    { optional: true, skipCache: true }
  );
  return !!(loc && loc.found);
}

async function isCallStillGoing() {
  const loc = await locateOnDesktop(
    "the red hang-up / end-call button, present any time a call is ringing OR connected",
    { optional: true, skipCache: true }
  );
  return !!(loc && loc.found);
}

async function hangUp() {
  const loc = await locateOnDesktop("the red hang-up / end-call button", { optional: true, skipCache: true });
  if (loc && loc.found) await Computer.desktopClick(loc.x, loc.y);
}

// ══════════════════════════════════════════════════════════════════
// AUDIO I/O
// ══════════════════════════════════════════════════════════════════
async function speak(text) {
  if (!text) return;
  const synth = await TTS.synthesize(text);
  if (!synth || !synth.buffer) {
    console.warn("[TEXTNOW] TTS returned nothing — skipping this turn's speech (text still logged in the transcript).");
    return;
  }
  const ext = synth.mimeType && synth.mimeType.includes("flac") ? "flac" : "mp3";
  const remotePath = `/tmp/jarvis_tts_${Date.now()}.${ext}`;
  await Computer.desktopWriteFile(remotePath, synth.buffer);
  // Play into the "jarvis_mic" sink specifically (not whatever the
  // default happens to be) so this never accidentally plays into a
  // capture device instead.
  await Computer.desktopRunCommand(`paplay -d jarvis_mic "${remotePath}" || ffplay -nodisp -autoexit -loglevel quiet "${remotePath}"`, {
    timeoutMs: 30000,
  });
}

async function listen(windowMs = LISTEN_WINDOW_MS) {
  const remotePath = `/tmp/jarvis_listen_${Date.now()}.wav`;
  const seconds = Math.max(1, Math.round(windowMs / 1000));
  // Records off the DEFAULT sink's monitor, i.e. "whatever the
  // browser/TextNow tab is currently outputting" — the other side of
  // the call, not Jarvis's own mic feed.
  await Computer.desktopRunCommand(
    `parec -d @DEFAULT_SINK@.monitor --file-format=wav "${remotePath}" & PID=$!; sleep ${seconds}; kill $PID 2>/dev/null; true`,
    { timeoutMs: (seconds + 5) * 1000 }
  );
  const bytes = await Computer.desktopReadFile(remotePath).catch(() => null);
  if (!bytes || !bytes.length) return "";
  try {
    const text = await STT.transcribe(Buffer.from(bytes), "clip.wav", "audio/wav");
    return (text || "").trim();
  } catch (e) {
    console.warn("[TEXTNOW] Transcription failed for this turn:", e.message);
    return "";
  }
}

// ── DECIDE WHAT JARVIS SAYS NEXT, GIVEN THE PER-CALL systemPrompt ──
async function nextReply(systemPrompt, history, heardText) {
  if (!GroqKeys.hasGroqKey()) {
    return heardText ? "Got it, thank you." : "";
  }
  const messages = [
    { role: "system", content: systemPrompt + "\n\nYou are LIVE on a phone call right now. Keep every reply to one or two short spoken sentences — this is speech, not text. Never use markdown." },
    ...history.flatMap((t) => ([
      { role: "user", content: t.transcript || "(silence)" },
      { role: "assistant", content: t.response || "" },
    ])),
    { role: "user", content: heardText || "(they haven't said anything yet — greet them / continue naturally)" },
  ];

  const key = GroqKeys.currentGroqKey();
  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ model: GROQ_MODEL, temperature: 0.6, messages }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`Groq reply generation failed (${res.status})`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

// ══════════════════════════════════════════════════════════════════
// THE ACTUAL CALL — same shape as AgentPhone's real API
// ══════════════════════════════════════════════════════════════════
async function placeOutboundCall({ toNumber, systemPrompt, initialGreeting, ownerName }) {
  if (!isConfigured()) throw notConfiguredError();
  if (!toNumber) throw new Error("placeOutboundCall requires toNumber");
  if (!systemPrompt) throw new Error("placeOutboundCall requires systemPrompt");

  const id = newCallId();
  const record = { id, status: "queued", toNumber, transcripts: [], recordingUrl: null, error: null };
  calls.set(id, record);

  _runTextNowCall(record, { toNumber, systemPrompt, initialGreeting, ownerName }).catch((e) => {
    record.status = "failed";
    record.error = e.message;
    console.error(`[TEXTNOW] Call ${id} failed:`, e.message);
  });

  return { id, status: "queued" };
}

async function _runTextNowCall(record, { toNumber, systemPrompt, initialGreeting, ownerName }) {
  record.status = "ringing";

  await ensureDesktopReady();
  await dialNumber(toNumber);

  const connectDeadline = Date.now() + 45000;
  let connected = false;
  while (Date.now() < connectDeadline) {
    if (await isCallConnected()) { connected = true; break; }
    if (!(await isCallStillGoing())) break; // they declined / it failed before ever connecting
    await sleep(2000);
  }

  if (!connected) {
    record.status = "failed";
    return;
  }

  record.status = "in-progress"; // not in CONNECTING_STATUSES and not completed/failed -> phone-agent.js treats this as "on the call"

  const greeting = initialGreeting || `Hi, this is Jarvis, ${ownerName || "my owner"}'s personal assistant.`;
  await speak(greeting);
  record.transcripts.push({ transcript: "", response: greeting });

  const start = Date.now();
  let turns = 0;
  while (Date.now() - start < CALL_TIMEOUT_MS && turns < MAX_TURNS) {
    if (!(await isCallStillGoing())) break; // other side hung up

    const heard = await listen();
    if (!(await isCallStillGoing())) break; // hung up mid-listen

    let reply;
    try {
      reply = await nextReply(systemPrompt, record.transcripts, heard);
    } catch (e) {
      console.warn("[TEXTNOW] Reply generation failed this turn:", e.message);
      reply = "";
    }
    if (reply) await speak(reply);
    record.transcripts.push({ transcript: heard, response: reply });
    turns++;

    // Natural close: model said goodbye and there's nothing left heard.
    if (/\b(goodbye|bye now|have a good (day|one)|talk soon)\b/i.test(reply) && turns > 1) break;
  }

  await hangUp();
  record.status = "completed";
}

async function getCall(callId) {
  const record = calls.get(callId);
  if (!record) throw new Error(`No such call: ${callId}`);
  return record;
}

async function waitForCallCompletion(callId, { pollMs = 3000, timeoutMs = CALL_TIMEOUT_MS + 30000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const call = await getCall(callId);
    if (call.status === "completed" || call.status === "failed") return call;
    await sleep(pollMs);
  }
  throw new Error(`Timed out waiting for call ${callId} to finish (still ${(await getCall(callId)).status} after ${timeoutMs / 1000}s)`);
}

module.exports = {
  isConfigured,
  accountCount,
  getStatus,
  consumeSwitchNotice,
  placeOutboundCall,
  getCall,
  waitForCallCompletion,
};
