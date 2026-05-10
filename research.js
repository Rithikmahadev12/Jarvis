"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Research Engine v2.1
// FIX: shouldResearch no longer fires on action/command queries
// ═══════════════════════════════════════════════════════════════

// ── SIMPLE CACHE ─────────────────────────────────────────────
const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

function getCached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > 300) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    cache.delete(oldest[0]);
  }
}

function cleanText(text) {
  if (!text) return "";
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\d+\]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\\n/g, " ")
    .trim();
}

function truncate(text, maxChars = 600) {
  if (!text || text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastDot = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastDot > maxChars * 0.6 ? cut.slice(0, lastDot + 1) : cut + "…";
}

function extractQuery(text) {
  return text
    .toLowerCase()
    .replace(/^(what is|what are|who is|who was|how does|how do|why does|why do|when did|when was|where is|where was|tell me about|explain|describe|define|what happened to|what caused|how was|give me info on|give me information about|i want to know about|can you tell me about|do you know about)\s+/i, "")
    .replace(/\?+$/, "")
    .replace(/,?\s+(please|jarvis|sir|thanks)$/i, "")
    .trim();
}

function extractPersonName(text) {
  const patterns = [
    /(?:look up|lookup|find out about|search for|research|investigate|dig up|find info on|locate|background check on|run a check on|pull up info on|pull everything on|what do you know about|what can you find on|anything on|info on|information on|check out)\s+(.+?)(?:\s+for me|\s+please|\s*\??\s*$)/i,
    /(?:who is|who's|who was)\s+(.+?)(?:\s*\??\s*$)/i,
    /(?:tell me about|give me everything on|give me the rundown on|run\s+(.+?)\s+through)\s+(.+?)(?:\s*\??\s*$)/i,
    /(?:i want to know about|i need info on|find me everything on)\s+(.+?)(?:\s*\??\s*$)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    const raw = m && (m[2] || m[1]);
    if (raw && raw.trim().length > 1) {
      return raw.replace(/^(a |an |the )\s*/i, '').trim();
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────
// ── DUCKDUCKGO / WIKIPEDIA / GITHUB / REDDIT etc. (unchanged)
// ─────────────────────────────────────────────────────────────
async function searchDuckDuckGo(query) {
  const cacheKey = `ddg:${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
    const res = await fetch(url, {
      headers: { "User-Agent": "JARVIS-Assistant/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const result = {
      abstract:      cleanText(data.Abstract)   || null,
      abstractSource: data.AbstractSource        || null,
      definition:    cleanText(data.Definition)  || null,
      answer:        cleanText(data.Answer)      || null,
      relatedTopics: [],
      infobox:       null,
      type:          data.Type                  || null,
      image:         data.Image                 || null,
      heading:       data.Heading               || null,
    };

    if (data.RelatedTopics && Array.isArray(data.RelatedTopics)) {
      for (const t of data.RelatedTopics.slice(0, 5)) {
        if (t.Text && t.Text.length > 20) result.relatedTopics.push(cleanText(t.Text));
      }
    }
    if (data.Infobox && data.Infobox.content) {
      const facts = {};
      for (const item of data.Infobox.content.slice(0, 8)) {
        if (item.label && item.value) facts[item.label] = cleanText(String(item.value));
      }
      if (Object.keys(facts).length) result.infobox = facts;
    }

    const hasContent = result.abstract || result.definition || result.answer || result.relatedTopics.length;
    if (hasContent) setCache(cacheKey, result);
    return hasContent ? result : null;
  } catch (e) {
    console.warn("[RESEARCH] DuckDuckGo error:", e.message);
    return null;
  }
}

async function searchWikipedia(query) {
  const cacheKey = `wiki:${query.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;
    const searchRes = await fetch(searchUrl, {
      headers: { "User-Agent": "JARVIS-Assistant/1.0" },
      signal: AbortSignal.timeout(6000),
    });
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const hits = searchData?.query?.search;
    if (!hits || hits.length === 0) return null;

    const title = hits[0].title;
    const extractUrl = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(title)}&prop=extracts&exintro=true&explaintext=true&format=json&origin=*`;
    const extractRes = await fetch(extractUrl, {
      headers: { "User-Agent": "JARVIS-Assistant/1.0" },
      signal: AbortSignal.timeout(6000),
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
      extract: truncate(extract, 900),
      url: `https://en.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`,
    };

    setCache(cacheKey, result);
    return result;
  } catch (e) {
    console.warn("[RESEARCH] Wikipedia error:", e.message);
    return null;
  }
}

async function searchGitHub(name) {
  const cacheKey = `github:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const searchRes = await fetch(
      `https://api.github.com/search/users?q=${encodeURIComponent(name)}&per_page=5`,
      {
        headers: { "User-Agent": "JARVIS-Assistant/1.0", "Accept": "application/vnd.github.v3+json" },
        signal: AbortSignal.timeout(7000),
      }
    );
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    if (!searchData.items || searchData.items.length === 0) return null;

    const topUser = searchData.items[0];
    let detail = topUser;
    try {
      const detailRes = await fetch(
        `https://api.github.com/users/${topUser.login}`,
        {
          headers: { "User-Agent": "JARVIS-Assistant/1.0", "Accept": "application/vnd.github.v3+json" },
          signal: AbortSignal.timeout(7000),
        }
      );
      if (detailRes.ok) detail = await detailRes.json();
    } catch {}

    const result = {
      login:        detail.login,
      name:         detail.name     ? cleanText(detail.name)    : null,
      bio:          detail.bio      ? cleanText(detail.bio)     : null,
      company:      detail.company  ? cleanText(detail.company) : null,
      location:     detail.location || null,
      publicRepos:  detail.public_repos || 0,
      followers:    detail.followers    || 0,
      following:    detail.following    || 0,
      url:          detail.html_url,
      blog:         detail.blog        || null,
      hireable:     detail.hireable    || null,
      createdYear:  detail.created_at  ? new Date(detail.created_at).getFullYear() : null,
      updatedYear:  detail.updated_at  ? new Date(detail.updated_at).getFullYear() : null,
      otherMatches: searchData.items.slice(1, 4).map(u => ({ login: u.login, url: u.html_url })),
    };

    setCache(cacheKey, result);
    return result;
  } catch (e) {
    console.warn("[RESEARCH] GitHub error:", e.message);
    return null;
  }
}

async function searchReddit(name) {
  const cacheKey = `reddit:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const [postRes, userRes] = await Promise.allSettled([
      fetch(
        `https://www.reddit.com/search.json?q=${encodeURIComponent('"' + name + '"')}&sort=relevance&limit=6&type=link`,
        { headers: { "User-Agent": "JARVIS-Assistant/1.0" }, signal: AbortSignal.timeout(7000) }
      ),
      fetch(
        `https://www.reddit.com/search.json?q=${encodeURIComponent(name)}&sort=relevance&limit=5&type=user`,
        { headers: { "User-Agent": "JARVIS-Assistant/1.0" }, signal: AbortSignal.timeout(7000) }
      ),
    ]);

    let posts = [], users = [];

    if (postRes.status === "fulfilled" && postRes.value.ok) {
      const data = await postRes.value.json();
      posts = (data?.data?.children || [])
        .filter(p => p.data && p.data.title)
        .slice(0, 4)
        .map(p => ({
          title:     cleanText(p.data.title),
          subreddit: p.data.subreddit,
          url:       `https://reddit.com${p.data.permalink}`,
          score:     p.data.score,
          year:      new Date(p.data.created_utc * 1000).getFullYear(),
        }));
    }

    if (userRes.status === "fulfilled" && userRes.value.ok) {
      const data = await userRes.value.json();
      users = (data?.data?.children || [])
        .filter(u => u.data && u.data.name)
        .slice(0, 3)
        .map(u => ({
          name:  u.data.name,
          url:   `https://reddit.com/u/${u.data.name}`,
          karma: (u.data.link_karma || 0) + (u.data.comment_karma || 0),
        }));
    }

    if (posts.length === 0 && users.length === 0) return null;
    const result = { posts, users };
    setCache(cacheKey, result);
    return result;
  } catch (e) {
    console.warn("[RESEARCH] Reddit error:", e.message);
    return null;
  }
}

