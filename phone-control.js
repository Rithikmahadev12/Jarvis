"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Phone Control v1.2
//
// CHANGE: planner now uses local Ollama (your computer's model)
//         instead of Groq. Falls back to Groq if Ollama is
//         unreachable (cloud deploy / Ollama not running).
//
// Uses LocalLLM.ollamaText() → hits http://127.0.0.1:11434
// Model: OLLAMA_MODEL env var (default: llama3.2:3b)
//        For best phone-control accuracy use llama3.1:8b or qwen2.5:7b
//
// FIX v1.1: plan returned at root, APK unwraps wrapper { ok, plan }
// FIX v1.1: open_app wait_ms raised to 2500 for heavy apps
// FIX v1.2: planner switched to Ollama, Groq kept as fallback
// ═══════════════════════════════════════════════════════════════

const fs       = require("fs");
const path     = require("path");
const Groq     = require("./hermes-engine");
const LocalLLM = require("./local-llm");

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

// ── PACKAGE MAP ───────────────────────────────────────────────
const APP_PACKAGES = {
  instagram:          "com.instagram.android",
  youtube:            "com.google.android.youtube",
  tiktok:             "com.zhiliaoapp.musically",
  spotify:            "com.spotify.music",
  maps:               "com.google.android.apps.maps",
  "google maps":      "com.google.android.apps.maps",
  chrome:             "com.android.chrome",
  settings:           "com.android.settings",
  contacts:           "com.android.contacts",
  messages:           "com.google.android.apps.messaging",
  whatsapp:           "com.whatsapp",
  telegram:           "org.telegram.messenger",
  gmail:              "com.google.android.gm",
  calculator:         "com.google.android.calculator",
  camera:             "com.android.camera2",
  files:              "com.google.android.apps.nbu.files",
  clock:              "com.google.android.deskclock",
  twitter:            "com.twitter.android",
  x:                  "com.twitter.android",
  reddit:             "com.reddit.frontpage",
  snapchat:           "com.snapchat.android",
  netflix:            "com.netflix.mediaclient",
  amazon:             "com.amazon.mShop.android.shopping",
  doordash:           "com.dd.doordash",
  uber:               "com.ubercab",
  lyft:               "com.lyft.android",
  "google photos":    "com.google.android.apps.photos",
  "play store":       "com.android.vending",
  phone:              "com.google.android.dialer",
  dialer:             "com.google.android.dialer",
  "samsung messages": "com.samsung.android.messaging",
  "samsung contacts": "com.samsung.android.contacts",
  "samsung camera":   "com.samsung.android.camera",
  "samsung clock":    "com.samsung.android.clock",
  "samsung gallery":  "com.samsung.android.gallery3d",
  "samsung dialer":   "com.samsung.android.dialer",
  discord:            "com.discord",
  facebook:           "com.facebook.katana",
  fb:                 "com.facebook.katana",
  pinterest:          "com.pinterest",
  linkedin:           "com.linkedin.android",
  twitch:             "tv.twitch.android.app",
  "prime video":      "com.amazon.avod.thirdpartyclient",
  "disney plus":      "com.disney.disneyplus",
  hulu:               "com.hulu.plus",
  paypal:             "com.paypal.android.p2pmobile",
  venmo:              "com.venmo",
  cashapp:            "com.squareup.cash",
  "cash app":         "com.squareup.cash",
  coinbase:           "com.coinbase.android",
  brave:              "com.brave.browser",
  firefox:            "org.mozilla.firefox",
};

function resolvePackage(appName) {
  if (!appName) return null;
  return APP_PACKAGES[appName.toLowerCase().trim()] || null;
}

