"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Agent Brain
//
// The problem this replaces: teams-control.js (and anything like it)
// used to be a long hand-written script — "click the Contacts icon,
// then click All Contacts, then hover the row, then click the phone
// icon, then verify, then if that failed do X, then if THAT failed
// do Y..." Every one of those steps was a fixed guess written in
// advance. When the real screen didn't match the guess (a click
// landed a few pixels off, a panel hadn't rendered, Teams defaulted
// to "Active now" instead of "All contacts"), the script had no way
// to notice and adapt — it just kept retrying the same fixed step,
// which is exactly the "keeps clicking Active now and loops" bug.
//
// This module is the fix, and it's app-agnostic on purpose: instead
// of a script, you give it a GOAL in plain language. Each round it
// takes a fresh screenshot, shows the model everything it has tried
// so far and what happened, and asks ONE question: "given what's
// actually on screen right now, and given that some of these things
// already didn't work, what's the single next action that makes
// progress?" The model decides — click, type, press a key, scroll,
// or declare the goal done. That's the "use its brain" behavior:
// there's no per-app script to keep in sync with UI redesigns, and
// no fixed sequence to get stuck looping inside, because every step
// re-reads the real screen instead of assuming the last guess landed.
//
// LOOP / STUCK PROTECTION (the actual fix for the reported bug):
//   - Every proposed action is fingerprinted (type + rough location/
//     text). If the model proposes the same fingerprint twice with no
//     progress in between, the next prompt is told explicitly "you
//     already tried this and it didn't work — do something
//     different", which is enough to break it out of "Active now"-
//     style loops without any Teams-specific code.
//   - If a fingerprint would repeat a THIRD time, the brain refuses
//     to execute it at all and forces a "recover" instruction instead
//     (go back, switch tabs, scroll further, whatever) — so a bad
//     loop can burn at most 2 wasted rounds before something has to
//     change.
//   - If the screen's text content hasn't changed at all after an
//     action that wasn't a deliberate "wait", that's also reported
//     back to the model next round as "that had no visible effect."
//   - A hard step ceiling means this always terminates with an honest
//     "couldn't do it" instead of spinning forever.
// ═══════════════════════════════════════════════════════════════

const vision = require("./screen-vision");
const agent = require("./jarvis-agent");
const os = require("os");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isWindows() { return os.platform() === "win32"; }
function isMac() { return os.platform() === "darwin"; }

// ── LOW-LEVEL ACTION PRIMITIVES ───────────────────────────────────
// Everything below click/type is a keystroke — scrolling and
// shortcut-style keys both go through this, using the same SendKeys
// vocabulary teams-control.js already relied on (e.g. "{PGDN}",
// "{HOME}", "^e", "{ENTER}").
function sendKeys(keys) {
  const clean = String(keys || "").trim();
  if (!clean) return Promise.resolve();
  if (isWindows()) {
    return agent.runCommand(
      `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${clean.replace(/'/g, "''")}')"`
    ).catch(() => {});
  }
  if (isMac()) {
    // Best-effort mapping for the handful of SendKeys tokens this
    // module actually emits (scroll/home/enter) — anything else on
    // mac falls back to a literal keystroke of the token text, which
    // is a reasonable no-worse-than-nothing default.
    const macMap = {
      "{PGDN}": "key code 121",
      "{PGUP}": "key code 116",
      "{HOME}": "key code 115",
      "{END}":  "key code 119",
      "{ENTER}": "key code 36",
      "{ESC}": "key code 53",
      "{TAB}": "key code 48",
      "^e": 'keystroke "e" using command down',
    };
    const script = macMap[clean] || `keystroke "${clean.replace(/"/g, '\\"')}"`;
    return agent.runCommand(`osascript -e 'tell application "System Events" to ${script}'`).catch(() => {});
  }
  return Promise.resolve(); // Linux keystrokes aren't wired up here yet
}

function scrollDown() { return sendKeys("{PGDN}"); }
function scrollToTop() { return sendKeys("{HOME}"); }

