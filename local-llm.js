"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Local LLM Bridge (Ollama)
//
// Single choke point for "are we running on the user's own machine,
// and if so, talk to their local Ollama model instead of any cloud
// API." Every other file that used to call Groq or Gemini directly
// should check isLocalMode() and, if true, route through this
// module instead — never Groq/Gemini when local.
//
// Cloud deploys (Render etc.) have no local Ollama to reach, so they
// keep using Groq/Gemini exactly as before; nothing changes there.
//
// MODEL: defaults to zarigata/unfiltered-llama3
// (https://ollama.com/zarigata/unfiltered-llama3) — an uncensored
// Llama 3 finetune published under a third-party Ollama namespace,
// not an official Meta/Ollama-library model. A couple of things
// worth knowing before pulling it:
//   - Ollama model pulls are just weights (GGUF) + a small text
//     Modelfile — there's no executable code that runs on your
//     machine the way a binary or npm package could. That makes the
//     "is it a virus" risk very different from, say, downloading a
//     random .exe: the worst a malicious Modelfile can realistically
//     do is set a weird system prompt or point at a bad weights URL.
//   - That said, it's community-published (namespace "zarigata", not
//     "library"/official), so nobody at Ollama or Meta has reviewed
//     its behaviour. "Unfiltered" specifically means it has had
//     safety fine-tuning removed, which is the point of it, but also
//     means Jarvis's own output filtering (if any) is now the only
//     thing between the raw model and the user.
//   - Sensible precautions: check the model page's pull count /
//     comments yourself before trusting it for anything sensitive,
//     and don't feed it credentials or point it at tools that can
//     take real-world actions (e.g. the "open X" / Teams-control
//     agents below) without reviewing what it actually says first.
// ═══════════════════════════════════════════════════════════════

const OLLAMA_URL          = process.env.OLLAMA_URL          || "http://127.0.0.1:11434";
const OLLAMA_MODEL        = process.env.OLLAMA_MODEL        || "zarigata/unfiltered-llama3";
// Optional — only needed for the screen/image-vision fallback in
// screen-vision.js. zarigata/unfiltered-llama3 is text-only, so
// image understanding needs a genuinely multimodal local model
// (e.g. "llama3.2-vision", "llava", "moondream"). Leave unset to
// simply disable the local vision fallback rather than silently
// reaching for Groq/Gemini.
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "";

// ── ENVIRONMENT DETECTION ──────────────────────────────────────
// Render sets RENDER=true (and other RENDER_* vars) on every
// instance automatically — same pattern already used by
// jarvis-agent.js / hermes-agent.js.
function isRenderEnv() {
  return !!(
    process.env.RENDER ||
    process.env.RENDER_SERVICE_ID ||
    process.env.RENDER_INSTANCE_ID
  );
}
// "Local mode" = running on the user's own machine, where Ollama is
// reachable. This is the ONLY switch that decides Ollama vs
// Groq/Gemini anywhere in the app.
function isLocalMode() {
  return !isRenderEnv();
}

function hasVisionModel() {
  return !!OLLAMA_VISION_MODEL;
}

async function isOllamaServing() {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function isModelPulled(model = OLLAMA_MODEL) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const data = await res.json();
    const base = model.split(":")[0];
    return (data.models || []).some(m => m.name === model || m.name.startsWith(base + ":") || m.model === model);
  } catch {
    return false;
  }
}

function friendlyOllamaError(e) {
  const cause = e && e.cause;
  const code = cause && cause.code;
  if (e.name === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT") {
    return `timed out reaching Ollama at ${OLLAMA_URL} — is \`ollama serve\` running?`;
  }
  if (code === "ECONNREFUSED") {
    return `couldn't connect to Ollama at ${OLLAMA_URL} — install it from https://ollama.com and run \`ollama serve\` (or just \`ollama run ${OLLAMA_MODEL}\` once to start it).`;
  }
  return (cause && cause.message) || e.message || "unknown error talking to Ollama";
}

// ── CORE CHAT CALL — Ollama's OpenAI-compatible endpoint ────────
// Accepts the same shape hermes-engine.js's groqFetchRaw already
// uses (messages, tools, tool_choice, temperature, maxTokens) so it
// can be dropped in as the local backend with no changes needed in
// any calling code. reasoning_effort/reasoning_format are Groq-only
// concepts and are simply ignored here.
async function ollamaChat(messages, options = {}) {
  const {
    model       = OLLAMA_MODEL,
    temperature = 0.75,
    maxTokens   = 1024,
    tools       = null,
    tool_choice = "auto",
  } = options;

  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }

  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000), // local generation can be slow on CPU-only setups
    });
  } catch (e) {
    throw new Error(`Could not reach local Ollama: ${friendlyOllamaError(e)}`);
  }

  if (res.status === 404) {
    throw new Error(
      `Ollama doesn't have "${model}" pulled yet. Run: ollama pull ${model}`
    );
  }
  if (!res.ok) {
    const body2 = await res.text().catch(() => "");
    throw new Error(`Ollama API error ${res.status}: ${body2.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message || {};
}

// Convenience wrapper mirroring hermes-engine.js's groqFetch (plain
// string reply, no tool-call plumbing).
async function ollamaText(messages, model = OLLAMA_MODEL, temperature = 0.75, maxTokens = 1024) {
  const msg = await ollamaChat(messages, { model, temperature, maxTokens });
  return msg.content || "";
}

// ── VISION (optional) ──────────────────────────────────────────
// Uses Ollama's native /api/chat (not the OpenAI-compat endpoint)
// since that's the documented way to pass images to a multimodal
// model. Only works if OLLAMA_VISION_MODEL is set to an actual
// vision-capable model the user has pulled locally.
async function ollamaVision(base64Image, prompt) {
  if (!OLLAMA_VISION_MODEL) {
    throw new Error(
      "No local vision model configured. zarigata/unfiltered-llama3 is text-only, so it can't look at " +
      "images. Pull a multimodal model (e.g. `ollama pull llama3.2-vision`) and set OLLAMA_VISION_MODEL " +
      "in .env to enable local screen-vision fallback."
    );
  }
  let res;
  try {
    res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_VISION_MODEL,
        stream: false,
        messages: [{ role: "user", content: prompt, images: [base64Image] }],
      }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (e) {
    throw new Error(`Could not reach local Ollama: ${friendlyOllamaError(e)}`);
  }
  if (!res.ok) {
    const body2 = await res.text().catch(() => "");
    throw new Error(`Ollama vision error ${res.status}: ${body2.slice(0, 300)}`);
  }
  const data = await res.json();
  return data?.message?.content || "";
}

module.exports = {
  OLLAMA_URL,
  OLLAMA_MODEL,
  OLLAMA_VISION_MODEL,
  isRenderEnv,
  isLocalMode,
  hasVisionModel,
  isOllamaServing,
  isModelPulled,
  ollamaChat,
  ollamaText,
  ollamaVision,
};
