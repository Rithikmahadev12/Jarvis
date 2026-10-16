"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Face Lookup Routes
// Save as: face-lookup-routes.js  (root level, next to server.js)
//
// Routes:
//   POST /api/face-lookup/image-search   → Firecrawl reverse image search
//   POST /api/face-lookup/sixtyfour      → SixtyFour async people lookup
//   GET  /api/face-lookup/sixtyfour-status/:taskId → poll SixtyFour job
//
// Uses: FIRECRAWL_API_KEY + SIXTYFOUR_API_KEY from .env
// No extra dependencies beyond what Jarvis already has (node-fetch via
// global fetch on Node 18+, or native undici).
// ═══════════════════════════════════════════════════════════════

const FIRECRAWL_KEY  = process.env.FIRECRAWL_API_KEY  || '';
const SIXTYFOUR_KEY  = process.env.SIXTYFOUR_API_KEY  || '';
const SIXTYFOUR_TIER = process.env.SIXTYFOUR_TIER     || 'low';

// Google Lens reverse image search URL — Firecrawl can scrape it
const GOOGLE_LENS_BASE = 'https://lens.google.com/uploadbyurl?url=';

// ── HELPERS ────────────────────────────────────────────────────

// Post an image URL to Google Lens via Firecrawl scrape.
// We use Firecrawl's /scrape endpoint with the Google Lens URL + the
// image embedded as a data: URI via a creative URL trick: we POST the
// base64 image to a temporary image host (imgbb — free, no account
// for API, 32MB limit) and pass the resulting URL to Google Lens.
// If imgbb fails we fall back to a Firecrawl-native "search" approach.

async function uploadImageToImgBB(base64Jpeg) {
  // ImgBB free API — no key needed for small images, just POST form data
  const form = new URLSearchParams();
  form.append('image', base64Jpeg);
  const res = await fetch('https://api.imgbb.com/1/upload?expiration=120&key=public', {
    method: 'POST',
    body:   form,
  });
  if (!res.ok) throw new Error(`ImgBB upload failed: ${res.status}`);
  const data = await res.json();
  return data?.data?.url || null;
}

// Alternative: use Firecrawl's /extract endpoint to search Google Images
// by constructing a search query from the image. This is a text-search
// fallback when we can't get an image URL.
async function firecrawlSearchByName(name) {
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(name + ' site:linkedin.com OR site:twitter.com OR site:instagram.com')}`;
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${FIRECRAWL_KEY}`,
    },
    body: JSON.stringify({
      url:     searchUrl,
      formats: ['markdown', 'links'],
      actions: [],
      onlyMainContent: true,
    }),
  });
  if (!res.ok) throw new Error(`Firecrawl scrape failed: ${res.status}`);
  return res.json();
}

// The real workhorse: use Firecrawl to scrape Google Lens results page
// for a given image URL, then parse candidate names from the markdown.
async function firecrawlGoogleLens(imageUrl) {
  const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}`;
  const res = await fetch('https://api.firecrawl.dev/v1/scrape', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${FIRECRAWL_KEY}`,
    },
    body: JSON.stringify({
      url:     lensUrl,
      formats: ['markdown', 'links'],
      onlyMainContent: true,
      waitFor: 3000,
    }),
  });
  if (!res.ok) throw new Error(`Firecrawl Lens scrape failed: ${res.status}`);
  return res.json();
}

