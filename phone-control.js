"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Phone Control v1.0
//
// "Jarvis, go on Instagram and search for chicken recipes"
// → Groq plans a sequence of accessibility actions
// → APK's PhoneControlService executes them step by step on the real phone UI
//
// FLOW:
//   1. APK sends POST /api/phone-control with { command, currentApp, screenContext }
//   2. Groq translates the NL command into a JSON action plan
//      (open_app, tap_element, type_text, scroll, back, wait, screenshot_check)
//   3. Backend returns the plan as JSON; APK executes each step via
//      Android Accessibility APIs (no root needed)
//   4. After each step the APK can POST /api/phone-control/verify with a
//      screenshot description; Groq decides whether to continue, retry, or abort.
//
// APPS SUPPORTED (Groq picks the right package name automatically):
//   Instagram, YouTube, TikTok, Spotify, Google Maps, Chrome, Settings,
//   Contacts, Messages, WhatsApp, Telegram, Gmail, Calculator, Camera,
//   Files, Clock, Notes, Twitter/X, Reddit, Snapchat, Netflix, Amazon,
//   DoorDash, Uber, Lyft, Google Photos, Play Store — plus any app the
//   user names by its real name (Groq resolves the package name).
//
// SECURITY: only the owner's authenticated sessions can trigger phone control.
//   All actions are logged to data/phone-control-log.json.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const Groq = require("./hermes-engine");

// ── LOG ───────────────────────────────────────────────────────
const LOG_FILE = path.join(__dirname, "data", "phone-control-log.json");

function logAction(entry) {
  try {
    const data = fs.existsSync(LOG_FILE)
      ? JSON.parse(fs.readFileSync(LOG_FILE, "utf8"))
      : [];
    data.unshift({ ...entry, ts: new Date().toISOString() });
    if (data.length > 500) data.length = 500;
    if (!fs.existsSync(path.dirname(LOG_FILE))) {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    }
    fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
  } catch { /* non-fatal */ }
}

// ── KNOWN APP PACKAGE MAP ─────────────────────────────────────
// Groq can resolve unknowns but we seed it with the most common ones
// so it doesn't have to guess.
const APP_PACKAGES = {
  instagram:     "com.instagram.android",
  youtube:       "com.google.android.youtube",
  tiktok:        "com.zhiliaoapp.musically",
  spotify:       "com.spotify.music",
  maps:          "com.google.android.apps.maps",
  "google maps": "com.google.android.apps.maps",
  chrome:        "com.android.chrome",
  settings:      "com.android.settings",
  contacts:      "com.android.contacts",
  messages:      "com.google.android.apps.messaging",
  whatsapp:      "com.whatsapp",
  telegram:      "org.telegram.messenger",
  gmail:         "com.google.android.gm",
  calculator:    "com.google.android.calculator",
  camera:        "com.android.camera2",
  files:         "com.google.android.apps.nbu.files",
  clock:         "com.google.android.deskclock",
  twitter:       "com.twitter.android",
  x:             "com.twitter.android",
  reddit:        "com.reddit.frontpage",
  snapchat:      "com.snapchat.android",
  netflix:       "com.netflix.mediaclient",
  amazon:        "com.amazon.mShop.android.shopping",
  doordash:      "com.dd.doordash",
  uber:          "com.ubercab",
  lyft:          "com.lyft.android",
  "google photos": "com.google.android.apps.photos",
  "play store":  "com.android.vending",
  "phone":       "com.google.android.dialer",
  "dialer":      "com.google.android.dialer",
};

function resolvePackage(appName) {
  if (!appName) return null;
  return APP_PACKAGES[appName.toLowerCase().trim()] || null;
}

