"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Own Brain: Background Training Loop
//
// own-brain.js's RNN doesn't train itself off in the void — this
// is what actually feeds it. Every so often it looks at:
//   - trainer.js's data/training_data.json  (every Q/A JARVIS has
//     logged, from conversation, Groq tutoring, or research)
//   - self-improve.js's data/knowledge.json  (facts learned per
//     topic, mostly from the research fallback)
// ...and trains the RNN on anything it hasn't seen yet, tracked by
// a small cursor file so restarts don't replay the entire history
// every single loop.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const OwnBrain = require("./own-brain");

const DATA_DIR    = path.join(__dirname, "data");
const CURSOR_FILE = path.join(__dirname, "data", "own-brain", "cursor.json");

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return fallback; }
}
function saveJSON(file, data) {
  OwnBrain.ensureDirs();
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function loadCursor() {
  return loadJSON(CURSOR_FILE, { lastTrainingExampleId: null, knowledgeTopicsSeenAt: {} });
}

function processTrainingExamples(cursor) {
  const data = loadJSON(path.join(DATA_DIR, "training_data.json"), { examples: [] });
  const examples = data.examples || [];
  if (!examples.length) return 0;

  let startIdx = 0;
  if (cursor.lastTrainingExampleId) {
    const idx = examples.findIndex(e => e.id === cursor.lastTrainingExampleId);
    if (idx >= 0) startIdx = idx + 1;
  }

  const toTrain = examples.slice(startIdx).filter(e => e.quality >= 0.5);
  for (const ex of toTrain) {
    OwnBrain.learnText(`Q: ${ex.input}\nA: ${ex.output}\n\n`);
    // Only groq/research-sourced answers become part of own-brain's
    // exact-recall memory — conversational chatter (smalltalk, tool
    // calls) is fine to *train the RNN's sense of language* on, but
    // isn't a fact worth recalling verbatim later.
    if (ex.source === "groq-tutor" || ex.source === "research" || ex.source === "groq") {
      OwnBrain.rememberAnswer(ex.input, ex.output, ex.source);
    }
  }
  if (examples.length) cursor.lastTrainingExampleId = examples[examples.length - 1].id;
  return toTrain.length;
}

function processKnowledgeFacts(cursor) {
  const data = loadJSON(path.join(DATA_DIR, "knowledge.json"), { topics: {} });
  const topics = data.topics || {};
  if (!cursor.knowledgeTopicsSeenAt) cursor.knowledgeTopicsSeenAt = {};

  let trained = 0;
  for (const [key, entry] of Object.entries(topics)) {
    const lastSeen = cursor.knowledgeTopicsSeenAt[key];
    if (lastSeen === entry.lastUpdated) continue; // nothing new for this topic

    const facts = (entry.facts || []).join(" ");
    if (facts) {
      OwnBrain.learnText(`Q: what do you know about ${entry.topic}?\nA: ${facts}\n\n`);
      OwnBrain.rememberAnswer(`what do you know about ${entry.topic}`, facts, "knowledge-base");
      trained++;
    }
    cursor.knowledgeTopicsSeenAt[key] = entry.lastUpdated;
  }
  return trained;
}

async function runOnce() {
  const cursor = loadCursor();
  try {
    const nExamples = processTrainingExamples(cursor);
    const nFacts = processKnowledgeFacts(cursor);
    if (nExamples || nFacts) {
      OwnBrain.flushIfDirty();
      const stats = OwnBrain.getStats();
      console.log(`[OWN-BRAIN] Trained on ${nExamples} new example(s) + ${nFacts} fact update(s). ` +
        `Total chars trained: ${stats.totalCharsTrained}, loss: ${stats.smoothLoss}, memory entries: ${stats.memoryEntries}.`);
    }
    saveJSON(CURSOR_FILE, cursor);
  } catch (e) {
    console.warn("[OWN-BRAIN] Training loop error:", e.message);
  }
}

let _loop = null;
function startOwnBrainTraining(intervalMs = 10 * 60 * 1000) {
  if (_loop) return;
  console.log("[OWN-BRAIN] Starting background training loop...");
  // Run once shortly after boot so a fresh install doesn't wait a
  // full interval before its first pass over existing data.
  setTimeout(() => runOnce(), 15 * 1000);
  _loop = setInterval(runOnce, intervalMs);
  return _loop;
}
function stopOwnBrainTraining() {
  if (_loop) { clearInterval(_loop); _loop = null; }
}

module.exports = { runOnce, startOwnBrainTraining, stopOwnBrainTraining };
