"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Own Brain (v1.0)
//
// This is JARVIS's actual own model — not a wrapper around Ollama,
// not a wrapper around Groq. own-brain-network.js is a from-scratch
// character RNN trained with real backprop; this file is the layer
// that:
//   1. Persists that network's weights to disk so it survives
//      restarts and keeps improving over time.
//   2. Gives it a real memory: exact/near-exact Q→A pairs it has
//      been taught get stored verbatim and are the first thing
//      checked (a tiny model's free generation is not reliable
//      enough to trust for facts — the memory IS the reliable
//      part, and it's real, it's just retrieval instead of
//      generation).
//   3. Falls back to free generation from the RNN only once
//      there's enough real training volume behind it, and even
//      then reports a conservative confidence score.
//
// Nothing here calls any cloud API. local-brain.js is the module
// that decides when to escalate to Groq/research — this file only
// knows how to learn and how to (try to) answer on its own.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const { RNNLanguageModel } = require("./own-brain-network");

const DATA_DIR     = path.join(__dirname, "data", "own-brain");
const WEIGHTS_FILE = path.join(DATA_DIR, "weights.json");
const MEMORY_FILE  = path.join(DATA_DIR, "memory.json"); // exact-answer store, JARVIS's own words

const HIDDEN_SIZE = parseInt(process.env.OWNBRAIN_HIDDEN_SIZE || "", 10) || 128;
// Below this many taught examples, free generation is essentially
// noise — don't show it to the user as an "answer", just say we
// don't know yet so local-brain.js escalates instead.
const MIN_EXAMPLES_FOR_GENERATION = parseInt(process.env.OWNBRAIN_MIN_EXAMPLES || "", 10) || 300;

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ── SINGLETON MODEL, LOADED ONCE PER PROCESS ───────────────────
let _model = null;
let _memory = null; // { entries: [{ key, question, answer, source, quality, ts, hits }] }
let _dirty = false; // whether weights need saving

function loadModel() {
  if (_model) return _model;
  ensureDirs();
  try {
    if (fs.existsSync(WEIGHTS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(WEIGHTS_FILE, "utf8"));
      const restored = RNNLanguageModel.fromJSON(raw);
      if (restored) {
        _model = restored;
        console.log(`[OWN-BRAIN] Loaded weights — ${_model.totalCharsTrained} chars trained so far, loss ${_model.smoothLoss.toFixed(3)}`);
        return _model;
      }
    }
  } catch (e) {
    console.warn("[OWN-BRAIN] Couldn't load saved weights, starting fresh:", e.message);
  }
  _model = new RNNLanguageModel(HIDDEN_SIZE);
  console.log("[OWN-BRAIN] Starting a brand new brain (no prior weights found).");
  return _model;
}

function loadMemory() {
  if (_memory) return _memory;
  ensureDirs();
  try {
    if (fs.existsSync(MEMORY_FILE)) {
      _memory = JSON.parse(fs.readFileSync(MEMORY_FILE, "utf8"));
    }
  } catch { /* fall through to fresh memory */ }
  if (!_memory || !Array.isArray(_memory.entries)) _memory = { entries: [] };
  return _memory;
}

function saveWeights() {
  ensureDirs();
  const model = loadModel();
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(model.toJSON()), "utf8");
  _dirty = false;
}
function saveMemory() {
  ensureDirs();
  fs.writeFileSync(MEMORY_FILE, JSON.stringify(loadMemory(), null, 2), "utf8");
}

function normalize(text) {
  return String(text || "").toLowerCase().trim().replace(/[^\w\s]/g, "").replace(/\s+/g, " ");
}

// ── MEMORY (retrieval) ─────────────────────────────────────────
function rememberAnswer(question, answer, source = "groq") {
  const mem = loadMemory();
  const key = normalize(question);
  if (!key || !answer) return;

  const existing = mem.entries.find(e => e.key === key);
  if (existing) {
    existing.answer = answer;
    existing.source = source;
    existing.ts = new Date().toISOString();
  } else {
    mem.entries.push({
      key, question: question.slice(0, 500), answer: answer.slice(0, 1500),
      source, ts: new Date().toISOString(), hits: 0,
    });
    // Keep the memory store bounded — oldest, least-used entries go first.
    if (mem.entries.length > 5000) {
      mem.entries.sort((a, b) => (a.hits - b.hits) || (new Date(a.ts) - new Date(b.ts)));
      mem.entries = mem.entries.slice(mem.entries.length - 5000);
    }
  }
  saveMemory();
}

