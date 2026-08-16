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
// MODEL: defaults to llama3.2:3b (https://ollama.com/library/llama3.2)
// — Meta's official Llama 3.2 3B instruct model, from Ollama's
// reviewed "library" namespace. Roughly a third the size of
// llama3.1:8b, so noticeably faster to prefill/generate on CPU-only
// hardware — the tradeoff is somewhat less reliable tool-call
// picking than 8B, which is exactly what the LOCAL_QUICK_PATTERNS
// keyword fast-path in hermes-engine.js exists to cover for the
// commands people say most often.
//   - Ollama model pulls are just weights (GGUF) + a small text
//     Modelfile — there's no executable code that runs on your
//     machine the way a binary or npm package could.
//   - Normal, safety-tuned instruct model, same as llama3.1:8b.
//   - If tool-calling accuracy on uncommon phrasings matters more
//     than raw speed, "llama3.1:8b" is the more capable option;
//     if even 3b is too slow, try "llama3.2:1b" or "qwen2.5:1.5b".
// ═══════════════════════════════════════════════════════════════

const OLLAMA_URL          = process.env.OLLAMA_URL          || "http://127.0.0.1:11434";
const OLLAMA_MODEL        = process.env.OLLAMA_MODEL        || "llama3.2:3b";
// Optional — only needed for the screen/image-vision fallback in
// screen-vision.js. llama3.2:3b (text) is not multimodal, so image
// understanding needs a genuinely multimodal local model (e.g.
// "llama3.2-vision", "llava", "moondream"). Leave unset to simply
// disable the local vision fallback rather than silently reaching
// for Groq/Gemini.
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || "";

// How long to wait for a single Ollama call before giving up.
// Overridable in .env — bump this if you're on a genuinely slow
// CPU-only machine and legitimate generations run long.
const OLLAMA_TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || "", 10) || 120000;

// How long Ollama should keep the model loaded in memory after a
// request finishes, so the NEXT request doesn't have to reload the
// whole model from disk. Ollama's default keep_alive is only 5
// minutes; on a CPU-only box reloading a multi-GB model back into
// RAM can easily blow past a 120s timeout on its own, which is a
// very plausible reason "it worked for 2 requests then failed" —
// the 3rd one landed after the model had already been unloaded.
const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE || "30m";

// ── OLLAMA CLOUD ────────────────────────────────────────────────
// A completely different thing from local Ollama above: this talks
// to ollama.com's own hosted infrastructure (real servers, real
// GPUs) instead of the user's machine. Used as a genuine fallback
// tier when Groq is out of quota — see hermes-engine.js. Docs:
// https://docs.ollama.com/cloud
const OLLAMA_CLOUD_URL   = "https://ollama.com";
const OLLAMA_API_KEY     = process.env.OLLAMA_API_KEY || "";
const OLLAMA_CLOUD_MODEL = process.env.OLLAMA_CLOUD_MODEL || "gpt-oss:120b";
// Ollama Cloud's smaller/faster tier — used when a Groq call asks for
// MODELS.fast specifically. Ollama's naming ("gpt-oss:20b") doesn't
// match Groq's ("openai/gpt-oss-20b"), so callers should map through
// mapGroqModelToOllamaCloud() below rather than forwarding a Groq
// model string straight through — that mismatch is exactly what
// causes a 404 "model not found" from ollama.com's API.
const OLLAMA_CLOUD_MODEL_FAST = process.env.OLLAMA_CLOUD_MODEL_FAST || "gpt-oss:20b";
// Vision-capable Ollama Cloud model. Ollama's cloud model lineup gets
// retired/replaced over time (qwen3-vl:235b-cloud was pulled from the
// registry on 2026-06-16), so this is deliberately kept overridable
// via env var — if this one ever 410s too, just set
// OLLAMA_CLOUD_VISION_MODEL in .env rather than editing code.
// gemma4:31b-cloud is Google's current cloud-hosted multimodal model,
// billed at Ollama's "Low Usage" tier, and handles the same
// "read a screenshot, point at a UI element" job the old qwen model
// did. Docs: https://ollama.com/library/gemma4
const OLLAMA_CLOUD_VISION_MODEL = process.env.OLLAMA_CLOUD_VISION_MODEL || "gemma4:31b-cloud";

