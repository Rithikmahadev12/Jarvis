"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — News Integration
// Uses NewsAPI.org's free tier.
// Get a free API key at: newsapi.org/register
// ═══════════════════════════════════════════════════════════════

const API_KEY  = process.env.NEWS_API_KEY || "";
const BASE_URL = "https://newsapi.org/v2";

// Simple in-memory cache — avoid hammering the API / burning the free quota
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// NewsAPI's valid top-headlines categories
const VALID_CATEGORIES = new Set([
  "business", "entertainment", "general", "health", "science", "sports", "technology",
]);

// ── EXTRACT TOPIC/CATEGORY FROM A FREE-TEXT MESSAGE ───────────
function extractTopic(message) {
  const lower = message.toLowerCase();
  for (const cat of VALID_CATEGORIES) {
    if (lower.includes(cat)) return { category: cat };
  }
  // "news about <topic>", "news on <topic>"
  const m = lower.match(/news (?:about|on|regarding) ([a-z0-9\s]+)/);
  if (m && m[1].trim().length > 1) return { query: m[1].trim() };
  return { category: "general" };
}

// ── FETCH TOP HEADLINES (by category) ─────────────────────────
async function fetchTopHeadlines({ category = "general", country = "us" } = {}) {
  if (!API_KEY) {
    return { error: "NEWS_API_KEY not configured. Add NEWS_API_KEY to your .env file. Get a free key at newsapi.org/register" };
  }
  const cacheKey = `top:${category}:${country}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/top-headlines?category=${encodeURIComponent(category)}&country=${country}&pageSize=12&apiKey=${API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 401) return { error: "Invalid API key. Check your NEWS_API_KEY." };
      if (res.status === 429) return { error: "News API rate limit hit. Free tier is capped — try again shortly." };
      return { error: `News API returned ${res.status}` };
    }
    const d = await res.json();
    const result = {
      category, country,
      updatedAt: new Date().toISOString(),
      articles: (d.articles || []).map(a => ({
        title:       a.title,
        source:      a.source?.name || "Unknown",
        url:         a.url,
        publishedAt: a.publishedAt,
        image:       a.urlToImage,
      })),
    };
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

// ── FETCH HEADLINES BY KEYWORD SEARCH ──────────────────────────
async function searchNews(query) {
  if (!API_KEY) return { error: "NEWS_API_KEY not configured." };
  const cacheKey = `search:${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/everything?q=${encodeURIComponent(query)}&sortBy=publishedAt&pageSize=12&apiKey=${API_KEY}`;
    const res = await fetch(url);
    if (!res.ok) return { error: `News API returned ${res.status}` };
    const d = await res.json();
    const result = {
      query,
      updatedAt: new Date().toISOString(),
      articles: (d.articles || []).map(a => ({
        title:       a.title,
        source:      a.source?.name || "Unknown",
        url:         a.url,
        publishedAt: a.publishedAt,
        image:       a.urlToImage,
      })),
    };
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

// ── MAIN HANDLER (mirrors weather.js's handleWeatherCommand) ──
async function handleNewsCommand(message) {
  const topic = extractTopic(message || "");
  if (topic.query) return { ...(await searchNews(topic.query)), type: "search" };
  return { ...(await fetchTopHeadlines({ category: topic.category })), type: "top" };
}

module.exports = { handleNewsCommand, fetchTopHeadlines, searchNews, extractTopic, VALID_CATEGORIES };