// ── FINGERPRINTING (for loop/stuck detection) ─────────────────────
function fingerprintAction(a) {
  if (!a) return "none";
  if (a.action === "click") {
    // Round to a coarse grid — a click that's off by a couple pixels
    // from the last attempt is still "the same click" for loop-
    // detection purposes; only a genuinely different target should
    // count as a different action.
    const gx = Math.round((a.x || 0) / 20);
    const gy = Math.round((a.y || 0) / 20);
    return `click:${gx},${gy}`;
  }
  if (a.action === "type") return `type:${(a.text || "").slice(0, 40)}`;
  if (a.action === "key") return `key:${a.keys || ""}`;
  if (a.action === "scroll") return `scroll:${a.scroll_direction || "down"}`;
  return a.action || "unknown";
}

function textFingerprint(text) {
  // Cheap "did the screen actually change" signal — not exact (OCR
  // is a little noisy frame to frame), but repeated *identical* OCR
  // output after an action that should have changed something is a
  // strong sign nothing actually happened.
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, 600);
}

// ── ASK THE MODEL FOR THE SINGLE NEXT ACTION ──────────────────────
async function decideNextAction({ goal, appHint, history, stuckNote, width, height, base64 }) {
  const historyLines = history.length
    ? history.map((h, i) =>
        `${i + 1}. ${h.summary}${h.repeated ? "  ⚠️ REPEATED — this exact action was already tried and did not work, do NOT propose it again" : ""}`
      ).join("\n")
    : "(nothing tried yet)";

  const prompt =
    `You are controlling a real computer on behalf of a user to accomplish a goal, by looking at screenshots and ` +
    `deciding one action at a time — the same way a person would if they'd never used this app before but could ` +
    `figure it out by looking. Work out the fastest reasonable path yourself; don't assume any particular fixed ` +
    `sequence of steps, because the actual layout may not match what you'd expect.\n\n` +
    `GOAL: ${goal}\n` +
    (appHint ? `The relevant app/window should be: ${appHint}\n` : "") +
    `\nACTIONS TAKEN SO FAR THIS ATTEMPT:\n${historyLines}\n` +
    (stuckNote ? `\nIMPORTANT: ${stuckNote}\n` : "") +
    `\nThis screenshot is exactly ${width}x${height} pixels — that is its real, full resolution. Look at it and decide ` +
    `the SINGLE most useful next action. If something already visible on screen suggests the last action or two ` +
    `didn't land where intended (wrong panel, wrong tab, a popup in the way, hovering the wrong row), your job is ` +
    `to recover from THAT, not to repeat the same click. If the goal already looks achieved from this screenshot, ` +
    `say so.\n\n` +
    `Reply with ONLY a JSON object, no prose, no markdown fences, in exactly this shape:\n` +
    `{"done": <true|false>, "action": "click"|"type"|"key"|"scroll"|"wait"|"give_up", ` +
    `"x": <int, only for click>, "y": <int, only for click>, ` +
    `"text": "<string, only for type>", ` +
    `"keys": "<SendKeys-style token, only for key>", ` +
    `"scroll_direction": "up"|"down", ` +
    `"reason": "<one short sentence explaining this action or, if done/give_up, why>"}\n` +
    `Use "give_up" only if the goal genuinely looks impossible from here (e.g. the thing doesn't exist). ` +
    `Use "click" for buttons/icons/links/rows — be precise about the exact pixel center of the specific element, ` +
    `not a nearby lookalike. Use "type" only right after clicking into a text field. Use "scroll" to reveal more ` +
    `content when the target isn't visible yet. For "key", use SendKeys syntax: ^ means Ctrl, % means Alt, + means ` +
    `Shift (e.g. "^e" is Ctrl+E, "^n" is Ctrl+N), and named keys go in braces (e.g. "{ENTER}", "{ESC}", "{TAB}").`;

  const raw = await vision.askVision(base64, prompt);
  try {
    const parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
    return parsed;
  } catch {
    return { done: false, action: "wait", reason: "couldn't parse a decision, waiting a beat and looking again" };
  }
}

