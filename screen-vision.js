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
const fs = require("fs");
const path = require("path");
const screenshot = require("screenshot-desktop");
const GroqKeys = require("./groq-keys");

// ── ELEMENT-LOCATION CACHE ─────────────────────────────────────
// The single biggest source of vision-model calls (and the thing
// actually burning through Gemini's/Groq's free-tier quota) isn't
// "look at my screen" — it's locateElement() being asked to find the
// SAME static piece of UI chrome over and over: the Contacts icon in
// Teams' left rail, the "All contacts" tab, the in-call Mic/Camera
// buttons, the lobby's "Join now" button, etc. Those sit in the
// exact same pixel position every time Teams is maximized at the
// same screen resolution — there's no reason to pay a vision-model
// round trip to re-discover them each time.
//
// This cache stores {x, y, ts} per (screen resolution + description)
// the first time the vision model successfully locates something,
// and locateElement() checks it BEFORE calling the model again. A
// TTL (default 12h, override with VISION_CACHE_TTL_MS) guards against
// a stale entry surviving a Teams UI update forever; forgetElement()
// lets a caller explicitly invalidate one the moment a click turns
// out not to have done what it should have (see teams-control.js).
const DATA_DIR = path.join(__dirname, "data");
const ELEMENT_CACHE_FILE = path.join(DATA_DIR, "vision_element_cache.json");
const ELEMENT_CACHE_TTL_MS = parseInt(process.env.VISION_CACHE_TTL_MS, 10) || 12 * 60 * 60 * 1000;

function loadElementCache() {
  try { return JSON.parse(fs.readFileSync(ELEMENT_CACHE_FILE, "utf8")); }
  catch { return {}; }
}
function saveElementCache(cache) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(ELEMENT_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) { console.error("[VISION] Failed to persist element cache:", e.message); }
}
function elementCacheKey(description, width, height) {
  return `${width}x${height}::${description}`;
}
function getElementCache(description, width, height) {
  const cache = loadElementCache();
  const hit = cache[elementCacheKey(description, width, height)];
  if (!hit) return null;
  if (Date.now() - hit.ts > ELEMENT_CACHE_TTL_MS) return null;
  return hit;
}
function setElementCache(description, width, height, x, y) {
  const cache = loadElementCache();
  cache[elementCacheKey(description, width, height)] = { x, y, ts: Date.now() };
  saveElementCache(cache);
}
// Invalidates every cached entry whose description matches (regardless
// of resolution) — call this the moment a click that used a cached
// position turns out not to have worked, so the NEXT attempt re-locates
// via the vision model instead of clicking the same wrong spot forever.
function forgetElement(description) {
  const cache = loadElementCache();
  let changed = false;
  for (const key of Object.keys(cache)) {
    if (key.endsWith(`::${description}`)) { delete cache[key]; changed = true; }
  }
  if (changed) saveElementCache(cache);
}

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || "qwen/qwen3.6-27b";
// Cheap text-only model for answering questions from OCR'd text —
// same default "fast" model the rest of the app (hermes-engine.js)
// uses for lightweight calls, so it shares that model's TPM bucket
// rather than opening up a third one.
const GROQ_TEXT_MODEL = process.env.GROQ_TEXT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

