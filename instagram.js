"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Instagram Integration
//
// Lets Jarvis look at YOUR OWN recent Instagram posts and comment on
// them the way a person glancing over your shoulder would — "Sir,
// you seemed to have a good time at the beach" — rather than just
// listing captions back at you.
//
// READ THIS BEFORE SETTING UP — Instagram's API changed a lot in
// 2024/2025 and the old easy path is gone:
//   - The old "Basic Display API" (personal accounts, one click)
//     was permanently shut down in December 2024. It is not an
//     option anymore, for anyone.
//   - What replaced it — "Instagram API with Instagram Login" — only
//     works for Instagram PROFESSIONAL accounts (Creator or
//     Business). Personal accounts have zero API access, full stop.
//     Converting is free and reversible: on the phone, Instagram app
//     -> Settings -> Account type and tools -> Switch to Professional
//     account -> Creator. It doesn't have to look different publicly
//     and doesn't require a linked Facebook Page for this flow.
//   - Because this only ever reads YOUR OWN account (you, the app's
//     own developer/tester), Meta's "App Review" step isn't required
//     — that's only for apps that other people's accounts sign into.
//     You still need to create the Meta developer app itself (below).
//
// SETUP:
//   1. Convert your Instagram account to Creator (see above).
//   2. https://developers.facebook.com -> My Apps -> Create App ->
//      choose "Other" -> "Business" type.
//   3. In the app, add the "Instagram" product (Instagram API with
//      Instagram Login setup, not the old Basic Display one).
//   4. Under that product's settings, add yourself as an
//      "Instagram tester" (your own Instagram account) — you'll get
//      an in-app request on Instagram to accept.
//   5. Copy the Instagram App ID + Instagram App Secret into .env:
//        INSTAGRAM_APP_ID=...
//        INSTAGRAM_APP_SECRET=...
//        INSTAGRAM_REDIRECT_BASE=https://your-domain-or-localhost:3000
//      (falls back to http://localhost:3000 if unset)
//   6. Add your exact redirect URI (INSTAGRAM_REDIRECT_BASE +
//      /api/instagram/callback) to the app's "Valid OAuth Redirect
//      URIs" in the Instagram product settings.
//   7. Restart Jarvis, then hit /api/instagram/auth in a browser (or
//      use whatever "Connect Instagram" button the front-end wires
//      up to it) and accept on your phone.
//
// Tokens persist to data/instagram-tokens.json — same folder
// persistence.js already mirrors to Supabase, so a connected account
// survives restarts/redeploys, same as everything else in data/.
// ═══════════════════════════════════════════════════════════════

const fs = require("fs");
const path = require("path");

const APP_ID     = process.env.INSTAGRAM_APP_ID     || "";
const APP_SECRET = process.env.INSTAGRAM_APP_SECRET || "";
const REDIRECT_BASE = (process.env.INSTAGRAM_REDIRECT_BASE || "").replace(/\/$/, "");
const CALLBACK_PATH = "/api/instagram/callback";

const DATA_DIR    = path.join(__dirname, "data");
const TOKEN_FILE  = path.join(DATA_DIR, "instagram-tokens.json");
const HANDLE_FILE = path.join(DATA_DIR, "instagram-handle.json");

function isConfigured() {
  return !!(APP_ID && APP_SECRET);
}

function getRedirectUri(reqHost) {
  if (REDIRECT_BASE) return REDIRECT_BASE + CALLBACK_PATH;
  if (reqHost) return "https://" + reqHost + CALLBACK_PATH;
  return "http://localhost:3000" + CALLBACK_PATH;
}

// ── TOKEN STORE (single owner account — same shape as spotify.js) ─
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadTokens() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return { access: null, userId: null, expiresAt: 0 };
  }
}

function saveTokens(tokens) {
  ensureDataDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokens, null, 2), "utf8");
}

function hasToken() {
  const t = loadTokens();
  return !!t.access;
}

function disconnect() {
  saveTokens({ access: null, userId: null, expiresAt: 0 });
}