async function searchStackOverflow(name) {
  const cacheKey = `so:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://api.stackexchange.com/2.3/users?inname=${encodeURIComponent(name)}&site=stackoverflow&pagesize=5&order=desc&sort=reputation`,
      { headers: { "User-Agent": "JARVIS-Assistant/1.0" }, signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.items || data.items.length === 0) return null;

    const result = data.items.slice(0, 3).map(u => ({
      name:       cleanText(u.display_name),
      reputation: u.reputation,
      location:   u.location ? cleanText(u.location) : null,
      url:        u.link,
      gold:       u.badge_counts?.gold   || 0,
      silver:     u.badge_counts?.silver || 0,
      bronze:     u.badge_counts?.bronze || 0,
      lastSeen:   u.last_access_date ? new Date(u.last_access_date * 1000).getFullYear() : null,
    }));

    setCache(cacheKey, result);
    return result;
  } catch (e) {
    console.warn("[RESEARCH] StackOverflow error:", e.message);
    return null;
  }
}

async function searchNPM(name) {
  const cacheKey = `npm:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://registry.npmjs.org/-/v1/search?text=author:${encodeURIComponent(name.toLowerCase().replace(/\s+/g, ""))}&size=5`,
      { headers: { "User-Agent": "JARVIS-Assistant/1.0" }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.objects || data.objects.length === 0) return null;

    const result = {
      packages: data.objects.slice(0, 4).map(o => ({
        name:        o.package.name,
        description: o.package.description ? cleanText(o.package.description) : null,
        version:     o.package.version,
        keywords:    (o.package.keywords || []).slice(0, 4),
        url:         `https://www.npmjs.com/package/${o.package.name}`,
        downloads:   o.downloads?.monthly || null,
      })),
      total: data.total,
    };

    if (result.packages.length > 0) setCache(cacheKey, result);
    return result.packages.length > 0 ? result : null;
  } catch (e) {
    console.warn("[RESEARCH] NPM error:", e.message);
    return null;
  }
}

