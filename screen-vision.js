"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Screen Vision v2.0 (OCR-first)
//
// Two jobs:
//   1. "Look at my screen" — capture a screenshot and answer
//      questions about it.
//   2. Vision-guided UI control — the primitive teams-control.js
//      is built on. Instead of relying on Teams keyboard shortcuts
//      (which the docs themselves admit drift between Teams
//      versions), Jarvis finds roughly WHERE a button/element is
//      on screen and clicks that point directly.
//
// v2.0 CHANGE — OCR FIRST, VISION MODEL AS FALLBACK ONLY:
// v1 sent the full screenshot to a Groq vision model on every call,
// which burns ~1500-2000 tokens per screenshot against an 8000 TPM
// budget shared with the rest of the app. Most "look at my screen"
// and "find this button" requests are really just "what does the
// text on screen say" and "where is the thing labeled X" — both of
// which a local OCR pass (tesseract.js, runs on-device, costs zero
// API tokens) answers directly, no Groq call at all in the common
// case:
//
//   - lookAtScreen(): OCR's the screen first. If OCR finds real
//     text, the question is answered from that plain-text extract
//     (a few hundred tokens through a cheap TEXT model — no image
//     tokens). Only falls through to the vision model when OCR
//     comes back empty (a mostly-graphical screen, paused video,
//     photo — genuinely nothing for OCR to read).
//
//   - locateElement(): tries to match the target description
//     against OCR'd on-screen text first (free, instant, exact
//     pixel coords from the OCR bounding box). Only falls through
//     to the vision model for icon-only targets with no visible
//     label (a bare toggle switch, an unlabeled icon) — OCR
//     fundamentally can't see those, so that fallback stays.
//
// REQUIRES: the "tesseract.js" npm package (added to package.json —
// run `npm install` to pull it in) for OCR, which does the vast
// majority of the work now with zero Groq usage.
//
// REQUIRES: GROQ_API_KEY (already used elsewhere in this repo) for
// the two fallback paths above. Vision fallback uses a vision-capable
// model (currently qwen/qwen3.6-27b — Groq retired the old
// meta-llama/llama-4-scout-17b-16e-instruct default on 2026-06-17).
// Set GROQ_VISION_MODEL in .env to override. Text-only OCR answers
// use a cheap fast model (GROQ_TEXT_MODEL, defaults to the same
// fast model the rest of the app uses).
//
// REQUIRES the "screenshot-desktop" npm package — cross-platform
// screen capture with no native build step.
//
// Windows-only for the click/mouse-move primitives (matches the
// rest of this repo's local-agent code, which is already
// Windows-heavy via PowerShell). macOS gets a best-effort
// osascript fallback. Linux is not wired up for clicking — screen
// READING still works everywhere screenshot-desktop supports.
// ═══════════════════════════════════════════════════════════════

const { exec } = require("child_process");
const os = require("os");
const screenshot = require("screenshot-desktop");

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
// Cheap text-only model for answering questions from OCR'd text —
// same default "fast" model the rest of the app (hermes-engine.js)
// uses for lightweight calls, so it shares that model's TPM bucket
// rather than opening up a third one.
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

// OCR words below this confidence (tesseract's 0-100 scale) are
// dropped — low-confidence hits are usually icon fragments or noise
// misread as letters, and matching against them just produces false
// element-location hits.
const OCR_MIN_CONFIDENCE = 40;

function isConfigured() {
  return !!GROQ_API_KEY;
}

// ── CAPTURE ─────────────────────────────────────────────────────
// Returns { base64, width, height }. width/height come from the OS
// display query so click coordinates can be mapped back correctly
// even if a model describes positions relative to a resized image.
async function captureScreenshot() {
  const buf = await screenshot({ format: "png" });
  const { width, height } = await getPrimaryDisplaySize();
  return { base64: buf.toString("base64"), width, height };
}

function getPrimaryDisplaySize() {
  return new Promise((resolve) => {
    if (os.platform() === "win32") {
      exec(
        `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output \\"$($s.Width)x$($s.Height)\\""`,
        { windowsHide: true },
        (err, stdout) => {
          const m = /(\d+)x(\d+)/.exec(stdout || "");
          resolve(m ? { width: +m[1], height: +m[2] } : { width: null, height: null });
        }
      );
    } else if (os.platform() === "darwin") {
      exec(`system_profiler SPDisplaysDataType | grep Resolution`, (err, stdout) => {
        const m = /(\d+)\s*x\s*(\d+)/.exec(stdout || "");
        resolve(m ? { width: +m[1], height: +m[2] } : { width: null, height: null });
      });
    } else {
      exec(`xdpyinfo | grep dimensions`, (err, stdout) => {
        const m = /(\d+)x(\d+)/.exec(stdout || "");
        resolve(m ? { width: +m[1], height: +m[2] } : { width: null, height: null });
      });
    }
  });
}

