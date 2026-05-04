"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Weather Integration
// Uses OpenWeatherMap free tier (no paid plan needed)
// Get free API key at: openweathermap.org/api
// ═══════════════════════════════════════════════════════════════

const API_KEY      = process.env.OPENWEATHER_API_KEY || "";
const DEFAULT_CITY = process.env.DEFAULT_CITY        || "London";
const BASE_URL     = "https://api.openweathermap.org/data/2.5";

// Simple in-memory cache — avoid hammering the API
const cache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) { cache.set(key, { data, ts: Date.now() }); }

// ── EXTRACT CITY FROM MESSAGE ─────────────────────────────────
function extractCity(message) {
  const lower = message.toLowerCase();
  // "weather in London", "what's it like in Tokyo", "forecast for Paris"
  const patterns = [
    /weather (?:in|for|at) ([a-z\s]+?)(?:\?|$|,|\s+today|\s+now|\s+tomorrow)/i,
    /(?:in|at|for) ([a-z\s]+?)(?:'s weather|weather|forecast|\?|$)/i,
    /how(?:'s| is) it (?:in|at) ([a-z\s]+)/i,
    /temperature (?:in|at|for) ([a-z\s]+)/i,
  ];
  for (const p of patterns) {
    const m = message.match(p);
    if (m && m[1].trim().length > 1) return m[1].trim();
  }
  return null;
}

// ── FETCH CURRENT WEATHER ─────────────────────────────────────
async function fetchWeather(city) {
  if (!API_KEY) {
    return { error: "OpenWeatherMap API key not configured. Add OPENWEATHER_API_KEY to your .env file. Get a free key at openweathermap.org/api" };
  }

  const cacheKey = `weather:${city.toLowerCase()}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/weather?q=${encodeURIComponent(city)}&units=metric&appid=${API_KEY}`;
    const res  = await fetch(url);
    if (!res.ok) {
      if (res.status === 401) return { error: "Invalid API key. Check your OPENWEATHER_API_KEY." };
      if (res.status === 404) return { error: `City "${city}" not found.` };
      return { error: `Weather API returned ${res.status}` };
    }
    const d = await res.json();

    const result = {
      city:        d.name + (d.sys?.country ? `, ${d.sys.country}` : ""),
      temp:        Math.round(d.main.temp),
      feels_like:  Math.round(d.main.feels_like),
      description: d.weather[0]?.description || "unknown",
      humidity:    d.main.humidity,
      wind_speed:  Math.round(d.wind?.speed || 0),
      high:        Math.round(d.main.temp_max),
      low:         Math.round(d.main.temp_min),
      icon:        d.weather[0]?.icon,
      conditions:  d.weather[0]?.main,
      visibility:  d.visibility ? `${Math.round(d.visibility / 1000)} km` : null,
      sunrise:     d.sys?.sunrise ? new Date(d.sys.sunrise * 1000).toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true }) : null,
      sunset:      d.sys?.sunset  ? new Date(d.sys.sunset  * 1000).toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true }) : null,
    };

    setCache(cacheKey, result);
    return result;
  } catch (e) {
    return { error: `Network error: ${e.message}` };
  }
}

// ── FETCH FORECAST (5-day) ────────────────────────────────────
async function fetchForecast(city) {
  if (!API_KEY) return { error: "No API key" };
  const cacheKey = `forecast:${city.toLowerCase()}`;
  const cached   = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE_URL}/forecast?q=${encodeURIComponent(city)}&units=metric&cnt=5&appid=${API_KEY}`;
    const res  = await fetch(url);
    if (!res.ok) return { error: `Forecast API returned ${res.status}` };
    const d = await res.json();
    const days = d.list.map(item => ({
      time:        new Date(item.dt * 1000).toLocaleDateString("en-GB", { weekday:"short", hour:"2-digit", minute:"2-digit" }),
      temp:        Math.round(item.main.temp),
      description: item.weather[0]?.description,
    }));
    const result = { city: d.city?.name, days };
    setCache(cacheKey, result);
    return result;
  } catch (e) { return { error: e.message }; }
}

// ── MAIN HANDLER ─────────────────────────────────────────────
async function handleWeatherCommand(message) {
  const city = extractCity(message) || DEFAULT_CITY;
  const isForecast = /forecast|tomorrow|next week|week|days/i.test(message);
  if (isForecast) return { ...(await fetchForecast(city)), type: "forecast" };
  return { ...(await fetchWeather(city)), type: "current" };
}

module.exports = { handleWeatherCommand, fetchWeather, extractCity };