// ── ACTION PLAN SCHEMA (what Groq returns) ────────────────────
// Each step is one of:
//   { action: "open_app",     package: "com.instagram.android", app_name: "Instagram" }
//   { action: "tap_element",  description: "Search icon",  fallback_text: "Search" }
//   { action: "type_text",    text: "chicken recipe" }
//   { action: "scroll",       direction: "down", amount: "medium" }
//   { action: "back" }
//   { action: "wait",         ms: 1500 }
//   { action: "screenshot_check", expect: "search results visible" }
//   { action: "home" }
//   { action: "swipe",        from: "bottom", to: "center" }
//   { action: "tap_coords",   x_pct: 0.5, y_pct: 0.15 }   // last resort

const PLANNER_SYSTEM = `You are JARVIS, an AI assistant controlling an Android phone on behalf of the user via Android Accessibility APIs.

Given a natural-language command and optional context about the current app and screen, produce a JSON action plan that will complete the task step by step.

Return ONLY a valid JSON object, no markdown, no preamble:
{
  "app": "Instagram",
  "package": "com.instagram.android",
  "summary": "Open Instagram and search for chicken recipe",
  "steps": [
    { "action": "open_app", "package": "com.instagram.android", "app_name": "Instagram" },
    { "action": "wait", "ms": 1500 },
    { "action": "tap_element", "description": "Search/magnifying glass icon in bottom nav bar", "fallback_text": "Search" },
    { "action": "type_text", "text": "chicken recipe" },
    { "action": "tap_element", "description": "Search button or Go key on keyboard", "fallback_text": "Search" }
  ]
}

ACTION TYPES AND RULES:
- open_app: always first if the app isn't already open. Include both package and app_name.
- tap_element: describe the UI element clearly. fallback_text is the exact visible text/label if description-based matching fails.
- type_text: text to type into the focused field. Do NOT include the Enter key here — use a separate tap_element for the search/go button.
- scroll: direction is "up"/"down"/"left"/"right", amount is "small"/"medium"/"large".
- back: press the Android back button.
- home: press the Android home button.
- wait: pause in milliseconds. Use after open_app (1500ms) and after type_text (300ms) to let UI settle.
- screenshot_check: add this after major transitions to verify the screen looks right before continuing. expect describes what should be visible.
- swipe: gesture swipe. from/to are "top"/"bottom"/"left"/"right"/"center".
- tap_coords: ONLY as absolute last resort when there's truly no element to describe. x_pct/y_pct are 0.0-1.0 fractions of screen width/height.

PACKAGE NAMES (use these exactly):
Instagram: com.instagram.android
YouTube: com.google.android.youtube
TikTok: com.zhiliaoapp.musically
Spotify: com.spotify.music
Chrome: com.android.chrome
Settings: com.android.settings
WhatsApp: com.whatsapp
Gmail: com.google.android.gm
Maps: com.google.android.apps.maps
Messages: com.google.android.apps.messaging
Twitter/X: com.twitter.android
Reddit: com.reddit.frontpage
Netflix: com.netflix.mediaclient
Snapchat: com.snapchat.android
Uber: com.ubercab
DoorDash: com.dd.doordash

COMMON TASK PATTERNS:
- "search for X on Instagram": open_app → wait → tap Search tab → type text → wait → tap search result/go
- "play X on YouTube": open_app → wait → tap search icon → type query → tap search → tap first video result  
- "search for X on TikTok": open_app → wait → tap Search icon → type text → wait
- "open [app]": just open_app + wait
- "go back": back
- "go home": home
- "scroll down": scroll down
- "DM [person] on Instagram": open_app → wait → tap DMs icon → tap search in DMs → type person's name → tap their name → tap message field → type message → send
- "set alarm for X": open clock app → tap Alarm tab → tap Add → set time → save

Keep steps minimal and precise. Prefer tap_element with clear descriptions over tap_coords.`;

