// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — MUSIC WIDGET
// Always-a-widget now-playing card. Audio comes from a 1px hidden
// YouTube IFrame player (we don't have Spotify), but nothing ever
// opens a new tab or page for playback — this is the only UI.
// Draggable, and keeps itself in sync when a radio mix / playlist
// auto-advances to a new track.
// ═══════════════════════════════════════════════════════════════
window.MusicWidget = (function () {
  let player = null;
  let playerReady = false;
  let pendingPlay = null;    // { videoId, list } queued while player boots
  let apiPromise = null;
  let progressTimer = null;
  let scrubbing = false;
  let repeatOn = false;
  let isPlaylist = false;    // whether the current source is a list/mix
  let requestedVideoId = null; // the video we explicitly asked to play
  let currentVideoId = null;   // whatever's actually loaded right now

  // "youtube" uses the YT IFrame player above; "audio" is any direct
  // streamable URL (currently Audius) played through a plain <audio>
  // element instead — there's no video/iframe involved for those.
  let currentSource = "youtube";
  let audioEl = null;

  function $(id) { return document.getElementById(id); }

  // ── Web Audio tap for beat-reactive visuals ──────────────────
  // Owned here (not by Sleep Mode) since this module owns the <audio>
  // element itself — a given element can only ever be wrapped by ONE
  // MediaElementSourceNode for its whole lifetime, so anything else
  // that wants beat/amplitude data (Sleep Mode's glow ring) reads it
  // through getBeatData()/getFrequencyBins() below instead of tapping
  // the element a second time. Audius (currentSource === "audio")
  // only — YouTube's iframe audio is cross-origin and unreadable.
  let audioCtx = null, analyser = null, sourceNode = null, freqData = null;
  let tappedElement = null;

  function ensureAudioTap() {
    if (currentSource !== "audio" || !audioEl) return false;
    if (tappedElement === audioEl && analyser) return true;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (!sourceNode || tappedElement !== audioEl) {
        sourceNode = audioCtx.createMediaElementSource(audioEl);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        sourceNode.connect(analyser);
        analyser.connect(audioCtx.destination); // keep it audible!
        tappedElement = audioEl;
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      return true;
    } catch (e) {
      console.warn("[MUSIC] Couldn't tap audio for beat data:", e.message);
      return false;
    }
  }

  function getAmplitude() {
    if (!analyser || !freqData) return 0;
    analyser.getByteFrequencyData(freqData);
    let sum = 0;
    for (let i = 0; i < freqData.length; i++) sum += freqData[i];
    return (sum / freqData.length) / 255; // 0..1
  }

  // Bass-energy onset/beat detector — tracks a slow running average of
  // bass-band energy and fires a decaying "beat" envelope whenever the
  // current bass level spikes well above it.
  let bassAvg = 0, lastBeatAt = 0, beatEnvelope = 0;
  function detectBeat() {
    if (!analyser || !freqData) return 0;
    analyser.getByteFrequencyData(freqData);
    const bassBins = Math.max(4, Math.floor(freqData.length * 0.12));
    let sum = 0;
    for (let i = 0; i < bassBins; i++) sum += freqData[i];
    const bass = sum / bassBins / 255;
    bassAvg = bassAvg === 0 ? bass : bassAvg * 0.92 + bass * 0.08;
    const now = Date.now();
    if (bass > bassAvg * 1.22 && bass > 0.18 && now - lastBeatAt > 220) {
      lastBeatAt = now;
      beatEnvelope = 1;
    }
    beatEnvelope *= 0.88; // exponential decay back to 0 between hits
    return beatEnvelope;
  }

  // Splits the analyser's frequency bins into `n` averaged buckets —
  // used by Sleep Mode's bar visualizer.
  function getFrequencyBins(n) {
    if (!analyser || !freqData) return null;
    analyser.getByteFrequencyData(freqData);
    const usable = Math.floor(freqData.length * 0.75);
    const bins = new Array(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(Math.pow(i / n, 1.5) * usable);
      const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / n, 1.5) * usable));
      let sum = 0, count = 0;
      for (let j = start; j < end && j < freqData.length; j++) { sum += freqData[j]; count++; }
      bins[i] = count ? (sum / count) / 255 : 0;
    }
    return bins;
  }

  // Public: current reactive amplitude/beat for anything that wants to
  // sync visuals to the music. `reactive` is false for YouTube (its
  // audio can't be read by the page at all), in which case callers
  // should fall back to their own ambient motion.
  function getBeatData() {
    const reactive = currentSource === "audio" && ensureAudioTap();
    return {
      reactive,
      amplitude: reactive ? getAmplitude() : 0,
      beat: reactive ? detectBeat() : 0,
    };
  }

  // ── Ring animation loop — drives the widget's rotating color-wheel
  // border via CSS custom properties so it spins faster / pulses
  // brighter on the beat (Audius), or sways gently for YouTube. Skipped
  // entirely for the embedded dashboard variant, which has no ring. ──
  let ringRafId = null;
  let ringAngle = 0;
  function ringTick() {
    const wrap = $("music-widget");
    if (!wrap || wrap.classList.contains("hidden") || wrap.classList.contains("mw-embedded")) {
      ringRafId = null;
      return;
    }
    const playing = isPlaying();
    const { reactive, amplitude, beat } = getBeatData();
    let speed, pulse;
    if (!playing) {
      speed = 0.15; pulse = 0.25;
    } else if (reactive) {
      speed = 0.3 + amplitude * 1.1 + beat * 2.4;
      pulse = 0.3 + amplitude * 0.45 + beat * 0.75;
    } else {
      // No readable audio (YouTube) — gentle ambient sway instead.
      speed = 0.35 + Math.sin(Date.now() / 700) * 0.15;
      pulse = 0.5 + Math.sin(Date.now() / 900) * 0.25;
    }
    ringAngle = (ringAngle + speed) % 360;
    wrap.style.setProperty("--mw-angle", ringAngle.toFixed(2) + "deg");
    wrap.style.setProperty("--mw-scale", (1 + pulse * 0.05).toFixed(3));
    wrap.style.setProperty("--mw-glow-opacity", Math.min(1, 0.55 + pulse * 0.55).toFixed(3));
    wrap.style.setProperty("--mw-blur", (2 + pulse * 6).toFixed(1) + "px");
    ringRafId = requestAnimationFrame(ringTick);
  }
  function startRingLoop() { if (!ringRafId) ringRafId = requestAnimationFrame(ringTick); }
  function stopRingLoop() { if (ringRafId) { cancelAnimationFrame(ringRafId); ringRafId = null; } }

  // Broadcast the current now-playing state so other widgets (the dashboard
  // MUSIC card) can mirror this player instead of polling the unconfigured
  // Spotify endpoint. Reads straight from the DOM since that's already the
  // single source of truth this file keeps up to date.
  function notifyDashboard(playing) {
    const title = $("mw-title")?.textContent || "";
    const artist = $("mw-artist")?.textContent || "";
    const album = $("mw-album")?.textContent || "";
    const artworkImg = $("mw-art")?.querySelector("img");
    const artwork = artworkImg ? artworkImg.src : "";
    window.dispatchEvent(new CustomEvent("jarvis:music-changed", {
      detail: { title, artist, album, artwork, playing: !!playing },
    }));
  }

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
    // If the dashboard's compact MUSIC card is on the page, mount the real
    // now-playing UI (cover art + controls) straight into it instead of
    // floating it as its own free card — shrunk to fit via .mw-embedded
    // rules in music-widget.css. Falls back to the classic floating card
    // (e.g. on widget-host.html, which has no dashboard) when it isn't.
    const embedHost = document.getElementById("db-music-embed");
    const embedded = !!embedHost;
    wrap.className = "music-widget hidden" + (embedded ? " mw-embedded" : "");
    // Lets hand-tracking's pinch gesture grab and drag this widget — it
    // synthesizes real pointer events, so it just rides the same drag
    // handling below that mouse/touch already use. Not relevant once
    // embedded in the dashboard card (that card has its own drag handling).
    if (!embedded) wrap.dataset.handDrag = "true";
    wrap.innerHTML = `
      <button class="mw-close" id="mw-close" aria-label="Close" title="Stop">&#10005;</button>
      <div class="mw-content" id="mw-content">
        <div class="mw-art" id="mw-art">
          <svg id="mw-art-fallback" viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
        </div>
        <div class="mw-info">
          <div class="mw-title" id="mw-title">—</div>
          <div class="mw-artist" id="mw-artist">—</div>
          <div class="mw-album" id="mw-album"></div>
          <div class="mw-progress-container">
            <span id="mw-elapsed">0:00</span>
            <div class="mw-progress-track" id="mw-progress-track"><div class="mw-progress-fill" id="mw-progress-fill"></div></div>
            <span id="mw-duration">0:00</span>
          </div>
          <div class="mw-controls">
            <button class="mw-btn" id="mw-prev" title="Restart / previous">|&#9664;</button>
            <button class="mw-btn active" id="mw-playpause" title="Play/Pause">&#10074;&#10074;</button>
            <button class="mw-btn" id="mw-next" title="Next">&#9654;|</button>
            <button class="mw-btn" id="mw-repeat" title="Repeat">&#8635;</button>
          </div>
        </div>
      </div>
      <div id="mw-yt-mount" class="mw-yt-mount"></div>
      <audio id="mw-audio" preload="auto"></audio>
    `;
    (embedHost || document.body).appendChild(wrap);

    audioEl = $("mw-audio");
    audioEl.addEventListener("play", () => { setPlayPauseIcon(true); notifyDashboard(true); });
    audioEl.addEventListener("pause", () => { setPlayPauseIcon(false); notifyDashboard(false); });
    audioEl.addEventListener("ended", () => {
      setPlayPauseIcon(false);
      notifyDashboard(false);
      if (repeatOn) { audioEl.currentTime = 0; audioEl.play(); }
    });

    $("mw-close").addEventListener("click", stop);
    $("mw-playpause").addEventListener("click", togglePlayPause);
    $("mw-prev").addEventListener("click", onPrev);
    $("mw-next").addEventListener("click", onNext);
    $("mw-repeat").addEventListener("click", onToggleRepeat);
    $("mw-progress-track").addEventListener("pointerdown", onScrub);

    if (!embedded) {
      initDrag(wrap);
      restorePosition(wrap);
    }
  }

  // ── Dragging (pointer events cover mouse + touch) ───────────
  function initDrag(wrap) {
    let dragging = false, offsetX = 0, offsetY = 0;

    wrap.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".mw-btn, .mw-close, .mw-progress-track")) return;
      dragging = true;
      const rect = wrap.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      wrap.style.left = rect.left + "px";
      wrap.style.top = rect.top + "px";
      wrap.style.right = "auto";
      wrap.style.bottom = "auto";
      wrap.classList.add("dragging");
      try { wrap.setPointerCapture(e.pointerId); } catch {}
    });

    wrap.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      let x = e.clientX - offsetX;
      let y = e.clientY - offsetY;
      const maxX = window.innerWidth - wrap.offsetWidth - 4;
      const maxY = window.innerHeight - wrap.offsetHeight - 4;
      x = Math.min(Math.max(4, x), Math.max(4, maxX));
      y = Math.min(Math.max(4, y), Math.max(4, maxY));
      wrap.style.left = x + "px";
      wrap.style.top = y + "px";
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      wrap.classList.remove("dragging");
      try { wrap.releasePointerCapture(e.pointerId); } catch {}
      savePosition(wrap);
    }
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);
  }

  function savePosition(wrap) {
    try {
      localStorage.setItem("jarvisMusicWidgetPos", JSON.stringify({ left: wrap.style.left, top: wrap.style.top }));
    } catch {}
  }
  function restorePosition(wrap) {
    try {
      const raw = localStorage.getItem("jarvisMusicWidgetPos");
      if (!raw) return;
      const pos = JSON.parse(raw);
      if (pos && pos.left && pos.top) {
        wrap.style.left = pos.left;
        wrap.style.top = pos.top;
        wrap.style.right = "auto";
        wrap.style.bottom = "auto";
      }
    } catch {}
  }

  // ── Small adapter so progress/scrub/controls don't need to care
  // whether playback is coming from the YT iframe player or the plain
  // <audio> element (Audius, or any other direct-stream source). ────
  function activeGetCurrentTime() {
    if (currentSource === "audio") return audioEl ? audioEl.currentTime || 0 : 0;
    return player && typeof player.getCurrentTime === "function" ? player.getCurrentTime() || 0 : 0;
  }
  function activeGetDuration() {
    if (currentSource === "audio") return audioEl ? audioEl.duration || 0 : 0;
    return player && typeof player.getDuration === "function" ? player.getDuration() || 0 : 0;
  }
  function activeSeek(sec) {
    if (currentSource === "audio") { if (audioEl) audioEl.currentTime = sec; return; }
    if (player && typeof player.seekTo === "function") player.seekTo(sec, true);
  }

  function onScrub(e) {
    const hasTarget = currentSource === "audio" ? !!audioEl : !!(player && typeof player.seekTo === "function");
    if (!hasTarget) return;
    scrubbing = true;
    const track = $("mw-progress-track");
    const seek = (evt) => {
      const rect = track.getBoundingClientRect();
      const pct = Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width));
      const dur = activeGetDuration();
      if (dur > 0) {
        $("mw-progress-fill").style.width = `${pct * 100}%`;
        activeSeek(dur * pct);
      }
    };
    seek(e);
    const onMove = (evt) => seek(evt);
    const onUp = () => {
      scrubbing = false;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
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

  function setArtwork(url) {
    const art = $("mw-art");
    if (!art) return;
    const existingImg = art.querySelector("img");
    if (url) {
      if (existingImg) { existingImg.src = url; }
      else {
        const img = document.createElement("img");
        img.src = url;
        img.alt = "";
        img.onerror = () => { img.remove(); const fb = $("mw-art-fallback"); if (fb) fb.style.display = ""; };
        art.appendChild(img);
      }
      const fb = $("mw-art-fallback");
      if (fb) fb.style.display = "none";
    } else {
      if (existingImg) existingImg.remove();
      const fb = $("mw-art-fallback");
      if (fb) fb.style.display = "";
    }
  }

  function show() { ensureDOM(); $("music-widget").classList.remove("hidden"); startRingLoop(); }
  function hide() { const w = $("music-widget"); if (w) w.classList.add("hidden"); stopRingLoop(); }

  function setPlayPauseIcon(isPlaying) {
    const btn = $("mw-playpause");
    if (btn) {
      btn.innerHTML = isPlaying ? "&#10074;&#10074;" : "&#9654;";
      btn.classList.toggle("active", !!isPlaying);
    }
    const art = $("mw-art");
    if (art) art.classList.toggle("playing", !!isPlaying);
  }

  function startProgressTimer() {
    stopProgressTimer();
    progressTimer = setInterval(() => {
      if (scrubbing) return;
      if (currentSource === "youtube" && (!player || typeof player.getCurrentTime !== "function")) return;
      if (currentSource === "audio" && !audioEl) return;
      const cur = activeGetCurrentTime();
      const dur = activeGetDuration();
      const elapsedEl = $("mw-elapsed"), durEl = $("mw-duration"), fillEl = $("mw-progress-fill");
      if (elapsedEl) elapsedEl.textContent = fmtTime(cur);
      if (durEl) durEl.textContent = fmtTime(dur);
      if (fillEl) fillEl.style.width = dur > 0 ? `${Math.min(100, (cur / dur) * 100)}%` : "0%";
    }, 500);
  }
  function stopProgressTimer() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

  // Same idea as the server-side lookup used for the first track: YouTube
  // itself has no album metadata, so whenever we land on a track without
  // one (next/prev, or a mix/playlist auto-advancing) we ask Apple's public
  // iTunes Search API directly from the browser. Guarded by videoId so a
  // slow response can't overwrite a track the user has already moved past.
  async function lookupAlbumClient(title, artist, videoId) {
    const term = [artist, title].filter(Boolean).join(" ").trim();
    if (!term) return;
    try {
      const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=5`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      const soundtrackHit = results.find(r => /soundtrack|motion picture|from the .*(film|movie|series)/i.test(r.collectionName || ""));
      const hit = soundtrackHit || results[0];
      if (!hit || videoId !== currentVideoId) return; // track changed while we waited
      if (hit.collectionName) $("mw-album").textContent = hit.collectionName;
      if (hit.artworkUrl100) setArtwork(hit.artworkUrl100.replace("100x100", "1200x1200"));
    } catch { /* leave blank, not worth surfacing an error for this */ }
  }

  // Whenever a new video actually starts playing — including ones the
  // radio mix/playlist picked on its own — sync the card to match.
  function syncNowPlayingFromPlayer() {
    if (!player || typeof player.getVideoData !== "function") return;
    let data;
    try { data = player.getVideoData(); } catch { return; }
    if (!data || !data.video_id || data.video_id === currentVideoId) return;
    currentVideoId = data.video_id;
    if (currentVideoId !== requestedVideoId) {
      // The mix moved on to a track we didn't explicitly request —
      // show YouTube's own title/channel for it since that's all we have.
      // Auto-generated music channels are usually named "<Artist> - Topic",
      // and "Artist - Song" titles are common too, so clean both up rather
      // than showing the raw channel name or the word "YouTube".
      let title = (data.title || "").trim();
      let artist = (data.author || "").trim().replace(/\s*-\s*Topic$/i, "").trim();
      const dashSplit = title.match(/^(.{1,60}?)\s+-\s+(.{1,80})$/);
      if (dashSplit) { artist = dashSplit[1].trim(); title = dashSplit[2].trim(); }
      $("mw-title").textContent = title || "Unknown Track";
      $("mw-artist").textContent = artist || "Unknown Artist";
      $("mw-album").textContent = "";
      setArtwork("");
      lookupAlbumClient(title, artist, currentVideoId);
      notifyDashboard(isPlaying());
    }
  }

  function onPlayerStateChange(e) {
    if (!window.YT) return;
    if (e.data === YT.PlayerState.PLAYING) {
      setPlayPauseIcon(true);
      syncNowPlayingFromPlayer();
      notifyDashboard(true);
    } else if (e.data === YT.PlayerState.PAUSED) {
      setPlayPauseIcon(false);
      notifyDashboard(false);
    } else if (e.data === YT.PlayerState.ENDED) {
      setPlayPauseIcon(false);
      notifyDashboard(false);
      if (repeatOn && player) { player.seekTo(0, true); player.playVideo(); }
    }
  }

  function loadIntoPlayer(videoId, list) {
    isPlaylist = !!list;
    if (list) player.loadPlaylist({ list, listType: "playlist" });
    else if (videoId) player.loadVideoById(videoId);
  }

  function createPlayer(videoId, list) {
    isPlaylist = !!list;
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
  // `source` tells us which backend to use: "youtube" (default, via
  // the YT iframe player) or "audio" — any direct-streamable URL, e.g.
  // Audius. Callers that don't know/care can omit it; a youtube.com
  // URL is still auto-detected either way.
  async function play({ url, title, artist, album, artwork, source }) {
    if (!url) return;

    const looksLikeYoutube = /(^|\.)youtube\.com$|youtu\.be$/i.test((() => { try { return new URL(url).hostname; } catch { return ""; } })());
    const useAudio = source === "audio" || source === "audius" || (!looksLikeYoutube && source !== "youtube");

    ensureDOM();
    repeatOn = false;
    $("mw-repeat").classList.remove("active");
    $("mw-title").textContent = title || "Unknown Track";
    $("mw-artist").textContent = artist || "Unknown Artist";
    $("mw-album").textContent = album || "";
    setArtwork(artwork || "");
    $("mw-elapsed").textContent = "0:00";
    $("mw-duration").textContent = "0:00";
    $("mw-progress-fill").style.width = "0%";
    show();
    notifyDashboard(true);

    if (useAudio) {
      // Switching away from a live YouTube player? Pause it so two
      // sources never play over each other.
      if (player && typeof player.pauseVideo === "function") { try { player.pauseVideo(); } catch {} }
      currentSource = "audio";
      isPlaylist = false;
      requestedVideoId = null;
      currentVideoId = null;
      audioEl.src = url;
      try {
        await audioEl.play();
      } catch (e) {
        console.warn("[MUSIC] Audio playback failed to start:", e.message);
      }
      setPlayPauseIcon(true);
      startProgressTimer();
      return;
    }

    // YouTube branch
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); }
    currentSource = "youtube";
    const { videoId, list } = parseYouTubeUrl(url);
    if (!videoId && !list) return;
    requestedVideoId = videoId || null;
    currentVideoId = null;

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
    if (currentSource === "audio") {
      if (!audioEl) return;
      if (!audioEl.paused) { audioEl.pause(); }
      else { audioEl.play().catch(() => {}); }
      return;
    }
    if (!player || typeof player.getPlayerState !== "function") return;
    const state = player.getPlayerState();
    if (state === YT.PlayerState.PLAYING) { player.pauseVideo(); setPlayPauseIcon(false); notifyDashboard(false); }
    else { player.playVideo(); setPlayPauseIcon(true); notifyDashboard(true); }
  }

  function onPrev() {
    if (currentSource === "audio") { if (audioEl) audioEl.currentTime = 0; return; }
    if (!player) return;
    if (isPlaylist && typeof player.previousVideo === "function") player.previousVideo();
    else if (player.seekTo) player.seekTo(0, true);
  }

  function onNext() {
    // No queue/playlist concept for direct-stream sources like Audius yet.
    if (currentSource === "audio") return;
    if (!player || !isPlaylist || typeof player.nextVideo !== "function") return;
    player.nextVideo();
  }

  function onToggleRepeat() {
    repeatOn = !repeatOn;
    $("mw-repeat").classList.toggle("active", repeatOn);
  }

  function pause() {
    if (currentSource === "audio") { if (audioEl) audioEl.pause(); return; }
    if (player && player.pauseVideo) { player.pauseVideo(); setPlayPauseIcon(false); notifyDashboard(false); }
  }
  function resume() {
    if (currentSource === "audio") { if (audioEl) audioEl.play().catch(() => {}); return; }
    if (player && player.playVideo) { player.playVideo(); setPlayPauseIcon(true); notifyDashboard(true); }
  }

  function stop() {
    if (currentSource === "audio") { if (audioEl) { audioEl.pause(); audioEl.removeAttribute("src"); audioEl.load(); } }
    else if (player && player.stopVideo) { try { player.stopVideo(); } catch {} }
    stopProgressTimer();
    stopRingLoop();
    hide();
    window.dispatchEvent(new CustomEvent("jarvis:music-changed", { detail: { title: "", artist: "", playing: false } }));
  }

  function isPlaying() {
    if (currentSource === "audio") return !!(audioEl && !audioEl.paused && !audioEl.ended);
    return !!(player && player.getPlayerState && player.getPlayerState() === YT.PlayerState.PLAYING);
  }

  // Snapshot of whatever's currently loaded, read straight from the DOM
  // (same source of truth notifyDashboard uses) — lets other UI (Sleep
  // Mode, dashboard) pull the current track without needing to have
  // caught the last "jarvis:music-changed" event.
  function getNowPlaying() {
    const widget = $("music-widget");
    if (!widget || widget.classList.contains("hidden")) return null;
    const artworkImg = $("mw-art")?.querySelector("img");
    return {
      title: $("mw-title")?.textContent || "",
      artist: $("mw-artist")?.textContent || "",
      album: $("mw-album")?.textContent || "",
      artwork: artworkImg ? artworkImg.src : "",
      playing: isPlaying(),
    };
  }

  // Raw <audio> element, for Sleep Mode's Web Audio analyser (only
  // meaningful when currentSource === "audio" — the YouTube iframe's
  // audio can't be read by the page at all, cross-origin).
  function getAudioElement() { return audioEl; }
  function getSource() { return currentSource; }

  return { play, pause, resume, stop, togglePlayPause, next: onNext, prev: onPrev, isPlaying, getNowPlaying, getAudioElement, getSource, getBeatData, getFrequencyBins };
})();
