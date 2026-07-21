"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Screen Vision v1.0
//
// Two jobs:
//   1. "Look at my screen" — capture a screenshot, ask a vision-
//      capable model to describe/answer questions about it.
//   2. Vision-guided UI control — the primitive teams-control.js
//      is built on. Instead of relying on Teams keyboard shortcuts
//      (which the docs themselves admit drift between Teams
//      versions — classic vs "new Teams", desktop vs web), Jarvis
//      takes a screenshot, asks the vision model roughly WHERE a
//      button/element is on screen, and clicks that point directly.
//      Slower than a hotkey, but it doesn't silently do nothing
//      when Microsoft renames a shortcut.
//
// REQUIRES: GROQ_API_KEY (already used elsewhere in this repo) +
// a vision-capable Groq model (currently qwen/qwen3.6-27b — Groq
// retired the old meta-llama/llama-4-scout-17b-16e-instruct default
// on 2026-06-17). Set GROQ_VISION_MODEL in .env if the default below
// has since been retired too — check https://console.groq.com/docs/models
// for the current vision-capable model list.
//
// REQUIRES the "screenshot-desktop" npm package (added to
// package.json) — cross-platform screen capture with no native
// build step.
//
// Windows-only for the click/mouse-move primitives (matches the
// rest of this repo's local-agent code, which is already
// Windows-heavy via PowerShell). macOS gets a best-effort
// osascript fallback. Linux is not wired up for clicking (no
// reliable dependency-free primitive) — screen READING still
// works everywhere screenshot-desktop supports.
// ═══════════════════════════════════════════════════════════════

const { exec } = require("child_process");
const os = require("os");
const screenshot = require("screenshot-desktop");

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
// NOTE: meta-llama/llama-4-scout-17b-16e-instruct (the old default
// here) was deprecated by Groq on 2026-06-17. Their recommended
// replacement for vision/multimodal use is qwen/qwen3.6-27b
// (openai/gpt-oss-120b is text-only, so it won't work for this file's
// screenshot-reading use case). If qwen/qwen3.6-27b is itself
// deprecated by the time you're reading this, set GROQ_VISION_MODEL
// in .env to override — check https://console.groq.com/docs/models
// for the current vision-capable model list.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";

function isConfigured() {
  return !!GROQ_API_KEY;
}

// ── CAPTURE ─────────────────────────────────────────────────────
// Returns { base64, width, height }. width/height come from the OS
// display query so click coordinates can be mapped back correctly
// even if the model describes positions relative to a resized image.
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

// ── ASK THE VISION MODEL ───────────────────────────────────────
async function askVision(base64Image, prompt) {
  if (!isConfigured()) throw new Error("GROQ_API_KEY isn't set in .env, so Jarvis can't look at the screen yet.");

  const res = await fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GROQ_API_KEY}` },
    body: JSON.stringify({
      model: GROQ_VISION_MODEL,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: `data:image/png;base64,${base64Image}` } },
          ],
        },
      ],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq vision request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

// ── "LOOK AT MY SCREEN" ─────────────────────────────────────────
// General-purpose: describe the screen, or answer a specific
// question about it ("what does that error say", "is the build
// still running", "what's the latest message in this chat").
async function lookAtScreen(question) {
  const { base64 } = await captureScreenshot();
  const q = question && question.trim()
    ? question.trim()
    : "Describe what's currently on screen in a few sentences, focused on anything that looks important or actionable.";
  const answer = await askVision(base64, `You're an AI assistant looking at the user's screen through a screenshot. Answer concisely and naturally, like you're glancing over and reporting back. Question: ${q}`);
  return answer.trim();
}

// ── LOCATE AN ELEMENT (for vision-guided clicking) ───────────────
// Asks the model to return the pixel center of a described UI
// element, as JSON. Coordinates are relative to the screenshot
// pixel grid, which getPrimaryDisplaySize() maps 1:1 to real
// screen pixels — that mapping breaks if Windows display scaling
// (e.g. 125%/150%) differs from what PrimaryScreen.Bounds reports,
// which is rare but worth knowing if clicks land slightly off.
async function locateElement(description) {
  const { base64, width, height } = await captureScreenshot();
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
async function findAndClick(description) {
  const loc = await locateElement(description);
  if (!loc || !loc.found) return false;
  await clickAt(loc.x, loc.y);
  return true;
}

module.exports = {
  isConfigured,
  captureScreenshot,
  lookAtScreen,
  locateElement,
  clickAt,
  findAndClick,
  GROQ_VISION_MODEL,
};
