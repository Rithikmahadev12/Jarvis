"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Google Integration (Gmail + Calendar)
// Uses Google OAuth2. Set up at console.cloud.google.com
// Enable: Gmail API + Google Calendar API
// Create OAuth2 credentials → Web Application
// ═══════════════════════════════════════════════════════════════

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI  || "http://localhost:3000/api/google/callback";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

let _tokens = { access: null, refresh: null, expiresAt: 0 };

// ── AUTH ──────────────────────────────────────────────────────
function getAuthUrl() {
  const params = new URLSearchParams({
    client_id:     GOOGLE_CLIENT_ID,
    redirect_uri:  GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope:         SCOPES.join(" "),
    access_type:   "offline",
    prompt:        "consent",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

async function exchangeCode(code) {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return { error: "missing_credentials" };
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        code,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri:  GOOGLE_REDIRECT_URI,
        grant_type:    "authorization_code",
      }),
    });
    const data = await res.json();
    if (data.error) return { error: data.error };
    _tokens = {
      access:    data.access_token,
      refresh:   data.refresh_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    };
    return { success: true };
  } catch (e) { return { error: e.message }; }
}

async function refreshToken() {
  if (!_tokens.refresh) return false;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        refresh_token: _tokens.refresh,
        client_id:     GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        grant_type:    "refresh_token",
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      _tokens.access    = data.access_token;
      _tokens.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
      return true;
    }
    return false;
  } catch { return false; }
}

async function getToken() {
  if (!_tokens.access) return null;
  if (Date.now() > _tokens.expiresAt) {
    const ok = await refreshToken();
    if (!ok) { _tokens.access = null; return null; }
  }
  return _tokens.access;
}

async function googleFetch(url, options = {}) {
  const token = await getToken();
  if (!token) return { needsAuth: true, authUrl: getAuthUrl() };
  try {
    const res = await fetch(url, {
      ...options,
      headers: { "Authorization": `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (res.status === 401) { _tokens.access = null; return { needsAuth: true, authUrl: getAuthUrl() }; }
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

// ── GMAIL ─────────────────────────────────────────────────────
async function getInbox(maxResults = 10) {
  const listData = await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&q=is:unread&maxResults=${maxResults}`
  );
  if (listData.needsAuth) return listData;
  if (listData.error) return listData;

  const unread = listData.resultSizeEstimate || 0;
  if (!listData.messages || listData.messages.length === 0) return { unread: 0, messages: [] };

  // Fetch first 3 message details
  const detailed = await Promise.all(
    listData.messages.slice(0, 3).map(async (msg) => {
      const detail = await googleFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`
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

  return {
    unread:   unread,
    messages: detailed.filter(Boolean),
  };
}

async function handleGmailCommand(message) {
  const lower = message.toLowerCase();
  if (/unread|inbox|check.*mail|new.*email|how many/i.test(lower)) return await getInbox();
  return await getInbox(5);
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
  if (/this week|week/i.test(lower)) {
    const start = new Date(now);
    const end   = new Date(now); end.setDate(end.getDate() + 7);
    return { start, end, label: "this week" };
  }
  if (/next week/i.test(lower)) {
    const start = new Date(now); start.setDate(start.getDate() + 7);
    const end   = new Date(start); end.setDate(end.getDate() + 7);
    return { start, end, label: "next week" };
  }
  // Default: today
  const start = new Date(now); start.setHours(0,0,0,0);
  const end   = new Date(now); end.setHours(23,59,59,999);
  return { start, end, label: "today" };
}

async function getCalendarEvents(message) {
  const range = parseDateRange(message);
  const params = new URLSearchParams({
    timeMin:      range.start.toISOString(),
    timeMax:      range.end.toISOString(),
    singleEvents: "true",
    orderBy:      "startTime",
    maxResults:   "10",
  });

  const data = await googleFetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);
  if (data.needsAuth) return data;
  if (data.error) return data;

  const events = (data.items || []).map(event => {
    const start = event.start?.dateTime || event.start?.date;
    const time  = start
      ? new Date(start).toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true })
      : "all day";
    return {
      title:    event.summary || "(untitled)",
      time,
      location: event.location || null,
      link:     event.htmlLink,
    };
  });

  return { events, period: range.label };
}

async function handleCalendarCommand(message) {
  return await getCalendarEvents(message);
}

function isConfigured()   { return !!(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET); }
function hasToken()       { return !!_tokens.access; }
function setTokens(t)     { _tokens = t; }
function getTokens()      { return _tokens; }

module.exports = {
  handleGmailCommand,
  handleCalendarCommand,
  exchangeCode,
  getAuthUrl,
  isConfigured,
  hasToken,
  setTokens,
  getTokens,
};