// ── PLAN A PHONE ACTION ───────────────────────────────────────
async function planPhoneAction({ command, currentApp = null, screenContext = null }) {
  const userMsg = [
    `Command: "${command}"`,
    currentApp    ? `Current app open: ${currentApp}` : "No app currently open.",
    screenContext ? `Current screen state: ${screenContext}` : "",
  ].filter(Boolean).join("\n");

  const messages = [
    { role: "system", content: PLANNER_SYSTEM },
    { role: "user",   content: userMsg },
  ];

  let raw;
  try {
    raw = await Groq.groqFetch(messages, Groq.MODELS.fast, 0.1, 1024);
  } catch (e) {
    throw new Error(`Groq planning failed: ${e.message}`);
  }

  const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
  let plan;
  try {
    plan = JSON.parse(cleaned);
  } catch {
    throw new Error(`Groq returned unparseable plan: ${cleaned.slice(0, 200)}`);
  }

  // Resolve package name if Groq left it generic
  if (plan.app && !plan.package) {
    plan.package = resolvePackage(plan.app) || plan.package;
  }
  for (const step of (plan.steps || [])) {
    if (step.action === "open_app" && step.app_name && !step.package) {
      step.package = resolvePackage(step.app_name) || step.package;
    }
  }

  logAction({ type: "plan", command, plan });
  return plan;
}

// ── VERIFY A STEP (screenshot description → continue/retry/abort) ─
const VERIFY_SYSTEM = `You are JARVIS verifying that a phone automation step succeeded.
Given what was expected after a step and a description of the current screen state, decide what to do next.
Return ONLY valid JSON: { "status": "ok" | "retry" | "abort", "reason": "one short sentence" }
- "ok": the expected state matches — continue with the next step
- "retry": close but not quite right — tap the same target again or wait a bit more  
- "abort": completely wrong screen, something went badly — stop and report to user`;

async function verifyStep({ expected, screenState }) {
  const messages = [
    { role: "system", content: VERIFY_SYSTEM },
    {
      role: "user",
      content: `Expected: "${expected}"\nActual screen: "${screenState}"`,
    },
  ];
  try {
    const raw = await Groq.groqFetch(messages, Groq.MODELS.fast, 0.1, 128);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch {
    return { status: "ok", reason: "Verification skipped — proceeding." };
  }
}

// ── TRANSLATE NATURAL LANGUAGE CORRECTIONS ────────────────────
// When user says "no, tap the heart not the search" mid-execution,
// Groq figures out the correction as a new mini-plan.
async function planCorrection({ original, correction, currentStep, currentApp }) {
  const messages = [
    { role: "system", content: PLANNER_SYSTEM },
    {
      role: "user",
      content: [
        `Original task: "${original}"`,
        `User correction: "${correction}"`,
        `Currently on step ${currentStep} with ${currentApp || "unknown app"} open.`,
        "Produce a corrected action plan from this point forward.",
      ].join("\n"),
    },
  ];
  try {
    const raw = await Groq.groqFetch(messages, Groq.MODELS.fast, 0.1, 1024);
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`Correction planning failed: ${e.message}`);
  }
}

// ── REPORT RESULT ─────────────────────────────────────────────
// After the APK finishes executing all steps, it calls back with the
// result. We generate a natural Jarvis voice reply.
async function buildCompletionReply({ command, success, errorStep, errorReason, userTitle = "Sir" }) {
  if (success) {
    return `Done, ${userTitle}. ${command} — completed successfully.`;
  }
  // Let Groq craft a natural failure reply
  const messages = [
    {
      role: "system",
      content: `You are JARVIS. The phone automation task failed. Report this briefly in 1-2 sentences in JARVIS's voice — dry, composed, direct. Address the user as "${userTitle}".`,
    },
    {
      role: "user",
      content: `Task: "${command}"\nFailed at step: ${errorStep || "unknown"}\nReason: ${errorReason || "unknown"}`,
    },
  ];
  try {
    return (await Groq.groqFetch(messages, Groq.MODELS.fast, 0.5, 120)).trim();
  } catch {
    return `That didn't go through, ${userTitle}. The automation stopped at ${errorStep || "an unknown step"}.`;
  }
}

module.exports = { planPhoneAction, verifyStep, planCorrection, buildCompletionReply, resolvePackage };
