// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — AUDIUS MUSIC SOURCE
// Audius is a free, artist-hosted streaming catalog with a fully
// open API. Unlike Spotify (no free streaming API) or Discogs (a
// discography/marketplace database that doesn't host audio at all),
// Audius actually serves playable MP3 streams for full tracks —
// which is why it's "platform 2" for `jarvis music platform 2`.
//
// AUTH NOTE: everything here — search and streaming — only needs an
// "app name" identifier, not a real secret. Audius's OAuth2/PKCE
// flow (the one that asks for a Redirect URI) is only for logging in
// as an Audius *user* (e.g. reading their private playlists/follows).
// Jarvis never does that here, so AUDIUS_APP_NAME is enough — leave
// the API key/secret and redirect URI fields on the Audius app
// unused, or set the redirect URI to anything (even
// http://localhost) since Jarvis never triggers that flow.
// ═══════════════════════════════════════════════════════════════
const APP_NAME = process.env.AUDIUS_APP_NAME || "Jarvis";

// A handful of well-known, historically stable Audius discovery
// nodes. Used as a fallback if the api.audius.co host-list redirector
// is slow/unreachable, so one flaky lookup doesn't kill playback.
const FALLBACK_HOSTS = [
  "https://discoveryprovider.audius.co",
  "https://discoveryprovider2.audius.co",
  "https://discoveryprovider3.audius.co",
  "https://audius-discovery-1.altego.net",
  "https://audius-discovery-2.altego.net",
];

let cachedHost = null;
let cachedHostAt = 0;
const HOST_TTL_MS = 30 * 60 * 1000; // re-check every 30 min

// Audius discovery nodes are independently run and occasionally go
// down, so we ask the official redirector for a fresh, currently-live
// list rather than hardcoding one host.
async function pickDiscoveryHost() {
  const now = Date.now();
  if (cachedHost && now - cachedHostAt < HOST_TTL_MS) return cachedHost;

  try {
    const res = await fetch("https://api.audius.co/", { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json();
      const hosts = Array.isArray(data?.data) ? data.data : [];
      if (hosts.length) {
        cachedHost = hosts[Math.floor(Math.random() * hosts.length)];
        cachedHostAt = now;
        return cachedHost;
      }
    }
  } catch (e) {
    console.warn(`[AUDIUS] Host redirector failed, falling back to a known node: ${e.message}`);
  }

  cachedHost = FALLBACK_HOSTS[Math.floor(Math.random() * FALLBACK_HOSTS.length)];
  cachedHostAt = now;
  return cachedHost;
}

// Tries the current host, and if the request errors out (node down,
// timeout, etc.) forces a fresh host pick and retries once.
async function audiusFetch(pathAndQuery) {
  let host = await pickDiscoveryHost();
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const url = `${host}${pathAndQuery}${sep}app_name=${encodeURIComponent(APP_NAME)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (res.ok) return res;
  } catch { /* fall through to retry on a different host */ }

  cachedHost = null; // force re-pick
  host = await pickDiscoveryHost();
  const retryUrl = `${host}${pathAndQuery}${sep}app_name=${encodeURIComponent(APP_NAME)}`;
  return fetch(retryUrl, { signal: AbortSignal.timeout(8000) });
}

// Searches Audius for a track and returns the closest match, or null.
// Shaped like the YouTube/library results elsewhere in server.js so
// callers can treat all three sources the same way.
async function searchAudiusTrack(query) {
  const q = (query || "").trim();
  if (!q) return null;
  try {
    const res = await audiusFetch(`/v1/tracks/search?query=${encodeURIComponent(q)}`);
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
      // Direct, playable stream URL — no separate lookup needed.
      streamUrl: `${await pickDiscoveryHost()}/v1/tracks/${track.id}/stream?app_name=${encodeURIComponent(APP_NAME)}`,
    };
  } catch (e) {
    console.warn(`[AUDIUS] Search for "${q}" failed: ${e.message}`);
    return null;
  }
}

module.exports = { searchAudiusTrack };
