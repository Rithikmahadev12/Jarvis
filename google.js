"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Google Integration (Gmail + Calendar)
// Per-user: each user stores their own OAuth credentials + tokens
// in their profile. No shared global credentials.
// ═══════════════════════════════════════════════════════════════

const REDIRECT_BASE = (process.env.GOOGLE_REDIRECT_BASE || "").replace(/\/$/, "");
const CALLBACK_PATH = "/api/google/callback";

// Derive the redirect URI at request time so it always matches the actual host.
// Priority: GOOGLE_REDIRECT_BASE env var → Host header → localhost fallback
function getRedirectUri(reqHost) {
  if (REDIRECT_BASE) return REDIRECT_BASE + CALLBACK_PATH;
  if (reqHost)       return "https://" + reqHost + CALLBACK_PATH;
  return "http://localhost:3000" + CALLBACK_PATH;
}

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// ── PER-USER TOKEN CACHE (in-memory, avoids repeated disk reads) ──
// Structure: { [nameKey]: { access, refresh, expiresAt } }
const _tokenCache = {};

// ── AUTH URL ──────────────────────────────────────────────────
// Pass the user's own clientId + a state param so the callback
// knows which user to store the tokens under.
function getAuthUrl(userKey, clientId, reqHost) {
  if (!clientId) return null;
  const redirectUri = getRedirectUri(reqHost);
  const params = new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: "code",
    scope:         SCOPES.join(" "),
    access_type:   "offline",
    prompt:        "consent",
    state:         userKey,   // round-tripped so callback knows the user
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

// ── EXCHANGE CODE ─────────────────────────────────────────────
async function exchangeCode(code, userKey, clientId, clientSecret, reqHost) {
  if (!clientId || !clientSecret) return { error: "missing_credentials" };
  const redirectUri = getRedirectUri(reqHost);
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    "authorization_code",
      }),
    });
    const data = await res.json();
    if (data.error) return { error: data.error };
    _tokenCache[userKey] = {
      access:    data.access_token,
      refresh:   data.refresh_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    return { success: true, tokens: _tokenCache[userKey] };
  } catch (e) { return { error: e.message }; }
}

// ── REFRESH TOKEN ─────────────────────────────────────────────
async function refreshToken(userKey, clientId, clientSecret) {
  const cache = _tokenCache[userKey];
  if (!cache?.refresh) return false;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        refresh_token: cache.refresh,
        client_id:     clientId,
        client_secret: clientSecret,
        grant_type:    "refresh_token",
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      cache.access    = data.access_token;
      cache.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
      return true;
    }
    return false;
  } catch { return false; }
}

// ── GET VALID TOKEN ───────────────────────────────────────────
async function getToken(userKey, clientId, clientSecret) {
  const cache = _tokenCache[userKey];
  if (!cache?.access) return null;
  if (Date.now() > cache.expiresAt) {
    const ok = await refreshToken(userKey, clientId, clientSecret);
    if (!ok) { delete _tokenCache[userKey]; return null; }
  }
  return cache.access;
}

// ── HYDRATE TOKENS FROM PROFILE ──────────────────────────────
// Call on login so the in-memory cache is warm
function hydrateTokens(userKey, savedTokens) {
  if (savedTokens?.access) _tokenCache[userKey] = { ...savedTokens };
}

// ── GOOGLE FETCH ──────────────────────────────────────────────
async function googleFetch(url, userKey, clientId, clientSecret, options = {}) {
  const token = await getToken(userKey, clientId, clientSecret);
  if (!token) return { needsAuth: true, authUrl: getAuthUrl(userKey, clientId) };
  try {
    const res = await fetch(url, {
      ...options,
      headers: { "Authorization": `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (res.status === 401) {
      delete _tokenCache[userKey];
      return { needsAuth: true, authUrl: getAuthUrl(userKey, clientId) };
    }
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

// ── GMAIL ─────────────────────────────────────────────────────
async function getInbox(userKey, clientId, clientSecret, maxResults = 10) {
  const listData = await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&q=is:unread&maxResults=${maxResults}`,
    userKey, clientId, clientSecret
  );
  if (listData.needsAuth || listData.error) return listData;
  const unread = listData.resultSizeEstimate || 0;
  if (!listData.messages?.length) return { unread: 0, messages: [] };

  const detailed = await Promise.all(
    listData.messages.slice(0, 3).map(async (msg) => {
      const detail = await googleFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        userKey, clientId, clientSecret
      );
      if (detail.error || detail.needsAuth) return null;
      const headers = detail.payload?.headers || [];
      const get = (name) => headers.find(h => h.name === name)?.value || "";
      return {
        subject: get("Subject") || "(no subject)",
        from:    get("From").replace(/<.*>/, "").trim() || "Unknown",
        date:    get("Date"),
        snippet: detail.snippet?.slice(0, 100),
      };
    })
  );
  return { unread, messages: detailed.filter(Boolean) };
}

async function handleGmailCommand(message, userKey, clientId, clientSecret) {
  return await getInbox(userKey, clientId, clientSecret, 10);
}

// ── GOOGLE CALENDAR ───────────────────────────────────────────
function parseDateRange(message) {
  const lower = message.toLowerCase();
  const now   = new Date();
  if (/tomorrow/i.test(lower)) {
    const start = new Date(now); start.setDate(start.getDate() + 1); start.setHours(0,0,0,0);
    const end   = new Date(start); end.setHours(23,59,59,999);
    return { start, end, label: "tomorrow" };
  }
  if (/next week/i.test(lower)) {
    const start = new Date(now); start.setDate(start.getDate() + 7);
    const end   = new Date(start); end.setDate(end.getDate() + 7);
    return { start, end, label: "next week" };
  }
  if (/this week|week/i.test(lower)) {
    const start = new Date(now);
    const end   = new Date(now); end.setDate(end.getDate() + 7);
    return { start, end, label: "this week" };
  }
  const start = new Date(now); start.setHours(0,0,0,0);
  const end   = new Date(now); end.setHours(23,59,59,999);
  return { start, end, label: "today" };
}

async function getCalendarEvents(message, userKey, clientId, clientSecret) {
  const range = parseDateRange(message);
  const params = new URLSearchParams({
    timeMin: range.start.toISOString(), timeMax: range.end.toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "10",
  });
  const data = await googleFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    userKey, clientId, clientSecret
  );
  if (data.needsAuth || data.error) return data;
  const events = (data.items || []).map(event => {
    const start = event.start?.dateTime || event.start?.date;
    const time  = start
      ? new Date(start).toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true })
      : "all day";
    return { title: event.summary || "(untitled)", time, location: event.location || null, link: event.htmlLink };
  });
  return { events, period: range.label };
}

async function handleCalendarCommand(message, userKey, clientId, clientSecret) {
  return await getCalendarEvents(message, userKey, clientId, clientSecret);
}

// ── USER CREDENTIAL HELPERS ───────────────────────────────────
function isConfiguredForUser(profile) {
  return !!(profile?.googleClientId && profile?.googleClientSecret);
}
function hasTokenForUser(userKey) {
  return !!_tokenCache[userKey]?.access;
}
function getTokensForUser(userKey) {
  return _tokenCache[userKey] || null;
}

module.exports = {
  getAuthUrl,
  exchangeCode,
  hydrateTokens,
  handleGmailCommand,
  handleCalendarCommand,
  isConfiguredForUser,
  hasTokenForUser,
  getTokensForUser,
};