// ── LOCAL OCR ───────────────────────────────────────────────────
// Lazily-created singleton worker — spinning one up loads tesseract's
// language data, which takes a moment, so we pay that cost once per
// process instead of on every screen read.
let ocrWorkerPromise = null;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = (async () => {
      const { createWorker } = require("tesseract.js");
      return createWorker("eng");
    })().catch((e) => { ocrWorkerPromise = null; throw e; });
  }
  return ocrWorkerPromise;
}

// Captures the screen and OCRs it locally — no Groq call, no tokens
// spent. Returns the extracted text, per-word bounding-box centers
// (for element location), and the raw screenshot (kept around only
// as a fallback for the vision-model paths below).
async function ocrScreen() {
  const { base64, width, height } = await captureScreenshot();
  let text = "";
  let words = [];
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(Buffer.from(base64, "base64"));
    text = (data?.text || "").trim();
    words = (data?.words || [])
      .filter(w => w.text && w.text.trim() && (w.confidence ?? 100) >= OCR_MIN_CONFIDENCE)
      .map(w => ({
        text: w.text.trim(),
        x: Math.round((w.bbox.x0 + w.bbox.x1) / 2),
        y: Math.round((w.bbox.y0 + w.bbox.y1) / 2),
      }));
  } catch (e) {
    // OCR failing (e.g. tesseract.js not installed yet — run `npm
    // install`) shouldn't break screen reading entirely; just fall
    // through with empty text so callers use the vision-model path.
    console.error("[VISION] Local OCR failed, falling back to vision model:", e.message);
  }
  return { text, words, base64, width, height };
}

// ── SHARED GROQ REQUEST (retried on 429) ────────────────────────
async function groqChatRequest(model, messages) {
  if (!isConfigured()) throw new Error("GROQ_API_KEY isn't set in .env, so Jarvis can't look at the screen yet.");

  const doFetch = () => fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, messages }),
    signal: AbortSignal.timeout(30000),
  });

  let res;
  try {
    res = await doFetch();
  } catch (e) {
    throw new Error(`Could not reach Groq API: ${e.message}`);
  }

  // Retry on 429 using Groq's own stated wait time (from the error
  // message, e.g. "Please try again in 29.145s") instead of giving up
  // on the first hit — capped at 45s, up to 2 attempts.
  let attempt = 0;
  while (res.status === 429 && attempt < 2) {
    attempt++;
    const errBody = await res.json().catch(() => ({}));
    const msg = errBody.error?.message || "";
    const waitMatch = msg.match(/try again in ([\d.]+)s/i);
    const waitSecs = waitMatch ? Math.min(parseFloat(waitMatch[1]), 45) : 5 * attempt;
    await new Promise(r => setTimeout(r, Math.ceil(waitSecs * 1000) + 250));
    try {
      res = await doFetch();
    } catch (e) {
      throw new Error(`Could not reach Groq API: ${e.message}`);
    }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq vision request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

// Text-only Groq call — used to answer questions from OCR'd text.
// Costs a few hundred tokens instead of the ~1500-2000 a full
// screenshot image costs through the vision model.
async function askText(prompt) {
  const messages = [{ role: "user", content: prompt }];
  return groqChatRequest(GROQ_TEXT_MODEL, messages);
}

// Vision-model call — kept as the fallback for screens/elements OCR
// genuinely can't handle (graphical content, unlabeled icons).
async function askVision(base64Image, prompt) {
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
      ],
    },
  ];
  return groqChatRequest(GROQ_VISION_MODEL, messages);
}

// ── "LOOK AT MY SCREEN" ─────────────────────────────────────────
// General-purpose: describe the screen, or answer a specific
// question about it ("what does that error say", "is the build
// still running", "what's the latest message in this chat").
async function lookAtScreen(question) {
  const q = question && question.trim()
    ? question.trim()
    : "Describe what's currently on screen in a few sentences, focused on anything that looks important or actionable.";

  const { text, base64 } = await ocrScreen();

  // OCR found readable text — answer from that, no image tokens spent.
  if (text && text.length > 20) {
    const answer = await askText(
      `You're an AI assistant that was given the raw text extracted (via OCR) from a screenshot of the user's screen — not the image itself. It may contain OCR noise or garbled fragments; use judgement and ignore obvious junk. Answer the question concisely and naturally, like you glanced over and are reporting back. If the extracted text genuinely doesn't contain enough to answer, say so plainly rather than guessing.\n\nQuestion: ${q}\n\nExtracted screen text:\n${text.slice(0, 4000)}`
    );
    return answer.trim();
  }

  // Nothing useful for OCR to read (graphical content, video, photo,
  // etc.) — this is the case that genuinely needs the vision model.
  const answer = await askVision(base64, `You're an AI assistant looking at the user's screen through a screenshot. Answer concisely and naturally, like you're glancing over and reporting back. Question: ${q}`);
  return answer.trim();
}