// ── GEMINI (preferred provider when configured) ──────────────────
// Groq's vision model is the actual bottleneck here — it's the free
// tier that keeps running out, and it's what "fetch failed"/429s
// have been hitting. Google AI Studio's free tier is far more
// generous for this exact use case (a handful of screenshot calls
// per command), and Gemini's vision models are specifically good at
// "find this element, give me its pixel coordinates" grounding
// tasks. Get a free key at https://aistudio.google.com/apikey — no
// credit card required for the free tier — then set GEMINI_API_KEY
// in .env. When it's set, Gemini is used for BOTH the text-only OCR
// answers and the vision fallback; Groq is only used if
// GEMINI_API_KEY is absent, so nothing breaks for anyone who hasn't
// added it yet.
// Multiple keys, so a 429 on one rotates to the next instead of
// dying. Accepts either GEMINI_API_KEY="key1,key2,key3" (comma-
// separated in one var) or the numbered style already used
// elsewhere in this .env (GEMINI_API_KEY, GEMINI_API_KEY2,
// GEMINI_API_KEY3, ...) — whichever's easier to paste keys into.
function loadGeminiKeys() {
  const keys = [];
  const primary = process.env.GEMINI_API_KEY || "";
  for (const k of primary.split(",")) {
    const trimmed = k.trim();
    if (trimmed) keys.push(trimmed);
  }
  for (let i = 2; ; i++) {
    const k = process.env[`GEMINI_API_KEY${i}`];
    if (!k) break;
    const trimmed = k.trim();
    if (trimmed) keys.push(trimmed);
  }
  return keys;
}
const GEMINI_API_KEYS = loadGeminiKeys();
// Points at whichever key is "current" — sticks there across calls
// (doesn't reset to key 0 every time) so a key that's out of quota
// stays skipped until IT rotates back around, instead of getting
// retried first on every single request.
let geminiKeyIndex = 0;
function currentGeminiKey() {
  return GEMINI_API_KEYS[geminiKeyIndex % GEMINI_API_KEYS.length];
}
function rotateGeminiKey() {
  geminiKeyIndex = (geminiKeyIndex + 1) % GEMINI_API_KEYS.length;
}
// "gemini-flash-latest" is Google's own auto-updating alias — it
// always points at whatever their current GA Flash model is (as of
// this writing that's gemini-3.6-flash), so it doesn't go stale the
// way a hardcoded version does. Google has been rotating/retiring
// specific version numbers (like gemini-2.5-flash) with little
// warning — sometimes ahead of their own published shutdown dates —
// which is exactly the 404 this was hitting. Set GEMINI_MODEL in
// .env only if you specifically need a pinned version instead of
// always-latest.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
function geminiUrlFor(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}
const GEMINI_API_URL = geminiUrlFor(GEMINI_MODEL);
const USE_GEMINI = GEMINI_API_KEYS.length > 0;

// OCR words below this confidence (tesseract's 0-100 scale) are
// dropped — low-confidence hits are usually icon fragments or noise
// misread as letters, and matching against them just produces false
// element-location hits.
const OCR_MIN_CONFIDENCE = 40;

function isConfigured() {
  return !!(GroqKeys.hasGroqKey() || GEMINI_API_KEYS.length);
}

// ── CAPTURE ─────────────────────────────────────────────────────
// Returns { base64, width, height }. width/height are read directly
// out of the captured PNG's own header — NOT from a separate "ask
// Windows what the display resolution is" query. Those two numbers
// only need to disagree slightly (a different monitor picked up by
// screenshot-desktop than the one Screen.PrimaryScreen.Bounds
// reports, a multi-monitor setup, screenshot-desktop applying its
// own internal scaling) for every coordinate Gemini computes — based
// on "this image is WxH" — to be silently wrong on click, and wrong
// the SAME consistent way every single time, which looks exactly
// like "it keeps clicking the same wrong spot" rather than a random
// miss. Reading the real image bytes removes that entire class of
// mismatch: what we tell the model is guaranteed to be the actual
// image it's looking at.
async function captureScreenshot() {
  const buf = await screenshot({ format: "png" });
  const dims = getPngDimensions(buf);
  if (dims) return { base64: buf.toString("base64"), width: dims.width, height: dims.height };
  // Only if the buffer somehow isn't a well-formed PNG (shouldn't
  // happen — screenshot-desktop always returns PNG) fall back to the
  // old display-bounds query rather than returning no dimensions at
  // all.
  const { width, height } = await getPrimaryDisplaySize();
  return { base64: buf.toString("base64"), width, height };
}