async function searchHackerNews(name) {
  const cacheKey = `hn:${name.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent('"' + name + '"')}&tags=story&hitsPerPage=5`,
      { headers: { "User-Agent": "JARVIS-Assistant/1.0" }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.hits || data.hits.length === 0) return null;

    const result = data.hits.slice(0, 3).map(h => ({
      title:  cleanText(h.title || ""),
      author: h.author,
      points: h.points,
      year:   h.created_at ? new Date(h.created_at).getFullYear() : null,
      url:    h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
    }));

    setCache(cacheKey, result);
    return result.length > 0 ? result : null;
  } catch (e) {
    console.warn("[RESEARCH] HackerNews error:", e.message);
    return null;
  }
}

async function lookupPerson(fullName) {
  console.log(`[RESEARCH] Person lookup initiated: "${fullName}"`);

  const [wikiRes, ddgRes, githubRes, redditRes, soRes, npmRes, hnRes] = await Promise.allSettled([
    searchWikipedia(fullName),
    searchDuckDuckGo(fullName),
    searchGitHub(fullName),
    searchReddit(fullName),
    searchStackOverflow(fullName),
    searchNPM(fullName),
    searchHackerNews(fullName),
  ]);

  const result = {
    name:          fullName,
    wikipedia:     wikiRes.status     === "fulfilled" ? wikiRes.value     : null,
    ddg:           ddgRes.status      === "fulfilled" ? ddgRes.value      : null,
    github:        githubRes.status   === "fulfilled" ? githubRes.value   : null,
    reddit:        redditRes.status   === "fulfilled" ? redditRes.value   : null,
    stackoverflow: soRes.status       === "fulfilled" ? soRes.value       : null,
    npm:           npmRes.status      === "fulfilled" ? npmRes.value      : null,
    hackerNews:    hnRes.status       === "fulfilled" ? hnRes.value       : null,
  };

  const sourceCount = Object.values(result).filter((v, i) => i > 0 && v !== null).length;
  console.log(`[RESEARCH] Person lookup complete: "${fullName}" — ${sourceCount} source(s) returned data`);
  return result;
}

const pick = arr => arr[Math.floor(Math.random() * arr.length)];

