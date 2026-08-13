// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — SLEEP MODE
// Triggers when you switch away to another tab/app while music is
// playing, then switch back — a fullscreen "now playing" takeover
// with a glow that traces the screen edge, Lumen-style. Audio-reactive
// for Audius tracks (we can read that <audio> element's actual output
// via Web Audio); for YouTube it's ambient motion instead, since the
// iframe's audio is cross-origin and the page can't read it at all.
//
// Two separate settings:
//   - Master on/off ("sleepMode") — server-persisted via /api/settings,
//     toggle lives in Dashboard Settings (see dashboard.js). Default on.
//   - Visual prefs (glow thickness, color override, etc.) — this
//     module's own gear-icon panel, local to this browser only.
// ═══════════════════════════════════════════════════════════════
(function () {
  const $ = (id) => document.getElementById(id);

  const PREFS_KEY = "jarvisSleepModePrefs";
  const DEFAULT_PREFS = {
    animation: "default",   // "default" | "static" | "none"  ("musicSync" is an alias of "default")
    thickness: 60,          // glow-light diameter, px
    glow: 38,                // blur radius, px
    overrideColors: false,
    primary: "#ff2d95",
    secondary: "#00d2ff",
    showCard: true,
  };

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      return raw ? { ...DEFAULT_PREFS, ...JSON.parse(raw) } : { ...DEFAULT_PREFS };
    } catch { return { ...DEFAULT_PREFS }; }
  }
  function savePrefs(p) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch {}
  }

  let prefs = loadPrefs();
  let enabled = true; // mirrors server Settings.sleepMode, fetched on boot

  fetch("/api/settings").then((r) => r.json()).then((s) => {
    if (typeof s.sleepMode === "boolean") enabled = s.sleepMode;
  }).catch(() => {});

  // Dashboard Settings' toggle calls this directly (see dashboard.js) so
  // there's no need to re-poll the server on every change.
  window.setSleepModeEnabled = function (on) {
    enabled = !!on;
    if (!enabled) deactivate();
  };
  window.isSleepModeEnabled = function () { return enabled; };

  // ── DOM ──────────────────────────────────────────────────────
  let overlay, lightA, lightB, staticBorder, cardEl, artEl, titleEl, artistEl,
      progFill, elapsedEl, durationEl, progTrack, playBtn, repeatBtnEl,
      gearBtn, panel, confirmBox, quitBtn;

  function ensureDOM() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "sleep-mode-overlay";
    overlay.innerHTML = `
      <div class="sm-glow-light sm-glow-a" id="sm-light-a"></div>
      <div class="sm-glow-light sm-glow-b" id="sm-light-b"></div>
      <div class="sm-static-border" id="sm-static-border"></div>

      <button class="sm-gear" id="sm-gear" title="Sleep Mode settings">&#9881;</button>

      <div class="sm-card" id="sm-card">
        <div class="sm-art" id="sm-art">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
            <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
          </svg>
        </div>
        <div class="sm-title" id="sm-title">—</div>
        <div class="sm-artist" id="sm-artist">—</div>
        <div class="sm-progress">
          <span id="sm-elapsed">0:00</span>
          <div class="sm-progress-track" id="sm-progress-track"><div class="sm-progress-fill" id="sm-progress-fill"></div></div>
          <span id="sm-duration">0:00</span>
        </div>
        <div class="sm-controls">
          <button class="sm-btn" id="sm-prev" title="Restart / previous">&#9664;&#9664;</button>
          <button class="sm-btn sm-play" id="sm-play" title="Play/Pause">&#10074;&#10074;</button>
          <button class="sm-btn" id="sm-next" title="Next">&#9654;&#9654;</button>
          <button class="sm-btn" id="sm-repeat" title="Repeat">&#8635;</button>
        </div>
      </div>

      <div class="sm-hint">Click anywhere to wake</div>

      <div id="sm-exit-confirm">
        <div class="sm-confirm-title">Exit Sleep Mode?</div>
        <div class="sm-confirm-row">
          <button class="sm-confirm-btn" id="sm-stay-btn">Stay</button>
          <button class="sm-confirm-btn sm-confirm-primary" id="sm-exit-btn">Exit</button>
        </div>
      </div>

      <div id="sm-settings-panel">
        <div class="sm-panel-title">SLEEP MODE</div>

        <div class="sm-panel-row">
          <label>Animation</label>
          <select id="sm-animation-select">
            <option value="default">Default</option>
            <option value="static">Static</option>
            <option value="none">No Animation</option>
          </select>
        </div>
        <div class="sm-panel-row">
          <label>Thickness</label>
          <input type="range" id="sm-thickness-slider" min="20" max="140" step="2">
        </div>
        <div class="sm-panel-row">
          <label>Glow</label>
          <input type="range" id="sm-glow-slider" min="10" max="80" step="2">
        </div>

        <div class="sm-panel-divider"></div>

        <div class="sm-panel-row">
          <label>Override album color</label>
          <div class="sm-switch" id="sm-override-switch"></div>
        </div>
        <div class="sm-panel-row sm-color-row" id="sm-color-row">
          <label>Primary / Secondary</label>
          <div style="display:flex;gap:6px;">
            <input type="color" id="sm-primary-color">
            <input type="color" id="sm-secondary-color">
          </div>
        </div>

        <div class="sm-panel-divider"></div>

        <div class="sm-panel-row">
          <label>Show now-playing card</label>
          <div class="sm-switch" id="sm-showcard-switch"></div>
        </div>

        <div class="sm-panel-divider"></div>
        <button id="sm-quit-btn">Exit Sleep Mode</button>
      </div>
    `;
    document.body.appendChild(overlay);

    lightA = $("sm-light-a"); lightB = $("sm-light-b");
    staticBorder = $("sm-static-border");
    cardEl = $("sm-card"); artEl = $("sm-art");
    titleEl = $("sm-title"); artistEl = $("sm-artist");
    progFill = $("sm-progress-fill"); elapsedEl = $("sm-elapsed"); durationEl = $("sm-duration");
    progTrack = $("sm-progress-track");
    playBtn = $("sm-play"); repeatBtnEl = $("sm-repeat");
    gearBtn = $("sm-gear"); panel = $("sm-settings-panel");
    confirmBox = $("sm-exit-confirm"); quitBtn = $("sm-quit-btn");

    // Controls just proxy straight to MusicWidget — sleep mode never
    // owns playback itself, it's purely a fullscreen skin on top of it.
    $("sm-prev").addEventListener("click", (e) => { e.stopPropagation(); window.MusicWidget?.prev?.(); });
    $("sm-next").addEventListener("click", (e) => { e.stopPropagation(); window.MusicWidget?.next?.(); });
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      window.MusicWidget?.togglePlayPause?.();
      setTimeout(syncPlayIcon, 50);
    });
    repeatBtnEl.addEventListener("click", (e) => { e.stopPropagation(); repeatBtnEl.classList.toggle("sm-active"); });
    progTrack.addEventListener("pointerdown", (e) => e.stopPropagation());

    gearBtn.addEventListener("click", (e) => { e.stopPropagation(); panel.classList.toggle("sm-visible"); });
    cardEl.addEventListener("click", (e) => e.stopPropagation());
    confirmBox.addEventListener("click", (e) => e.stopPropagation());

    // Clicking the dimmed background (i.e. not the card, gear, or panel)
    // asks first. The gear panel's own "Exit Sleep Mode" button below
    // skips the confirm — it's an explicit action, not an accidental click.
    overlay.addEventListener("click", (e) => {
      if (panel.classList.contains("sm-visible") && !panel.contains(e.target)) {
        panel.classList.remove("sm-visible");
        return;
      }
      confirmBox.classList.add("sm-visible");
    });
    $("sm-stay-btn").addEventListener("click", (e) => { e.stopPropagation(); confirmBox.classList.remove("sm-visible"); });
    $("sm-exit-btn").addEventListener("click", (e) => { e.stopPropagation(); deactivate(); });
    quitBtn.addEventListener("click", (e) => { e.stopPropagation(); deactivate(); });

    wireSettingsPanel();
  }

  function syncPlayIcon() {
    const playing = window.MusicWidget?.isPlaying?.();
    playBtn.innerHTML = playing ? "&#10074;&#10074;" : "&#9654;";
  }

  // ── settings panel wiring ───────────────────────────────────
  function applyPrefsToPanelUI() {
    $("sm-animation-select").value = prefs.animation;
    $("sm-thickness-slider").value = prefs.thickness;
    $("sm-glow-slider").value = prefs.glow;
    $("sm-override-switch").classList.toggle("sm-on", prefs.overrideColors);
    $("sm-color-row").classList.toggle("sm-show", prefs.overrideColors);
    $("sm-primary-color").value = prefs.primary;
    $("sm-secondary-color").value = prefs.secondary;
    $("sm-showcard-switch").classList.toggle("sm-on", prefs.showCard);
    staticBorder.classList.toggle("sm-on", prefs.animation === "none");
    cardEl.classList.toggle("sm-hidden", !prefs.showCard);
  }

  function wireSettingsPanel() {
    $("sm-animation-select").addEventListener("change", (e) => {
      prefs.animation = e.target.value;
      staticBorder.classList.toggle("sm-on", prefs.animation === "none");
      savePrefs(prefs);
    });
    $("sm-thickness-slider").addEventListener("input", (e) => { prefs.thickness = +e.target.value; savePrefs(prefs); });
    $("sm-glow-slider").addEventListener("input", (e) => { prefs.glow = +e.target.value; savePrefs(prefs); });
    $("sm-override-switch").addEventListener("click", () => {
      prefs.overrideColors = !prefs.overrideColors;
      $("sm-override-switch").classList.toggle("sm-on", prefs.overrideColors);
      $("sm-color-row").classList.toggle("sm-show", prefs.overrideColors);
      savePrefs(prefs);
    });
    $("sm-primary-color").addEventListener("input", (e) => { prefs.primary = e.target.value; savePrefs(prefs); });
    $("sm-secondary-color").addEventListener("input", (e) => { prefs.secondary = e.target.value; savePrefs(prefs); });
    $("sm-showcard-switch").addEventListener("click", () => {
      prefs.showCard = !prefs.showCard;
      $("sm-showcard-switch").classList.toggle("sm-on", prefs.showCard);
      cardEl.classList.toggle("sm-hidden", !prefs.showCard);
      savePrefs(prefs);
    });
  }

  // ── dominant color extraction from the album art ────────────
  // Simple bucketed sampler: downscale, ignore near-black/near-white
  // pixels, group into coarse buckets, take the two most common —
  // not a real k-means, but plenty for picking a glow color.
  function extractColorsFromImage(url) {
    return new Promise((resolve) => {
      if (!url) return resolve(null);
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          const size = 24;
          c.width = size; c.height = size;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;
          const buckets = {};
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
            if (a < 100) continue;
            const brightness = (r + g + b) / 3;
            if (brightness < 25 || brightness > 235) continue; // skip near-black/near-white
            const key = `${Math.round(r / 32)}_${Math.round(g / 32)}_${Math.round(b / 32)}`;
            if (!buckets[key]) buckets[key] = { r: 0, g: 0, b: 0, n: 0 };
            buckets[key].r += r; buckets[key].g += g; buckets[key].b += b; buckets[key].n++;
          }
          const sorted = Object.values(buckets).sort((a, b) => b.n - a.n);
          if (!sorted.length) return resolve(null);
          const toHex = (v) => Math.round(v).toString(16).padStart(2, "0");
          const bucketColor = (bk) => `#${toHex(bk.r / bk.n)}${toHex(bk.g / bk.n)}${toHex(bk.b / bk.n)}`;
          const primary = bucketColor(sorted[0]);
          const secondary = sorted[1] ? bucketColor(sorted[1]) : primary;
          resolve({ primary, secondary });
        } catch (e) {
          // Canvas taint from a non-CORS image, etc. — just fall back.
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  let activeColors = { primary: "#ff2d95", secondary: "#00d2ff" };

  async function refreshColors(artwork) {
    if (prefs.overrideColors) {
      activeColors = { primary: prefs.primary, secondary: prefs.secondary };
      return;
    }
    const extracted = await extractColorsFromImage(artwork);
    activeColors = extracted || { primary: "#ff2d95", secondary: "#00d2ff" };
  }

  // ── Web Audio tap (Audius only — YouTube's iframe audio is
  // cross-origin and can't be read by the page at all) ───────────
  let audioCtx = null, analyser = null, sourceNode = null, freqData = null;
  let tappedElement = null;

  function ensureAudioTap() {
    const el = window.MusicWidget?.getAudioElement?.();
    if (!el || window.MusicWidget.getSource() !== "audio") return false;
    if (tappedElement === el && analyser) return true;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      // A given <audio> element can only ever be wrapped by ONE
      // MediaElementSourceNode for its whole lifetime — since
      // music-widget.js reuses the same element across tracks, only
      // create this once and just leave it connected from then on.
      if (!sourceNode || tappedElement !== el) {
        sourceNode = audioCtx.createMediaElementSource(el);
        analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        freqData = new Uint8Array(analyser.frequencyBinCount);
        sourceNode.connect(analyser);
        analyser.connect(audioCtx.destination); // keep it audible!
        tappedElement = el;
      }
      if (audioCtx.state === "suspended") audioCtx.resume();
      return true;
    } catch (e) {
      console.warn("[SLEEP MODE] Couldn't tap audio for reactive glow:", e.message);
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

  // ── glow animation loop — two lights traced around the viewport
  // perimeter (rounded-rectangle path), audio-reactive when possible,
  // gentle constant motion otherwise. ─────────────────────────────
  let rafId = null;
  let travelT = 0; // 0..1 position along the perimeter for light A (light B trails behind)

  function perimeterPoint(t, inset) {
    const w = window.innerWidth - inset * 2;
    const h = window.innerHeight - inset * 2;
    const perim = 2 * (w + h);
    let d = ((t % 1) + 1) % 1 * perim;
    if (d < w) return { x: inset + d, y: inset };
    d -= w;
    if (d < h) return { x: inset + w, y: inset + d };
    d -= h;
    if (d < w) return { x: inset + w - d, y: inset + h };
    d -= w;
    return { x: inset, y: inset + h - d };
  }

  function tick() {
    if (!overlay || !overlay.classList.contains("sm-visible")) { rafId = null; return; }

    const mode = prefs.animation;
    if (mode === "none") {
      lightA.style.opacity = 0; lightB.style.opacity = 0;
      rafId = requestAnimationFrame(tick);
      return;
    }

    const isAudius = window.MusicWidget?.getSource?.() === "audio";
    const reactive = isAudius && ensureAudioTap();
    const amp = reactive ? getAmplitude() : 0;

    let speed, pulse;
    if (mode === "static") {
      speed = 0; pulse = 0.5;
    } else if (reactive) {
      speed = 0.00035 + amp * 0.0009;
      pulse = 0.5 + amp * 0.6;
    } else {
      // ambient — constant gentle drift + slow breathing, not tied to audio
      speed = 0.00028;
      pulse = 0.55 + Math.sin(Date.now() / 900) * 0.18;
    }

    travelT += speed;
    const inset = 12;
    const pA = perimeterPoint(travelT, inset);
    const pB = perimeterPoint(travelT + 0.5, inset); // opposite side of the screen

    const size = prefs.thickness * (0.85 + pulse * 0.3);
    const blur = prefs.glow * (0.7 + pulse * 0.5);

    lightA.style.left = pA.x + "px"; lightA.style.top = pA.y + "px";
    lightB.style.left = pB.x + "px"; lightB.style.top = pB.y + "px";
    lightA.style.width = lightA.style.height = size + "px";
    lightB.style.width = lightB.style.height = size + "px";
    lightA.style.filter = `blur(${blur}px)`;
    lightB.style.filter = `blur(${blur}px)`;
    lightA.style.opacity = mode === "static" ? 0.7 : Math.min(1, 0.55 + pulse * 0.5);
    lightB.style.opacity = lightA.style.opacity;
    lightA.style.background = activeColors.primary;
    lightB.style.background = activeColors.secondary;

    rafId = requestAnimationFrame(tick);
  }

  // ── progress bar (mirrors whatever MusicWidget is doing) ───────
  let progressTimer = null;
  function startProgressMirror() {
    stopProgressMirror();
    progressTimer = setInterval(() => {
      // MusicWidget doesn't expose raw current-time/duration publicly,
      // so sleep mode's progress bar just mirrors play/pause state —
      // good enough for an ambient screensaver view.
      syncPlayIcon();
    }, 1000);
  }
  function stopProgressMirror() { if (progressTimer) { clearInterval(progressTimer); progressTimer = null; } }

  // ── activate / deactivate ───────────────────────────────────
  let active = false;

  async function activate() {
    if (active || !enabled) return;
    const now = window.MusicWidget?.getNowPlaying?.();
    if (!now || !now.playing) return; // only makes sense if something's actually playing

    ensureDOM();
    active = true;
    titleEl.textContent = now.title || "Unknown Track";
    artistEl.textContent = now.artist || "Unknown Artist";
    artEl.innerHTML = now.artwork
      ? `<img src="${now.artwork}" alt="">`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    syncPlayIcon();
    applyPrefsToPanelUI();
    await refreshColors(now.artwork);

    confirmBox.classList.remove("sm-visible");
    panel.classList.remove("sm-visible");
    overlay.classList.add("sm-visible");
    travelT = 0;
    if (!rafId) rafId = requestAnimationFrame(tick);
    startProgressMirror();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    overlay.classList.remove("sm-visible");
    confirmBox.classList.remove("sm-visible");
    panel.classList.remove("sm-visible");
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    stopProgressMirror();
  }

  // ── trigger: switch tabs away & back while music is playing ────
  let wasPlayingWhenHidden = false;
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      wasPlayingWhenHidden = !!window.MusicWidget?.isPlaying?.();
      return;
    }
    // came back to the tab
    if (wasPlayingWhenHidden && enabled && window.state?.phase === "chatting") {
      activate();
    }
    wasPlayingWhenHidden = false;
  });

  // Keep now-playing info fresh while sleep mode is up, in case a
  // playlist auto-advances to a new track while you're away.
  window.addEventListener("jarvis:music-changed", (e) => {
    if (!active) return;
    const d = e.detail || {};
    if (!d.playing) { deactivate(); return; }
    titleEl.textContent = d.title || "Unknown Track";
    artistEl.textContent = d.artist || "Unknown Artist";
    if (d.artwork) {
      artEl.innerHTML = `<img src="${d.artwork}" alt="">`;
      refreshColors(d.artwork);
    }
    syncPlayIcon();
  });
})();