// ── PLANNER SYSTEM PROMPT ─────────────────────────────────────
// Kept identical whether Ollama or Groq handles it — both see the
// same instructions. Ollama's local model is more literal and less
// creative, so the prompt is deliberately explicit and example-heavy.
const PLANNER_SYSTEM = `You are JARVIS, an AI assistant controlling an Android phone via Android Accessibility APIs.

Given a natural-language command, produce a JSON action plan to complete the task step by step.

Return ONLY a valid JSON object — no markdown, no explanation, no preamble, nothing before or after the JSON:
{
  "app": "YouTube",
  "package": "com.google.android.youtube",
  "summary": "Open YouTube and search for hi",
  "steps": [
    { "action": "open_app", "package": "com.google.android.youtube", "app_name": "YouTube", "wait_ms": 2500 },
    { "action": "wait", "ms": 1000 },
    { "action": "tap_element", "description": "Search magnifying glass icon at top of screen", "fallback_text": "Search" },
    { "action": "wait", "ms": 600 },
    { "action": "type_text", "text": "hi" },
    { "action": "wait", "ms": 400 },
    { "action": "tap_element", "description": "Search or Go button on keyboard", "fallback_text": "Search" }
  ]
}

CRITICAL RULES:
1. Return ONLY the JSON object. Nothing else. No "Here is the plan:" no markdown code blocks.
2. open_app MUST include both "package" and "app_name".
3. For YouTube, Instagram, TikTok, Netflix, Spotify — set wait_ms: 2500 (they are slow to open).
4. For all other apps — set wait_ms: 1800.
5. Always add a { "action": "wait", "ms": 1000 } step immediately after open_app.
6. Use tap_element before type_text to focus the search field.

PACKAGE NAMES — use EXACTLY these strings:
YouTube: com.google.android.youtube
Instagram: com.instagram.android
TikTok: com.zhiliaoapp.musically
Spotify: com.spotify.music
Chrome: com.android.chrome
Settings: com.android.settings
WhatsApp: com.whatsapp
Gmail: com.google.android.gm
Maps: com.google.android.apps.maps
Messages: com.google.android.apps.messaging
Twitter: com.twitter.android
Reddit: com.reddit.frontpage
Netflix: com.netflix.mediaclient
Snapchat: com.snapchat.android
Uber: com.ubercab
DoorDash: com.dd.doordash
Phone/Dialer: com.google.android.dialer
Contacts: com.android.contacts
Calculator: com.google.android.calculator
Clock: com.google.android.deskclock
Camera: com.android.camera2
Files: com.google.android.apps.nbu.files
Play Store: com.android.vending

COMMON PATTERNS — copy these exactly:
Open YouTube and search X:
  open_app(youtube, wait_ms:2500) → wait(1000) → tap_element("Search icon top","Search") → wait(600) → type_text(X) → wait(400) → tap_element("Search button keyboard","Search")

Open Instagram and search X:
  open_app(instagram, wait_ms:2500) → wait(1000) → tap_element("Search magnifying glass bottom nav","Search") → type_text(X) → wait(400)

Open any app (no further action):
  open_app(pkg, wait_ms:2500 or 1800) → wait(1000)

Go back:
  { "action": "back" }

Go home:
  { "action": "home" }

Scroll down:
  { "action": "scroll", "direction": "down", "amount": "medium" }`;

// ── OLLAMA PLANNER ────────────────────────────────────────────
// Calls local-llm.js's ollamaText() which hits 127.0.0.1:11434.
// Raises after OLLAMA_PLAN_TIMEOUT_MS if the model is too slow;
// caller falls through to Groq in that case.
const OLLAMA_PLAN_TIMEOUT_MS = parseInt(process.env.OLLAMA_PLAN_TIMEOUT_MS || "", 10) || 60000;

async function planWithOllama(userMsg) {
  const messages = [
    { role: "system", content: PLANNER_SYSTEM },
    { role: "user",   content: userMsg },
  ];

  // ollamaText uses the queue in local-llm.js so concurrent calls
  // don't race. We wrap in a timeout so a hung Ollama doesn't stall
  // the phone-control path indefinitely.
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Ollama plan timed out after ${OLLAMA_PLAN_TIMEOUT_MS}ms`)),
      OLLAMA_PLAN_TIMEOUT_MS)
  );

  const raw = await Promise.race([
    LocalLLM.ollamaText(messages, undefined, 0.05, 1024),
    timeoutPromise,
  ]);

  return raw;
}

// ── GROQ PLANNER (fallback) ───────────────────────────────────
async function planWithGroq(userMsg) {
  const messages = [
    { role: "system", content: PLANNER_SYSTEM },
    { role: "user",   content: userMsg },
  ];
  return await Groq.groqFetch(messages, Groq.MODELS.fast, 0.1, 1024);
}

// ── PARSE + PATCH PLAN ────────────────────────────────────────
function parsePlan(raw) {
  // Strip any markdown fences a model sneaks in despite instructions
  const cleaned = raw
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/g, "")
    .trim();

  // Some models prepend "Here is the plan:" or similar — find the
  // first { to start parsing from there.
  const jsonStart = cleaned.indexOf("{");
  if (jsonStart === -1) throw new Error("No JSON object found in model output");
  const jsonStr = cleaned.slice(jsonStart);

  let plan;
  try {
    plan = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Unparseable plan JSON: ${jsonStr.slice(0, 200)}`);
  }

  // Resolve missing package names
  if (plan.app && !plan.package) {
    plan.package = resolvePackage(plan.app) || plan.package;
  }
  for (const step of (plan.steps || [])) {
    if (step.action === "open_app") {
      if (step.app_name && !step.package) {
        step.package = resolvePackage(step.app_name) || step.package;
      }
      // Enforce minimum wait for heavy apps regardless of what model said
      const heavy = ["youtube", "instagram", "netflix", "tiktok", "spotify"];
      const isHeavy = heavy.some(h => (step.package || "").includes(h));
      if (isHeavy && (!step.wait_ms || step.wait_ms < 2500)) {
        step.wait_ms = 2500;
      } else if (!isHeavy && (!step.wait_ms || step.wait_ms < 1800)) {
        step.wait_ms = 1800;
      }
    }
  }

  return plan;
}

