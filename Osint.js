"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — OSINT Engine v2.0
// Thinks like an investigator. Gathers intel first, then uses
// that intel to generate smart username guesses based on
// interests, locations, nicknames, associations — not just
// name patterns. Sweeps platforms, grabs profile photos,
// cross-references everything.
// ═══════════════════════════════════════════════════════════════

const cache = new Map();
const CACHE_TTL = 20 * 60 * 1000;

function getCached(k) {
  const e = cache.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { cache.delete(k); return null; }
  return e.data;
}
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

function clean(text) {
  if (!text) return "";
  return text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function timeout(ms) {
  return new AbortSignal.timeout ? AbortSignal.timeout(ms) : (() => {
    const c = new AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  })();
}

async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(6000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        ...(opts.headers || {}),
      },
    });
    return res;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// ── PHASE 1: INTELLIGENCE GATHERING ──────────────────────────
// Before generating usernames, gather everything we can about
// the person — interests, locations, associations, nicknames.
// This intel is what makes username guesses smart.
// ═══════════════════════════════════════════════════════════════

async function gatherIntel(fullName) {
  const intel = {
    name:         fullName,
    knownAs:      [],        // nicknames, shortened names
    interests:    [],        // hobbies, topics they're associated with
    locations:    [],        // cities, countries, schools, workplaces
    associations: [],        // teams, brands, creators they're linked to
    descriptions: [],        // physical or identity descriptors
    keywords:     [],        // any strong keywords from search results
    photos:       [],        // URLs of photos found
    wikiData:     null,
    ddgData:      null,
    redditData:   null,
  };

  // Run all searches in parallel
  const [wiki, ddg, reddit, hn] = await Promise.allSettled([
    searchWikipediaIntel(fullName),
    searchDDGIntel(fullName),
    searchRedditIntel(fullName),
    searchHNIntel(fullName),
  ]);

  if (wiki.status === "fulfilled" && wiki.value) {
    intel.wikiData = wiki.value;
    extractIntelFromText(wiki.value.extract || "", intel);
    if (wiki.value.photo) intel.photos.push(wiki.value.photo);
  }

  if (ddg.status === "fulfilled" && ddg.value) {
    intel.ddgData = ddg.value;
    extractIntelFromText(ddg.value.abstract || "", intel);
    extractIntelFromText(ddg.value.answer || "", intel);
    if (ddg.value.image) intel.photos.push(ddg.value.image);
    // DDG infobox often has location, occupation
    if (ddg.value.infobox) {
      for (const [k, v] of Object.entries(ddg.value.infobox)) {
        const vl = v.toLowerCase();
        if (/born|birth|origin|hometown|city|country|nation/.test(k.toLowerCase())) {
          intel.locations.push(...extractLocations(v));
        }
        if (/occupation|job|profession|sport|team|club|genre|style/.test(k.toLowerCase())) {
          intel.interests.push(...v.split(/[,\/]/).map(s => s.trim()).filter(s => s.length > 2 && s.length < 30));
        }
      }
    }
  }

  if (reddit.status === "fulfilled" && reddit.value) {
    intel.redditData = reddit.value;
    for (const post of (reddit.value.posts || []).slice(0, 5)) {
      extractIntelFromText(post.title || "", intel);
    }
  }

  // Extract nickname variants from the name itself
  intel.knownAs = generateNameVariants(fullName);

  // Deduplicate everything
  intel.interests    = [...new Set(intel.interests)].filter(i => i.length > 2).slice(0, 20);
  intel.locations    = [...new Set(intel.locations)].filter(l => l.length > 2).slice(0, 10);
  intel.associations = [...new Set(intel.associations)].filter(a => a.length > 2).slice(0, 15);
  intel.keywords     = [...new Set(intel.keywords)].filter(k => k.length > 3).slice(0, 20);
  intel.photos       = [...new Set(intel.photos)].slice(0, 5);

  return intel;
}

