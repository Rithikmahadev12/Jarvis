"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Spotify Integration
// Uses Spotify Web API with OAuth2 PKCE flow
// ═══════════════════════════════════════════════════════════════

const SPOTIFY_CLIENT_ID     = process.env.SPOTIFY_CLIENT_ID     || "";
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || "";
const SPOTIFY_REDIRECT_URI  = process.env.SPOTIFY_REDIRECT_URI  || "http://localhost:3000/api/spotify/callback";

let _tokens = { access: null, refresh: null, expiresAt: 0 };

// ── AUTH URL ─────────────────────────────────────────────────
function getAuthUrl() {
  const scopes = [
    "user-read-playback-state",
    "user-modify-playback-state",
    "user-read-currently-playing",
    "streaming",
    "playlist-read-private",
  ].join(" ");
  const params = new URLSearchParams({
    client_id:     SPOTIFY_CLIENT_ID,
    response_type: "code",
    redirect_uri:  SPOTIFY_REDIRECT_URI,
    scope:         scopes,
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

// ── TOKEN EXCHANGE ────────────────────────────────────────────
async function exchangeCode(code) {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) return { error: "missing_credentials" };
  try {
    const body = new URLSearchParams({
      grant_type:   "authorization_code",
      code,
      redirect_uri: SPOTIFY_REDIRECT_URI,
    });
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      },
      body,
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
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: _tokens.refresh });
    const res = await fetch("https://accounts.spotify.com/api/token", {
      method:  "POST",
      headers: {
        "Content-Type":  "application/x-www-form-urlencoded",
        "Authorization": "Basic " + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString("base64"),
      },
      body,
    });
    const data = await res.json();
    if (data.access_token) {
      _tokens.access    = data.access_token;
      _tokens.expiresAt = Date.now() + (data.expires_in - 60) * 1000;
      if (data.refresh_token) _tokens.refresh = data.refresh_token;
      return true;
    }
    return false;
  } catch { return false; }
}

async function getToken() {
  if (!_tokens.access) return null;
  if (Date.now() > _tokens.expiresAt) {
    const ok = await refreshToken();
    if (!ok) return null;
  }
  return _tokens.access;
}

async function spotifyFetch(endpoint, method = "GET", body = null) {
  const token = await getToken();
  if (!token) return { needsAuth: true, authUrl: getAuthUrl() };
  const opts = { method, headers: { "Authorization": `Bearer ${token}` } };
  if (body) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
  try {
    const res = await fetch(`https://api.spotify.com/v1${endpoint}`, opts);
    if (res.status === 204 || res.status === 202) return { ok: true };
    if (res.status === 401) { _tokens.access = null; return { needsAuth: true, authUrl: getAuthUrl() }; }
    const text = await res.text();
    return text ? JSON.parse(text) : { ok: true };
  } catch (e) { return { error: e.message }; }
}

// ── PUBLIC API ────────────────────────────────────────────────
async function nowPlaying() {
  const data = await spotifyFetch("/me/player/currently-playing");
  if (data.needsAuth) return data;
  if (!data || !data.item) return { action: "now_playing", track: null };
  const item = data.item;
  const ms = (p, d) => {
    const pm = Math.floor(p/60000), ps = Math.floor((p%60000)/1000);
    const dm = Math.floor(d/60000), ds = Math.floor((d%60000)/1000);
    return `${pm}:${String(ps).padStart(2,"0")} / ${dm}:${String(ds).padStart(2,"0")}`;
  };
  return {
    action:     "now_playing",
    track:      item.name,
    artist:     item.artists.map(a => a.name).join(", "),
    album:      item.album?.name,
    is_playing: data.is_playing,
    progress:   ms(data.progress_ms || 0, item.duration_ms),
    duration:   ms(item.duration_ms, item.duration_ms),
  };
}

async function playPause(play) {
  const action = play ? "play" : "pause";
  const data = await spotifyFetch(`/me/player/${action}`, "PUT");
  return data.needsAuth ? data : { action: play ? "resumed" : "paused" };
}

async function nextTrack() {
  const data = await spotifyFetch("/me/player/next", "POST");
  if (data.needsAuth) return data;
  await new Promise(r => setTimeout(r, 400));
  const np = await nowPlaying();
  return { action: "next", ...np };
}

async function searchAndPlay(query) {
  const searchData = await spotifyFetch(`/search?q=${encodeURIComponent(query)}&type=track&limit=1`);
  if (searchData.needsAuth) return searchData;
  if (!searchData.tracks?.items?.length) return { error: "no_results" };
  const track = searchData.tracks.items[0];
  const playData = await spotifyFetch("/me/player/play", "PUT", { uris: [track.uri] });
  if (playData.needsAuth) return playData;
  return { action: "played", track: track.name, artist: track.artists.map(a => a.name).join(", ") };
}

async function setVolume(pct) {
  const vol = Math.max(0, Math.min(100, parseInt(pct) || 50));
  const data = await spotifyFetch(`/me/player/volume?volume_percent=${vol}`, "PUT");
  return data.needsAuth ? data : { action: "volume", volume: vol };
}

async function handleSpotifyCommand(message) {
  const lower = message.toLowerCase();
  if (!SPOTIFY_CLIENT_ID) return { error: "Spotify credentials not configured. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET to your .env file." };

  if (/what'?s playing|now playing|currently playing/i.test(lower)) return await nowPlaying();
  if (/\bpause\b|\bstop music\b|\bstop playing\b/i.test(lower)) return await playPause(false);
  if (/\bresume\b|\bplay again\b|\bunpause\b/i.test(lower)) return await playPause(true);
  if (/\bnext\b|\bskip\b|\bnext track\b|\bnext song\b/i.test(lower)) return await nextTrack();
  if (/volume\s+(\d+)/i.test(lower)) { const m = lower.match(/volume\s+(\d+)/i); return await setVolume(m[1]); }

  // Search & play
  const playMatch = lower.match(/play\s+(?:some\s+)?(?:the\s+)?(.{3,60})$/i);
  if (playMatch) return await searchAndPlay(playMatch[1]);

  return await nowPlaying();
}

function isConfigured() { return !!(SPOTIFY_CLIENT_ID && SPOTIFY_CLIENT_SECRET); }
function hasToken()     { return !!_tokens.access; }
function setTokens(t)   { _tokens = t; }
function getTokens()    { return _tokens; }

module.exports = { handleSpotifyCommand, exchangeCode, getAuthUrl, isConfigured, hasToken, setTokens, getTokens, nowPlaying };