function isCloudConfigured() {
  return !!OLLAMA_API_KEY;
}

// Groq model names ("openai/gpt-oss-20b") don't match Ollama Cloud's
// own naming ("gpt-oss:20b") — this translates the handful Jarvis
// actually uses so a caller can pass a Groq model straight through
// without knowing Ollama's naming scheme. Anything unrecognized
// (e.g. Groq's coding model) falls back to the general cloud model
// rather than 404ing.
const GROQ_TO_OLLAMA_CLOUD_MODEL = {
  "openai/gpt-oss-20b":  OLLAMA_CLOUD_MODEL_FAST,
  "openai/gpt-oss-120b": OLLAMA_CLOUD_MODEL,
};
function mapGroqModelToOllamaCloud(groqModel) {
  return GROQ_TO_OLLAMA_CLOUD_MODEL[groqModel] || OLLAMA_CLOUD_MODEL;
}

// Uses Ollama's native /api/chat shape (not the OpenAI-compat
// endpoint — ollama.com's own docs recommend the native route for
// cloud access). Response comes back as { message: { role, content,
// tool_calls? } }, which is the same shape callers already expect
// from groqFetchRaw/ollamaChat below.
async function ollamaCloudChat(messages, options = {}) {
  const {
    model       = OLLAMA_CLOUD_MODEL,
    temperature = 0.75,
    maxTokens   = 1024,
    tools       = null,
    tool_choice = "auto",
    // Pass "json" to force strict JSON-object output — Ollama's native
    // /api/chat supports this the same way Groq's response_format:
    // {type:"json_object"} does. Used by callers (e.g. github-bounty.js's
    // triage step) that need to JSON.parse() the reply.
    format      = null,
  } = options;

  if (!OLLAMA_API_KEY) throw new Error("OLLAMA_API_KEY not set in .env");

  const body = {
    model,
    messages,
    stream: false,
    options: { temperature, num_predict: maxTokens },
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }
  if (format) body.format = format;

  let res;
  try {
    res = await fetch(`${OLLAMA_CLOUD_URL}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OLLAMA_API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (e) {
    throw new Error(`Could not reach Ollama Cloud: ${e.message}`);
  }

  if (!res.ok) {
    const body2 = await res.text().catch(() => "");
    throw new Error(`Ollama Cloud API error ${res.status}: ${body2.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.message || {};
}

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

// ── REQUEST QUEUE ───────────────────────────────────────────────
// A CPU-only Ollama instance effectively handles one generation at
// a time. Jarvis has several background jobs (proactive.js,
// self-improve.js, briefing/news summarization, memory sync
// triggers, etc.) that can all decide to call the model around the
// same time as a live chat message. Without serializing, those pile
// up behind whichever request got there first, and by the time an
// earlier one finishes, later ones have already blown past their
// own timeout — which looks exactly like "worked, worked, then
// timed out for no reason." Running everything through this queue
// means each call waits its turn instead of racing and starving.
let _queue = Promise.resolve();
function enqueue(fn) {
  const run = _queue.then(fn, fn);
  // Swallow errors here so one failed call doesn't wedge the queue
  // for everything queued after it.
  _queue = run.then(() => {}, () => {});
  return run;
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
    // Keep the model resident between calls — see OLLAMA_KEEP_ALIVE
    // above. Ollama's OpenAI-compatible endpoint passes this through
    // even though it's not part of the official OpenAI schema.
    keep_alive: OLLAMA_KEEP_ALIVE,
  };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = tool_choice; }

  const attempt = async () => {
    let res;
    try {
      res = await fetch(`${OLLAMA_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
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
  };

  // Serialize against every other Ollama call Jarvis makes (see the
  // queue above). NOTE: no retry-on-timeout here anymore — on hardware
  // where the model is genuinely too slow, retrying just means waiting
  // through TWO full timeouts before the user sees anything, which is
  // worse, not better. Log elapsed time either way so it's obvious
  // from the console whether Ollama is slow, hanging, or not
  // responding at all.
  return enqueue(async () => {
    const startedAt = Date.now();
    console.log(`[OLLAMA] sending request to ${model} (${JSON.stringify(messages).length} chars)...`);
    try {
      const result = await attempt();
      console.log(`[OLLAMA] ${model} responded in ${Date.now() - startedAt}ms`);
      return result;
    } catch (e) {
      console.error(`[OLLAMA] ${model} failed after ${Date.now() - startedAt}ms: ${e.message}`);
      throw e;
    }
  });
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
      "No local vision model configured. llama3.2:3b is text-only, so it can't look at " +
      "images. Pull a multimodal model (e.g. `ollama pull llama3.2-vision`) and set OLLAMA_VISION_MODEL " +
      "in .env to enable local screen-vision fallback."
    );
  }
  const attempt = async () => {
    let res;
    try {
      res = await fetch(`${OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: OLLAMA_VISION_MODEL,
          stream: false,
          keep_alive: OLLAMA_KEEP_ALIVE,
          messages: [{ role: "user", content: prompt, images: [base64Image] }],
        }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
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
  };

  return enqueue(async () => {
    const startedAt = Date.now();
    console.log(`[OLLAMA-VISION] sending request to ${OLLAMA_VISION_MODEL}...`);
    try {
      const result = await attempt();
      console.log(`[OLLAMA-VISION] ${OLLAMA_VISION_MODEL} responded in ${Date.now() - startedAt}ms`);
      return result;
    } catch (e) {
      console.error(`[OLLAMA-VISION] ${OLLAMA_VISION_MODEL} failed after ${Date.now() - startedAt}ms: ${e.message}`);
      throw e;
    }
  });
}

function hasCloudVisionModel() {
  return !!OLLAMA_API_KEY; // qwen3-vl:235b-cloud needs no separate opt-in — just the API key
}

// Same job as ollamaVision() above, but against ollama.com's hosted
// compute instead of a local install — no GPU, no multi-GB local
// download, works anywhere the server can reach the internet. Good
// free option for locateElement()/clickAt() (screen-vision.js) since
// qwen3-vl is specifically tuned as a GUI/visual agent.
async function ollamaCloudVision(base64Image, prompt, model = OLLAMA_CLOUD_VISION_MODEL) {
  if (!OLLAMA_API_KEY) throw new Error("OLLAMA_API_KEY not set in .env");

  const attempt = async () => {
    let res;
    try {
      res = await fetch(`${OLLAMA_CLOUD_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${OLLAMA_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: "user", content: prompt, images: [base64Image] }],
        }),
        signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      });
    } catch (e) {
      throw new Error(`Could not reach Ollama Cloud: ${e.message}`);
    }
    if (!res.ok) {
      const body2 = await res.text().catch(() => "");
      throw new Error(`Ollama Cloud vision error ${res.status}: ${body2.slice(0, 300)}`);
    }
    const data = await res.json();
    return data?.message?.content || "";
  };

  const startedAt = Date.now();
  console.log(`[OLLAMA-CLOUD-VISION] sending request to ${model}...`);
  try {
    const result = await attempt();
    console.log(`[OLLAMA-CLOUD-VISION] ${model} responded in ${Date.now() - startedAt}ms`);
    return result;
  } catch (e) {
    console.error(`[OLLAMA-CLOUD-VISION] ${model} failed after ${Date.now() - startedAt}ms: ${e.message}`);
    throw e;
  }
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
  isCloudConfigured,
  ollamaCloudChat,
  ollamaCloudVision,
  hasCloudVisionModel,
  OLLAMA_CLOUD_MODEL,
  OLLAMA_CLOUD_MODEL_FAST,
  OLLAMA_CLOUD_VISION_MODEL,
  mapGroqModelToOllamaCloud,
};