function extractIntelFromText(text, intel) {
  if (!text || text.length < 10) return;
  const lower = text.toLowerCase();

  // Sports
  const sports = ["football", "soccer", "basketball", "cricket", "tennis", "boxing", "mma", "wrestling", "baseball", "hockey", "golf", "swimming", "athletics", "rugby", "volleyball", "gaming", "esports", "chess", "skating", "surfing", "skiing", "cycling", "running", "fitness"];
  for (const s of sports) {
    if (lower.includes(s)) intel.interests.push(s);
  }

  // Music genres / roles
  const music = ["rapper", "singer", "producer", "dj", "musician", "artist", "hip hop", "rap", "pop", "rock", "jazz", "rnb", "trap", "drill", "afrobeats", "reggae", "country", "electronic", "edm"];
  for (const m of music) {
    if (lower.includes(m)) intel.interests.push(m.replace(/\s+/g, ""));
  }

  // Tech
  const tech = ["developer", "programmer", "engineer", "designer", "hacker", "startup", "founder", "ceo", "python", "javascript", "crypto", "blockchain", "ai", "ml", "data science", "cybersecurity"];
  for (const t of tech) {
    if (lower.includes(t)) intel.interests.push(t.replace(/\s+/g, ""));
  }

  // Animals (for username patterns like "xlion")
  const animals = ["lion", "tiger", "wolf", "bear", "eagle", "shark", "dragon", "fox", "hawk", "snake", "bull", "panther", "jaguar", "viper", "cobra"];
  for (const a of animals) {
    if (lower.includes(a)) intel.associations.push(a);
  }

  // Colors (common in usernames)
  const colors = ["red", "blue", "black", "white", "gold", "silver", "green", "purple", "pink", "dark", "neon"];
  for (const c of colors) {
    if (lower.includes(c)) intel.associations.push(c);
  }

  // Numbers that might appear (jersey numbers, birth years)
  const nums = text.match(/\b(19|20)\d{2}\b/g) || [];
  for (const n of nums) intel.keywords.push(n);
  const jerseyNums = text.match(/\b([1-9][0-9]?)\b/g) || [];
  for (const n of jerseyNums.slice(0, 3)) intel.keywords.push(n);

  // Locations
  intel.locations.push(...extractLocations(text));
}

