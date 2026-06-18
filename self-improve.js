"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Self-Improvement Engine
// Watches for failures, learns patterns, generates new handlers
// Stores learned knowledge in data/learned/ directory
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const Groq = require("./groq-engine");

// ── STORAGE PATHS ─────────────────────────────────────────────
const DATA_DIR     = path.join(__dirname, "data");
const LEARNED_DIR  = path.join(DATA_DIR, "learned");
const FAILURES_FILE = path.join(DATA_DIR, "failures.json");
const PATTERNS_FILE = path.join(DATA_DIR, "patterns.json");
const KNOWLEDGE_FILE = path.join(DATA_DIR, "knowledge.json");
const HANDLERS_FILE = path.join(DATA_DIR, "learned_handlers.json");

function ensureDirs() {
  [DATA_DIR, LEARNED_DIR].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });
  [FAILURES_FILE, PATTERNS_FILE, KNOWLEDGE_FILE, HANDLERS_FILE].forEach(f => {
    if (!fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({}), "utf8");
  });
}

function loadJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return {}; }
}
function saveJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

// ── FAILURE TRACKER ───────────────────────────────────────────
// Records every time JARVIS gives a bad/fallback response
const failures = {
  log(message, response, action, sessionId) {
    ensureDirs();
    const data = loadJSON(FAILURES_FILE);
    if (!data.failures) data.failures = [];
    
    const entry = {
      id: `f${Date.now()}`,
      message: message.slice(0, 500),
      response: response.slice(0, 500),
      action,
      sessionId,
      timestamp: new Date().toISOString(),
      analyzed: false,
      improved: false,
    };
    
    data.failures.push(entry);
    // Keep last 500 failures
    if (data.failures.length > 500) data.failures = data.failures.slice(-500);
    data.totalFailures = (data.totalFailures || 0) + 1;
    
    saveJSON(FAILURES_FILE, data);
    console.log(`[IMPROVE] Failure logged: "${message.slice(0, 50)}..." (action: ${action})`);
    
    // Trigger async analysis if Groq is available
    if (Groq.isConfigured()) {
      this.analyzeAsync(entry).catch(e => console.warn("[IMPROVE] Async analysis failed:", e.message));
    }
    
    return entry.id;
  },

  async analyzeAsync(entry) {
    try {
      const analysis = await Groq.analyzeIntent(entry.message, entry.response);
      
      // Save analysis back to failure entry
      const data = loadJSON(FAILURES_FILE);
      const idx = data.failures?.findIndex(f => f.id === entry.id);
      if (idx >= 0) {
        data.failures[idx].analysis = analysis;
        data.failures[idx].analyzed = true;
        saveJSON(FAILURES_FILE, data);
      }

      // If confidence is high enough, learn from it
      if (analysis.confidence > 0.6) {
        await patterns.learn(entry.message, analysis);
      }
    } catch (e) {
      console.warn("[IMPROVE] Analysis error:", e.message);
    }
  },

  getUnanalyzed(limit = 10) {
    const data = loadJSON(FAILURES_FILE);
    return (data.failures || []).filter(f => !f.analyzed).slice(0, limit);
  },

  getStats() {
    const data = loadJSON(FAILURES_FILE);
    const all = data.failures || [];
    return {
      total: data.totalFailures || 0,
      recent: all.slice(-20).length,
      analyzed: all.filter(f => f.analyzed).length,
      improved: all.filter(f => f.improved).length,
    };
  }
};

// ── PATTERN LEARNER ───────────────────────────────────────────
// Learns which types of messages need which types of responses
const patterns = {
  async learn(message, analysis) {
    ensureDirs();
    const data = loadJSON(PATTERNS_FILE);
    if (!data.patterns) data.patterns = {};
    
    const category = analysis.category || "unknown";
    if (!data.patterns[category]) data.patterns[category] = [];
    
    // Check if we already have a very similar pattern
    const exists = data.patterns[category].some(p => 
      p.keywords.some(k => analysis.keywords.includes(k)) &&
      p.intent === analysis.intent
    );
    
    if (!exists) {
      data.patterns[category].push({
        id: `p${Date.now()}`,
        intent: analysis.intent,
        keywords: analysis.keywords,
        suggestedHandler: analysis.suggestedHandler,
        exampleMessage: message,
        learnedAt: new Date().toISOString(),
        useCount: 0,
      });
      
      saveJSON(PATTERNS_FILE, data);
      console.log(`[IMPROVE] New pattern learned: ${category} - ${analysis.intent}`);
      
      // If we have enough failures of same type, generate a handler
      const categoryPatterns = data.patterns[category];
      if (categoryPatterns.length >= 3 && Groq.isConfigured()) {
        await handlers.generate(category, categoryPatterns.slice(-3));
      }
    }
  },

  match(message) {
    const data = loadJSON(PATTERNS_FILE);
    const lower = message.toLowerCase();
    const words = new Set(lower.split(/\s+/));
    
    let bestMatch = null;
    let bestScore = 0;
    
    for (const [category, patternList] of Object.entries(data.patterns || {})) {
      for (const pattern of patternList) {
        const matchedKeywords = pattern.keywords.filter(k => 
          lower.includes(k.toLowerCase()) || words.has(k.toLowerCase())
        );
        const score = matchedKeywords.length / Math.max(pattern.keywords.length, 1);
        
        if (score > bestScore && score > 0.4) {
          bestScore = score;
          bestMatch = { ...pattern, category, score };
        }
      }
    }
    
    return bestMatch;
  },

  getAll() {
    return loadJSON(PATTERNS_FILE).patterns || {};
  }
};

