"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Research Engine
// Uses DuckDuckGo Instant Answer API + Wikipedia API
// Zero API keys. Zero credits. Zero limits.
// ═══════════════════════════════════════════════════════════════

// ── SIMPLE CACHE ─────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  // Keep cache from growing unbounded
  if (cache.size > 200) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
}

// ── TEXT CLEANER ─────────────────────────────────────────────
function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, " ")           // strip HTML tags
    .replace(/\[\d+\]/g, "")            // strip Wikipedia citation numbers [1]
    .replace(/\s+/g, " ")               // collapse whitespace
    .replace(/\\n/g, " ")
    .trim();
}

function truncate(text, maxChars = 600) {
  if (!text || text.length <= maxChars) return text;
  // Cut at last sentence boundary within limit
  const cut = text.slice(0, maxChars);
  const lastDot = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastDot > maxChars * 0.6 ? cut.slice(0, lastDot + 1) : cut + "…";
}

// ── EXTRACT SEARCH QUERY ─────────────────────────────────────
// Pulls the core topic from a natural language question
function extractQuery(text) {
  return text
    .toLowerCase()
    .replace(/^(what is|what are|who is|who was|how does|how do|why does|why do|when did|when was|where is|where was|tell me about|explain|describe|define|what happened to|what caused|how was|give me info on|give me information about|i want to know about|can you tell me about|do you know about)\s+/i, "")
    .replace(/\?+$/, "")
    .replace(/,?\s+(please|jarvis|sir|thanks)$/i, "")
    .trim();
}