// ── LOCATE AN ELEMENT (for vision-guided clicking) ───────────────
function normalizeForMatch(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Pulls out the parts of a description most likely to be literal
// on-screen text — quoted phrases first (e.g. the "Join now" in
// `the "Join now" button`), falling back to the whole description.
function candidatePhrases(description) {
  const quoted = [...(description || "").matchAll(/["'“”]([^"'“”]+)["'“”]/g)].map(m => m[1]);
  return (quoted.length ? quoted : [description]).map(normalizeForMatch).filter(Boolean);
}

// Tries to find a run of consecutive OCR words matching a candidate
// phrase. Free and instant when it hits — no Groq call at all.
function locateFromOcrWords(description, words) {
  if (!words || !words.length) return null;
  for (const phrase of candidatePhrases(description)) {
    const phraseWords = phrase.split(" ").filter(Boolean);
    if (!phraseWords.length) continue;
    for (let i = 0; i < words.length; i++) {
      const matched = [];
      let wi = i;
      for (const pw of phraseWords) {
        if (wi >= words.length) break;
        const norm = normalizeForMatch(words[wi].text);
        if (norm === pw || (pw.length > 2 && norm.includes(pw))) {
          matched.push(words[wi]);
          wi++;
        } else {
          break;
        }
      }
      if (matched.length === phraseWords.length) {
        const x = Math.round(matched.reduce((s, w) => s + w.x, 0) / matched.length);
        const y = Math.round(matched.reduce((s, w) => s + w.y, 0) / matched.length);
        return { found: true, x, y, source: "ocr" };
      }
    }
  }
  return null;
}

// Asks the model to return the pixel center of a described UI
// element, as JSON. Coordinates are relative to the screenshot
// pixel grid, which getPrimaryDisplaySize() maps 1:1 to real screen
// pixels — that mapping breaks if Windows display scaling (e.g.
// 125%/150%) differs from what PrimaryScreen.Bounds reports, which
// is rare but worth knowing if clicks land slightly off.
// forceVision: true skips the OCR fast-path entirely. Use this for
// any description that depends on LAYOUT/SECTION context (e.g. "the
// entry under the People heading, not the one under Group Chats") or
// that names something the model should specifically AVOID clicking
// (e.g. "don't click Open"). The OCR path below only does dumb
// literal substring matching on quoted phrases — it has no concept
// of on-screen sections or negation, so it can silently click the
// wrong occurrence of a repeated phrase, or click the exact thing
// the prompt said not to. Only the vision model actually reads the
// prompt's reasoning.
async function locateElement(description, opts = {}) {
  const { base64, width, height, words } = await ocrScreen();

  // Try the free, local OCR match first — covers anything with a
  // visible text label (buttons, menu items, tabs, window titles) —
  // but only when the caller hasn't asked for vision-only reasoning.
  const ocrHit = opts.forceVision ? null : locateFromOcrWords(description, words);
  if (ocrHit) return ocrHit;

  // No literal on-screen text matched this description — it's
  // probably an icon-only target (a bare toggle, an unlabeled icon)
  // that OCR fundamentally can't see. This is the one case that
  // still genuinely needs the vision model.
  const prompt =
    `This screenshot is ${width}x${height} pixels. Find this UI element: "${description}". ` +
    `Reply with ONLY a JSON object, no prose, no markdown fences, in the exact shape ` +
    `{"found": true, "x": <int>, "y": <int>} with x/y being the pixel center of the element ` +
    `in this exact ${width}x${height} image. If you cannot find it, reply {"found": false}.`;

  const raw = await askVision(base64, prompt);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    parsed = { found: false };
  }
  return parsed;
}

// ── MOUSE CONTROL ────────────────────────────────────────────────
function clickAt(x, y) {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class MouseSim {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
}';
[MouseSim]::SetCursorPos(${Math.round(x)}, ${Math.round(y)});
Start-Sleep -Milliseconds 80;
[MouseSim]::mouse_event(0x0002, 0, 0, 0, 0);
[MouseSim]::mouse_event(0x0004, 0, 0, 0, 0);
`.replace(/\r?\n/g, " ");
    return runPS(ps);
  }
  if (platform === "darwin") {
    return runCmd(`osascript -e 'tell application "System Events" to click at {${Math.round(x)}, ${Math.round(y)}}'`);
  }
  return Promise.reject(new Error("Vision-guided clicking isn't wired up for Linux yet — only screen reading works there."));
}

function runPS(script) {
  return new Promise((resolve, reject) => {
    exec(`powershell -NoProfile -Command "${script.replace(/"/g, '\\"')}"`, { windowsHide: true, timeout: 10000 }, (err) => (err ? reject(err) : resolve()));
  });
}
function runCmd(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 10000 }, (err) => (err ? reject(err) : resolve()));
  });
}

// Convenience: find something on screen and click it in one call.
// Returns true if it found + clicked, false if it couldn't find it
// (caller should fall back to telling the user rather than silently
// failing).
async function findAndClick(description, opts = {}) {
  const loc = await locateElement(description, opts);
  if (!loc || !loc.found) return false;
  await clickAt(loc.x, loc.y);
  return true;
}

module.exports = {
  isConfigured,
  captureScreenshot,
  ocrScreen,
  lookAtScreen,
  locateElement,
  clickAt,
  findAndClick,
  GROQ_VISION_MODEL,
  GROQ_TEXT_MODEL,
};
