"use strict";
// ═══════════════════════════════════════════════════════════════
// Generic Groq "give me back JSON" helper.
//
// Several places in this codebase need to hand Groq some text and
// get a strict JSON object back (phone-agent.js's call-outcome
// summarizer, inbound-agent.js's caller-name matcher, etc). This is
// that logic pulled into one place instead of each file re-writing
// the same fetch + key-rotation + JSON-parse-with-fallback loop.
//
// Usage:
//   const { askGroqForJSON } = require("./groq-json");
//   const result = await askGroqForJSON({
//     systemPrompt: "Reply with ONLY JSON: {\"foo\": boolean}",
//     userContent: "some text to analyze",
//     fallback: { foo: false },   // returned if Groq isn't configured / parse fails
//   });
// ═══════════════════════════════════════════════════════════════

const GroqKeys = require("./groq-keys");

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_AGENT_MODEL || process.env.GROQ_MODEL_FAST || "openai/gpt-oss-20b";

async function askGroqForJSON({ systemPrompt, userContent, fallback = {}, temperature = 0 }) {
  if (!GroqKeys.hasGroqKey()) {
    return { ...fallback, _groqConfigured: false };
  }

  const doFetch = (key) => fetch(GROQ_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({
      model: GROQ_MODEL,
      response_format: { type: "json_object" },
      temperature,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent || "" },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });

  const totalKeys = GroqKeys.groqKeyCount();
  let res, lastError = null;
  for (let attempt = 0; attempt < totalKeys; attempt++) {
    const key = GroqKeys.currentGroqKey();
    const isLastKey = attempt === totalKeys - 1;
    try {
      res = await doFetch(key);
    } catch (e) {
      lastError = e;
      if (isLastKey) throw new Error(`Could not reach Groq: ${e.message}`);
      GroqKeys.rotateGroqKey();
      continue;
    }
    if (!res.ok && (res.status === 429 || res.status >= 500) && !isLastKey) {
      GroqKeys.rotateGroqKey();
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const status = res ? res.status : "no response";
    throw new Error(`Groq JSON request failed (${status})${lastError ? `: ${lastError.message}` : ""}`);
  }

  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "{}";
  try {
    return { ...JSON.parse(raw), _groqConfigured: true };
  } catch {
    return { ...fallback, _groqConfigured: true, _parseFailed: true, _raw: raw };
  }
}

module.exports = { askGroqForJSON, GROQ_MODEL };