// ── KNOWLEDGE BASE ────────────────────────────────────────────
// Stores facts JARVIS learns from conversations and research
const knowledge = {
  store(topic, facts, source = "conversation") {
    ensureDirs();
    const data = loadJSON(KNOWLEDGE_FILE);
    if (!data.topics) data.topics = {};
    
    const key = topic.toLowerCase().trim();
    if (!data.topics[key]) {
      data.topics[key] = {
        topic,
        facts: [],
        sources: [],
        firstLearned: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        queryCount: 0,
      };
    }
    
    // Add new facts, avoid duplicates
    for (const fact of (Array.isArray(facts) ? facts : [facts])) {
      if (fact && !data.topics[key].facts.includes(fact)) {
        data.topics[key].facts.push(fact);
      }
    }
    
    if (!data.topics[key].sources.includes(source)) {
      data.topics[key].sources.push(source);
    }
    
    data.topics[key].lastUpdated = new Date().toISOString();
    // Keep max 20 facts per topic
    if (data.topics[key].facts.length > 20) {
      data.topics[key].facts = data.topics[key].facts.slice(-20);
    }
    
    saveJSON(KNOWLEDGE_FILE, data);
    return true;
  },

  lookup(topic) {
    const data = loadJSON(KNOWLEDGE_FILE);
    const key = topic.toLowerCase().trim();
    const entry = data.topics?.[key];
    
    if (entry) {
      // Increment query count
      const d = loadJSON(KNOWLEDGE_FILE);
      if (d.topics?.[key]) {
        d.topics[key].queryCount = (d.topics[key].queryCount || 0) + 1;
        saveJSON(KNOWLEDGE_FILE, d);
      }
      return entry;
    }
    
    // Fuzzy search
    const topics = Object.keys(data.topics || {});
    const fuzzy = topics.find(t => 
      t.includes(key) || key.includes(t) ||
      t.split(" ").some(w => key.includes(w) && w.length > 3)
    );
    
    return fuzzy ? data.topics[fuzzy] : null;
  },

  getTopTopics(limit = 10) {
    const data = loadJSON(KNOWLEDGE_FILE);
    return Object.values(data.topics || {})
      .sort((a, b) => (b.queryCount || 0) - (a.queryCount || 0))
      .slice(0, limit);
  },

  getStats() {
    const data = loadJSON(KNOWLEDGE_FILE);
    const topics = Object.keys(data.topics || {});
    return {
      topicCount: topics.length,
      totalFacts: Object.values(data.topics || {}).reduce((s, t) => s + t.facts.length, 0),
    };
  }
};

