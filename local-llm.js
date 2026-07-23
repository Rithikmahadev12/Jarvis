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
// MODEL: defaults to llama3.1:8b (https://ollama.com/library/llama3.1)
// — Meta's official Llama 3.1 8B instruct model, from Ollama's own
// "library" namespace (reviewed/maintained, not a random third-party
// upload). It's also the model Ollama used in their own tool-calling
// announcement (https://ollama.com/blog/tool-support), so it's a
// known-good pick for the function-calling Jarvis relies on — unlike
// a general uncensored chat finetune, it was actually built with that
// use case in mind.
//   - Ollama model pulls are just weights (GGUF) + a small text
//     Modelfile — there's no executable code that runs on your
//     machine the way a binary or npm package could.
//   - It's still a normal, safety-tuned instruct model (no jailbroken/
//     "unfiltered" finetuning), so Jarvis's usual guardrails apply as
//     expected.
//   - 8B is a reasonable size for CPU-only machines; if generations
//     are still too slow, "llama3.2:3b" is smaller/faster (weaker
//     tool-calling reliability), or "llama3.1:70b" if you have the
//     RAM/GPU for something stronger.
// ═══════════════════════════════════════════════════════════════

const OLLAMA_URL          = process.env.OLLAMA_URL          || "http://127.0.0.1:11434";
const OLLAMA_MODEL        = process.env.OLLAMA_MODEL        || "llama3.1:8b";
// Optional — only needed for the screen/image-vision fallback in
// screen-vision.js. llama3.1:8b is text-only, so image understanding
// needs a genuinely multimodal local model (e.g. "llama3.2-vision",
// "llava", "moondream"). Leave unset to simply disable the local
// vision fallback rather than silently reaching for Groq/Gemini.
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
  // queue above), then retry ONE time on a timeout specifically —
  // a queued request that finally gets its turn right as the model
  // was mid-reload is exactly the "worked twice then timed out"
  // symptom, and a fresh attempt right after usually lands on an
  // already-warm model instead of triggering a second reload.
  return enqueue(async () => {
    try {
      return await attempt();
    } catch (e) {
      if (/timed out/i.test(e.message)) {
        try {
          return await attempt();
        } catch (e2) {
          throw e2;
        }
      }
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
      "No local vision model configured. llama3.1:8b is text-only, so it can't look at " +
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
    try {
      return await attempt();
    } catch (e) {
      if (/timed out/i.test(e.message)) {
        try { return await attempt(); } catch (e2) { throw e2; }
      }
      throw e;
    }
  });
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