// Firecrawl deep search — uses their /search endpoint to find pages
// about a person across the web given a text query
async function firecrawlSearch(query) {
  const res = await fetch('https://api.firecrawl.dev/v1/search', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${FIRECRAWL_KEY}`,
    },
    body: JSON.stringify({
      query,
      limit:          8,
      scrapeOptions:  { formats: ['markdown'] },
    }),
  });
  if (!res.ok) throw new Error(`Firecrawl search failed: ${res.status}`);
  return res.json();
}

// Parse candidate identities out of Firecrawl markdown/links
// Returns array of { name, url, confidence, platform }
function extractCandidatesFromFirecrawl(scrapeData, searchResults) {
  const candidates = [];
  const seen = new Set();

  // From search results (most reliable)
  if (searchResults?.data) {
    for (const result of searchResults.data) {
      const title = result.title || '';
      const url   = result.url   || '';
      const desc  = result.description || result.markdown?.slice(0, 200) || '';

      // Try to extract a person name from title
      const nameMatch = title.match(/^([A-Z][a-z]+ (?:[A-Z][a-z]+ ?)+)/);
      const name = nameMatch ? nameMatch[1].trim() : null;

      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        const platform = url.includes('linkedin') ? 'LINKEDIN'
                       : url.includes('twitter')  ? 'TWITTER'
                       : url.includes('instagram') ? 'INSTAGRAM'
                       : url.includes('facebook')  ? 'FACEBOOK'
                       : url.includes('github')    ? 'GITHUB'
                       : 'WEB';
        candidates.push({ name, url, confidence: 0.72, platform, snippet: desc.slice(0, 120) });
      }
    }
  }

  // From lens scrape markdown
  if (scrapeData?.markdown) {
    const md = scrapeData.markdown;
    // Regex to pull capitalized Name patterns from markdown text
    const nameRegex = /\b([A-Z][a-z]{2,}\s+[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)\b/g;
    let m;
    while ((m = nameRegex.exec(md)) !== null) {
      const name = m[1].trim();
      // Filter out common non-person phrases
      const blocklist = ['Google Lens','Search Results','Related Images','Visual Match','Similar Images','About Results'];
      if (blocklist.some(b => name.includes(b))) continue;
      if (!seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        candidates.push({ name, url: null, confidence: 0.55, platform: 'GOOGLE_LENS', snippet: '' });
      }
    }
  }

  // Sort by confidence desc
  candidates.sort((a, b) => b.confidence - a.confidence);
  return candidates.slice(0, 5);
}

// ── SIXTYFOUR HELPERS ──────────────────────────────────────────

const STRUCT_FIELDS = {
  full_name:      "The individual's full name.",
  headline:       "A short one-line description — current job title and company, or what they're best known for.",
  location:       "City/region if publicly findable.",
  linkedin_url:   "LinkedIn profile URL.",
  twitter_url:    "Twitter/X profile URL.",
  instagram_url:  "Instagram profile URL.",
  github_url:     "GitHub profile URL.",
  website_url:    "Personal website URL.",
  summary:        "Two to three sentence public-facing summary based only on publicly available info.",
};

async function sixtyfourStartLookup(name, url) {
  const leadInfo = {};
  if (name) leadInfo.name = name;
  if (url)  leadInfo.website = url;

  const body = {
    lead_info: leadInfo,
    tier:      SIXTYFOUR_TIER,
    structured_data_to_collect: STRUCT_FIELDS,
  };

  const res = await fetch('https://api.sixtyfour.ai/v1/people-intelligence-async', {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SIXTYFOUR_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`SixtyFour start failed ${res.status}: ${txt}`);
  }
  return res.json(); // { task_id, status, ... }
}

async function sixtyfourGetStatus(taskId) {
  const res = await fetch(`https://api.sixtyfour.ai/v1/job-status/${taskId}`, {
    headers: { 'Authorization': `Bearer ${SIXTYFOUR_KEY}` },
  });
  if (!res.ok) throw new Error(`SixtyFour poll failed: ${res.status}`);
  return res.json();
}

// Flatten SixtyFour structured_data into a flat profile object
function flattenSixtyFourProfile(jobData) {
  const sd = jobData?.structured_data || jobData?.result?.structured_data || {};
  const profile = {};
  for (const [key, val] of Object.entries(sd)) {
    profile[key] = typeof val === 'object' ? (val?.value || val?.text || JSON.stringify(val)) : val;
  }
  // Also pull top-level fields
  if (jobData?.name)     profile.full_name  = profile.full_name  || jobData.name;
  if (jobData?.headline) profile.headline   = profile.headline   || jobData.headline;
  if (jobData?.location) profile.location   = profile.location   || jobData.location;
  if (jobData?.summary)  profile.summary    = profile.summary    || jobData.summary;
  return profile;
}

