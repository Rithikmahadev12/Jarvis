"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Video Ad Script Generator
//
// Turns a business_clients.js profile into a short, scene-by-scene
// ad script: video-producer.js walks these scenes to build the
// visuals (an HTML slide per scene) and narrate them (Camb.ai TTS,
// one synthesis call per scene's line).
//
// Goes through Hermes's own groqFetch(), which as of hermes-engine.js's
// 4-tier rewrite already tries Ollama Cloud -> Gemini -> self-hosted
// sandbox Ollama -> Groq on its own — nothing extra to wire up here.
// ═══════════════════════════════════════════════════════════════

let Hermes = null;
try { Hermes = require("./hermes-engine"); } catch { Hermes = null; }

const MIN_SCENES = 3;
const MAX_SCENES = 6;

function isConfigured() {
  return !!Hermes;
}

function buildPrompt(client, opts) {
  const targetSeconds = opts.targetSeconds || 30;
  const platformNote = client.platforms && client.platforms.length
    ? `It will be posted to: ${client.platforms.join(", ")}.`
    : "";

  return `Write a short vertical-video ad script for this business.

Business name: ${client.name}
Website: ${client.website || "(none given)"}
What it does / sells: ${client.about || "(not given — infer something plausible and generic but tasteful from the name/niche)"}
Niche/category: ${client.niche || "(not given)"}
Desired tone: ${client.tone || "energetic"}
Target length: about ${targetSeconds} seconds of spoken narration total.
${platformNote}

Return ONLY a JSON object, no prose, no markdown fences, in exactly this shape:
{
  "title": "short internal title for this ad",
  "caption": "a social-media caption/description to post alongside the video, with 3-6 relevant hashtags",
  "scenes": [
    { "heading": "short on-screen headline for this scene (few words)", "narration": "what the voiceover says during this scene, ONE OR TWO sentences, natural spoken English" }
  ]
}

Rules:
- ${MIN_SCENES} to ${MAX_SCENES} scenes total.
- The first scene should hook attention fast (a question, a bold claim, or the core benefit) — not a slow intro.
- The last scene must be a clear call to action (visit the website, follow, order now, book now — whatever fits the business).
- Keep narration natural to SAY out loud, not read — short sentences, no jargon, no emojis inside narration text.
- Headlines are short punchy on-screen text (max ~6 words), not full sentences.
- Never invent specific prices, addresses, phone numbers, or claims (awards, certifications, guarantees) that weren't given — keep those generic if not provided.`;
}

function tryParseScript(raw) {
  const cleaned = String(raw || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```\s*$/i, "");
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) { throw new Error(`Model didn't return valid JSON for the script: ${e.message}`); }

  if (!parsed || !Array.isArray(parsed.scenes) || !parsed.scenes.length) {
    throw new Error("Model response had no usable scenes array.");
  }
  const scenes = parsed.scenes
    .map((s) => ({
      heading: String(s.heading || "").trim().slice(0, 80),
      narration: String(s.narration || "").trim().slice(0, 500),
    }))
    .filter((s) => s.narration);

  if (!scenes.length) throw new Error("Every scene was missing narration text.");

  return {
    title: String(parsed.title || "").trim() || "Untitled ad",
    caption: String(parsed.caption || "").trim(),
    scenes,
  };
}

/**
 * Generate a scene-by-scene ad script for a business.
 * @param {object} client - a business_clients.js record
 * @param {object} [opts]
 * @param {number} [opts.targetSeconds]
 * @returns {Promise<{title:string, caption:string, scenes:Array<{heading:string,narration:string}>}>}
 */
async function generateVideoScript(client, opts = {}) {
  if (!client || !client.name) throw new Error("generateVideoScript() needs a business client with at least a name.");
  if (!isConfigured()) throw new Error("hermes-engine isn't available — can't generate a script.");

  const messages = [
    {
      role: "system",
      content:
        "You are an advertising copywriter who writes tight, natural-sounding short-form video ad scripts " +
        "for small businesses. You output ONLY the requested JSON, nothing else.",
    },
    { role: "user", content: buildPrompt(client, opts) },
  ];

  // fast model, JSON-shaped output, low temperature for reliable structure
  const raw = await Hermes.groqFetch(messages, Hermes.MODELS.smart, 0.6, 1200);
  return tryParseScript(raw);
}

module.exports = { generateVideoScript, isConfigured };