function buildPersonIntelReport(data, userTitle) {
  const T    = userTitle || "Sir";
  const name = data.name;
  const parts = [];

  const hasAnything = data.wikipedia || data.ddg?.abstract || data.ddg?.answer ||
    data.github || data.reddit || data.stackoverflow || data.npm || data.hackerNews;

  if (!hasAnything) {
    return pick([
      `Intel on "${name}" came back empty across all channels, ${T}. Wikipedia — nothing. GitHub — no matching profile. Reddit — no mentions. Stack Overflow — clear. HN — nothing. Either this person maintains an unusually clean digital absence, or the name needs refining.`,
      `Running "${name}" through every public database I have access to returned minimal signal, ${T}. No Wikipedia entry. No notable GitHub presence. No Reddit footprint. No Stack Overflow account matching that name.`,
    ]);
  }

  const openers = [
    `Intel report on ${name}, ${T}. Cross-referencing ${_sourceSummary(data)}.`,
    `${T}, running ${name} through public channels. Here's what I have.`,
    `${T} — ${name}. Open-source intelligence report follows.`,
  ];
  parts.push(pick(openers));

  if (data.wikipedia) {
    parts.push(truncate(data.wikipedia.extract, 350));
  } else if (data.ddg?.answer) {
    parts.push(data.ddg.answer);
  } else if (data.ddg?.abstract) {
    parts.push(truncate(data.ddg.abstract, 300));
  } else if (data.ddg?.definition) {
    parts.push(data.ddg.definition);
  }

  if (data.ddg?.infobox) {
    const facts = Object.entries(data.ddg.infobox).slice(0, 5).map(([k, v]) => `${k}: ${v}`).join(" · ");
    if (facts) parts.push(`Key data — ${facts}.`);
  }

  if (data.github) {
    const gh = data.github;
    const segments = [`GitHub: @${gh.login}`];
    if (gh.name && gh.name.toLowerCase() !== name.toLowerCase()) segments.push(`(listed as ${gh.name})`);
    if (gh.location) segments.push(`based in ${gh.location}`);
    if (gh.company) segments.push(`works at ${gh.company}`);
    if (gh.publicRepos) segments.push(`${gh.publicRepos} public repos`);
    if (gh.followers) segments.push(`${gh.followers.toLocaleString()} followers`);
    if (gh.createdYear) segments.push(`active since ${gh.createdYear}`);
    if (gh.bio) segments.push(`Bio: "${truncate(gh.bio, 120)}"`);
    if (gh.blog) segments.push(`Web: ${gh.blog}`);
    parts.push(segments.join(", ") + ".");
  }

  if (data.stackoverflow && data.stackoverflow.length > 0) {
    const top = data.stackoverflow[0];
    const soSegments = [`Stack Overflow: ${top.name}`];
    if (top.reputation) soSegments.push(`rep ${top.reputation.toLocaleString()}`);
    if (top.location) soSegments.push(`location ${top.location}`);
    if (top.gold || top.silver || top.bronze) soSegments.push(`badges: ${top.gold}🥇 ${top.silver}🥈 ${top.bronze}🥉`);
    parts.push(soSegments.join(", ") + ".");
  }

  if (data.npm && data.npm.packages.length > 0) {
    const pkgs = data.npm.packages.slice(0, 3).map(p => `${p.name}${p.description ? ` (${truncate(p.description, 60)})` : ""}`).join(", ");
    parts.push(`NPM packages published: ${pkgs}.`);
  }

  if (data.hackerNews && data.hackerNews.length > 0) {
    const hn = data.hackerNews[0];
    parts.push(`Hacker News mention: "${truncate(hn.title, 100)}" — ${hn.points} points${hn.year ? `, ${hn.year}` : ""}.`);
  }

  if (data.reddit) {
    if (data.reddit.users && data.reddit.users.length > 0) {
      const u = data.reddit.users[0];
      parts.push(`Reddit account: u/${u.name} — ${u.karma.toLocaleString()} combined karma.`);
    }
    if (data.reddit.posts && data.reddit.posts.length > 0) {
      const topPost = data.reddit.posts[0];
      parts.push(`Reddit mentions found — top result in r/${topPost.subreddit}: "${truncate(topPost.title, 100)}" (${topPost.score} points${topPost.year ? `, ${topPost.year}` : ""}).`);
    }
  }

  const closers = [
    `End of public record, ${T}. That's everything the open web has.`,
    `That's the full open-source picture, ${T}.`,
    `Intel summary complete, ${T}.`,
  ];
  parts.push(pick(closers));

  return parts.filter(Boolean).join(" ");
}

