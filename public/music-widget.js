// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — MUSIC WIDGET
// Always-a-widget now-playing card. Audio comes from a 1px hidden
// YouTube IFrame player (we don't have Spotify), but nothing ever
// opens a new tab or page for playback — this is the only UI.
// ═══════════════════════════════════════════════════════════════
window.MusicWidget = (function () {
  let player = null;
  let playerReady = false;
  let pendingPlay = null;   // { videoId, list } queued while player boots
  let apiPromise = null;
  let progressTimer = null;
  let scrubbing = false;

  function $(id) { return document.getElementById(id); }

  // ── YouTube IFrame API loader (loaded once, lazily) ──────────
  function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) return Promise.resolve();
    if (apiPromise) return apiPromise;
    apiPromise = new Promise((resolve) => {
      const prevCb = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = function () {
        if (typeof prevCb === "function") prevCb();
        resolve();
      };
      const tag = document.createElement("script");
      tag.src = "https://www.youtube.com/iframe_api";
      document.head.appendChild(tag);
    });
    return apiPromise;
  }

  // ── DOM ────────────────────────────────────────────────────
  function ensureDOM() {
    if ($("music-widget")) return;
    const wrap = document.createElement("div");
    wrap.id = "music-widget";
    wrap.className = "music-widget hidden";
    wrap.innerHTML = `
      <div class="mw-header">
        <span class="mw-label">&#9670; NOW PLAYING</span>
        <button class="mw-close" id="mw-close" aria-label="Close" title="Stop">&#10005;</button>
      </div>
      <div class="mw-body">
        <div class="mw-art" id="mw-art">
          <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6">
            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
        </div>
        <div class="mw-info">
          <div class="mw-title" id="mw-title">—</div>
          <div class="mw-subtitle" id="mw-subtitle">—</div>
        </div>
      </div>
      <div class="mw-progress">
        <div class="mw-progress-track" id="mw-progress-track">
          <div class="mw-progress-fill" id="mw-progress-fill"></div>
        </div>
        <div class="mw-times"><span id="mw-elapsed">0:00</span><span id="mw-duration">0:00</span></div>
      </div>
      <div class="mw-controls">
        <button class="mw-btn" id="mw-stop" aria-label="Stop" title="Stop">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>
        </button>
        <button class="mw-btn mw-btn-main" id="mw-playpause" aria-label="Play or pause" title="Play/Pause">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" id="mw-playpause-icon"><polygon points="6,4 20,12 6,20"/></svg>
        </button>
        <a class="mw-btn" id="mw-open-yt" target="_blank" rel="noopener" aria-label="Open source" title="Open source">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>
        </a>
      </div>
      <div id="mw-yt-mount" class="mw-yt-mount"></div>
    `;
    document.body.appendChild(wrap);

    $("mw-close").addEventListener("click", stop);
    $("mw-stop").addEventListener("click", stop);
    $("mw-playpause").addEventListener("click", togglePlayPause);
    $("mw-progress-track").addEventListener("click", onScrub);
  }

  function onScrub(e) {
    if (!player || typeof player.seekTo !== "function") return;
    const track = $("mw-progress-track");
    const rect = track.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const dur = player.getDuration ? player.getDuration() : 0;
    if (dur > 0) player.seekTo(dur * pct, true);
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${s < 10 ? "0" : ""}${s}`;
  }

  function parseYouTubeUrl(url) {
    try {
      const u = new URL(url);
      return { videoId: u.searchParams.get("v"), list: u.searchParams.get("list") };
    } catch { return { videoId: null, list: null }; }
  }

  function show() { ensureDOM(); $("music-widget").classList.remove("hidden"); }
  function hide() { const w = $("music-widget"); if (w) w.classList.add("hidden"); }

  function setPlayPauseIcon(isPlaying) {
    const icon = $("mw-playpause-icon");
    const art = $("mw-art");
    if (icon) {
      icon.innerHTML = isPlaying
        ? '<rect x="5" y="4" width="4.5" height="16" rx="1"/><rect x="14.5" y="4" width="4.5" height="16" rx="1"/>'
        : '<polygon points="6,4 20,12 6,20"/>';
    }
    if (art) art.classList.toggle("playing", !!isPlaying);
  }

  function startProgressTimer() {
    stopProgressTimer();
    progressTimer = setInterval(() => {
      if (!player || scrubbing || typeof player.getCurrentTime !== "function") return;
      const cur = player.getCurrentTime() || 0;
      const dur = player.getDuration() || 0;
      const elapsedEl = $("mw-elapsed"), durEl = $("mw-duration"), fillEl = $("mw-progress-fill");
      if (elapsedEl) elapsedEl.textContent = fmtTime(cur);
      if (durEl) durEl.textContent = fmtTime(dur);
      if (fillEl) fillEl.style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%";
    }, 500);
  }
  function stopProgressTimer() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

  function onPlayerStateChange(e) {
    if (!window.YT) return;
    if (e.data === YT.PlayerState.PLAYING) setPlayPauseIcon(true);
    else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) setPlayPauseIcon(false);
  }

  function loadIntoPlayer(videoId, list) {
    if (list) player.loadPlaylist({ list, listType: "playlist" });
    else if (videoId) player.loadVideoById(videoId);
  }

  function createPlayer(videoId, list) {
    const playerVars = { autoplay: 1, controls: 0, playsinline: 1, rel: 0 };
    if (list) { playerVars.listType = "playlist"; playerVars.list = list; }
    player = new YT.Player("mw-yt-mount", {
      height: "1",
      width: "1",
      videoId: videoId || undefined,
      playerVars,
      events: {
        onReady: () => {
          playerReady = true;
          if (pendingPlay) { loadIntoPlayer(pendingPlay.videoId, pendingPlay.list); pendingPlay = null; }
          player.playVideo();
          setPlayPauseIcon(true);
          startProgressTimer();
        },
        onStateChange: onPlayerStateChange,
      },
    });
  }

  // ── Public API ─────────────────────────────────────────────
  async function play({ url, title, artist }) {
    if (!url) return;
    const { videoId, list } = parseYouTubeUrl(url);
    if (!videoId && !list) return;

    ensureDOM();
    $("mw-title").textContent = title || "Unknown Track";
    $("mw-subtitle").textContent = artist || "Now playing";
    $("mw-open-yt").href = url;
    $("mw-elapsed").textContent = "0:00";
    $("mw-duration").textContent = "0:00";
    $("mw-progress-fill").style.width = "0%";
    show();

    await loadYouTubeAPI();

    if (!player) {
      createPlayer(videoId, list);
    } else if (playerReady) {
      loadIntoPlayer(videoId, list);
      player.playVideo();
      setPlayPauseIcon(true);
      startProgressTimer();
    } else {
      pendingPlay = { videoId, list };
    }
  }

  function togglePlayPause() {
    if (!player || typeof player.getPlayerState !== "function") return;
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) { player.pauseVideo(); setPlayPauseIcon(false); }
    else { player.playVideo(); setPlayPauseIcon(true); }
  }

  function pause() { if (player && player.pauseVideo) { player.pauseVideo(); setPlayPauseIcon(false); } }
  function resume() { if (player && player.playVideo) { player.playVideo(); setPlayPauseIcon(true); } }

  function stop() {
    if (player && player.stopVideo) { try { player.stopVideo(); } catch {} }
    stopProgressTimer();
    hide();
  }

  function isPlaying() {
    return !!(player && player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING);
  }

  return { play, pause, resume, stop, togglePlayPause, isPlaying };
})();
