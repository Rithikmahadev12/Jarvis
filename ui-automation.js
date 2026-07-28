"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — UI Automation (deterministic, zero-AI clicking)
//
// screen-vision.js's findAndClick() has two tiers: free local OCR
// text-match, then a Gemini/Groq vision-model guess for anything OCR
// can't read. The vision tier is the one that's unreliable — it's
// pixel-guessing a click point from a screenshot, and it gets worse
// the further the real window layout drifts from what the model was
// trained on (see the long comment in teams-control.js's
// ensureTeamsMaximized about exactly this failure mode).
//
// This module adds a THIRD tier, tried before either of the above:
// ask Windows itself where the control is. Every native Win32 app
// (Teams desktop included) exposes a UI Automation tree — the same
// structured data screen readers use — with real control names,
// roles, and click points. No screenshot, no OCR, no AI call, no
// guessing: "find the button named Mic" returns the actual button.
//
// Built on node-winautomation (MIT, free) — NOT the nut.js element-
// inspector, which requires a $75/mo "Solo" subscription as of this
// writing. node-winautomation is a native addon binding straight
// onto Microsoft's own UI Automation COM API, so it needs Visual
// Studio Build Tools + Python present the first time `npm install`
// compiles it (see README's Requirements table) — same category of
// one-time setup as this repo's other native deps, just a heavier
// one. Listed as an optionalDependency in package.json specifically
// so a failed/skipped build on a dev machine that lacks those tools
// doesn't break `npm install` for everyone else — this whole module
// just reports isAvailable():false and every caller falls straight
// through to the existing OCR/vision path, unchanged.
//
// SCOPE, ON PURPOSE: this only handles the case screen-vision.js's
// callers already hand it today — a short natural-language
// description that happens to contain the control's visible name in
// quotes (teams-control.js is full of these: `the "Mic" button...`,
// `the "Join now" button...`). No quoted name in the description
// means there's nothing concrete to search UI Automation for, so
// this tier is skipped entirely and control passes straight to OCR/
// vision, exactly like before this module existed. That keeps this
// additive-only — zero call sites elsewhere needed to change.
// ═══════════════════════════════════════════════════════════════

const os = require("os");

let ActivityLog = null;
try { ActivityLog = require("./activity-log"); } catch { ActivityLog = null; }

let UIAutomation = null;
let loadError = null;
try {
  ({ UIAutomation } = require("node-winautomation"));
} catch (e) {
  loadError = e;
}

function isWindows() { return os.platform() === "win32"; }

// True only when we're on Windows AND the native addon actually
// loaded (it needs to have been compiled at install time — see the
// header comment above). Cheap to call repeatedly; doesn't re-probe.
function isAvailable() {
  return isWindows() && !!UIAutomation;
}

if (!isWindows()) {
  console.log("[ui-automation] Not on Windows — this tier is skipped; screen-vision.js falls back to OCR/vision as before.");
} else if (!UIAutomation) {
  console.log(`[ui-automation] node-winautomation didn't load (${loadError ? loadError.message : "unknown reason"}) — ` +
    `likely not built yet (needs Visual Studio Build Tools + Python, then \`npm install\`). ` +
    `Skipping this tier; screen-vision.js falls back to OCR/vision as before.`);
}

// Lazy singleton — constructing Automation() spins up a COM object,
// no reason to pay that cost until something actually needs it.
let automationInstance = null;
function getAutomation() {
  if (!automationInstance) automationInstance = new UIAutomation.Automation();
  return automationInstance;
}

// A call into the native addon can, in principle, hang (a COM call
// against a hung/unresponsive app). Never let that stall the rest of
// the assistant — race every native call against a short timeout and
// treat a timeout as "didn't find it," same as any other miss.
function withTimeout(promiseFactory, ms = 3000) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    Promise.resolve()
      .then(promiseFactory)
      .then((v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } })
      .catch(() => { if (!done) { done = true; clearTimeout(timer); resolve(null); } });
  });
}

// Pulls every "quoted phrase" out of a findAndClick() description —
// e.g. `the "Mic" button itself (not its dropdown arrow)` -> ["Mic"].
// These are the only candidates worth searching UI Automation for;
// anything else in the description is prose written for a vision
// model, not a literal control name.
function extractQuotedNames(description) {
  const out = [];
  const re = /"([^"]+)"/g;
  let m;
  while ((m = re.exec(String(description || "")))) {
    const name = m[1].trim();
    if (name) out.push(name);
  }
  return out;
}

// Finds the top-level window whose title contains titleSubstring
// (case-insensitive) — findAll+filter rather than an exact property
// condition, since window titles routinely carry extra suffixes
// ("Chat | Microsoft Teams", document names, unread counts, etc.)
// that would make an exact-equality condition miss constantly.
function findWindowByTitle(automation, titleSubstring) {
  const root = automation.getRootElement();
  const needle = String(titleSubstring || "").toLowerCase();
  if (!needle) return null;
  const windows = root.findAll(
    UIAutomation.TreeScopes.Children,
    automation.createPropertyCondition(UIAutomation.PropertyIds.ControlTypePropertyId, UIAutomation.ControlTypeIds.WindowControlTypeId)
  ) || [];
  return windows.find(w => String(w.currentName || "").toLowerCase().includes(needle)) || null;
}

