// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — SLEEP MODE
// Triggers when you switch away to another tab/app while music is
// playing, then switch back — a fullscreen "now playing" takeover.
// A continuous glowing ring traces the screen's rounded edge
// (Lumen-style neon frame), with an optional audio-reactive bar
// visualizer. Audio-reactive for Audius tracks (we can read that
// <audio> element's actual output via Web Audio); for YouTube it's
// ambient motion instead, since the iframe's audio is cross-origin
// and the page can't read it at all.
//
// Two separate settings:
//   - Master on/off ("sleepMode") — server-persisted via /api/settings,
//     toggle lives in Dashboard Settings (see dashboard.js). Default on.
//   - Visual prefs (glow thickness, gradient, style, etc.) — this
//     module's own gear-icon panel, local to this browser only.
//
// NOTE: "Style" only changes the on-screen layout (a centered card vs
// a compact bottom media bar) — there's no OS-level "lock screen"
// integration here, since a browser tab has no API to draw on the
// actual system lock screen. This is purely an in-tab takeover.
// ═══════════════════════════════════════════════════════════════
(function () {
  const $ = (id) => document.getElementById(id);

  const PREFS_KEY = "jarvisSleepModePrefs";
  const DEFAULT_PREFS = {
    animation: "default",   // "default" | "static" | "none" — motion behavior of the glow ring
    gradient: "default",    // "default" (album colors) | "rainbow" | "mono" (primary only)
    thickness: 60,          // ring thickness, px-ish (scaled down internally)
    glow: 38,                // blur radius, px
    musicBars: true,        // audio-reactive bar visualizer under the artwork
    reflect: false,          // mirrored reflection under the album art
    overrideColors: false,
    primary: "#ff2d95",
    secondary: "#00d2ff",
    showCard: true,
    style: "card",           // "card" (centered) | "bar" (compact bottom media bar)
  };

  // Quick preset color pairs shown as swatches in the panel — clicking
  // one turns on overrideColors and applies both colors at once.
  const PRESETS = [
    { primary: "#ff2d95", secondary: "#00d2ff" }, // default pink/cyan
    { primary: "#ff5a3c", secondary: "#ffb020" }, // sunset orange/amber
    { primary: "#8b3cff", secondary: "#3c6bff" }, // violet/blue
    { primary: "#39ff88", secondary: "#00d2ff" }, // mint/cyan
    { primary: "#ff3c6b", secondary: "#ffe23c" }, // hot pink/yellow
    { primary: "#ffffff", secondary: "#7a8a9a" }, // mono white/grey
  ];

  const BAR_COUNT = 28;

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
  let overlay, frameGlow, frameCore, cardEl, artWrapEl, artEl, artReflectEl,
      barsEl, barsEls, titleEl, artistEl,
      progFill, elapsedEl, durationEl, progTrack, playBtn, repeatBtnEl, shuffleBtnEl,
      gearBtn, panel, confirmBox, quitBtn;

  function buildBarsHTML() {
    let html = "";
    for (let i = 0; i < BAR_COUNT; i++) html += `<div class="sm-bar"></div>`;
    return html;
  }

  function buildPresetSwatchesHTML() {
    return PRESETS.map((p, i) =>
      `<button class="sm-swatch" data-preset="${i}" title="${p.primary} / ${p.secondary}" style="background:linear-gradient(135deg, ${p.primary}, ${p.secondary});"></button>`
    ).join("");
  }

  function ensureDOM() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.id = "sleep-mode-overlay";
    overlay.innerHTML = `
      <div class="sm-frame-glow" id="sm-frame-glow"></div>
      <div class="sm-frame-core" id="sm-frame-core"></div>

      <button class="sm-gear" id="sm-gear" title="Sleep Mode settings">&#9881;</button>

      <div class="sm-card" id="sm-card">
        <div class="sm-art-wrap" id="sm-art-wrap">
          <div class="sm-art" id="sm-art">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
              <path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>
            </svg>
          </div>
          <div class="sm-art-reflect" id="sm-art-reflect"></div>
        </div>

        <div class="sm-bars" id="sm-bars">${buildBarsHTML()}</div>

        <div class="sm-text">
          <div class="sm-title" id="sm-title">—</div>
          <div class="sm-artist" id="sm-artist">—</div>
        </div>

        <div class="sm-progress">
          <span id="sm-elapsed">0:00</span>
          <div class="sm-progress-track" id="sm-progress-track"><div class="sm-progress-fill" id="sm-progress-fill"></div></div>
          <span id="sm-duration">0:00</span>
        </div>
        <div class="sm-controls">
          <button class="sm-btn" id="sm-shuffle" title="Shuffle">&#8646;</button>
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
          <label>Gradient</label>
          <select id="sm-gradient-select">
            <option value="default">Default</option>
            <option value="rainbow">Rainbow</option>
            <option value="mono">Mono</option>
          </select>
        </div>
        <div class="sm-panel-row">
          <label>Animation</label>
          <select id="sm-animation-select">
            <option value="default">Default</option>
            <option value="static">Static</option>
            <option value="none">No Animation</option>
          </select>
        </div>
        <div class="sm-panel-row">
          <label>Music Bars</label>
          <div class="sm-switch" id="sm-bars-switch"></div>
        </div>
        <div class="sm-panel-row">
          <label>Reflect</label>
          <div class="sm-switch" id="sm-reflect-switch"></div>
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
        <div class="sm-panel-row sm-color-row sm-swatch-row" id="sm-preset-row">
          ${buildPresetSwatchesHTML()}
        </div>

        <div class="sm-panel-divider"></div>

        <div class="sm-panel-row">
          <label>Style</label>
          <select id="sm-style-select">
            <option value="card">Card</option>
            <option value="bar">Bar</option>
          </select>
        </div>
        <div class="sm-panel-row">
          <label>Show now-playing card</label>
          <div class="sm-switch" id="sm-showcard-switch"></div>
        </div>

        <div class="sm-panel-divider"></div>
        <button id="sm-quit-btn">Exit Sleep Mode</button>
      </div>
    `;
    document.body.appendChild(overlay);

    frameGlow = $("sm-frame-glow"); frameCore = $("sm-frame-core");
    cardEl = $("sm-card"); artWrapEl = $("sm-art-wrap"); artEl = $("sm-art"); artReflectEl = $("sm-art-reflect");
    barsEl = $("sm-bars"); barsEls = Array.from(barsEl.querySelectorAll(".sm-bar"));
    titleEl = $("sm-title"); artistEl = $("sm-artist");
    progFill = $("sm-progress-fill"); elapsedEl = $("sm-elapsed"); durationEl = $("sm-duration");
    progTrack = $("sm-progress-track");
    playBtn = $("sm-play"); repeatBtnEl = $("sm-repeat"); shuffleBtnEl = $("sm-shuffle");
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
    // Repeat/shuffle are local UI toggles only, same as before — Jarvis's
    // music widget has no queue/playlist concept for these to act on yet.
    repeatBtnEl.addEventListener("click", (e) => { e.stopPropagation(); repeatBtnEl.classList.toggle("sm-active"); });
    shuffleBtnEl.addEventListener("click", (e) => { e.stopPropagation(); shuffleBtnEl.classList.toggle("sm-active"); });
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
    $("sm-gradient-select").value = prefs.gradient;
    $("sm-animation-select").value = prefs.animation;
    $("sm-bars-switch").classList.toggle("sm-on", prefs.musicBars);
    $("sm-reflect-switch").classList.toggle("sm-on", prefs.reflect);
    $("sm-thickness-slider").value = prefs.thickness;
    $("sm-glow-slider").value = prefs.glow;
    $("sm-override-switch").classList.toggle("sm-on", prefs.overrideColors);
    $("sm-color-row").classList.toggle("sm-show", prefs.overrideColors);
    $("sm-preset-row").classList.toggle("sm-show", prefs.overrideColors);
    $("sm-primary-color").value = prefs.primary;
    $("sm-secondary-color").value = prefs.secondary;
    $("sm-style-select").value = prefs.style;
    $("sm-showcard-switch").classList.toggle("sm-on", prefs.showCard);

    barsEl.classList.toggle("sm-show", prefs.musicBars);
    artReflectEl.classList.toggle("sm-show", prefs.reflect);
    cardEl.classList.toggle("sm-hidden", !prefs.showCard);
    cardEl.classList.toggle("sm-style-bar", prefs.style === "bar");
  }

  function applyPresetColors(i) {
    const p = PRESETS[i];
    if (!p) return;
    prefs.overrideColors = true;
    prefs.primary = p.primary;
    prefs.secondary = p.secondary;
    $("sm-override-switch").classList.add("sm-on");
    $("sm-color-row").classList.add("sm-show");
    $("sm-preset-row").classList.add("sm-show");
    $("sm-primary-color").value = p.primary;
    $("sm-secondary-color").value = p.secondary;
    savePrefs(prefs);
    refreshColors(null);
  }

  function wireSettingsPanel() {
    $("sm-gradient-select").addEventListener("change", (e) => { prefs.gradient = e.target.value; savePrefs(prefs); });
    $("sm-animation-select").addEventListener("change", (e) => { prefs.animation = e.target.value; savePrefs(prefs); });
    $("sm-bars-switch").addEventListener("click", () => {
      prefs.musicBars = !prefs.musicBars;
      $("sm-bars-switch").classList.toggle("sm-on", prefs.musicBars);
      barsEl.classList.toggle("sm-show", prefs.musicBars);
      savePrefs(prefs);
    });
    $("sm-reflect-switch").addEventListener("click", () => {
      prefs.reflect = !prefs.reflect;
      $("sm-reflect-switch").classList.toggle("sm-on", prefs.reflect);
      artReflectEl.classList.toggle("sm-show", prefs.reflect);
      savePrefs(prefs);
    });
    $("sm-thickness-slider").addEventListener("input", (e) => { prefs.thickness = +e.target.value; savePrefs(prefs); });
    $("sm-glow-slider").addEventListener("input", (e) => { prefs.glow = +e.target.value; savePrefs(prefs); });
    $("sm-override-switch").addEventListener("click", () => {
      prefs.overrideColors = !prefs.overrideColors;
      $("sm-override-switch").classList.toggle("sm-on", prefs.overrideColors);
      $("sm-color-row").classList.toggle("sm-show", prefs.overrideColors);
      $("sm-preset-row").classList.toggle("sm-show", prefs.overrideColors);
      savePrefs(prefs);
      refreshColors(null);
    });
    $("sm-primary-color").addEventListener("input", (e) => { prefs.primary = e.target.value; savePrefs(prefs); refreshColors(null); });
    $("sm-secondary-color").addEventListener("input", (e) => { prefs.secondary = e.target.value; savePrefs(prefs); refreshColors(null); });
    $("sm-preset-row").addEventListener("click", (e) => {
      const btn = e.target.closest(".sm-swatch");
      if (!btn) return;
      applyPresetColors(+btn.dataset.preset);
    });
    $("sm-style-select").addEventListener("change", (e) => {
      prefs.style = e.target.value;
      cardEl.classList.toggle("sm-style-bar", prefs.style === "bar");
      savePrefs(prefs);
    });
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
  let lastArtwork = "";

  async function refreshColors(artwork) {
    if (artwork !== null) lastArtwork = artwork || "";
    if (prefs.overrideColors) {
      activeColors = { primary: prefs.primary, secondary: prefs.secondary };
      return;
    }
    const extracted = await extractColorsFromImage(lastArtwork);
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

  // Splits the analyser's frequency bins into `n` averaged buckets, with
  // a touch of log-ish spacing so the low end isn't crammed into the
  // first couple of bars (most audible energy sits there).
  function getFrequencyBins(n) {
    if (!analyser || !freqData) return null;
    analyser.getByteFrequencyData(freqData);
    const usable = Math.floor(freqData.length * 0.75); // top slice is mostly noise
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

  // ── bar visualizer ──────────────────────────────────────────
  function updateBars(reactive) {
    if (!prefs.musicBars || !barsEls.length) return;
    const bins = reactive ? getFrequencyBins(barsEls.length) : null;
    const now = Date.now();
    for (let i = 0; i < barsEls.length; i++) {
      let h;
      if (bins) {
        h = 8 + bins[i] * 92;
      } else {
        // ambient — layered sines with a per-bar phase offset so it reads
        // as organic movement rather than a uniform pulse
        h = 20 + 25 * Math.sin(now / 260 + i * 0.5) + 15 * Math.sin(now / 500 + i * 0.9);
        h = Math.max(6, Math.min(100, h));
      }
      barsEls[i].style.height = h.toFixed(1) + "%";
    }
  }

  // ── glow ring gradient builder ──────────────────────────────
  function buildGradient(angleDeg) {
    const { primary, secondary } = activeColors;
    if (prefs.gradient === "rainbow") {
      return `conic-gradient(from ${angleDeg}deg, #ff3b3b, #ffb020, #f7ff3b, #3bff6a, #3bd9ff, #7a3bff, #ff3bd0, #ff3b3b)`;
    }
    if (prefs.gradient === "mono") {
      return `conic-gradient(from ${angleDeg}deg, ${primary}, ${primary})`;
    }
    return `conic-gradient(from ${angleDeg}deg, ${primary}, ${secondary}, ${primary})`;
  }

  // ── main animation loop — a continuous glowing ring around the
  // screen edge (rotating conic-gradient masked down to just the
  // border), audio-reactive when possible, gentle ambient motion
  // otherwise, plus the bar visualizer. ────────────────────────
  let rafId = null;
  let travelT = 0; // 0..1, converted to a 0..360deg rotation each frame

  function tick() {
    if (!overlay || !overlay.classList.contains("sm-visible")) { rafId = null; return; }

    const mode = prefs.animation;
    const isAudius = window.MusicWidget?.getSource?.() === "audio";
    const reactive = isAudius && ensureAudioTap();
    const amp = reactive ? getAmplitude() : 0;

    let speed, pulse, blurMult = 1, thicknessMult = 1;
    if (mode === "none") {
      speed = 0; pulse = 0.5; blurMult = 0.22; thicknessMult = 0.5;
    } else if (mode === "static") {
      speed = 0; pulse = 0.5 + Math.sin(Date.now() / 900) * 0.18;
    } else if (reactive) {
      speed = 0.05 + amp * 0.4;
      pulse = 0.5 + amp * 0.6;
    } else {
      speed = 0.045;
      pulse = 0.55 + Math.sin(Date.now() / 900) * 0.18;
    }

    travelT = (travelT + speed / 360) % 1;
    const angleDeg = travelT * 360;

    const thickness = Math.max(2, prefs.thickness * 0.12 * thicknessMult * (0.75 + pulse * 0.5));
    const blur = Math.max(4, prefs.glow * blurMult * (0.7 + pulse * 0.6));
    const opacity = mode === "none" ? 0.95 : Math.min(1, 0.5 + pulse * 0.5);

    const gradient = buildGradient(angleDeg);
    frameGlow.style.background = gradient;
    frameGlow.style.padding = thickness + "px";
    frameGlow.style.filter = `blur(${blur}px)`;
    frameGlow.style.opacity = opacity;
    frameCore.style.background = gradient;
    frameCore.style.padding = Math.max(1.5, thickness * 0.35) + "px";
    frameCore.style.opacity = Math.min(1, opacity + 0.15);

    barsEl.style.setProperty("--sm-bar-a", activeColors.primary);
    barsEl.style.setProperty("--sm-bar-b", activeColors.secondary);
    updateBars(reactive);

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

  function setArtwork(url) {
    artEl.innerHTML = url
      ? `<img src="${url}" alt="">`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
    artReflectEl.style.backgroundImage = url ? `url("${url}")` : "none";
  }

  async function activate() {
    if (active || !enabled) return;
    const now = window.MusicWidget?.getNowPlaying?.();
    if (!now || !now.playing) return; // only makes sense if something's actually playing

    ensureDOM();
    active = true;
    titleEl.textContent = now.title || "Unknown Track";
    artistEl.textContent = now.artist || "Unknown Artist";
    setArtwork(now.artwork);
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
      setArtwork(d.artwork);
      refreshColors(d.artwork);
    }
    syncPlayIcon();
  });
})();