function extractLocations(text) {
  // Common location indicators
  const locationPatterns = [
    /born in ([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g,
    /from ([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g,
    /based in ([A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/g,
    /([A-Z][a-z]+(?:\s[A-Z][a-z]+)?),\s*(?:India|USA|UK|Australia|Canada|Nigeria|Ghana|Pakistan|Bangladesh)/g,
  ];
  const locs = [];
  for (const p of locationPatterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const loc = (m[1] || m[0]).trim();
      if (loc.length > 2 && loc.length < 25) locs.push(loc.toLowerCase());
    }
  }
  return locs;
}

function generateNameVariants(fullName) {
  const parts  = fullName.trim().split(/\s+/);
  const first  = parts[0]  || "";
  const middle = parts[1]  || "";
  const last   = parts[parts.length - 1] || "";
  const firstL = first.toLowerCase();
  const middleL = middle.toLowerCase();
  const lastL  = last.toLowerCase();

  const variants = new Set();

  // Basic variants
  variants.add(firstL);
  if (lastL)   variants.add(lastL);
  if (middleL) variants.add(middleL);

  // Combinations
  variants.add(firstL + lastL);
  variants.add(firstL + "_" + lastL);
  variants.add(firstL + "." + lastL);
  variants.add(firstL[0] + lastL);
  variants.add(firstL + lastL[0]);

  // With middle name
  if (middleL) {
    variants.add(firstL + middleL);
    variants.add(firstL + middleL + lastL);
    variants.add(firstL + middleL[0] + lastL);
    variants.add(firstL[0] + middleL[0] + lastL);
    variants.add(firstL + "_" + middleL);
  }

  // Common suffixes people add to usernames
  const suffixes = ["x", "xx", "official", "real", "og", "tv", "yt", "irl", "hd", "pro", "vip", "777", "666", "99", "00", "01"];
  for (const s of suffixes) {
    variants.add(firstL + s);
    if (lastL) variants.add(firstL + lastL + s);
  }

  // Common prefixes
  const prefixes = ["the", "its", "im", "iamthe", "official"];
  for (const p of prefixes) {
    variants.add(p + firstL);
    if (lastL) variants.add(p + firstL + lastL);
  }

  return [...variants].filter(v => v.length >= 3 && v.length <= 30);
}

// ═══════════════════════════════════════════════════════════════
// ── PHASE 2: SMART USERNAME GENERATION ───────────────────────
// Uses gathered intel to generate usernames like a human would.
// If someone likes lions + is called Rithik → rithikxlion
// If they're from Chennai → rithikchennai
// ═══════════════════════════════════════════════════════════════

function generateSmartUsernames(intel) {
  const usernames = new Set();
  const name = intel.name;
  const parts = name.trim().split(/\s+/);
  const first = (parts[0] || "").toLowerCase();
  const last  = (parts[parts.length - 1] || "").toLowerCase();

  // Add all basic name variants
  for (const v of intel.knownAs) usernames.add(v);

  // Interest-based (the smart part)
  // e.g. rithikxlion, rithiklion, lionrithik
  for (const interest of intel.interests.slice(0, 8)) {
    const i = interest.toLowerCase().replace(/\s+/g, "");
    usernames.add(first + i);
    usernames.add(first + "x" + i);
    usernames.add(first + "_" + i);
    usernames.add(i + first);
    usernames.add(i + "_" + first);
    if (last) {
      usernames.add(last + i);
      usernames.add(last + "x" + i);
    }
  }

  // Association-based (animals, colors, teams)
  for (const assoc of intel.associations.slice(0, 8)) {
    const a = assoc.toLowerCase().replace(/\s+/g, "");
    usernames.add(first + a);
    usernames.add(first + "x" + a);
    usernames.add(first + "_" + a);
    usernames.add(a + first);
    usernames.add("x" + a + first);
    if (last) {
      usernames.add(last + a);
      usernames.add(last + "x" + a);
    }
  }

  // Location-based
  for (const loc of intel.locations.slice(0, 5)) {
    const l = loc.toLowerCase().replace(/\s+/g, "");
    usernames.add(first + l);
    usernames.add(first + "_" + l);
    if (last) usernames.add(last + l);
  }

  // Number-based (birth year, jersey number)
  for (const kw of intel.keywords.filter(k => /^\d+$/.test(k)).slice(0, 4)) {
    usernames.add(first + kw);
    usernames.add(first + last + kw);
    usernames.add(kw + first);
  }

  // Keyword combos
  for (const kw of intel.keywords.filter(k => !/^\d+$/.test(k)).slice(0, 5)) {
    const k = kw.toLowerCase().replace(/\s+/g, "");
    if (k.length > 2) {
      usernames.add(first + k);
      usernames.add(first + "x" + k);
    }
  }

  // Filter: reasonable length, no weird chars
  return [...usernames]
    .filter(u => u && u.length >= 3 && u.length <= 30 && /^[a-z0-9._]+$/.test(u))
    .slice(0, 80); // max 80 to sweep
}

// ═══════════════════════════════════════════════════════════════
// ── PHASE 3: PLATFORM SWEEP ───────────────────────────────────
// Check each generated username across platforms.
// For platforms that return profile photos, grab them.
// ═══════════════════════════════════════════════════════════════

const PLATFORMS = [
  {
    name: "GitHub",
    check: async (u) => {
      const res = await safeFetch(`https://api.github.com/users/${u}`, {
        headers: { "Accept": "application/vnd.github.v3+json" },
      });
      if (!res || !res.ok) return null;
      const d = await res.json().catch(() => null);
      if (!d || d.message === "Not Found") return null;
      return {
        platform: "GitHub",
        username: d.login,
        url:      d.html_url,
        name:     d.name || null,
        bio:      d.bio  || null,
        photo:    d.avatar_url || null,
        followers: d.followers || 0,
        repos:    d.public_repos || 0,
        location: d.location || null,
      };
    },
  },
  {
    name: "Reddit",
    check: async (u) => {
      const res = await safeFetch(`https://www.reddit.com/user/${u}/about.json`, {
        headers: { "Accept": "application/json" },
      });
      if (!res || !res.ok) return null;
      const d = await res.json().catch(() => null);
      if (!d?.data || d.data.is_suspended) return null;
      return {
        platform: "Reddit",
        username: d.data.name,
        url:      `https://www.reddit.com/u/${d.data.name}`,
        karma:    (d.data.link_karma || 0) + (d.data.comment_karma || 0),
        photo:    d.data.icon_img || null,
        created:  d.data.created_utc ? new Date(d.data.created_utc * 1000).getFullYear() : null,
      };
    },
  },
  {
    name: "Twitter/X",
    check: async (u) => {
      // No auth API — check via nitter (public mirror)
      const res = await safeFetch(`https://nitter.net/${u}`, {
        headers: { "Accept": "text/html" },
      });
      if (!res || res.status === 404) return null;
      const html = await res.text().catch(() => "");
      if (!html || html.includes("User not found") || html.includes("account doesn't exist")) return null;
      // Extract basic info from HTML
      const nameMatch  = html.match(/<a class="fullname"[^>]*>([^<]+)<\/a>/);
      const photoMatch = html.match(/class="avatar[^"]*"[^>]*src="([^"]+)"/);
      const bioMatch   = html.match(/<p class="profile-bio"[^>]*>([^<]+)<\/p>/);
      return {
        platform: "Twitter/X",
        username: u,
        url:      `https://twitter.com/${u}`,
        name:     nameMatch ? clean(nameMatch[1]) : null,
        bio:      bioMatch  ? clean(bioMatch[1])  : null,
        photo:    photoMatch ? `https://nitter.net${photoMatch[1]}` : null,
      };
    },
  },
  {
    name: "Instagram",
    check: async (u) => {
      // Instagram blocks scraping hard — check if profile page exists
      const res = await safeFetch(`https://www.instagram.com/${u}/`, {
        headers: { "Accept": "text/html", "Cookie": "" },
      });
      if (!res) return null;
      if (res.status === 404) return null;
      if (res.status !== 200) return null;
      const html = await res.text().catch(() => "");
      if (!html || html.includes('"userNotFound"') || html.length < 1000) return null;
      // Try to get display name and photo from meta tags
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
      const imgMatch   = html.match(/<meta property="og:image" content="([^"]+)"/);
      const descMatch  = html.match(/<meta property="og:description" content="([^"]+)"/);
      return {
        platform: "Instagram",
        username: u,
        url:      `https://www.instagram.com/${u}/`,
        name:     titleMatch ? clean(titleMatch[1]).replace(/\(@[^)]+\)/, "").trim() : null,
        bio:      descMatch  ? clean(descMatch[1])  : null,
        photo:    imgMatch   ? imgMatch[1]           : null,
      };
    },
  },
  {
    name: "TikTok",
    check: async (u) => {
      const res = await safeFetch(`https://www.tiktok.com/@${u}`, {
        headers: { "Accept": "text/html" },
      });
      if (!res || res.status === 404) return null;
      const html = await res.text().catch(() => "");
      if (!html || html.includes('"statusCode":10202') || html.includes("Couldn't find this account")) return null;
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
      const imgMatch   = html.match(/<meta property="og:image" content="([^"]+)"/);
      const descMatch  = html.match(/<meta property="og:description" content="([^"]+)"/);
      return {
        platform: "TikTok",
        username: u,
        url:      `https://www.tiktok.com/@${u}`,
        name:     titleMatch ? clean(titleMatch[1]) : null,
        bio:      descMatch  ? clean(descMatch[1])  : null,
        photo:    imgMatch   ? imgMatch[1]           : null,
      };
    },
  },
  {
    name: "YouTube",
    check: async (u) => {
      const res = await safeFetch(`https://www.youtube.com/@${u}`, {
        headers: { "Accept": "text/html" },
      });
      if (!res || res.status === 404) return null;
      const html = await res.text().catch(() => "");
      if (!html || html.includes('"error":{"code":404')) return null;
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
      const imgMatch   = html.match(/<meta property="og:image" content="([^"]+)"/);
      const descMatch  = html.match(/<meta property="og:description" content="([^"]+)"/);
      if (!titleMatch) return null;
      return {
        platform: "YouTube",
        username: u,
        url:      `https://www.youtube.com/@${u}`,
        name:     titleMatch ? clean(titleMatch[1]) : null,
        bio:      descMatch  ? clean(descMatch[1]).slice(0, 150)  : null,
        photo:    imgMatch   ? imgMatch[1]           : null,
      };
    },
  },
  {
    name: "Pinterest",
    check: async (u) => {
      const res = await safeFetch(`https://www.pinterest.com/${u}/`, {
        headers: { "Accept": "text/html" },
      });
      if (!res || res.status === 404) return null;
      const html = await res.text().catch(() => "");
      if (!html || html.includes("Page not found") || html.length < 500) return null;
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
      if (!titleMatch) return null;
      return {
        platform: "Pinterest",
        username: u,
        url:      `https://www.pinterest.com/${u}/`,
        name:     titleMatch ? clean(titleMatch[1]) : null,
      };
    },
  },
  {
    name: "Twitch",
    check: async (u) => {
      const res = await safeFetch(`https://www.twitch.tv/${u}`, {
        headers: { "Accept": "text/html" },
      });
      if (!res || res.status === 404) return null;
      const html = await res.text().catch(() => "");
      if (!html || html.includes('"statusCode":404') || html.length < 500) return null;
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
      const imgMatch   = html.match(/<meta property="og:image" content="([^"]+)"/);
      if (!titleMatch || titleMatch[1].includes("Twitch")) return null;
      return {
        platform: "Twitch",
        username: u,
        url:      `https://www.twitch.tv/${u}`,
        name:     titleMatch ? clean(titleMatch[1]) : null,
        photo:    imgMatch   ? imgMatch[1]           : null,
      };
    },
  },
  {
    name: "Steam",
    check: async (u) => {
      const res = await safeFetch(`https://steamcommunity.com/id/${u}`, {
        headers: { "Accept": "text/html" },
      });
      if (!res || res.status === 404) return null;
      const html = await res.text().catch(() => "");
      if (!html || html.includes("The specified profile could not be found")) return null;
      const titleMatch = html.match(/<title>Steam Community :: ([^<]+)<\/title>/);
      const imgMatch   = html.match(/class="playerAvatarAutoSizeInner"[^>]*>.*?<img src="([^"]+)"/s);
      return {
        platform: "Steam",
        username: u,
        url:      `https://steamcommunity.com/id/${u}`,
        name:     titleMatch ? clean(titleMatch[1]) : null,
        photo:    imgMatch   ? imgMatch[1]           : null,
      };
    },
  },
  {
    name: "Medium",
    check: async (u) => {
      const res = await safeFetch(`https://medium.com/@${u}`, {
        headers: { "Accept": "text/html" },
      });
      if (!res || res.status === 404) return null;
      const html = await res.text().catch(() => "");
      if (!html || html.includes('"statusCode":404') || html.length < 500) return null;
      const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
      const imgMatch   = html.match(/<meta property="og:image" content="([^"]+)"/);
      if (!titleMatch || titleMatch[1] === "Medium") return null;
      return {
        platform: "Medium",
        username: u,
        url:      `https://medium.com/@${u}`,
        name:     titleMatch ? clean(titleMatch[1]) : null,
        photo:    imgMatch   ? imgMatch[1]           : null,
      };
    },
  },
];