// ── MOUNT ROUTES ───────────────────────────────────────────────
function mount(app) {

  // ── POST /api/face-lookup/image-search ──────────────────────
  // Body: { imageBase64: string }   (JPEG base64, no data: prefix)
  // Returns: { success, candidates: [{name, url, confidence, platform}] }
  app.post('/api/face-lookup/image-search', async (req, res) => {
    const { imageBase64 } = req.body || {};
    if (!imageBase64) return res.status(400).json({ success: false, error: 'Missing imageBase64' });
    if (!FIRECRAWL_KEY) return res.status(503).json({ success: false, error: 'FIRECRAWL_API_KEY not set' });

    try {
      let imageUrl   = null;
      let lensData   = null;
      let searchData = null;

      // 1. Try to upload image to ImgBB to get a URL for Google Lens
      try {
        imageUrl = await uploadImageToImgBB(imageBase64);
        console.log('[FACE-LOOKUP] ImgBB upload OK:', imageUrl);
      } catch (e) {
        console.warn('[FACE-LOOKUP] ImgBB upload failed (will skip Lens):', e.message);
      }

      // 2. Scrape Google Lens with the image URL if we got one
      if (imageUrl) {
        try {
          lensData = await firecrawlGoogleLens(imageUrl);
          console.log('[FACE-LOOKUP] Google Lens scraped, markdown length:', lensData?.markdown?.length || 0);
        } catch (e) {
          console.warn('[FACE-LOOKUP] Lens scrape failed:', e.message);
        }
      }

      // 3. Extract candidate names from Lens results
      const lensCandidates = extractCandidatesFromFirecrawl(lensData, null);

      // 4. If we got names, do a Firecrawl search to find their profiles
      if (lensCandidates.length > 0) {
        const topName = lensCandidates[0].name;
        try {
          searchData = await firecrawlSearch(`${topName} person profile`);
          console.log('[FACE-LOOKUP] Firecrawl search results:', searchData?.data?.length || 0);
        } catch (e) {
          console.warn('[FACE-LOOKUP] Firecrawl search failed:', e.message);
        }
      }

      // 5. Merge all results
      const allCandidates = extractCandidatesFromFirecrawl(lensData, searchData);

      if (!allCandidates.length) {
        return res.json({ success: false, candidates: [], reason: 'no_candidates' });
      }

      console.log('[FACE-LOOKUP] Top candidate:', allCandidates[0].name, 'conf:', allCandidates[0].confidence);
      return res.json({ success: true, candidates: allCandidates });

    } catch (e) {
      console.error('[FACE-LOOKUP] image-search error:', e.message);
      return res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /api/face-lookup/sixtyfour ─────────────────────────
  // Body: { name: string, url?: string }
  // Returns: { success, status: 'pending'|'complete', taskId?, profile? }
  app.post('/api/face-lookup/sixtyfour', async (req, res) => {
    const { name, url } = req.body || {};
    if (!name) return res.status(400).json({ success: false, error: 'Missing name' });

    if (!SIXTYFOUR_KEY) {
      // No SixtyFour key — return success:false so frontend uses Firecrawl data alone
      return res.json({ success: false, error: 'SIXTYFOUR_API_KEY not set' });
    }

    try {
      const job = await sixtyfourStartLookup(name, url);
      const taskId = job.task_id || job.id;
      console.log('[FACE-LOOKUP] SixtyFour job started:', taskId, 'status:', job.status);

      if (job.status === 'completed' || job.status === 'complete') {
        const profile = flattenSixtyFourProfile(job);
        return res.json({ success: true, status: 'complete', profile });
      }

      return res.json({ success: true, status: 'pending', taskId });
    } catch (e) {
      console.error('[FACE-LOOKUP] SixtyFour start error:', e.message);
      return res.json({ success: false, error: e.message });
    }
  });

  // ── GET /api/face-lookup/sixtyfour-status/:taskId ───────────
  app.get('/api/face-lookup/sixtyfour-status/:taskId', async (req, res) => {
    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ status: 'error', error: 'Missing taskId' });

    if (!SIXTYFOUR_KEY) return res.status(503).json({ status: 'error', error: 'SIXTYFOUR_API_KEY not set' });

    try {
      const job = await sixtyfourGetStatus(taskId);
      const done = ['completed','complete','done','success'].includes((job.status||'').toLowerCase());

      if (done) {
        const profile = flattenSixtyFourProfile(job);
        return res.json({ status: 'complete', profile });
      }

      return res.json({ status: 'pending', jobStatus: job.status });
    } catch (e) {
      console.error('[FACE-LOOKUP] SixtyFour poll error:', e.message);
      return res.status(500).json({ status: 'error', error: e.message });
    }
  });

  console.log('[FACE-LOOKUP] Routes mounted: /api/face-lookup/*');
}

module.exports = { mount };