function _sourceSummary(data) {
  const sources = [];
  if (data.wikipedia)     sources.push("Wikipedia");
  if (data.ddg)           sources.push("DuckDuckGo");
  if (data.github)        sources.push("GitHub");
  if (data.stackoverflow) sources.push("Stack Overflow");
  if (data.npm)           sources.push("NPM");
  if (data.hackerNews)    sources.push("Hacker News");
  if (data.reddit)        sources.push("Reddit");
  if (sources.length === 0) return "public databases";
  if (sources.length === 1) return sources[0];
  return sources.slice(0, -1).join(", ") + " and " + sources[sources.length - 1];
}

const PERSONALITY = {
  openers: [
    "Here's what I found on that —",
    "Pulling from live sources —",
    "Research complete —",
    "I looked that up —",
    "Here's what I have on",
  ],
  connectors: [
    "Beyond that,", "Additionally,", "Worth noting:", "Furthermore,",
    "On top of that,", "It's also the case that,",
  ],
};

function synthesizeResponse(query, ddgResult, wikiResult, userTitle) {
  const T = userTitle || "Sir";
  const parts = [];

  let primaryText = null;
  let source      = null;

  if (ddgResult?.answer) {
    primaryText = ddgResult.answer;
    source      = "duckduckgo";
  } else if (wikiResult?.extract && wikiResult.extract.length > 100) {
    primaryText = truncate(wikiResult.extract, 500);
    source      = "wikipedia";
  } else if (ddgResult?.abstract && ddgResult.abstract.length > 50) {
    primaryText = truncate(ddgResult.abstract, 400);
    source      = "duckduckgo";
  } else if (ddgResult?.definition) {
    primaryText = ddgResult.definition;
    source      = "duckduckgo";
  }

  if (!primaryText && ddgResult?.relatedTopics?.length) {
    primaryText = ddgResult.relatedTopics[0];
    source      = "duckduckgo";
  }

  if (!primaryText) return null;

  const opener     = pick(PERSONALITY.openers);
  const topicLabel = wikiResult?.title || query;

  if (Math.random() > 0.4) parts.push(`${opener} ${topicLabel}:`);
  parts.push(primaryText);

  if (ddgResult?.infobox && source !== "duckduckgo") {
    const infoFacts = Object.entries(ddgResult.infobox).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(", ");
    if (infoFacts) parts.push(`${pick(PERSONALITY.connectors)} ${infoFacts}.`);
  }

  if (ddgResult?.relatedTopics?.length > 1 && primaryText.length < 300) {
    const extra = ddgResult.relatedTopics[1];
    if (extra && extra.length > 30 && !primaryText.includes(extra.slice(0, 30))) {
      parts.push(`${pick(PERSONALITY.connectors)} ${truncate(extra, 150)}`);
    }
  }

  let response = parts.filter(Boolean).join(" ").replace(/\s{2,}/g, " ").trim();
  if (!response.match(/[.!?]$/)) response += ".";
  if (source === "wikipedia" && Math.random() > 0.5) response += ` Source: Wikipedia — "${wikiResult.title}".`;
  if (Math.random() > 0.55) response += ` ${T}.`;

  return response;
}

async function research(rawQuery, userTitle) {
  const query = extractQuery(rawQuery);
  if (!query || query.length < 2) return null;

  console.log(`[RESEARCH] Knowledge search: "${query}"`);

  const [ddgResult, wikiResult] = await Promise.allSettled([
    searchDuckDuckGo(query),
    searchWikipedia(query),
  ]);

  const ddg  = ddgResult.status  === "fulfilled" ? ddgResult.value  : null;
  const wiki = wikiResult.status === "fulfilled" ? wikiResult.value : null;

  if (!ddg && !wiki) {
    console.log(`[RESEARCH] No results for: "${query}"`);
    return null;
  }

  const response = synthesizeResponse(query, ddg, wiki, userTitle);
  if (!response) return null;

  return {
    reply:   response,
    sources: {
      ddg:       !!ddg,
      wiki:      !!wiki,
      wikiTitle: wiki?.title || null,
      wikiUrl:   wiki?.url   || null,
    },
    query,
  };
}