// ── MAIN PLAN FUNCTION ────────────────────────────────────────
async function planPhoneAction({ command, currentApp = null, screenContext = null }) {
  const userMsg = [
    `Command: "${command}"`,
    currentApp    ? `Current app open: ${currentApp}` : "No app currently open.",
    screenContext ? `Current screen state: ${screenContext}` : "",
  ].filter(Boolean).join("\n");

  // ── 1. Try local Ollama first ─────────────────────────────
  let raw;
  let usedModel = "ollama";
  try {
    console.log("[PHONE-CTRL] Asking local Ollama to plan:", command);
    raw = await planWithOllama(userMsg);
    console.log("[PHONE-CTRL] Ollama responded OK");
  } catch (ollamaErr) {
    // Ollama unreachable, timed out, or model not pulled
    console.warn(`[PHONE-CTRL] Ollama plan failed (${ollamaErr.message}) — falling back to Groq`);

    if (!Groq.isConfigured()) {
      throw new Error("Local Ollama is unavailable and no Groq key is set — cannot plan phone action.");
    }

    try {
      raw = await planWithGroq(userMsg);
      usedModel = "groq";
    } catch (groqErr) {
      throw new Error(`Both Ollama and Groq failed. Ollama: ${ollamaErr.message}. Groq: ${groqErr.message}`);
    }
  }

  // ── 2. Parse + patch ──────────────────────────────────────
  let plan;
  try {
    plan = parsePlan(raw);
  } catch (parseErr) {
    // If Ollama produced garbage JSON, try Groq before giving up
    if (usedModel === "ollama" && Groq.isConfigured()) {
      console.warn(`[PHONE-CTRL] Ollama plan unparseable — retrying with Groq: ${parseErr.message}`);
      try {
        const groqRaw = await planWithGroq(userMsg);
        plan = parsePlan(groqRaw);
        usedModel = "groq-fallback";
      } catch (groqParseErr) {
        throw new Error(`Plan parse failed on both models. Last error: ${groqParseErr.message}`);
      }
    } else {
      throw parseErr;
    }
  }

  console.log(`[PHONE-CTRL] Plan ready via ${usedModel} — ${plan.steps ? plan.steps.length : 0} steps for "${plan.summary || command}"`);
  logAction({ type: "plan", usedModel, command, plan });
  return plan;
}

// ── VERIFY A STEP ─────────────────────────────────────────────
// Verification is lightweight (small JSON output) — Ollama handles
// it fine; Groq stays as fallback.
const VERIFY_SYSTEM = `You are JARVIS verifying a phone automation step.
Return ONLY valid JSON: { "status": "ok" | "retry" | "abort", "reason": "one short sentence" }
- ok: expected state visible, continue
- retry: close but not quite — try again
- abort: completely wrong screen, stop`;

async function verifyStep({ expected, screenState }) {
  const messages = [
    { role: "system", content: VERIFY_SYSTEM },
    { role: "user",   content: `Expected: "${expected}"\nActual screen: "${screenState}"` },
  ];

  let raw;
  try {
    raw = await LocalLLM.ollamaText(messages, undefined, 0.05, 128);
  } catch {
    try {
      raw = await Groq.groqFetch(messages, Groq.MODELS.fast, 0.1, 128);
    } catch {
      return { status: "ok", reason: "Verification skipped — proceeding." };
    }
  }

  try {
    const cleaned = raw.replace(/```json?\n?/g, "").replace(/```/g, "").trim();
    const jsonStart = cleaned.indexOf("{");
    return JSON.parse(jsonStart > -1 ? cleaned.slice(jsonStart) : cleaned);
  } catch {
    return { status: "ok", reason: "Verification skipped — proceeding." };
  }
}

// ── CORRECTION ────────────────────────────────────────────────
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

  let raw;
  try {
    raw = await LocalLLM.ollamaText(messages, undefined, 0.05, 1024);
  } catch {
    raw = await Groq.groqFetch(messages, Groq.MODELS.fast, 0.1, 1024);
  }

  return parsePlan(raw);
}

// ── COMPLETION REPLY ──────────────────────────────────────────
async function buildCompletionReply({ command, success, errorStep, errorReason, userTitle = "Sir" }) {
  if (success) {
    return `Done, ${userTitle}. ${command} — completed successfully.`;
  }
  const messages = [
    {
      role: "system",
      content: `You are JARVIS. A phone task failed. Report it in 1-2 sentences, JARVIS-style — dry, composed. Address user as "${userTitle}".`,
    },
    {
      role: "user",
      content: `Task: "${command}"\nFailed at: ${errorStep || "unknown"}\nReason: ${errorReason || "unknown"}`,
    },
  ];
  try {
    let raw;
    try { raw = await LocalLLM.ollamaText(messages, undefined, 0.4, 120); }
    catch { raw = await Groq.groqFetch(messages, Groq.MODELS.fast, 0.5, 120); }
    return raw.trim();
  } catch {
    return `That didn't go through, ${userTitle}. Stopped at ${errorStep || "an unknown step"}.`;
  }
}

module.exports = { planPhoneAction, verifyStep, planCorrection, buildCompletionReply, resolvePackage };
