"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — SixtyFour People-Intelligence Lookup
//
// Wraps SixtyFour AI's people-intelligence API so "jarvis lookup
// <name / email / username>" can resolve someone into a short
// profile plus the public profile links tied to them.
//
// This is a long-running search on SixtyFour's end (can take
// minutes), so it's wired as an async job:
//   1. startLookup()  -> POST /people-intelligence-async, returns a task_id
//   2. getStatus(id)  -> GET  /job-status/:id, polled by the browser
//                        (see public/lookup-widget.js) until it's done
//
// Get a key at app.sixtyfour.ai -> add SIXTYFOUR_API_KEY to .env
// Docs: https://docs.sixtyfour.ai/api-reference/endpoint/people-intelligence
// ═══════════════════════════════════════════════════════════════

const API_KEY  = process.env.SIXTYFOUR_API_KEY || "";
const BASE_URL = "https://api.sixtyfour.ai";
// "low" (default) is the fast/cheap tier — fine for a voice-command
// lookup. "medium" digs deeper but takes longer. "high"/"xhigh" are
// OSINT-grade tiers that are sales-gated on SixtyFour's side — a
// user can still ask for them via the osint tier command, but the
// request will 403 unless their org has been granted access.
const DEFAULT_TIER = process.env.SIXTYFOUR_TIER || "low";
const VALID_TIERS = ["micro", "low", "medium", "high", "xhigh"];

function isConfigured() {
  return !!API_KEY;
}

function isValidTier(tier) {
  return VALID_TIERS.includes(String(tier || "").toLowerCase());
}

// What we want back for each field. Keys become properties on
// result.structured_data; the string is the instruction SixtyFour's
// agent uses to go find that field.
const STRUCT = {
  full_name:      "The individual's full name.",
  headline:       "A short one-line description of who they are — current job title and company, or what they're best known for.",
  location:       "The individual's city/region, if it can be found.",
  linkedin_url:   "LinkedIn profile URL.",
  twitter_url:    "Twitter/X profile URL.",
  instagram_url:  "Instagram profile URL.",
  facebook_url:   "Facebook profile URL.",
  github_url:     "GitHub profile URL.",
  tiktok_url:     "TikTok profile URL.",
  youtube_url:    "YouTube channel URL.",
  website_url:    "Personal or company website URL.",
  other_profiles: "Any other notable public profiles/accounts found, as a short comma-separated list of platform + URL.",
  summary:        "A two to three sentence public-facing summary of who this person is, based only on what's publicly findable.",
};

function buildLeadInfo({ name, email, username } = {}) {
  const lead = {};
  if (name)     lead.name     = String(name).trim();
  if (email)    lead.email    = String(email).trim();
  if (username) lead.username = String(username).trim();
  return lead;
}

// ── START A LOOKUP ──────────────────────────────────────────────
// `tier` is optional — pass the caller's chosen OSINT tier (see
// "jarvis osint tier ..." in server.js) to override DEFAULT_TIER
// for just this request.
async function startLookup({ name, email, username, tier } = {}) {
  if (!isConfigured()) {
    return { error: "SixtyFour API key not configured. Add SIXTYFOUR_API_KEY to your .env file. Get a key at app.sixtyfour.ai." };
  }

  const lead_info = buildLeadInfo({ name, email, username });
  if (!Object.keys(lead_info).length) {
    return { error: "Need a name, email, or username to look up." };
  }

  const useTier = isValidTier(tier) ? String(tier).toLowerCase() : DEFAULT_TIER;

  try {
    const res = await fetch(`${BASE_URL}/people-intelligence-async`, {
      method: "POST",
      headers: { "x-api-key": API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ lead_info, struct: STRUCT, tier: useTier }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { error: `SixtyFour rejected the request (${res.status}). ${res.status === 403 ? `The "${useTier}" tier may not be enabled for your account — check with SixtyFour, or switch to "medium" or "low".` : "Check SIXTYFOUR_API_KEY."}` };
      }
      return { error: `SixtyFour returned ${res.status} starting the lookup.` };
    }

    const data = await res.json();
    if (!data.task_id) return { error: "SixtyFour didn't return a task ID." };
    return { taskId: data.task_id, query: lead_info, tier: useTier };
  } catch (e) {
    return { error: `SixtyFour lookup failed to start: ${e.message}` };
  }
}

// ── POLL STATUS ──────────────────────────────────────────────────
async function getStatus(taskId) {
  if (!isConfigured()) return { error: "SixtyFour API key not configured." };
  if (!taskId) return { error: "Missing task ID." };

  try {
    const res = await fetch(`${BASE_URL}/job-status/${encodeURIComponent(taskId)}`, {
      headers: { "x-api-key": API_KEY },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: `SixtyFour returned ${res.status} checking status.` };

    const data = await res.json();
    // Async start returns uppercase RUNNING; job-status returns lowercase.
    const status = String(data.status || "").toLowerCase();

    if (status === "completed") {
      return { status: "completed", profile: normalizeResult(data.result) };
    }
    if (status === "failed" || status === "cancelled") {
      return { status, error: data.error || `Job ${status}.` };
    }
    return { status: status || "running" };
  } catch (e) {
    return { error: `SixtyFour status check failed: ${e.message}` };
  }
}

// ── SHAPE THE RESULT FOR THE WIDGET ───────────────────────────────
function guessPlatform(url, desc) {
  const u = String(url).toLowerCase();
  if (u.includes("linkedin.com"))                        return "LinkedIn";
  if (u.includes("twitter.com") || u.includes("x.com"))   return "Twitter/X";
  if (u.includes("instagram.com"))                        return "Instagram";
  if (u.includes("facebook.com"))                         return "Facebook";
  if (u.includes("github.com"))                           return "GitHub";
  if (u.includes("tiktok.com"))                           return "TikTok";
  if (u.includes("youtube.com"))                          return "YouTube";
  const label = (desc || "Link").split(/[.,–-]/)[0].trim();
  return label.slice(0, 24) || "Link";
}

function normalizeResult(result) {
  const sd = (result && result.structured_data) || result || {};
  const links = [];
  const seen = new Set();

  const push = (platform, url) => {
    if (!url || typeof url !== "string") return;
    const u = url.trim();
    if (!/^https?:\/\//i.test(u) || seen.has(u)) return;
    seen.add(u);
    links.push({ platform, url: u });
  };

  push("LinkedIn",   sd.linkedin_url  || sd.linkedin);
  push("Twitter/X",  sd.twitter_url);
  push("Instagram",  sd.instagram_url);
  push("Facebook",   sd.facebook_url);
  push("GitHub",     sd.github_url);
  push("TikTok",     sd.tiktok_url);
  push("YouTube",    sd.youtube_url);
  push("Website",    sd.website_url || sd.website);

  // `references` is a { url: description } map SixtyFour returns
  // separately — sometimes it turns up extra profiles the struct
  // fields above didn't catch.
  if (result && result.references && typeof result.references === "object") {
    for (const [url, desc] of Object.entries(result.references)) {
      push(guessPlatform(url, desc), url);
    }
  }

  return {
    name:       sd.full_name || sd.name || null,
    headline:   sd.headline  || sd.title || null,
    location:   sd.location  || null,
    summary:    sd.summary   || null,
    otherNote:  sd.other_profiles || null,
    confidence: typeof result?.confidence_score === "number" ? result.confidence_score : null,
    links,
  };
}

module.exports = { isConfigured, isValidTier, startLookup, getStatus, VALID_TIERS };