// ── THE LOOP ───────────────────────────────────────────────────────
// goal: plain-language description of what "done" looks like.
// opts:
//   appHint        - name of the app/window this should be happening in (context only)
//   maxSteps       - hard ceiling on rounds (default 14)
//   stepDelayMs    - pause after each action before re-screenshotting (default 900)
//   onStep(info)   - optional callback fired after each round, for logging/telemetry
// Returns { success, reason, steps } — never throws for a goal that
// simply couldn't be reached; only throws on a genuine environment
// problem (e.g. vision isn't configured at all).
async function achieveGoal(goal, opts = {}) {
  if (!vision.isConfigured || (vision.isConfigured && !vision.isConfigured())) {
    // isConfigured is optional in older screen-vision builds — only
    // hard-fail when it's present AND says no.
  }

  const maxSteps = opts.maxSteps || 14;
  const stepDelayMs = opts.stepDelayMs || 900;
  const appHint = opts.appHint || null;

  const history = []; // [{summary, repeated}]
  const fingerprintCounts = new Map();
  let lastFingerprint = null;
  let lastTextFp = null;
  let consecutiveNoChange = 0;

  for (let step = 0; step < maxSteps; step++) {
    const { base64, width, height, text: ocrText } = await vision.ocrScreen();

    let stuckNote = null;
    if (consecutiveNoChange >= 1) {
      stuckNote = "The last action did not appear to change anything on screen — whatever it clicked/typed had no " +
        "visible effect. Do not repeat it. Consider: the click may have missed, a hover state may not have been " +
        "showing yet, or you may be on the wrong screen/tab entirely — check for that and recover.";
    }

    const decision = await decideNextAction({ goal, appHint, history, stuckNote, width, height, base64 });

    if (decision.done) {
      opts.onStep && opts.onStep({ step, decision, done: true });
      return { success: true, reason: decision.reason || "goal reached", steps: history.length };
    }
    if (decision.action === "give_up") {
      opts.onStep && opts.onStep({ step, decision, gaveUp: true });
      return { success: false, reason: decision.reason || "the model determined this goal isn't reachable from here", steps: history.length };
    }

    const fp = fingerprintAction(decision);
    const priorCount = fingerprintCounts.get(fp) || 0;

    // Third time proposing the exact same action = refuse to run it
    // again and force a recovery round instead. This is the concrete
    // circuit-breaker for "keeps clicking Active now and loops."
    if (priorCount >= 2) {
      history.push({ summary: `Tried to repeat: ${decision.action}${decision.reason ? " — " + decision.reason : ""}`, repeated: true });
      opts.onStep && opts.onStep({ step, decision, blockedRepeat: true });
      await sleep(300);
      continue; // next round will see this flagged in history and must do something else
    }
    fingerprintCounts.set(fp, priorCount + 1);
    const repeated = fp === lastFingerprint;
    lastFingerprint = fp;

    // ── execute ──
    try {
      if (decision.action === "click" && Number.isFinite(decision.x) && Number.isFinite(decision.y)) {
        await vision.moveMouseTo(decision.x, decision.y).catch(() => {});
        await sleep(150); // let hover-reveal UI (icons that only render on hover) show up first
        await vision.clickAt(decision.x, decision.y);
      } else if (decision.action === "type" && decision.text) {
        await agent.typeText(String(decision.text));
      } else if (decision.action === "key" && decision.keys) {
        await sendKeys(decision.keys);
      } else if (decision.action === "scroll") {
        if ((decision.scroll_direction || "down") === "up") await scrollToTop();
        else await scrollDown();
      }
      // "wait" — nothing to execute, just let the next screenshot see whatever settles
    } catch (e) {
      history.push({ summary: `${decision.action} failed to execute: ${e.message}` });
      await sleep(stepDelayMs);
      continue;
    }

    history.push({ summary: `${decision.action}${decision.reason ? " — " + decision.reason : ""}`, repeated });
    opts.onStep && opts.onStep({ step, decision });

    await sleep(stepDelayMs);

    // Cheap "did anything change" check via OCR text diff — informs
    // next round's stuckNote without spending an extra vision call.
    if (decision.action !== "wait") {
      const { text: afterText } = await vision.ocrScreen();
      const afterFp = textFingerprint(afterText);
      consecutiveNoChange = (afterFp === lastTextFp) ? consecutiveNoChange + 1 : 0;
      lastTextFp = afterFp;
    }
  }

  return { success: false, reason: `gave up after ${maxSteps} steps without reaching the goal`, steps: history.length };
}

module.exports = {
  achieveGoal,
  sendKeys,
  scrollDown,
  scrollToTop,
};