// ═══════════════════════════════════════════════════════════════
// ── SIMPLE "JUST GIVE ME A USERNAME" TRACKING ─────────────────────
//
// The OAuth flow above is the "correct" way to read YOUR OWN account
// through Instagram's real API, but it requires a Meta developer app,
// a Professional account, etc. This is the lightweight alternative:
// say "Jarvis, connect Instagram", give it any public username (not
// necessarily your own — could be a friend's, a team's, whoever), and
// Jarvis will search the web for that account's latest post and
// comment on it — no app review, no login, no tokens.
//
// Trade-off: it's a web-search-and-scrape, not an API call, so it's
// slower, less reliable (Instagram often serves a login wall to
// logged-out visitors), and only sees whatever's publicly indexed —
// but it's a one-line setup instead of a multi-step Meta app dance.
// ═══════════════════════════════════════════════════════════════
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// How often the daily/proactive check is allowed to actually run the
// search+scrape (as opposed to the OAuth path, this hits a search
// engine and Instagram's own pages directly, so it's polled far less
// aggressively — once a day, not once a minute).
const TRACK_CHECK_INTERVAL_MS = 20 * 60 * 60 * 1000; // ~once/day

function loadHandleData() {
  ensureDataDir();
  try {
    return JSON.parse(fs.readFileSync(HANDLE_FILE, "utf8"));
  } catch {
    return { username: null, lastPostUrl: null, lastCheckedAt: 0 };
  }
}

function saveHandleData(data) {
  ensureDataDir();
  fs.writeFileSync(HANDLE_FILE, JSON.stringify(data, null, 2), "utf8");
}

function getTrackedUsername() {
  return loadHandleData().username;
}

function setTrackedUsername(rawUsername) {
  const clean = String(rawUsername || "").trim().replace(/^@/, "").split(/\s+/)[0];
  if (!/^[a-zA-Z0-9_.]{1,30}$/.test(clean)) return null;
  saveHandleData({ username: clean, lastPostUrl: null, lastCheckedAt: 0 });
  return clean;
}

function clearTrackedUsername() {
  saveHandleData({ username: null, lastPostUrl: null, lastCheckedAt: 0 });
}

// ── PENDING "what's the username?" QUESTION (per chat session) ───
// Mirrors the pattern briefing.js/debrief.js use for their own
// follow-up questions — server.js checks this at the top of /api/chat
// so whatever the user says next gets treated as the username instead
// of being routed anywhere else.
const pendingUsernameQuestions = new Map(); // sessionId -> true

function setPendingUsernameQuestion(sessionId) {
  if (sessionId) pendingUsernameQuestions.set(sessionId, true);
}
function getPendingUsernameQuestion(sessionId) {
  return !!sessionId && pendingUsernameQuestions.get(sessionId) === true;
}
function clearPendingUsernameQuestion(sessionId) {
  if (sessionId) pendingUsernameQuestions.delete(sessionId);
}

// "Jarvis, connect Instagram" (+ a username, given inline or as a
// follow-up answer) lands here.
async function handleConnectCommand(rawUsername, userTitle) {
  const T = userTitle || "Sir";
  const clean = setTrackedUsername(rawUsername);
  if (!clean) return { reply: `That doesn't look like a valid username, ${T} — try again?`, ok: false };
  return {
    reply: `Got it, ${T} — I'll keep an eye on @${clean}'s Instagram and let you know when something new goes up.`,
    ok: true,
    username: clean,
  };
}

// Searches the web for the account's most recent public post rather
// than calling any Instagram API. "<username> instagram post" reliably
// surfaces either the profile itself or a specific /p/ or /reel/ link
// in the first few results — this just picks the best one found.
async function findLatestPostViaSearch(username) {
  const research = require("./research");
  let results = [];
  try {
    results = await research.webSearch(`${username} instagram post`, { maxResults: 8 });
  } catch (e) {
    return { error: `couldn't search for that account (${e.message})` };
  }

  const directPost = results.find((r) => /instagram\.com\/[^/?]+\/(p|reel)\/[^/?]+/i.test(r.url));
  const profile = results.find((r) => /^https?:\/\/(www\.)?instagram\.com\/[a-z0-9_.]+\/?(\?.*)?$/i.test(r.url));
  const target = directPost || profile;

  if (!target) return { error: `couldn't find @${username} on Instagram` };
  return { url: target.url, isDirectPost: !!directPost, snippet: target.snippet || "" };
}