// Reads width/height straight from a PNG buffer's IHDR chunk — the
// PNG spec fixes this at bytes 16-23 (big-endian uint32 each),
// immediately after the 8-byte signature and 4-byte length + "IHDR"
// tag, no library needed. Returns null if the buffer doesn't look
// like a PNG (wrong signature) rather than throwing.
function getPngDimensions(buf) {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function getPrimaryDisplaySize() {
  return new Promise((resolve) => {
    if (os.platform() === "win32") {
      // Without declaring DPI awareness first, PowerShell reports
      // Screen.PrimaryScreen.Bounds in Windows' virtualized LOGICAL
      // resolution (e.g. 2560x1440 on a 3840x2160 physical monitor
      // running 150% scaling) — but screenshot-desktop captures the
      // real PHYSICAL pixel buffer (3840x2160). Telling the vision
      // model "this screenshot is 2560x1440" when it's actually
      // 3840x2160 throws every coordinate it returns off by the
      // scaling factor, worse the further from the top-left corner
      // the target is — which matches "mouse moved, but not quite to
      // the right spot." Declaring PER_MONITOR_AWARE_V2 here makes
      // Bounds report the same physical pixels the screenshot uses.
      exec(
        `powershell -NoProfile -Command "` +
          `Add-Type -AssemblyName System.Windows.Forms; ` +
          `Add-Type -TypeDefinition 'using System.Runtime.InteropServices; public class DpiHelper { [DllImport(\\"user32.dll\\")] public static extern bool SetProcessDpiAwarenessContext(int value); }'; ` +
          `[DpiHelper]::SetProcessDpiAwarenessContext(-4) | Out-Null; ` +
          `$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; Write-Output \\"$($s.Width)x$($s.Height)\\""`,
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

// Cheap local presence check — no model call at all, just OCR. Used
// as a pre-filter before an expensive forceVision locate-and-click:
// if the text we're hunting for isn't even visible on screen right
// now (e.g. scanning a scrolling contacts list for a name), there is
// no point paying a vision-model round trip to confirm that — skip
// straight to scrolling further and check again next screen.
function pageContainsText(candidateText) {
  return ocrScreen().then(({ text }) => {
    const needle = String(candidateText || "").trim().toLowerCase();
    if (!needle) return true; // nothing to filter on, don't block the caller
    return text.toLowerCase().includes(needle);
  });
}

// ── SHARED GROQ REQUEST (multi-key failover + retried on 429) ───
async function groqChatRequest(model, messages) {
  if (!isConfigured()) throw new Error("GROQ_API_KEY isn't set in .env, so Jarvis can't look at the screen yet.");

  const doFetch = (key) => fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, temperature: 0, messages }),
    signal: AbortSignal.timeout(30000),
  });

  // Node's fetch() always throws a TypeError whose .message is the
  // generic literal "fetch failed" — the real reason (DNS lookup
  // failure, connection refused, TLS error, our own 30s timeout
  // above firing) lives in .cause and was previously being thrown
  // away, which is why every network hiccup surfaced as the same
  // useless "Could not reach Groq API: fetch failed" with no way to
  // tell a dead wifi connection apart from a DNS block apart from a
  // slow response. Surfacing .cause turns that into something you
  // can actually act on.
  function describeNetworkError(e) {
    const cause = e && e.cause;
    const code = cause && cause.code;
    if (e.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return "timed out connecting to Groq (30s) — check your internet connection";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS lookup for api.groq.com failed — check your internet/DNS connection";
    if (code === "ECONNREFUSED") return "connection refused — a firewall, proxy, or VPN may be blocking outbound HTTPS";
    if (code === "ECONNRESET" || code === "EPIPE") return "connection was reset mid-request — likely a flaky network, not Jarvis";
    if (code && /CERT|SSL|TLS/i.test(code)) return `TLS/certificate error (${code}) — a corporate proxy or antivirus may be intercepting HTTPS`;
    return (cause && cause.message) || e.message || "unknown network error";
  }

  // Runs the existing single-key logic (one retry for connection-level
  // failures, up to two retries on 429 using Groq's own stated wait
  // time) against ONE key. Returns the Response, or throws.
  async function attemptWithKey(key) {
    let res;
    try {
      res = await doFetch(key);
    } catch (e1) {
      await new Promise(r => setTimeout(r, 800));
      try {
        res = await doFetch(key);
      } catch (e2) {
        throw new Error(`Could not reach Groq API: ${describeNetworkError(e2)}`);
      }
    }

    let attempt = 0;
    while (res.status === 429 && attempt < 2) {
      attempt++;
      const errBody = await res.json().catch(() => ({}));
      const msg = errBody.error?.message || "";
      const waitMatch = msg.match(/try again in ([\d.]+)s/i);
      const waitSecs = waitMatch ? Math.min(parseFloat(waitMatch[1]), 45) : 5 * attempt;
      await new Promise(r => setTimeout(r, Math.ceil(waitSecs * 1000) + 250));
      try {
        res = await doFetch(key);
      } catch (e) {
        throw new Error(`Could not reach Groq API: ${describeNetworkError(e)}`);
      }
    }
    return res;
  }

  // ── MULTI-KEY FAILOVER ──────────────────────────────────────────
  // If more than one GROQ_API_KEY(2,3...) is configured (see
  // groq-keys.js), a key that still fails after its own retries above
  // (network trouble, still rate-limited, revoked/invalid, or a
  // Groq-side 5xx) rotates to the next key and starts fresh, instead
  // of giving up. With only one key configured, behavior is identical
  // to before this existed.
  const totalKeys = GroqKeys.groqKeyCount();
  let res, lastError = null;

  for (let i = 0; i < totalKeys; i++) {
    const key = GroqKeys.currentGroqKey();
    const isLastKey = i === totalKeys - 1;
    try {
      res = await attemptWithKey(key);
    } catch (e) {
      lastError = e;
      if (isLastKey) throw e;
      GroqKeys.rotateGroqKey();
      continue;
    }
    if (!res.ok && (res.status === 429 || res.status === 401 || res.status === 403 || res.status >= 500) && !isLastKey) {
      const body = await res.text().catch(() => "");
      lastError = new Error(`Groq vision request failed (${res.status}): ${body.slice(0, 300)}`);
      GroqKeys.rotateGroqKey();
      continue;
    }
    break;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Groq vision request failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.choices?.[0]?.message?.content || "";
}

// ── GEMINI REQUEST (text and/or image in one call) ────────────────
// base64Image is optional — omit it for a text-only ask (same
// function handles both, unlike the Groq path above which needs two
// different message shapes for text vs. image).
async function geminiRequest(prompt, base64Image = null) {
  if (!GEMINI_API_KEYS.length) throw new Error("GEMINI_API_KEY isn't set in .env.");

  const parts = [{ text: prompt }];
  if (base64Image) parts.push({ inline_data: { mime_type: "image/png", data: base64Image } });
  const body = JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0 } });

  const doFetch = (key, model = GEMINI_MODEL) => fetch(`${geminiUrlFor(model)}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30000),
  });

  function describeNetworkError(e) {
    const cause = e && e.cause;
    const code = cause && cause.code;
    if (e.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") return "timed out connecting to Gemini (30s) — check your internet connection";
    if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "DNS lookup for generativelanguage.googleapis.com failed — check your internet/DNS connection";
    if (code === "ECONNREFUSED") return "connection refused — a firewall, proxy, or VPN may be blocking outbound HTTPS";
    if (code === "ECONNRESET" || code === "EPIPE") return "connection was reset mid-request — likely a flaky network, not Jarvis";
    if (code && /CERT|SSL|TLS/i.test(code)) return `TLS/certificate error (${code}) — a corporate proxy or antivirus may be intercepting HTTPS`;
    return (cause && cause.message) || e.message || "unknown network error";
  }

  async function fetchWithRetry(key, model) {
    try {
      return await doFetch(key, model);
    } catch (e1) {
      await new Promise(r => setTimeout(r, 800));
      try {
        return await doFetch(key, model);
      } catch (e2) {
        throw new Error(`Could not reach Gemini API: ${describeNetworkError(e2)}`);
      }
    }
  }

  // Try the current key. If it's out of quota (429), rotate to the
  // next configured key and try again immediately — no backoff needed,
  // a different key isn't rate-limited by the first one's usage. Keeps
  // going until either a key works or every configured key has been
  // tried once this call, at which point we back off and retry the
  // current (now rotated) key like before, so a single-key setup keeps
  // its old behavior exactly.
  let res;
  let lastErrObj = null;
  const attempts = GEMINI_API_KEYS.length;
  for (let i = 0; i < attempts; i++) {
    const key = currentGeminiKey();
    res = await fetchWithRetry(key);
    if (res.status !== 429) break;
    lastErrObj = await res.json().catch(() => ({}));
    console.error(`[VISION] Gemini key #${geminiKeyIndex + 1} hit its quota (429), rotating to the next key.`);
    rotateGeminiKey();
  }

  // Every key came back 429 — fall back to Gemini's own suggested
  // wait (if any) and retry the current key once more before giving up.
  if (res.status === 429) {
    const detail = lastErrObj?.error?.details?.find(d => d["@type"]?.includes("RetryInfo"));
    const waitSecs = detail?.retryDelay ? parseFloat(detail.retryDelay) : 5;
    await new Promise(r => setTimeout(r, Math.ceil(waitSecs * 1000) + 250));
    res = await fetchWithRetry(currentGeminiKey());
  }

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    // A 404 here specifically means "this model string doesn't exist
    // or was retired" (not a network problem) — Google has been
    // retiring specific versions abruptly, so on a 404 for the
    // configured model, try one hardcoded known-current fallback
    // before giving up entirely, in case that happens again.
    if (res.status === 404 && GEMINI_MODEL !== "gemini-3.6-flash") {
      try {
        const fallbackRes = await doFetch(currentGeminiKey(), "gemini-3.6-flash");
        if (fallbackRes.ok) {
          const data = await fallbackRes.json();
          return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        }
      } catch { /* fall through to the original error below */ }
    }
    const quotaNote = res.status === 429 && attempts > 1 ? ` (all ${attempts} configured Gemini keys are currently rate-limited)` : "";
    throw new Error(`Gemini request failed (${res.status})${quotaNote}: ${bodyText.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// Text-only Groq call — used to answer questions from OCR'd text.
// Costs a few hundred tokens instead of the ~1500-2000 a full
// screenshot image costs through the vision model.
async function askText(prompt) {
  if (USE_GEMINI) {
    try {
      return await geminiRequest(prompt);
    } catch (e) {
      // Gemini failed for ANY reason (quota exhausted across every
      // configured key, network issue, retired model, whatever) —
      // rather than let the whole request die when a second free
      // provider is sitting right there, fall through to Groq. Only
      // actually useful if GROQ_API_KEY is set; if it isn't,
      // groqChatRequest below throws its own clear error anyway.
      console.error("[VISION] Gemini request failed, falling back to Groq:", e.message);
    }
  }
  const messages = [{ role: "user", content: prompt }];
  return groqChatRequest(GROQ_TEXT_MODEL, messages);
}

// Vision-model call — kept as the fallback for screens/elements OCR
// genuinely can't handle (graphical content, unlabeled icons).
async function askVision(base64Image, prompt) {
  if (USE_GEMINI) {
    try {
      return await geminiRequest(prompt, base64Image);
    } catch (e) {
      console.error("[VISION] Gemini vision request failed, falling back to Groq:", e.message);
    }
  }
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

  // Next, the cache — a previous vision-model call already found
  // this exact description at this exact screen resolution, and it's
  // still within its TTL. This is what makes repeated clicks on
  // Teams' static chrome (sidebar icons, in-call toolbar buttons,
  // lobby buttons) free after the very first time. Skipped when the
  // caller explicitly wants a fresh read (opts.skipCache).
  if (!opts.skipCache) {
    const cached = getElementCache(description, width, height);
    if (cached) return { found: true, x: cached.x, y: cached.y, source: "cache" };
  }

  // No literal on-screen text matched this description — it's
  // probably an icon-only target (a bare toggle, an unlabeled icon)
  // that OCR fundamentally can't see. This is the one case that
  // still genuinely needs the vision model.
  const prompt =
    `This screenshot is exactly ${width}x${height} pixels — that is its real, full resolution, not a resized or ` +
    `cropped preview. Find this UI element: "${description}". ` +
    `Before answering, double-check you haven't confused it with a different, visually- or textually-similar ` +
    `element elsewhere on screen (e.g. a similarly-worded nav item, tab, or label sitting near the target) — the ` +
    `target must match the FULL description given, not just part of it. ` +
    `Reply with ONLY a JSON object, no prose, no markdown fences, in the exact shape ` +
    `{"found": true, "x": <int>, "y": <int>} with x/y being the pixel center of the element, as precise integer ` +
    `pixel coordinates within this exact ${width}x${height} image. If you cannot find it, reply {"found": false}.`;

  const raw = await askVision(base64, prompt);
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, "").trim());
  } catch {
    parsed = { found: false };
  }
  if (parsed && parsed.found) setElementCache(description, width, height, parsed.x, parsed.y);
  return parsed;
}