// ═══════════════════════════════════════════════════════════════
// ── DUCKDUCKGO INSTANT ANSWER API ────────────────────────────
// Free, no key, returns structured answers for many topics
// ═══════════════════════════════════════════════════════════════
async function searchDuckDuckGo(query) {
  const cacheKey = `ddg:${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "JARVIS-Assistant/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;

    const data = await res.json();

    const result = {
      abstract:      cleanText(data.Abstract)      || null,
      abstractSource: data.AbstractSource           || null,
      definition:    cleanText(data.Definition)    || null,
      answer:        cleanText(data.Answer)         || null,
      relatedTopics: [],
      infobox:       null,
      type:          data.Type                     || null,
    };

    // Extract related topic summaries
    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const t of data.RelatedTopics.slice(0, 4)) {
        if (t.Text && t.Text.length > 20) {
          result.relatedTopics.push(cleanText(t.Text));
        }
      }
    }

    // Extract infobox key facts
    if (data.Infobox && data.Infobox.content) {
      const facts = {};
      for (const item of data.Infobox.content.slice(0, 6)) {
        if (item.label && item.value) {
          facts[item.label] = cleanText(String(item.value));
        }
      }
      if (Object.keys(facts).length) result.infobox = facts;
    }

    // Only cache if we got something useful
    const hasContent = result.abstract || result.definition || result.answer || result.relatedTopics.length;
    if (hasContent) setCache(cacheKey, result);

    return hasContent ? result : null;
  } catch (e) {
    console.warn("[RESEARCH] DuckDuckGo error:", e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// ── WIKIPEDIA API ────────────────────────────────────────────
// Free, no key, excellent for factual topics
// ═══════════════════════════════════════════════════════════════
async function searchWikipedia(query) {
  const cacheKey = `wiki:${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    // Step 1: Search for the best matching article title
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;
    const searchRes = await fetch(searchUrl, {
      headers: { "User-Agent": "JARVIS-Assistant/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const hits = searchData?.query?.search;
    if (!hits || hits.length === 0) return null;

    const title = hits[0].title;

    // Step 2: Get the extract (summary) for that article
    const extractUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=true&explaintext=true&format=json&origin=*`;
    const extractRes = await fetch(extractUrl, {
      headers: { "User-Agent": "JARVIS-Assistant/1.0" },
      signal: AbortSignal.timeout(5000),
    });
    if (!extractRes.ok) return null;

    const extractData = await extractRes.json();
    const pages = extractData?.query?.pages;
    if (!pages) return null;

    const page = Object.values(pages)[0];
    if (!page || page.missing) return null;

    const extract = cleanText(page.extract || "");
    if (!extract || extract.length < 30) return null;

    const result = {
      title: page.title,
      extract: truncate(extract, 800),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    };

    setCache(cacheKey, result);
    return result;
  } catch (e) {
    console.warn("[RESEARCH] Wikipedia error:", e.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// ── KNOWLEDGE SYNTHESIZER ────────────────────────────────────
// Takes raw API results and builds a JARVIS-style response
// ═══════════════════════════════════════════════════════════════
const PERSONALITY = {
  openers: [
    "Here's what I found on that —",
    "Pulling from live sources —",
    "Research complete —",
    "I looked that up —",
    "Here's what I have on",
  ],
  sourceLabels: {
    wikipedia: "via Wikipedia",
    duckduckgo: "via DuckDuckGo",
    combined: "cross-referenced sources",
  },
  connectors: [
    "Beyond that,", "Additionally,", "Worth noting:", "Furthermore,",
    "On top of that,", "It's also the case that,",
  ],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function synthesizeResponse(query, ddgResult, wikiResult, userTitle) {
  const T = userTitle || "Sir";
  const parts = [];

  // Primary content — prefer Wikipedia extract for depth, DDG for quick answers
  let primaryText = null;
  let source = null;

  if (ddgResult?.answer) {
    // DDG gave a direct factual answer (e.g. "What is the capital of France?")
    primaryText = ddgResult.answer;
    source = "duckduckgo";
  } else if (wikiResult?.extract && wikiResult.extract.length > 100) {
    // Wikipedia has a solid article
    primaryText = truncate(wikiResult.extract, 500);
    source = "wikipedia";
  } else if (ddgResult?.abstract && ddgResult.abstract.length > 50) {
    primaryText = truncate(ddgResult.abstract, 400);
    source = "duckduckgo";
  } else if (ddgResult?.definition) {
    primaryText = ddgResult.definition;
    source = "duckduckgo";
  }

  if (!primaryText && ddgResult?.relatedTopics?.length) {
    primaryText = ddgResult.relatedTopics[0];
    source = "duckduckgo";
  }

  if (!primaryText) return null; // Nothing found

  // Build the opener
  const opener = pick(PERSONALITY.openers);
  const topicLabel = wikiResult?.title || query;

  if (Math.random() > 0.4) {
    parts.push(`${opener} ${topicLabel}:`);
  }

  parts.push(primaryText);

  // Add infobox facts if available and relevant
  if (ddgResult?.infobox && source !== "duckduckgo") {
    const infoFacts = Object.entries(ddgResult.infobox).slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`)
      .join(", ");
    if (infoFacts) {
      parts.push(`${pick(PERSONALITY.connectors)} ${infoFacts}.`);
    }
  }

  // Add a related topic snippet if we have room
  if (ddgResult?.relatedTopics?.length > 1 && primaryText.length < 300) {
    const extra = ddgResult.relatedTopics[1];
    if (extra && extra.length > 30 && !primaryText.includes(extra.slice(0, 30))) {
      parts.push(`${pick(PERSONALITY.connectors)} ${truncate(extra, 150)}`);
    }
  }

  // Personalise the ending
  const sourceNote = source === "wikipedia"
    ? `Source: Wikipedia — "${wikiResult.title}".`
    : "";

  let response = parts.filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
  if (!response.match(/[.!?]$/)) response += ".";

  if (sourceNote && Math.random() > 0.5) response += ` ${sourceNote}`;
  if (Math.random() > 0.55) response += ` ${T}.`;

  return response;
}

// ═══════════════════════════════════════════════════════════════
// ── MAIN RESEARCH FUNCTION ───────────────────────────────────
// Called by server.js when JARVIS returns FALLBACK or KNOWLEDGE
// with no local match
// ═══════════════════════════════════════════════════════════════
async function research(rawQuery, userTitle) {
  const query = extractQuery(rawQuery);
  if (!query || query.length < 2) return null;

  console.log(`[RESEARCH] Searching: "${query}"`);

  // Run both in parallel for speed
  const [ddgResult, wikiResult] = await Promise.allSettled([
    searchDuckDuckGo(query),
    searchWikipedia(query),
  ]);

  const ddg  = ddgResult.status  === "fulfilled" ? ddgResult.value  : null;
  const wiki = wikiResult.status === "fulfilled" ? wikiResult.value : null;

  if (!ddg && !wiki) {
    console.log(`[RESEARCH] No results found for: "${query}"`);
    return null;
  }

  const response = synthesizeResponse(query, ddg, wiki, userTitle);
  if (!response) return null;

  console.log(`[RESEARCH] Found answer for: "${query}" (DDG: ${!!ddg}, Wiki: ${!!wiki})`);

  return {
    reply:   response,
    sources: {
      ddg:  !!ddg,
      wiki: !!wiki,
      wikiTitle: wiki?.title || null,
      wikiUrl:   wiki?.url   || null,
    },
    query,
  };
}

// ── SHOULD WE RESEARCH? ──────────────────────────────────────
// Determines if a message is the kind of thing worth looking up
function shouldResearch(text) {
  const lower = text.toLowerCase();

  // Strong research signals
  if (/^(what is|what are|who is|who was|when did|when was|where is|where was|how does|how did|why does|why did|tell me about|explain|define|describe)\b/i.test(lower)) return true;
  if (/\b(history|invention|discovery|founded|created|born|died|meaning of|definition of|facts about|how to|what happened)\b/i.test(lower)) return true;

  // Skip things that are clearly local intents
  if (/\b(clip|timer|alarm|reminder|links|camera|screen|memory|remember|forget|log out|logout|weather|spotify|gmail|calendar|open|launch|navigate)\b/i.test(lower)) return false;

  // Skip very short queries
  if (text.trim().split(/\s+/).length < 3) return false;

  return false; // Default: don't research, let local engine handle
}

module.exports = { research, shouldResearch, searchDuckDuckGo, searchWikipedia };
