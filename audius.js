// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — AUDIUS MUSIC SOURCE
// Audius is a free, artist-hosted streaming catalog with a fully
// open API. Unlike Spotify (no free streaming API) or Discogs (a
// discography/marketplace database that doesn't host audio at all),
// Audius actually serves playable full-length audio — which is why
// it's "platform 2" for `jarvis music platform 2`.
//
// AUTH: Audius's console (audius.co/settings or api.audius.co/plans)
// hands you two credentials when you register an app:
//   - API Key      — safe for client-side use, read-only
//   - Bearer Token — BACKEND ONLY, grants higher rate limits + auth
//     features. Never put this in browser code.
// Everything in this file runs server-side, so we use the Bearer
// Token (falling back to the API key, then to no auth at all if
// neither is set — Audius still serves unauthenticated requests,
// just at a much lower rate limit).
//
// The OAuth2/PKCE flow (the one that asks for a Redirect URI) is a
// SEPARATE thing — it's for logging in *as* an Audius user to act on
// their behalf (favorite tracks, read their private playlists, etc).
// Jarvis never does that here, so the redirect URI field can be left
// blank or set to anything; it's unused by this module.
// ═══════════════════════════════════════════════════════════════
const API_BASE = "https://api.audius.co/v1";
const APP_NAME = process.env.AUDIUS_APP_NAME || "Jarvis";
const API_KEY = process.env.AUDIUS_API_KEY || "";
const BEARER_TOKEN = process.env.AUDIUS_BEARER_TOKEN || process.env.AUDIUS_API_SECRET || "";

function authHeaders() {
  if (BEARER_TOKEN) return { Authorization: `Bearer ${BEARER_TOKEN}` };
  return {};
}

// Every request carries app_name as a harmless, backward-compatible
// identifier, plus api_key when we have one (some endpoints/rate-limit
// tiers key off this rather than the Authorization header).
function withCreds(pathAndQuery) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  let url = `${API_BASE}${pathAndQuery}${sep}app_name=${encodeURIComponent(APP_NAME)}`;
  if (API_KEY) url += `&api_key=${encodeURIComponent(API_KEY)}`;
  return url;
}

async function audiusFetch(pathAndQuery) {
  return fetch(withCreds(pathAndQuery), {
    signal: AbortSignal.timeout(8000),
    headers: authHeaders(),
  });
}

// Searches Audius for a track and returns the closest match, or null.
// Shaped like the YouTube/library results elsewhere in server.js so
// callers can treat all three sources the same way.
async function searchAudiusTrack(query) {
  const q = (query || "").trim();
  if (!q) return null;
  try {
    const res = await audiusFetch(`/tracks/search?query=${encodeURIComponent(q)}`);
    if (!res.ok) {
      console.warn(`[AUDIUS] Search for "${q}" returned HTTP ${res.status}`);
      return null;
    }
    const json = await res.json();
    const track = Array.isArray(json?.data) ? json.data[0] : null;
    if (!track) return null;

    return {
      id: track.id,
      title: track.title || q,
      artist: track.user?.name || track.user?.handle || "",
      artwork: track.artwork?.["480x480"] || track.artwork?.["150x150"] || "",
      // Direct, playable stream URL. Bearer-token auth can't be
      // attached to this since it just gets handed to an <audio> tag
      // (no custom headers on that request), so carry api_key/app_name
      // in the URL itself — the stream endpoint accepts either.
      streamUrl: withCreds(`/tracks/${track.id}/stream`),
    };
  } catch (e) {
    console.warn(`[AUDIUS] Search for "${q}" failed: ${e.message}`);
    return null;
  }
}

module.exports = { searchAudiusTrack };