// Pulls Open Graph tags (og:image / og:description) off a public
// Instagram URL. Instagram populates these server-side for link
// previews, so — when it doesn't serve a login wall instead — this
// works without any authentication.
async function scrapeOgTags(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, "Accept-Language": "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(10000),
  });
  const html = await res.text();

  const grab = (prop) => {
    let m = html.match(new RegExp(`<meta[^>]+property=["']${prop}["'][^>]+content=["']([^"']*)["']`, "i"));
    if (!m) m = html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${prop}["']`, "i"));
    if (!m) return null;
    return m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#39;/g, "'").trim();
  };

  return { image: grab("og:image"), description: grab("og:description"), title: grab("og:title") };
}

// Turns whatever was scraped into the "glancing over your shoulder"
// remark — looks at the image if there is one (same vision call the
// OAuth path uses), otherwise falls back to the caption text.
async function describeScraped(og, opts = {}) {
  const T = opts.userTitle || "Sir";

  if (og.image) {
    try {
      const imgRes = await fetch(og.image, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(10000) });
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const base64 = buf.toString("base64");

      const vision = require("./screen-vision");
      const prompt =
        `You're Jarvis, a witty and warm personal AI assistant, looking at someone's most recent Instagram post. ` +
        `Make ONE short, natural, observational remark about it — the kind of thing you'd say glancing over their ` +
        `shoulder, addressing them as "${T}". Be specific to what's actually IN the photo (setting, mood, activity, ` +
        `who or what's in it — e.g. if it looks like a soccer match, say so) rather than generic. Warm and a little ` +
        `playful is good; don't be over the top or gushing. One or two sentences, nothing more.` +
        (og.description ? ` The caption was: "${truncate(og.description, 200)}" — you can nod to it, but the photo is the point.` : "");

      const remark = await vision.askVision(base64, prompt);
      return remark.trim();
    } catch {
      // Image fetch/vision failed — fall through to text-only below.
    }
  }

  if (og.description) return `Saw the new post, ${T} — "${truncate(og.description, 140)}."`;
  return null;
}

// The actual check: search -> scrape -> describe. Used both for
// on-demand ("check my Instagram") and the daily proactive nudge.
// force=true always produces a remark even if it's the same post as
// last time (on-demand case); force=false (proactive) only speaks up
// when the post is new.
async function checkTrackedAccount(userTitle, opts = {}) {
  const T = userTitle || "Sir";
  const force = !!opts.force;
  const data = loadHandleData();
  if (!data.username) return { notTracking: true };

  const found = await findLatestPostViaSearch(data.username);
  if (found.error) return { error: found.error };

  const isNew = found.url !== data.lastPostUrl;
  if (!isNew && !force) return { unchanged: true, url: found.url };

  let og = {};
  try { og = await scrapeOgTags(found.url); } catch { og = {}; }

  let remark = await describeScraped(og, { userTitle: T });
  if (!remark) {
    remark = `Found @${data.username}'s latest on Instagram, ${T}, but it's behind Instagram's login wall from here — I couldn't actually see it.`;
  }

  saveHandleData({ ...data, lastPostUrl: found.url, lastCheckedAt: Date.now() });
  return { reply: remark, url: found.url, isNew };
}

// Gate for the proactive/daily poll — only actually runs the
// search+scrape once every ~20 hours per tracked account, and only
// speaks up (returns non-null) when there's something new to say.
async function dailyTrackedCheck(userTitle) {
  const data = loadHandleData();
  if (!data.username) return null;
  if (Date.now() - (data.lastCheckedAt || 0) < TRACK_CHECK_INTERVAL_MS) return null;

  let result;
  try { result = await checkTrackedAccount(userTitle, { force: false }); }
  catch { return null; }

  if (!result || result.error || result.notTracking || result.unchanged) return null;
  return result;
}