// Sweep all usernames across all platforms
// Batches requests to avoid hammering servers
async function sweepPlatforms(usernames, onProgress) {
  const found = [];
  const BATCH = 10; // check 10 usernames at a time per platform

  // For each platform, check top usernames
  for (const platform of PLATFORMS) {
    const toCheck = usernames.slice(0, 40); // max 40 per platform
    if (onProgress) onProgress(`Checking ${platform.name}...`);

    // Batch it
    for (let i = 0; i < toCheck.length; i += BATCH) {
      const batch = toCheck.slice(i, i + BATCH);
      const results = await Promise.allSettled(
        batch.map(u => platform.check(u).catch(() => null))
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value) {
          found.push(r.value);
        }
      }
      // Small delay between batches
      if (i + BATCH < toCheck.length) {
        await new Promise(r => setTimeout(r, 300));
      }
    }
  }

  return found;
}

// ═══════════════════════════════════════════════════════════════
// ── SEARCH FUNCTIONS ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

async function searchWikipediaIntel(name) {
  const cacheKey = `wiki_intel:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const searchRes = await safeFetch(
      `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(name)}&format=json&srlimit=3&origin=*`
    );
    if (!searchRes || !searchRes.ok) return null;
    const searchData = await searchRes.json();
    const hits = searchData?.query?.search;
    if (!hits?.length) return null;

    const title = hits[0].title;
    const [extractRes, imageRes] = await Promise.allSettled([
      safeFetch(`https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts|pageimages&exintro=true&explaintext=true&pithumbsize=400&format=json&origin=*`),
    ]);

    if (extractRes.status !== "fulfilled" || !extractRes.value?.ok) return null;
    const extractData = await extractRes.value.json();
    const pages = extractData?.query?.pages;
    if (!pages) return null;
    const page = Object.values(pages)[0];
    if (!page || page.missing) return null;

    const result = {
      title:   page.title,
      extract: clean(page.extract || "").slice(0, 1000),
      photo:   page.thumbnail?.source || null,
      url:     `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
    };
    setCache(cacheKey, result);
    return result;
  } catch { return null; }
}

