"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Conversation Trainer v1.0
// Builds training datasets from JARVIS conversation history
// and Groq responses. Stores examples so JARVIS learns what
// good responses look like for each intent/topic.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const Groq = require("./hermes-engine");

const DATA_DIR       = path.join(__dirname, "data");
const TRAINING_FILE  = path.join(DATA_DIR, "training_data.json");
const SESSIONS_FILE  = path.join(DATA_DIR, "sessions.json");

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(TRAINING_FILE)) fs.writeFileSync(TRAINING_FILE, JSON.stringify({ examples: [], stats: {} }), "utf8");
  if (!fs.existsSync(SESSIONS_FILE)) fs.writeFileSync(SESSIONS_FILE, JSON.stringify({ sessions: [] }), "utf8");
}

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ── TRAINING EXAMPLE STRUCTURE ────────────────────────────────
// { input, output, intent, topic, quality, source, ts }

function addExample(input, output, intent, topic, quality = 0.7, source = "conversation") {
  ensureDataDir();
  const data = loadJSON(TRAINING_FILE);
  if (!data.examples) data.examples = [];

  // Don't duplicate near-identical inputs
  const duplicate = data.examples.some(ex =>
    ex.input.toLowerCase().slice(0, 60) === input.toLowerCase().slice(0, 60)
  );
  if (duplicate) return false;

  data.examples.push({
    id:      `ex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    input:   input.slice(0, 500),
    output:  output.slice(0, 1000),
    intent:  intent || "general",
    topic:   topic  || null,
    quality,
    source,
    ts:      new Date().toISOString(),
  });

  // Keep last 2000 examples
  if (data.examples.length > 2000) data.examples = data.examples.slice(-2000);

  // Update stats
  if (!data.stats) data.stats = {};
  data.stats[intent] = (data.stats[intent] || 0) + 1;
  data.stats._total  = (data.stats._total  || 0) + 1;
  data.stats._lastUpdated = new Date().toISOString();

  saveJSON(TRAINING_FILE, data);
  return true;
}

// ── LOG FULL SESSION ──────────────────────────────────────────
// Call this at the end of a conversation to save the whole session
function logSession(sessionId, turns, userName, userTitle) {
  ensureDataDir();
  const data = loadJSON(SESSIONS_FILE);
  if (!data.sessions) data.sessions = [];

  data.sessions.push({
    sessionId,
    userName,
    userTitle,
    turns: turns.map(t => ({
      input:   t.input  ? t.input.slice(0, 500)  : "",
      output:  t.output ? t.output.slice(0, 1000) : "",
      action:  t.action  || "UNKNOWN",
      topic:   t.topic   || null,
      quality: t.quality || 0.5,
    })),
    turnCount: turns.length,
    ts: new Date().toISOString(),
  });

  // Keep last 500 sessions
  if (data.sessions.length > 500) data.sessions = data.sessions.slice(-500);
  saveJSON(SESSIONS_FILE, data);
}

// ── SCORE RESPONSE QUALITY ────────────────────────────────────
// Heuristic scoring — no API call needed
function scoreQuality(input, output, action) {
  if (!output || output.length < 10) return 0.1;

  let score = 0.5;

  // Length — too short or too long is bad
  if (output.length > 50  && output.length < 800)  score += 0.15;
  if (output.length > 200 && output.length < 600)  score += 0.05;
  if (output.length < 20 || output.length > 2000)  score -= 0.2;

  // Good actions get higher base scores
  const goodActions = ["CODE", "TERMINAL", "KNOWLEDGE", "WEATHER", "SPOTIFY", "GMAIL", "CALENDAR", "RESEARCH", "DIY_PROJECT"];
  if (goodActions.includes(action)) score += 0.15;

  // Bad actions
  if (action === "FALLBACK") score -= 0.3;
  if (action === "ERROR")    score -= 0.4;

  // Has code block — good for code requests
  if (/\bwrite\b|\bcode\b|\bcreate\b/.test(input.toLowerCase()) && output.includes("```")) score += 0.2;

  // Addresses user by title — good sign
  if (/\bSir\b|\bMa'am\b|\bBoss\b|\bChief\b/.test(output)) score += 0.05;

  return Math.max(0, Math.min(1, score));
}

// ── BULK GENERATE TRAINING DATA ───────────────────────────────
// Uses Groq to generate synthetic training examples for weak areas
async function generateSyntheticExamples(intent, count = 5) {
  if (!Groq.isConfigured()) {
    console.log("[TRAINER] Groq not configured — skipping synthetic generation");
    return [];
  }

  console.log(`[TRAINER] Generating ${count} synthetic examples for: ${intent}`);
  try {
    const examples = await Groq.generateTrainingExamples(intent, count);
    if (!examples || !Array.isArray(examples)) return [];

    let added = 0;
    for (const ex of examples) {
      if (ex.input && ex.output) {
        const ok = addExample(ex.input, ex.output, intent, intent, 0.6, "synthetic");
        if (ok) added++;
      }
    }
    console.log(`[TRAINER] Added ${added} synthetic examples for: ${intent}`);
    return examples;
  } catch (e) {
    console.warn("[TRAINER] Synthetic generation error:", e.message);
    return [];
  }
}

// ── ANALYSE WEAK INTENTS ──────────────────────────────────────
// Finds intents with few training examples and generates more
async function reinforceWeakAreas(minExamples = 3) {
  if (!Groq.isConfigured()) return;

  const data = loadJSON(TRAINING_FILE);
  const stats = data.stats || {};

  const knownIntents = [
    "coding", "terminal", "weather", "spotify", "memory", "timer",
    "lookup_person", "diy_project", "hologram", "knowledge_science",
    "knowledge_tech", "knowledge_history", "smalltalk", "greeting",
  ];

  for (const intent of knownIntents) {
    const count = stats[intent] || 0;
    if (count < minExamples) {
      console.log(`[TRAINER] Weak area detected: ${intent} (${count} examples) — generating more`);
      await generateSyntheticExamples(intent, 5);
      // Delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// ── EXPORT TRAINING DATA ──────────────────────────────────────
// Returns examples in a format suitable for fine-tuning or prompt stuffing
function exportForPromptStuffing(intent, limit = 5) {
  const data = loadJSON(TRAINING_FILE);
  const examples = (data.examples || [])
    .filter(ex => ex.intent === intent && ex.quality >= 0.6)
    .sort((a, b) => b.quality - a.quality)
    .slice(0, limit);

  return examples.map(ex => `User: ${ex.input}\nJARVIS: ${ex.output}`).join("\n\n---\n\n");
}

// ── BUILD PROMPT WITH EXAMPLES ────────────────────────────────
// Enhances a Groq request by prepending high-quality examples
function buildEnhancedPrompt(message, intent, systemPrompt, maxExamples = 3) {
  const examples = exportForPromptStuffing(intent, maxExamples);
  if (!examples) return systemPrompt;

  return systemPrompt + `\n\nHere are examples of ideal responses for this type of request:\n\n${examples}\n\nNow respond to the user's actual message in the same style.`;
}

// ── DEDUPLICATE AND CLEAN TRAINING DATA ───────────────────────
function cleanTrainingData() {
  ensureDataDir();
  const data = loadJSON(TRAINING_FILE);
  if (!data.examples) return 0;

  const seen   = new Set();
  const before = data.examples.length;

  data.examples = data.examples.filter(ex => {
    const key = ex.input.toLowerCase().slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Remove very low quality examples
  data.examples = data.examples.filter(ex => ex.quality >= 0.3);

  saveJSON(TRAINING_FILE, data);
  const removed = before - data.examples.length;
  console.log(`[TRAINER] Cleaned training data: removed ${removed} duplicates/low-quality`);
  return removed;
}

// ── GET STATS ─────────────────────────────────────────────────
function getStats() {
  ensureDataDir();
  const training = loadJSON(TRAINING_FILE);
  const sessions = loadJSON(SESSIONS_FILE);

  const examples = training.examples || [];
  const avgQuality = examples.length
    ? examples.reduce((s, e) => s + e.quality, 0) / examples.length
    : 0;

  return {
    totalExamples:    examples.length,
    totalSessions:    (sessions.sessions || []).length,
    avgQuality:       parseFloat(avgQuality.toFixed(3)),
    byIntent:         training.stats || {},
    sources: {
      conversation:   examples.filter(e => e.source === "conversation").length,
      groq:           examples.filter(e => e.source === "groq").length,
      synthetic:      examples.filter(e => e.source === "synthetic").length,
    },
    lastUpdated:      training.stats?._lastUpdated || null,
  };
}

// ── RETRIEVE BEST EXAMPLES FOR A MESSAGE ──────────────────────
function findRelevantExamples(message, limit = 3) {
  const data = loadJSON(TRAINING_FILE);
  const words = new Set(
    message.toLowerCase()
      .split(/\s+/)
      .filter(w => w.length > 3)
  );

  const scored = (data.examples || [])
    .filter(ex => ex.quality >= 0.6)
    .map(ex => {
      const exWords = ex.input.toLowerCase().split(/\s+/);
      const overlap = exWords.filter(w => words.has(w)).length;
      return { ...ex, relevance: overlap };
    })
    .filter(ex => ex.relevance > 0)
    .sort((a, b) => b.relevance * b.quality - a.relevance * a.quality)
    .slice(0, limit);

  return scored;
}

// ── BACKGROUND TRAINING LOOP ──────────────────────────────────
let _trainingLoop = null;

function startTrainingLoop(intervalMs = 15 * 60 * 1000) {
  if (_trainingLoop) return;

  console.log("[TRAINER] Starting background training loop...");

  _trainingLoop = setInterval(async () => {
    try {
      cleanTrainingData();
      await reinforceWeakAreas(3);
    } catch (e) {
      console.warn("[TRAINER] Background loop error:", e.message);
    }
  }, intervalMs);

  return _trainingLoop;
}

function stopTrainingLoop() {
  if (_trainingLoop) {
    clearInterval(_trainingLoop);
    _trainingLoop = null;
  }
}

module.exports = {
  addExample,
  logSession,
  scoreQuality,
  generateSyntheticExamples,
  reinforceWeakAreas,
  exportForPromptStuffing,
  buildEnhancedPrompt,
  cleanTrainingData,
  getStats,
  findRelevantExamples,
  startTrainingLoop,
  stopTrainingLoop,
};