// ── AUTH URL ────────────────────────────────────────────────────
// instagram_business_basic is the current (post-Jan-2025) scope name
// for "read my own profile + media" — the old instagram_basic /
// instagram_graph_user_media scope names were deprecated and no
// longer work.
function getAuthUrl(reqHost) {
  if (!isConfigured()) return null;
  const params = new URLSearchParams({
    client_id: APP_ID,
    redirect_uri: getRedirectUri(reqHost),
    response_type: "code",
    scope: "instagram_business_basic",
  });
  return `https://www.instagram.com/oauth/authorize?${params}`;
}

// ── EXCHANGE CODE → SHORT-LIVED TOKEN → LONG-LIVED TOKEN ──────────
// Instagram Login hands back a short-lived (1hr) token first; this
// immediately trades it for a long-lived one (60 days) so Jarvis
// isn't re-authing every hour. The long-lived token itself needs
// refreshing before it expires — see refreshIfNeeded() below.
async function exchangeCode(code, reqHost) {
  if (!isConfigured()) return { error: "missing_credentials" };
  try {
    const shortRes = await fetch("https://api.instagram.com/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: APP_ID,
        client_secret: APP_SECRET,
        grant_type: "authorization_code",
        redirect_uri: getRedirectUri(reqHost),
        code,
      }),
    });
    const shortData = await shortRes.json();
    if (shortData.error_message || !shortData.access_token) {
      return { error: shortData.error_message || "no access_token in response" };
    }

    const longRes = await fetch(
      `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${encodeURIComponent(APP_SECRET)}&access_token=${encodeURIComponent(shortData.access_token)}`
    );
    const longData = await longRes.json();
    if (!longData.access_token) {
      return { error: "couldn't get a long-lived token" };
    }

    const tokens = {
      access: longData.access_token,
      userId: shortData.user_id,
      expiresAt: Date.now() + (longData.expires_in - 86400) * 1000, // refresh a day early
    };
    saveTokens(tokens);
    return { success: true, tokens };
  } catch (e) {
    return { error: e.message };
  }
}

// Refreshes the long-lived token if it's close to expiring. Instagram
// requires the token to still be valid (not yet expired) to refresh
// it — there's no "refresh token" concept here like OAuth normally
// has, just re-upping the same token before its 60-day clock runs out.
async function refreshIfNeeded() {
  const tokens = loadTokens();
  if (!tokens.access) return null;
  if (Date.now() < tokens.expiresAt) return tokens.access;

  try {
    const res = await fetch(
      `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(tokens.access)}`
    );
    const data = await res.json();
    if (!data.access_token) { disconnect(); return null; }
    tokens.access = data.access_token;
    tokens.expiresAt = Date.now() + (data.expires_in - 86400) * 1000;
    saveTokens(tokens);
    return tokens.access;
  } catch {
    return null;
  }
}

// ── FETCH RECENT MEDIA ─────────────────────────────────────────────
// Returns the owner's own recent posts — id, caption, media type/url,
// permalink, timestamp. limit defaults to a handful, enough for "did
// I post anything today/this week" style checks without over-fetching.
async function fetchRecentMedia(limit = 6) {
  const token = await refreshIfNeeded();
  if (!token) return { needsAuth: true, authUrl: getAuthUrl() };

  try {
    const fields = "id,caption,media_type,media_url,thumbnail_url,permalink,timestamp";
    const res = await fetch(
      `https://graph.instagram.com/me/media?fields=${fields}&limit=${limit}&access_token=${encodeURIComponent(token)}`
    );
    const data = await res.json();
    if (data.error) {
      // A token that Instagram itself has invalidated (revoked
      // access, password change, etc.) shows up here as an API error
      // even though our local expiresAt clock thought it was fine.
      if (data.error.code === 190) { disconnect(); return { needsAuth: true, authUrl: getAuthUrl() }; }
      return { error: data.error.message || "Instagram API error" };
    }
    return { media: data.data || [] };
  } catch (e) {
    return { error: e.message };
  }
}