async function searchDDGIntel(name) {
  const cacheKey = `ddg_intel:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await safeFetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(name)}&format=json&no_html=1&skip_disambig=1`
    );
    if (!res || !res.ok) return null;
    const d = await res.json();

    const result = {
      abstract:  clean(d.Abstract)   || null,
      answer:    clean(d.Answer)     || null,
      image:     d.Image             || null,
      heading:   d.Heading           || null,
      infobox:   null,
      related:   [],
    };

    if (d.Infobox?.content) {
      const facts = {};
      for (const item of d.Infobox.content.slice(0, 12)) {
        if (item.label && item.value) facts[item.label] = clean(String(item.value));
      }
      if (Object.keys(facts).length) result.infobox = facts;
    }

    if (d.RelatedTopics) {
      result.related = d.RelatedTopics.slice(0, 5)
        .filter(t => t.Text)
        .map(t => clean(t.Text))
        .filter(t => t.length > 10);
    }

    const hasContent = result.abstract || result.answer || result.heading;
    if (!hasContent) return null;
    setCache(cacheKey, result);
    return result;
  } catch { return null; }
}

async function searchRedditIntel(name) {
  const cacheKey = `reddit_intel:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await safeFetch(
      `https://www.reddit.com/search.json?q=${encodeURIComponent('"' + name + '"')}&sort=relevance&limit=8&type=link`,
      { headers: { "User-Agent": "JARVIS-OSINT/1.0" } }
    );
    if (!res || !res.ok) return null;
    const d = await res.json();
    const posts = (d?.data?.children || [])
      .filter(p => p.data?.title)
      .slice(0, 6)
      .map(p => ({
        title:     clean(p.data.title),
        subreddit: p.data.subreddit,
        url:       `https://reddit.com${p.data.permalink}`,
        score:     p.data.score,
        body:      clean(p.data.selftext || "").slice(0, 200),
      }));

    if (!posts.length) return null;
    const result = { posts };
    setCache(cacheKey, result);
    return result;
  } catch { return null; }
}