// ── HANDLER GENERATOR ─────────────────────────────────────────
// Uses Groq to write new JavaScript handler code for gaps
const handlers = {
  async generate(category, patternList) {
    if (!Groq.isConfigured()) return null;
    
    console.log(`[IMPROVE] Generating new handler for category: ${category}`);
    
    const examples = patternList.map(p => 
      `- "${p.exampleMessage}" → needs: ${p.suggestedHandler}`
    ).join("\n");

    const prompt = `Generate a JavaScript handler function for J.A.R.V.I.S that handles these types of requests:
Category: ${category}
Examples:
${examples}

The function should:
1. Be named "handle${category.charAt(0).toUpperCase() + category.slice(1)}"
2. Accept (message, userTitle) parameters
3. Return { reply: string } or null if it can't handle the message
4. Handle all the example cases above
5. Use module.exports at the bottom

Write the complete handler function now:`;

    try {
      const code = await Groq.generateCode(prompt);
      
      if (!code || code.length < 50) {
        console.warn("[IMPROVE] Generated code too short, skipping");
        return null;
      }

      // Save the generated handler
      const handlerFile = path.join(LEARNED_DIR, `handler_${category}_${Date.now()}.js`);
      fs.writeFileSync(handlerFile, code, "utf8");
      
      // Register in handlers index
      const data = loadJSON(HANDLERS_FILE);
      if (!data.handlers) data.handlers = [];
      data.handlers.push({
        id: `h${Date.now()}`,
        category,
        file: handlerFile,
        patterns: patternList.map(p => p.intent),
        generatedAt: new Date().toISOString(),
        usageCount: 0,
        successRate: null,
      });
      saveJSON(HANDLERS_FILE, data);
      
      console.log(`[IMPROVE] Handler generated for ${category}: ${handlerFile}`);
      return { code, file: handlerFile };
    } catch (e) {
      console.error("[IMPROVE] Handler generation failed:", e.message);
      return null;
    }
  },

  // Try all learned handlers against a message
  tryAll(message, userTitle) {
    const data = loadJSON(HANDLERS_FILE);
    
    for (const handlerMeta of (data.handlers || [])) {
      try {
        if (!fs.existsSync(handlerMeta.file)) continue;
        
        // Clear require cache to get latest version
        delete require.cache[require.resolve(handlerMeta.file)];
        const handler = require(handlerMeta.file);
        
        // Find the exported function
        const fn = typeof handler === "function" ? handler :
          Object.values(handler).find(v => typeof v === "function");
        
        if (!fn) continue;
        
        const result = fn(message, userTitle);
        if (result && result.reply) {
          // Track usage
          const d = loadJSON(HANDLERS_FILE);
          const idx = d.handlers.findIndex(h => h.id === handlerMeta.id);
          if (idx >= 0) {
            d.handlers[idx].usageCount = (d.handlers[idx].usageCount || 0) + 1;
            saveJSON(HANDLERS_FILE, d);
          }
          
          console.log(`[IMPROVE] Learned handler matched for: ${handlerMeta.category}`);
          return { ...result, source: "learned", handlerId: handlerMeta.id };
        }
      } catch (e) {
        console.warn(`[IMPROVE] Handler ${handlerMeta.id} errored:`, e.message);
      }
    }
    
    return null;
  },

  getAll() {
    return loadJSON(HANDLERS_FILE).handlers || [];
  }
};

// ── CONVERSATION LEARNER ──────────────────────────────────────
// Extracts knowledge from successful conversations
const conversationLearner = {
  async learnFromSuccess(message, response, topic) {
    if (!Groq.isConfigured() || !topic) return;
    
    try {
      const extracted = await Groq.extractKnowledge(response, topic);
      if (extracted.facts && extracted.facts.length > 0) {
        knowledge.store(topic, extracted.facts, "conversation");
        console.log(`[IMPROVE] Learned ${extracted.facts.length} facts about: ${topic}`);
      }
    } catch (e) {
      console.warn("[IMPROVE] Knowledge extraction failed:", e.message);
    }
  },

  async processConversationBatch(conversations) {
    let learned = 0;
    for (const conv of conversations) {
      if (conv.topic && conv.response && conv.action !== "FALLBACK") {
        await this.learnFromSuccess(conv.message, conv.response, conv.topic);
        learned++;
      }
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 200));
    }
    return learned;
  }
};

// ── BACKGROUND IMPROVEMENT LOOP ───────────────────────────────
// Runs periodically to process failures and improve
let _improvementLoop = null;

function startImprovementLoop(intervalMs = 5 * 60 * 1000) {
  if (_improvementLoop) return;
  
  console.log("[IMPROVE] Starting self-improvement loop...");
  
  _improvementLoop = setInterval(async () => {
    if (!Groq.isConfigured()) return;
    
    try {
      // Process unanalyzed failures
      const unanalyzed = failures.getUnanalyzed(5);
      if (unanalyzed.length > 0) {
        console.log(`[IMPROVE] Processing ${unanalyzed.length} unanalyzed failures...`);
        for (const failure of unanalyzed) {
          await failures.analyzeAsync(failure);
          await new Promise(r => setTimeout(r, 500));
        }
      }
    } catch (e) {
      console.warn("[IMPROVE] Loop error:", e.message);
    }
  }, intervalMs);
  
  return _improvementLoop;
}

function stopImprovementLoop() {
  if (_improvementLoop) {
    clearInterval(_improvementLoop);
    _improvementLoop = null;
  }
}

// ── STATS ─────────────────────────────────────────────────────
function getStats() {
  ensureDirs();
  return {
    failures: failures.getStats(),
    knowledge: knowledge.getStats(),
    handlers: handlers.getAll().length,
    patterns: Object.keys(patterns.getAll()).reduce((s, k) => s + patterns.getAll()[k].length, 0),
    groqConfigured: Groq.isConfigured(),
  };
}

module.exports = {
  failures,
  patterns,
  knowledge,
  handlers,
  conversationLearner,
  startImprovementLoop,
  stopImprovementLoop,
  getStats,
  ensureDirs,
};