// ── GENERATE AN OBSERVATION FROM A POST ────────────────────────────
// The whole point of this feature: not just reading the caption back,
// but actually LOOKING at the photo/video thumbnail and commenting on
// it like a person would — "you seemed to have a good time at the
// beach" is an observation about the image, not a caption quote.
// Uses screen-vision.js's askVision (same Gemini/Groq vision call
// already used for screen-reading) since it already handles
// multi-provider fallback and key rotation — no need for a second
// vision client just for this.
async function describePost(post, opts = {}) {
  const T = opts.userTitle || "Sir";
  const imageUrl = post.media_type === "VIDEO" ? post.thumbnail_url : post.media_url;
  if (!imageUrl) {
    return post.caption
      ? `Looks like a post from ${timeAgo(post.timestamp)} — "${truncate(post.caption, 120)}."`
      : `A post from ${timeAgo(post.timestamp)}, ${T}, though there's nothing for me to read into it.`;
  }

  try {
    const imgRes = await fetch(imageUrl);
    const buf = Buffer.from(await imgRes.arrayBuffer());
    const base64 = buf.toString("base64");

    const vision = require("./screen-vision");
    const prompt =
      `You're Jarvis, a witty and warm personal AI assistant, looking at a photo your user just posted to Instagram ` +
      `${timeAgo(post.timestamp)}. Make ONE short, natural, observational remark about it — the kind of thing you'd ` +
      `say glancing over their shoulder, addressing them as "${T}". Be specific to what's actually IN the photo (the ` +
      `setting, mood, activity, who/what's in it) rather than generic. Warm and a little playful is good; don't be ` +
      `over the top or gushing. One or two sentences, nothing more.` +
      (post.caption ? ` Their caption was: "${truncate(post.caption, 200)}" — you can nod to it, but the photo itself is the point.` : "");

    const remark = await vision.askVision(base64, prompt);
    return remark.trim();
  } catch (e) {
    // Image fetch/vision failed — fall back to caption-only rather
    // than surfacing an error for what's meant to be a light, casual
    // feature.
    return post.caption
      ? `Saw your post from ${timeAgo(post.timestamp)} — "${truncate(post.caption, 120)}."`
      : `Saw a new post from ${timeAgo(post.timestamp)}, ${T}, but couldn't quite make it out.`;
  }
}

function truncate(s, n) {
  const clean = String(s || "").replace(/\s+/g, " ").trim();
  return clean.length > n ? clean.slice(0, n - 1).trimEnd() + "…" : clean;
}

function timeAgo(isoTimestamp) {
  const then = new Date(isoTimestamp).getTime();
  if (!then) return "recently";
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 60) return diffMin <= 1 ? "just now" : `${diffMin} minutes ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay === 1) return "yesterday";
  if (diffDay < 7) return `${diffDay} days ago`;
  return new Date(isoTimestamp).toLocaleDateString();
}

// ── ON-DEMAND: "what do you think of my last post" / "check my instagram"
async function handleInstagramCommand(userTitle) {
  if (!isConfigured()) {
    return { error: "Instagram isn't configured yet — add INSTAGRAM_APP_ID and INSTAGRAM_APP_SECRET to .env (see this file's header comment for the full setup)." };
  }
  const result = await fetchRecentMedia(3);
  if (result.needsAuth) return result;
  if (result.error) return { error: result.error };
  if (!result.media.length) return { reply: `Nothing posted recently that I can see, ${userTitle || "Sir"}.` };

  const remark = await describePost(result.media[0], { userTitle });
  return { reply: remark, post: result.media[0] };
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCode,
  hasToken,
  disconnect,
  fetchRecentMedia,
  describePost,
  handleInstagramCommand,
  loadTokens, // exported for the proactive dedupe store (checkSocialMoment) to read the connected userId, etc. if ever needed

  // Simple username-based tracking (no OAuth) — see the big comment
  // block above for how this differs from the API path.
  getTrackedUsername,
  setTrackedUsername,
  clearTrackedUsername,
  setPendingUsernameQuestion,
  getPendingUsernameQuestion,
  clearPendingUsernameQuestion,
  handleConnectCommand,
  checkTrackedAccount,
  dailyTrackedCheck,
};