async function searchHNIntel(name) {
  const cacheKey = `hn_intel:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await safeFetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent('"' + name + '"')}&tags=story&hitsPerPage=5`
    );
    if (!res || !res.ok) return null;
    const d = await res.json();
    const hits = (d.hits || []).slice(0, 3).map(h => ({
      title:  clean(h.title || ""),
      author: h.author,
      points: h.points,
      url:    h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    })).filter(h => h.title);

    if (!hits.length) return null;
    const result = { hits };
    setCache(cacheKey, result);
    return result;
  } catch { return null; }
}

// Additional targeted searches
async function searchGoogleImages(name) {
  // Use DuckDuckGo image search (no API key needed)
  try {
    const tokenRes = await safeFetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(name)}&iax=images&ia=images`,
      { headers: { "Accept": "text/html" } }
    );
    if (!tokenRes || !tokenRes.ok) return [];
    const html = await tokenRes.text();
    const vqdMatch = html.match(/vqd=([^&"]+)/);
    if (!vqdMatch) return [];

    const imgRes = await safeFetch(
      `https://duckduckgo.com/i.js?q=${encodeURIComponent(name)}&vqd=${vqdMatch[1]}&f=,,,,,&p=1`,
      { headers: { "Referer": "https://duckduckgo.com/" } }
    );
    if (!imgRes || !imgRes.ok) return [];
    const data = await imgRes.json();
    return (data.results || []).slice(0, 5).map(r => ({
      url:       r.image,
      thumbnail: r.thumbnail,
      title:     r.title,
      source:    r.url,
    }));
  } catch { return []; }
}

async function searchGitHub(name) {
  const cacheKey = `github:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await safeFetch(
      `https://api.github.com/search/users?q=${encodeURIComponent(name)}&per_page=5`,
      { headers: { "Accept": "application/vnd.github.v3+json" } }
    );
    if (!res || !res.ok) return null;
    const d = await res.json();
    if (!d.items?.length) return null;

    const users = await Promise.allSettled(
      d.items.slice(0, 3).map(async u => {
        const detail = await safeFetch(
          `https://api.github.com/users/${u.login}`,
          { headers: { "Accept": "application/vnd.github.v3+json" } }
        );
        if (!detail || !detail.ok) return u;
        return detail.json();
      })
    );

    const result = users
      .filter(r => r.status === "fulfilled" && r.value)
      .map(r => r.value)
      .map(u => ({
        login:    u.login,
        name:     u.name || null,
        bio:      u.bio  || null,
        location: u.location || null,
        company:  u.company  || null,
        repos:    u.public_repos || 0,
        followers:u.followers || 0,
        photo:    u.avatar_url || null,
        url:      u.html_url,
        blog:     u.blog || null,
      }));

    if (!result.length) return null;
    setCache(cacheKey, result);
    return result;
  } catch { return null; }
}

async function searchStackOverflow(name) {
  const cacheKey = `so:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await safeFetch(
      `https://api.stackexchange.com/2.3/users?inname=${encodeURIComponent(name)}&site=stackoverflow&pagesize=5&order=desc&sort=reputation`
    );
    if (!res || !res.ok) return null;
    const d = await res.json();
    if (!d.items?.length) return null;

    const result = d.items.slice(0, 3).map(u => ({
      name:       clean(u.display_name),
      reputation: u.reputation,
      location:   u.location ? clean(u.location) : null,
      url:        u.link,
      photo:      u.profile_image || null,
      gold:       u.badge_counts?.gold   || 0,
      silver:     u.badge_counts?.silver || 0,
      bronze:     u.badge_counts?.bronze || 0,
    }));

    setCache(cacheKey, result);
    return result;
  } catch { return null; }
}