// ═══════════════════════════════════════════════════════════════
// ── shouldResearch — THE KEY FIX ─────────────────────────────
// Only returns true for genuine knowledge/info queries.
// Aggressively returns false for anything that looks like a
// command, task, or action the AI should just handle directly.
// ═══════════════════════════════════════════════════════════════

// Action verbs that mean "do something" not "look something up"
const ACTION_VERBS = /^(write|create|build|make|generate|code|script|program|implement|develop|debug|fix|refactor|optimise|optimize|review|improve|give|show|tell|set|open|launch|play|pause|stop|clip|save|record|switch|turn|enable|disable|activate|deactivate|send|call|ring|connect|start|run|help me|can you|could you|i need you to|i want you to|please|do|let|go|navigate|pull up|bring up|load|display|render|draw|check|scan|search for|find|look up|lookup|remind|alert|schedule|automate|watch|monitor|read|translate|convert|calculate|solve|compute|figure out|work out|summarize|summarise|list|compare|explain how to|show me how|walk me through)/i;

// Things that are clearly NOT research queries
const NON_RESEARCH_SIGNALS = /\b(clip|timer|alarm|reminder|links|camera|screen|memory|remember|forget|log out|logout|weather|spotify|gmail|calendar|open|launch|navigate|turn on|turn off|set a|set timer|remind me|alert me|wake me|ping me|show me|pull up|build mode|hologram|3d model|write me|create a|build me|make me|generate a|give me a|code a|script for|function that|class that|hello|hi|hey|good morning|good evening|good night|how are you|thank you|thanks|cheers|goodbye|bye|shut down|what time|what day|what date|clip that|save that|record that|switch camera|camera \d|home panel|smart home|lights on|lights off|plug on|plug off)\b/i;

// Genuine question starters that suggest info lookup
const RESEARCH_QUESTION_STARTERS = /^(what is |what are |who is |who was |when did |when was |where is |where was |how does |how did |why does |why did |tell me about |explain |define |describe |what happened |history of |facts about |what caused |who invented |who created |who founded |how was .+ (made|created|built|invented|discovered))/i;

function shouldResearch(text) {
  const lower = text.toLowerCase().trim();

  // Hard no — these are clearly commands, not info queries
  if (NON_RESEARCH_SIGNALS.test(lower)) return false;

  // Hard no — starts with an action verb
  if (ACTION_VERBS.test(lower)) return false;

  // Hard no — very short (probably a greeting or quick command)
  const wordCount = text.trim().split(/\s+/).length;
  if (wordCount < 4) return false;

  // Hard no — contains code-related keywords anywhere
  if (/\b(function|class|script|component|api|server|endpoint|query|module|snippet|python|javascript|node|react|sql|bash|html|css|typescript|rust|go lang|flutter|dart|swift|kotlin|c\+\+|csharp|php|ruby|rails)\b/i.test(lower)) return false;

  // Hard no — conversational/emotional
  if (/\b(i feel|i am|i'm|i've|i was|i want|i need|i think|i believe|should i|help me|my |me |myself)\b/i.test(lower)) return false;

  // Yes — starts with a clear research question pattern
  if (RESEARCH_QUESTION_STARTERS.test(lower)) return true;

  // Yes — explicit knowledge/info markers with no action words
  if (/\b(history|origin|meaning|definition|invented|discovery|founded|born|died|facts about|what happened to)\b/i.test(lower)) return true;

  // Default: don't research — let the AI handle it
  return false;
}

// ── IS THIS A PERSON LOOKUP? ─────────────────────────────────
function isPersonLookup(text) {
  const lower = text.toLowerCase();
  return /\b(look up|lookup|find out about|search for|investigate|dig up|background check|run a check|pull everything on|find info on|who is|who was|what do you know about|give me everything on|give me the rundown on|find me everything on|research|locate|find the person)\b/i.test(lower);
}

module.exports = {
  research,
  shouldResearch,
  isPersonLookup,
  extractPersonName,
  lookupPerson,
  buildPersonIntelReport,
  searchDuckDuckGo,
  searchWikipedia,
  searchGitHub,
  searchReddit,
  searchStackOverflow,
  searchNPM,
  searchHackerNews,
};
