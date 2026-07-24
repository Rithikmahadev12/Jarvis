"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Google Integration (Gmail + Calendar)
// Per-user: each user stores their own OAuth credentials + tokens
// in their profile. No shared global credentials.
// ═══════════════════════════════════════════════════════════════

const REDIRECT_BASE = (process.env.GOOGLE_REDIRECT_BASE || "").replace(/\/$/, "");
const CALLBACK_PATH = "/api/google/callback";

// ── APP-WIDE CREDENTIALS ──────────────────────────────────────
// One Google Cloud OAuth app for the whole deployment. Set these once in
// .env; every user then just clicks "Sign in with Google" — nobody has to
// create their own Google Cloud project or paste in a client ID/secret.
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID     || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";

function isConfigured() {
  return !!(CLIENT_ID && CLIENT_SECRET);
}

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
// state param round-trips so the callback knows which user to store the
// tokens under. Uses the single app-wide client ID — the user never
// needs to supply their own.
function getAuthUrl(userKey, reqHost) {
  if (!isConfigured()) return null;
  const redirectUri = getRedirectUri(reqHost);
  const params = new URLSearchParams({
    client_id:     CLIENT_ID,
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
async function exchangeCode(code, userKey, reqHost) {
  if (!isConfigured()) return { error: "missing_credentials" };
  const redirectUri = getRedirectUri(reqHost);
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        code,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
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
async function refreshToken(userKey) {
  const cache = _tokenCache[userKey];
  if (!cache?.refresh) return false;
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    new URLSearchParams({
        refresh_token: cache.refresh,
        client_id:     CLIENT_ID,
        client_secret: CLIENT_SECRET,
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
async function getToken(userKey) {
  const cache = _tokenCache[userKey];
  if (!cache?.access) return null;
  if (Date.now() > cache.expiresAt) {
    const ok = await refreshToken(userKey);
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
async function googleFetch(url, userKey, options = {}) {
  const token = await getToken(userKey);
  if (!token) return { needsAuth: true, authUrl: getAuthUrl(userKey) };
  try {
    const res = await fetch(url, {
      ...options,
      headers: { "Authorization": `Bearer ${token}`, ...(options.headers || {}) },
    });
    if (res.status === 401) {
      delete _tokenCache[userKey];
      return { needsAuth: true, authUrl: getAuthUrl(userKey) };
    }
    return await res.json();
  } catch (e) { return { error: e.message }; }
}

// ── GMAIL ─────────────────────────────────────────────────────

// Heuristic: is this "From" header a real person, or a company/automated
// sender? Used so JARVIS can flag "this one's actually from a person"
// vs "this is a company reaching out" (and name the person if the
// company's From header names one, e.g. "Sarah from Acme <sarah@acme.com>").
const AUTOMATED_LOCAL_PARTS = /^(no-?reply|do-?not-?reply|notifications?|notify|support|help|info|hello|team|news(letter)?|updates?|billing|accounts?|sales|marketing|orders?|alerts?|mailer|admin|contact|feedback|jobs|careers)\b/i;
const COMPANY_NAME_HINTS    = /\b(inc|llc|ltd|co\.|corp|team|support|notifications?|newsletter|no-?reply|billing|marketing)\b/i;

function classifySender(fromHeader) {
  const raw = String(fromHeader || "").trim();
  const emailMatch = raw.match(/<([^>]+)>/);
  const email = (emailMatch ? emailMatch[1] : raw).trim();
  const localPart = email.split("@")[0] || "";
  const displayName = raw.replace(/<.*>/, "").replace(/"/g, "").trim();
  // Handle "Sarah Jones, Acme Sales" — split into a name candidate and a
  // trailing company/role fragment so each can be checked on its own.
  const [namePart, ...restParts] = displayName.split(",").map(s => s.trim());
  const restText = restParts.join(", ");

  const isHumanName = (s) => /^[A-Z][a-z'-]+(\s[A-Z][a-z'-]+){1,2}$/.test(s || "") && !COMPANY_NAME_HINTS.test(s || "");

  const looksLikeHumanName = isHumanName(displayName) || (isHumanName(namePart) === true);
  const looksAutomated = AUTOMATED_LOCAL_PARTS.test(localPart) || COMPANY_NAME_HINTS.test(displayName);

  if (looksAutomated) {
    // Company/automated sender — but see if a person's name is embedded,
    // e.g. "Sarah at Acme Support" or "Sarah Jones, Acme Sales".
    const nameInside = displayName.match(/^([A-Z][a-z'-]+(?:\s[A-Z][a-z'-]+)?)\b/);
    return {
      type: "company",
      personName: nameInside && !COMPANY_NAME_HINTS.test(nameInside[1]) ? nameInside[1] : null,
    };
  }
  if (looksLikeHumanName && restText) {
    // "Sarah Jones, Acme Sales" — a real name, but reaching out on a
    // company's behalf (comma-separated role/company suffix implies this,
    // regardless of whether the suffix contains an obvious keyword).
    return { type: "company", personName: namePart };
  }
  if (looksLikeHumanName) return { type: "person", personName: namePart || displayName };
  // Ambiguous — default to person-ish so we don't bury real people, but
  // without claiming a clean name match.
  return { type: "unknown", personName: namePart || null };
}

async function getInbox(userKey, maxResults = 15) {
  const listData = await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages?labelIds=INBOX&q=is:unread&maxResults=${maxResults}`,
    userKey
  );
  if (listData.needsAuth || listData.error) return listData;
  const unread = listData.resultSizeEstimate || 0;
  if (!listData.messages?.length) return { unread: 0, messages: [] };

  const detailed = await Promise.all(
    listData.messages.map(async (msg) => {
      const detail = await googleFetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        userKey
      );
      if (detail.error || detail.needsAuth) return null;
      const headers = detail.payload?.headers || [];
      const get = (name) => headers.find(h => h.name === name)?.value || "";
      const fromHeader = get("From");
      const sender = classifySender(fromHeader);
      return {
        id:      msg.id,
        subject: get("Subject") || "(no subject)",
        from:    fromHeader.replace(/<.*>/, "").trim() || "Unknown",
        fromEmail: (fromHeader.match(/<([^>]+)>/) || [])[1] || fromHeader,
        date:    get("Date"),
        snippet: detail.snippet?.slice(0, 140),
        senderType: sender.type,     // "person" | "company" | "unknown"
        senderPersonName: sender.personName,
      };
    })
  );
  return { unread, messages: detailed.filter(Boolean) };
}

// Fetch the full plain-text body of one message, for "read the one from
// John" / "read email 2" follow-ups. Decodes the base64url body, walking
// multipart payloads to find a text/plain part (falling back to text/html
// stripped of tags if that's all there is).
function decodeBase64Url(data) {
  if (!data) return "";
  const normalized = data.replace(/-/g, "+").replace(/_/g, "/");
  try { return Buffer.from(normalized, "base64").toString("utf8"); }
  catch { return ""; }
}

function extractBody(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  if (payload.mimeType === "text/html" && payload.body?.data) {
    return decodeBase64Url(payload.body.data).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  for (const part of payload.parts || []) {
    const found = extractBody(part);
    if (found) return found;
  }
  return "";
}

async function getMessageBody(userKey, messageId) {
  const detail = await googleFetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    userKey
  );
  if (detail.error || detail.needsAuth) return detail;
  const headers = detail.payload?.headers || [];
  const get = (name) => headers.find(h => h.name === name)?.value || "";
  const body = extractBody(detail.payload).trim();
  return {
    id:      messageId,
    subject: get("Subject") || "(no subject)",
    from:    get("From").replace(/<.*>/, "").trim() || "Unknown",
    date:    get("Date"),
    body:    body || detail.snippet || "(no readable body)",
  };
}

async function handleGmailCommand(message, userKey) {
  return await getInbox(userKey, 10);
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

async function getCalendarEvents(message, userKey) {
  const range = parseDateRange(message);
  const params = new URLSearchParams({
    timeMin: range.start.toISOString(), timeMax: range.end.toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "10",
  });
  const data = await googleFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    userKey
  );
  if (data.needsAuth || data.error) return data;
  const events = (data.items || []).map(event => {
    const start = event.start?.dateTime || event.start?.date;
    const time  = start
      ? new Date(start).toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true })
      : "all day";
    return {
      title: event.summary || "(untitled)",
      time,
      // Raw ISO start + a stable id — added so downstream consumers (e.g.
      // proactive.js's nudge engine) can compute "starts in N minutes" and
      // dedupe "already nudged about this one" without re-parsing `time`.
      startISO: start || null,
      id: event.id || `${event.summary || "untitled"}|${start || "allday"}`,
      location: event.location || null,
      link: event.htmlLink,
    };
  });
  return { events, period: range.label };
}

async function handleCalendarCommand(message, userKey) {
  return await getCalendarEvents(message, userKey);
}

// ── USER TOKEN HELPERS ────────────────────────────────────────
function hasTokenForUser(userKey) {
  return !!_tokenCache[userKey]?.access;
}
function getTokensForUser(userKey) {
  return _tokenCache[userKey] || null;
}

module.exports = {
  isConfigured,
  getAuthUrl,
  exchangeCode,
  hydrateTokens,
  handleGmailCommand,
  handleCalendarCommand,
  hasTokenForUser,
  getTokensForUser,
  getInbox,
  getMessageBody,
  classifySender,
};