async function searchNPM(name) {
  const slug = name.toLowerCase().replace(/\s+/g, "");
  try {
    const res = await safeFetch(
      `https://registry.npmjs.org/-/v1/search?text=author:${encodeURIComponent(slug)}&size=5`
    );
    if (!res || !res.ok) return null;
    const d = await res.json();
    if (!d.objects?.length) return null;
    return d.objects.slice(0, 4).map(o => ({
      name:        o.package.name,
      description: clean(o.package.description || "").slice(0, 100),
      version:     o.package.version,
      url:         `https://www.npmjs.com/package/${o.package.name}`,
    }));
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════
// ── MAIN LOOKUP FUNCTION ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════

async function lookupPerson(fullName, onProgress) {
  const progress = (msg) => {
    if (onProgress) onProgress(msg);
    else console.log(`[OSINT] ${msg}`);
  };

  progress(`Starting intel sweep on: ${fullName}`);

  // Phase 1: Gather intel
  progress("Gathering background intelligence...");
  const intel = await gatherIntel(fullName);

  progress(`Intel gathered — found ${intel.interests.length} interests, ${intel.locations.length} locations, ${intel.associations.length} associations`);

  // Phase 2: Generate smart usernames
  const usernames = generateSmartUsernames(intel);
  progress(`Generated ${usernames.length} smart username candidates`);

  // Phase 3: Platform sweep
  progress("Sweeping platforms...");
  const platformResults = await sweepPlatforms(usernames, progress);

  // Phase 4: Additional targeted searches
  progress("Running targeted searches...");
  const [github, so, npm, images] = await Promise.allSettled([
    searchGitHub(fullName),
    searchStackOverflow(fullName),
    searchNPM(fullName),
    searchGoogleImages(fullName),
  ]);

  // Collect all photos found
  const allPhotos = [...intel.photos];
  for (const r of platformResults) {
    if (r.photo) allPhotos.push(r.photo);
  }
  if (github.status === "fulfilled" && github.value) {
    for (const u of (github.value || [])) if (u.photo) allPhotos.push(u.photo);
  }
  if (images.status === "fulfilled" && images.value) {
    for (const img of (images.value || [])) if (img.thumbnail) allPhotos.push(img.thumbnail);
  }

  progress(`Sweep complete — found ${platformResults.length} accounts across platforms`);

  return {
    name:            fullName,
    intel,
    usernamesChecked: usernames.length,
    platformResults: platformResults,
    github:          github.status  === "fulfilled" ? github.value  : null,
    stackoverflow:   so.status      === "fulfilled" ? so.value      : null,
    npm:             npm.status     === "fulfilled" ? npm.value     : null,
    images:          images.status  === "fulfilled" ? images.value  : [],
    photos:          [...new Set(allPhotos)].slice(0, 10),
    summary: {
      accountsFound:   platformResults.length,
      platformsCovered: PLATFORMS.length,
      photosFound:     allPhotos.length,
      usernamesChecked: usernames.length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
// ── REPORT BUILDER ────────────────────────────────────────────
// Builds a natural JARVIS-style report from the results.
// References specific findings, not preset phrases.
// ═══════════════════════════════════════════════════════════════

function buildIntelReport(data, T = "Sir") {
  const name     = data.name;
  const intel    = data.intel;
  const found    = data.platformResults || [];
  const summary  = data.summary;

  const parts = [];

  // Opening — specific to what we found
  if (found.length === 0 && !intel.wikiData && !intel.ddgData) {
    return `Intel sweep on ${name} came back clean across all channels, ${T}. No Wikipedia entry, no social accounts matching any of the ${summary.usernamesChecked} username variants I generated, no GitHub presence, nothing on Stack Overflow. Either this person has no digital footprint, goes by a completely different name online, or they're genuinely good at staying off the grid. If you have more context — a username, a photo, a location — I can narrow the search.`;
  }

  parts.push(`Intel report on ${name}, ${T}. Checked ${summary.usernamesChecked} username variants across ${summary.platformsCovered} platforms.`);

  // Background intel
  if (intel.wikiData) {
    parts.push(intel.wikiData.extract.slice(0, 400));
  } else if (intel.ddgData?.abstract) {
    parts.push(intel.ddgData.abstract.slice(0, 300));
  } else if (intel.ddgData?.answer) {
    parts.push(intel.ddgData.answer);
  }

  // What we know about them
  if (intel.interests.length > 0) {
    parts.push(`Associated interests and fields: ${intel.interests.slice(0, 8).join(", ")}.`);
  }
  if (intel.locations.length > 0) {
    parts.push(`Location references: ${intel.locations.slice(0, 4).join(", ")}.`);
  }

  // Platform accounts found
  if (found.length > 0) {
    // Group by platform
    const byPlatform = {};
    for (const r of found) {
      if (!byPlatform[r.platform]) byPlatform[r.platform] = [];
      byPlatform[r.platform].push(r);
    }

    parts.push(`Found ${found.length} account${found.length > 1 ? "s" : ""} across ${Object.keys(byPlatform).length} platform${Object.keys(byPlatform).length > 1 ? "s" : ""}:`);

    for (const [platform, accounts] of Object.entries(byPlatform)) {
      for (const acc of accounts) {
        const details = [];
        if (acc.username) details.push(`@${acc.username}`);
        if (acc.name && acc.name !== name) details.push(`(listed as "${acc.name}")`);
        if (acc.bio) details.push(`— ${acc.bio.slice(0, 80)}`);
        if (acc.followers) details.push(`${acc.followers.toLocaleString()} followers`);
        if (acc.karma) details.push(`${acc.karma.toLocaleString()} karma`);
        if (acc.repos) details.push(`${acc.repos} repos`);
        if (acc.location) details.push(`based in ${acc.location}`);
        parts.push(`${platform}: ${details.join(" ")} — ${acc.url}`);
      }
    }
  }

  // GitHub specific
  if (data.github?.length) {
    for (const gh of data.github.slice(0, 2)) {
      if (!found.find(f => f.platform === "GitHub" && f.username === gh.login)) {
        parts.push(`GitHub: @${gh.login}${gh.name ? ` (${gh.name})` : ""} — ${gh.repos} repos, ${gh.followers} followers${gh.location ? `, ${gh.location}` : ""}. ${gh.url}`);
      }
    }
  }

  // Stack Overflow
  if (data.stackoverflow?.length) {
    const top = data.stackoverflow[0];
    parts.push(`Stack Overflow: ${top.name} — ${top.reputation?.toLocaleString()} reputation${top.location ? `, ${top.location}` : ""}. ${top.url}`);
  }

  // Photos found
  if (data.photos.length > 0) {
    parts.push(`Photos found: ${data.photos.length} image${data.photos.length > 1 ? "s" : ""} pulled from ${found.filter(f => f.photo).map(f => f.platform).join(", ")}${intel.wikiData?.photo ? ", Wikipedia" : ""}.`);
  }

  // Reddit mentions
  if (intel.redditData?.posts?.length) {
    const top = intel.redditData.posts[0];
    parts.push(`Reddit mentions found — most relevant in r/${top.subreddit}: "${top.title.slice(0, 80)}"`);
  }

  // Closing
  if (found.length > 0) {
    parts.push(`That's the open-source picture on ${name}, ${T}. ${summary.photosFound > 0 ? `${summary.photosFound} photo${summary.photosFound > 1 ? "s" : ""} collected for cross-reference.` : ""}`);
  } else {
    parts.push(`Background intel gathered but no social accounts found under the ${summary.usernamesChecked} username variants I generated, ${T}. They may use a completely different handle online. If you can give me more — a known username, a platform they use, a location — I can narrow it.`);
  }

  return parts.filter(Boolean).join(" ");
}

// ── UTILITY: Is this a person lookup request? ─────────────────
function isPersonLookup(text) {
  const lower = text.toLowerCase();
  // Exclude address/location/footage queries
  if (/\d+\s+\w+\s+(ave|st|rd|blvd|drive|lane|way|court|avenue|street)/i.test(lower)) return false;
  if (/footage|video|recording|street view|address|location of|coordinates/i.test(lower)) return false;
  return /\b(look up|lookup|find out about|search for|investigate|dig up|background check|run a check|pull everything on|find info on|who is|who was|what do you know about|give me everything on|give me the rundown on|find me everything on|research|locate|find the person|osint|intel on)\b/i.test(lower);
}

function extractPersonName(text) {
  const patterns = [
    /(?:look up|lookup|find out about|search for|research|investigate|dig up|find info on|locate|background check on|run a check on|pull up info on|pull everything on|what do you know about|what can you find on|anything on|info on|information on|check out|find me everything on|give me everything on|give me the rundown on|i need info on|i want to know about|osint on|intel on)\s+(.+?)(?:\s+for me|\s+please|\s*[?.!]*\s*$)/i,
    /(?:who is|who's|who was)\s+(.+?)(?:\s*[?.!]*\s*$)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    const raw = m && (m[2] || m[1]);
    if (raw && raw.trim().length > 1) {
      return raw.replace(/^(a |an |the )\s*/i, "").replace(/[?.!]+$/, "").trim();
    }
  }
  return null;
}

module.exports = {
  lookupPerson,
  buildIntelReport,
  isPersonLookup,
  extractPersonName,
  gatherIntel,
  generateSmartUsernames,
  sweepPlatforms,
  searchWikipediaIntel,
  searchDDGIntel,
  searchGitHub,
  searchStackOverflow,
  searchNPM,
  searchGoogleImages,
};