function recallAnswer(question) {
  const mem = loadMemory();
  const key = normalize(question);
  if (!key) return null;

  // exact match first
  let hit = mem.entries.find(e => e.key === key);

  // otherwise, near match by word overlap (same idea trainer.js already
  // uses for findRelevantExamples — kept independent here so own-brain
  // doesn't have to depend on trainer.js's file format)
  if (!hit) {
    const words = new Set(key.split(" ").filter(w => w.length > 3));
    if (words.size) {
      let best = null, bestScore = 0;
      for (const e of mem.entries) {
        const eWords = e.key.split(" ").filter(w => w.length > 3);
        if (!eWords.length) continue;
        const overlap = eWords.filter(w => words.has(w)).length;
        const score = overlap / Math.max(eWords.length, words.size);
        if (score > bestScore) { bestScore = score; best = e; }
      }
      if (best && bestScore >= 0.6) hit = best;
    }
  }

  if (!hit) return null;
  hit.hits = (hit.hits || 0) + 1;
  saveMemory();
  return hit;
}

// ── LEARNING ────────────────────────────────────────────────────
// Called by local-brain.js whenever Groq or research produces a
// good answer, and by own-brain-trainer.js's background loop for
// bulk replay of everything JARVIS has been taught so far.
function learnFromExchange(question, answer, source = "groq") {
  if (!question || !answer) return;
  rememberAnswer(question, answer, source);
  const model = loadModel();
  const text = `Q: ${question.trim()}\nA: ${answer.trim()}\n\n`;
  model.trainOnText(text);
  _dirty = true;
}

// Bulk-train on an arbitrary block of text (used by the background
// loop to replay trainer.js's training_data.json / self-improve.js's
// knowledge.json so the RNN keeps learning from everything JARVIS
// has already picked up, not just brand-new exchanges).
function learnText(text) {
  if (!text || text.length < 2) return;
  const model = loadModel();
  model.trainOnText(text);
  _dirty = true;
}

function flushIfDirty() {
  if (_dirty) saveWeights();
}

// ── CONFIDENCE HEURISTIC ────────────────────────────────────────
// Deliberately conservative. A few hundred taught examples is
// nowhere near enough for a ~128-unit char RNN to be a reliable
// generator of facts — this keeps free generation from being shown
// as a confident answer until there's real volume behind it, and
// even then caps out well short of "trust me over Groq."
function generationConfidence() {
  const model = loadModel();
  const n = model.totalCharsTrained;
  if (n < MIN_EXAMPLES_FOR_GENERATION * 40) return 0; // ~40 chars/example rough floor
  if (n < 20000)  return 0.15;
  if (n < 100000) return 0.30;
  if (n < 500000) return 0.45;
  return 0.55; // deliberately never higher — this model's ceiling is low by design
}

// ── PUBLIC: try to answer on our own ────────────────────────────
// Returns { text, confidence, via } — via is "memory" | "generation" | "none"
function answer(message) {
  const recalled = recallAnswer(message);
  if (recalled) {
    return { text: recalled.answer, confidence: 0.9, via: "memory" };
  }

  const genConfidence = generationConfidence();
  if (genConfidence <= 0) {
    return { text: null, confidence: 0, via: "none" };
  }

  const model = loadModel();
  const generated = model.generate(`Q: ${message.trim()}\nA:`, 220, 0.55);
  const cleaned = generated.split("\n")[0].trim();
  if (!cleaned || cleaned.length < 3) {
    return { text: null, confidence: 0, via: "none" };
  }
  return { text: cleaned, confidence: genConfidence, via: "generation" };
}

function getStats() {
  const model = loadModel();
  const mem = loadMemory();
  return {
    totalCharsTrained: model.totalCharsTrained,
    smoothLoss: parseFloat(model.smoothLoss.toFixed(4)),
    memoryEntries: mem.entries.length,
    generationConfidence: generationConfidence(),
    readyForGeneration: generationConfidence() > 0,
  };
}

module.exports = {
  answer,
  learnFromExchange,
  learnText,
  recallAnswer,
  rememberAnswer,
  flushIfDirty,
  saveWeights,
  getStats,
  ensureDirs,
};