// ── MOUSE CONTROL ────────────────────────────────────────────────
// Moves the cursor WITHOUT clicking. Needed for hover-reveal UI —
// e.g. Microsoft Teams only renders the chat/call/more icons on a
// contacts-list row once the mouse is actually over that row; a
// screenshot taken without hovering first simply doesn't have those
// icons in it, which is how findAndClick ends up guessing at
// something else nearby (like the tab bar above the list) instead.
function moveMouseTo(x, y) {
  const platform = os.platform();
  if (platform === "win32") {
    const ps = `
Add-Type -TypeDefinition '
using System;
using System.Runtime.InteropServices;
public class MouseMove {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(int value);
}';
[MouseMove]::SetProcessDpiAwarenessContext(-4) | Out-Null;
[MouseMove]::SetCursorPos(${Math.round(x)}, ${Math.round(y)});
`.replace(/\r?\n/g, " ");
    return runPS(ps);
  }
  if (platform === "darwin") {
    // AppleScript's System Events doesn't have a clean pure hover
    // primitive, but a zero-duration mouse-move via cliclick (if
    // present) is the closest equivalent; fall back to a no-op if
    // it's not installed rather than failing the whole flow.
    return runCmd(`cliclick m:${Math.round(x)},${Math.round(y)}`).catch(() => {});
  }
  return Promise.reject(new Error("Hover isn't wired up for Linux yet — only screen reading works there."));
}

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
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(int value);
}';
[MouseSim]::SetProcessDpiAwarenessContext(-4) | Out-Null;
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
  // TIER 0 — UI Automation: ask Windows for the real control instead
  // of guessing from a screenshot (see ui-automation.js for the full
  // rationale). Free, deterministic, no AI call. Silently skipped
  // (not an error) when: not on Windows, the native addon isn't
  // built, the description has no quoted control name to search for,
  // or the control just isn't found this way — any of those fall
  // straight through to the OCR/vision tiers below, unchanged.
  if (!opts.skipUIA) {
    try {
      const uia = require("./ui-automation");
      if (await uia.findAndClick(description, opts)) return true;
    } catch { /* fall through — this tier must never block the rest */ }
  }

  const loc = await locateElement(description, opts);
  if (!loc || !loc.found) return false;
  await clickAt(loc.x, loc.y);
  return true;
}

module.exports = {
  isConfigured,
  captureScreenshot,
  ocrScreen,
  pageContainsText,
  lookAtScreen,
  locateElement,
  forgetElement,
  clickAt,
  moveMouseTo,
  findAndClick,
  askVision, // exported for agent-brain.js's grounded next-action decisions
  askText,
  GROQ_VISION_MODEL,
  GROQ_TEXT_MODEL,
  GEMINI_MODEL,
  usingGemini: USE_GEMINI,
};