// Searches for a descendant whose name contains nameSubstring,
// preferring interactive control types (button/checkbox/tab/menu
// item) over plain text/labels so we don't end up "clicking" a
// caption instead of the control it labels. Tries typed searches
// first (cheap — COM filters natively before returning to JS) and
// only falls back to an unrestricted Descendants walk, which is
// slower on a deep tree, if nothing typed matches.
const PREFERRED_CONTROL_TYPES = [
  "ButtonControlTypeId",
  "CheckBoxControlTypeId",
  "TabItemControlTypeId",
  "MenuItemControlTypeId",
  "ListItemControlTypeId",
  "EditControlTypeId",
];

function findElementByName(automation, scopeElement, nameSubstring) {
  const needle = String(nameSubstring || "").toLowerCase();
  if (!needle || !scopeElement) return null;

  for (const typeKey of PREFERRED_CONTROL_TYPES) {
    const typeId = UIAutomation.ControlTypeIds[typeKey];
    if (typeId === undefined) continue;
    try {
      const matches = scopeElement.findAll(
        UIAutomation.TreeScopes.Descendants,
        automation.createPropertyCondition(UIAutomation.PropertyIds.ControlTypePropertyId, typeId)
      ) || [];
      const hit = matches.find(el => String(el.currentName || "").toLowerCase().includes(needle));
      if (hit) return hit;
    } catch { /* this control type may not exist in this app's tree — try the next */ }
  }

  // Last resort: unrestricted walk, name match only. Slower, but only
  // reached when nothing in the common interactive types matched.
  try {
    const all = scopeElement.findAll(UIAutomation.TreeScopes.Descendants, automation.createTrueCondition()) || [];
    return all.find(el => String(el.currentName || "").toLowerCase().includes(needle)) || null;
  } catch {
    return null;
  }
}

// Clicks an element: prefer the Invoke pattern (buttons, menu items —
// this is a "real" programmatic click, no mouse movement needed),
// then Toggle (checkboxes/toggle buttons), then fall back to a
// genuine physical click at the element's clickable point using the
// same win32 mouse primitive screen-vision.js already has.
async function clickElement(el) {
  if (!el) return false;

  try {
    const invoke = el.getCurrentPattern(UIAutomation.PatternIds.InvokePatternId);
    if (invoke) { invoke.invoke(); return true; }
  } catch { /* pattern not supported on this element — try the next */ }

  try {
    const toggle = el.getCurrentPattern(UIAutomation.PatternIds.TogglePatternId);
    if (toggle) { toggle.toggle(); return true; }
  } catch { /* not supported either — fall back to a physical click */ }

  try {
    let point = null;
    try { point = el.getClickablePoint(); } catch { point = null; }
    if (!point && el.currentBoundingRectangle) {
      const r = el.currentBoundingRectangle;
      point = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
    if (point && Number.isFinite(point.x) && Number.isFinite(point.y)) {
      // Lazily required to avoid a require cycle at module load —
      // screen-vision.js requires this module, so this module
      // requires screen-vision.js's clickAt only when actually needed.
      const vision = require("./screen-vision");
      await vision.clickAt(point.x, point.y);
      return true;
    }
  } catch { /* fall through to false below */ }

  return false;
}

// Public entry point: given the same free-text description
// screen-vision.js's findAndClick() already receives, try to resolve
// and click it via UI Automation. Returns true only on a real click;
// false for anything else (no quoted name to search for, element not
// found, native module unavailable, timeout, any error) — callers
// should treat false as "fall through to the next tier," never as
// an error to surface to the user.
async function findAndClick(description, opts = {}) {
  if (!isAvailable()) return false;

  const names = extractQuotedNames(description);
  if (!names.length) return false; // nothing literal to search for — let OCR/vision handle it

  return withTimeout(async () => {
    const automation = getAutomation();

    // Scope to the current foreground window by default (matches
    // what a vision-model screenshot would also be looking at) unless
    // the caller knows better and passes one explicitly.
    const windowTitleHint = opts.windowTitleContains
      || (ActivityLog ? await ActivityLog.getForegroundWindowTitle() : "");
    if (!windowTitleHint) return false;

    const windowEl = findWindowByTitle(automation, windowTitleHint) || automation.getRootElement();

    for (const name of names) {
      const el = findElementByName(automation, windowEl, name);
      if (el) {
        const clicked = await clickElement(el);
        if (clicked) return true;
      }
    }
    return false;
  }, opts.uiaTimeoutMs || 3000);
}

module.exports = {
  isAvailable,
  findAndClick,
  extractQuotedNames, // exported for testing
};
