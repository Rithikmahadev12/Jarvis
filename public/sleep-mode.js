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
    thickness: 110,           // ring thickness, px-ish (scaled down internally)
    glow: 58,                 // blur radius, px
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
  let overlay, frameGlow, frameCore, washEl, artHaloEl, artHaloCoreEl, cardEl, artWrapEl, artEl, artReflectEl,
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
      <div class="sm-wash" id="sm-wash"></div>
      <div class="sm-frame-glow" id="sm-frame-glow"></div>
      <div class="sm-frame-core" id="sm-frame-core"></div>

      <button class="sm-gear" id="sm-gear" title="Sleep Mode settings">&#9881;</button>

      <div class="sm-card" id="sm-card">
        <div class="sm-art-wrap" id="sm-art-wrap">
          <div class="sm-art-halo" id="sm-art-halo"></div>
          <div class="sm-art-halo-core" id="sm-art-halo-core"></div>
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

        <div class="sm-panel-row sm-color-mode-row">
          <label>Color</label>
          <div class="sm-color-mode" id="sm-color-mode">
            <button type="button" class="sm-color-mode-btn" id="sm-mode-auto-btn" data-mode="auto">Automatic</button>
            <button type="button" class="sm-color-mode-btn" id="sm-mode-custom-btn" data-mode="custom">Custom</button>
          </div>
        </div>
        <div class="sm-panel-hint" id="sm-color-auto-hint">Jarvis picks this from the album art.</div>

        <div class="sm-wheel-block" id="sm-wheel-block">
          <div class="sm-wheel-wrap" id="sm-wheel-wrap">
            <canvas id="sm-color-wheel" width="150" height="150"></canvas>
            <div class="sm-wheel-handle" id="sm-wheel-handle"></div>
          </div>
          <div class="sm-panel-row">
            <label>Brightness</label>
            <input type="range" id="sm-lightness-slider" min="25" max="85" step="1">
          </div>
          <div class="sm-swatch-row" id="sm-preset-row">
            ${buildPresetSwatchesHTML()}
          </div>
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

    frameGlow = $("sm-frame-glow"); frameCore = $("sm-frame-core"); washEl = $("sm-wash");
    artHaloEl = $("sm-art-halo"); artHaloCoreEl = $("sm-art-halo-core");
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
      // Any click landing inside the settings panel — a select, switch,
      // slider, swatch, etc. — is handled entirely by that control's own
      // listener above. It must never also fall through to the exit
      // confirm, regardless of whether the panel is open or closed.
      if (panel.contains(e.target)) return;
      if (panel.classList.contains("sm-visible")) {
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
    setColorModeUI(prefs.overrideColors);
    $("sm-style-select").value = prefs.style;
    $("sm-showcard-switch").classList.toggle("sm-on", prefs.showCard);

    barsEl.classList.toggle("sm-show", prefs.musicBars);
    artReflectEl.classList.toggle("sm-show", prefs.reflect);
    cardEl.classList.toggle("sm-hidden", !prefs.showCard);
    cardEl.classList.toggle("sm-style-bar", prefs.style === "bar");

    ensureWheelDrawn();
    setWheelFromHex(prefs.primary);
  }

  function applyPresetColors(i) {
    const p = PRESETS[i];
    if (!p) return;
    prefs.overrideColors = true;
    prefs.primary = p.primary;
    prefs.secondary = p.secondary;
    setColorModeUI(true);
    setWheelFromHex(p.primary);
    savePrefs(prefs);
    refreshColors(null);
  }

  // ── color wheel (HSV hue/sat disc + a brightness slider) ────
  // Replaces the old dual color-picker boxes with a single Apple-style
  // wheel: drag anywhere on the disc to set hue (angle) + saturation
  // (distance from center), and the Brightness slider controls value.
  // The secondary/accent color is derived automatically (an analogous
  // hue a little further round the wheel, slightly desaturated) so a
  // single drag still produces a nice two-tone glow like the presets do.
  let wheelDrawn = false;
  let wheelHue = 330, wheelSat = 0.85, wheelVal = 0.75; // current picker state

  function hsvToRgb(h, s, v) {
    h = ((h % 360) + 360) % 360;
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60)       { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else              { r = c; g = 0; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function rgbToHex(r, g, b) {
    const h = (v) => v.toString(16).padStart(2, "0");
    return `#${h(r)}${h(g)}${h(b)}`;
  }
  function hexToHsv(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
    if (!m) return { h: 330, s: 0.85, v: 0.75 };
    const r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return { h, s, v: max };
  }

  function ensureWheelDrawn() {
    if (wheelDrawn) return;
    const canvas = $("sm-color-wheel");
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const w = canvas.width, h = canvas.height, cx = w / 2, cy = h / 2, r = w / 2;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const dx = x - cx + 0.5, dy = y - cy + 0.5;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const idx = (y * w + x) * 4;
        if (dist > r) { img.data[idx + 3] = 0; continue; }
        let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (angle < 0) angle += 360;
        const sat = Math.min(1, dist / r);
        const [rr, gg, bb] = hsvToRgb(angle, sat, 1);
        img.data[idx] = rr; img.data[idx + 1] = gg; img.data[idx + 2] = bb; img.data[idx + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    wheelDrawn = true;
  }

  function positionWheelHandle() {
    const handle = $("sm-wheel-handle");
    const canvas = $("sm-color-wheel");
    if (!handle || !canvas) return;
    const r = canvas.width / 2;
    const rad = (wheelHue * Math.PI) / 180;
    const dist = wheelSat * r;
    const x = r + Math.cos(rad) * dist;
    const y = r + Math.sin(rad) * dist;
    handle.style.left = x + "px";
    handle.style.top = y + "px";
    handle.style.background = rgbToHex(...hsvToRgb(wheelHue, wheelSat, 1));
  }

  function applyWheelColor() {
    const primaryHex = rgbToHex(...hsvToRgb(wheelHue, wheelSat, wheelVal));
    // Secondary: an analogous hue further round the wheel, a touch
    // brighter/less saturated, so the ring reads as a real two-tone
    // gradient rather than one flat color repeated.
    const secondaryHex = rgbToHex(...hsvToRgb(wheelHue + 42, Math.max(0.25, wheelSat * 0.75), Math.min(1, wheelVal * 1.15 + 0.1)));
    prefs.primary = primaryHex;
    prefs.secondary = secondaryHex;
    positionWheelHandle();
    savePrefs(prefs);
    refreshColors(null);
  }

  function setWheelFromHex(hex) {
    const { h, s, v } = hexToHsv(hex);
    wheelHue = h; wheelSat = s; wheelVal = Math.max(0.25, Math.min(0.85, v));
    const slider = $("sm-lightness-slider");
    if (slider) slider.value = Math.round(wheelVal * 100);
    positionWheelHandle();
  }

  function wireColorWheel() {
    const wrap = $("sm-wheel-wrap");
    const canvas = $("sm-color-wheel");
    if (!wrap || !canvas) return;
    let dragging = false;

    function updateFromEvent(e) {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const dx = e.clientX - cx, dy = e.clientY - cy;
      let angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (angle < 0) angle += 360;
      const dist = Math.min(1, Math.sqrt(dx * dx + dy * dy) / (rect.width / 2));
      wheelHue = angle;
      wheelSat = dist;
      prefs.overrideColors = true;
      setColorModeUI(true);
      applyWheelColor();
    }

    wrap.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      dragging = true;
      try { wrap.setPointerCapture(e.pointerId); } catch {}
      updateFromEvent(e);
    });
    wrap.addEventListener("pointermove", (e) => { if (dragging) { e.stopPropagation(); updateFromEvent(e); } });
    const endDrag = (e) => { dragging = false; try { wrap.releasePointerCapture(e.pointerId); } catch {} };
    wrap.addEventListener("pointerup", endDrag);
    wrap.addEventListener("pointercancel", endDrag);
  }

  function setColorModeUI(custom) {
    $("sm-mode-auto-btn").classList.toggle("sm-active", !custom);
    $("sm-mode-custom-btn").classList.toggle("sm-active", custom);
    $("sm-wheel-block").classList.toggle("sm-show", custom);
    $("sm-color-auto-hint").classList.toggle("sm-show", !custom);
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

    $("sm-mode-auto-btn").addEventListener("click", () => {
      prefs.overrideColors = false;
      setColorModeUI(false);
      savePrefs(prefs);
      refreshColors(null);
    });
    $("sm-mode-custom-btn").addEventListener("click", () => {
      prefs.overrideColors = true;
      setColorModeUI(true);
      ensureWheelDrawn();
      setWheelFromHex(prefs.primary);
      savePrefs(prefs);
      refreshColors(null);
    });
    ensureWheelDrawn();
    wireColorWheel();
    $("sm-lightness-slider").addEventListener("input", (e) => {
      wheelVal = Math.max(0.1, Math.min(1, (+e.target.value) / 100));
      prefs.overrideColors = true;
      setColorModeUI(true);
      applyWheelColor();
    });
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
    activeColors = extracted
      ? { primary: vividColor(extracted.primary), secondary: vividColor(extracted.secondary) }
      : { primary: "#ff2d95", secondary: "#00d2ff" };
  }

  // ── Beat/amplitude data (Audius only — YouTube's iframe audio is
  // cross-origin and can't be read by the page at all) ───────────
  // music-widget.js owns the actual Web Audio tap on the <audio>
  // element (a given element can only ever be wrapped by ONE
  // MediaElementSourceNode for its whole lifetime, and it's already
  // using this same element to drive its own beat-reactive ring — a
  // second tap here would throw). Sleep Mode just reads the shared
  // amplitude/beat/frequency data through its public getters instead.
  function getAmplitude() {
    return window.MusicWidget?.getBeatData?.().amplitude || 0;
  }

  function detectBeat() {
    return window.MusicWidget?.getBeatData?.().beat || 0;
  }

  // Splits the analyser's frequency bins into `n` averaged buckets, with
  // a touch of log-ish spacing so the low end isn't crammed into the
  // first couple of bars (most audible energy sits there).
  function getFrequencyBins(n) {
    return window.MusicWidget?.getFrequencyBins?.(n) || null;
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

  // ── glow ring background builder ─────────────────────────────
  // The reference look (image 2) is a smooth, solid neon border —
  // one continuous wrap of color around the screen edge, not a string
  // of separate glowing dots. So this builds ONE smooth conic gradient
  // (a slow drift, not discrete traveling spots) and lets pulse/beat
  // drive its overall intensity and thickness instead of moving lights
  // around the ring.
  const SPOT_COUNT = 6;

  function colorToRgba(color, alpha) {
    const a = Math.max(0, Math.min(1, alpha)).toFixed(3);
    if (color[0] === "#") {
      const r = parseInt(color.slice(1, 3), 16), g = parseInt(color.slice(3, 5), 16), b = parseInt(color.slice(5, 7), 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    if (color.startsWith("hsl(")) return color.replace("hsl(", "hsla(").replace(")", `,${a})`);
    return color;
  }

  // ── "vivid-ize" a color pulled from the album art ─────────────
  // Raw extracted swatches are often muddy/desaturated (a dark maroon,
  // a dull brown) because they're just an average of whatever pixels
  // happened to be common. The reference look (image 2) is a punchy,
  // saturated neon — so push extracted colors toward high saturation
  // and a mid-bright lightness before they're ever used as a glow
  // color. Colors the user picked by hand on the wheel are left alone.
  function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    const d = max - min;
    if (d !== 0) {
      s = d / (1 - Math.abs(2 * l - 1));
      switch (max) {
        case r: h = ((g - b) / d) % 6; break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60; if (h < 0) h += 360;
    }
    return { h, s, l };
  }
  function hslToHex(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
    let r, g, b;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }
  function vividColor(hex) {
    try {
      const { h, s, l } = hexToHsl(hex);
      const s2 = Math.max(s, 0.82);
      const l2 = Math.min(0.68, Math.max(0.42, l < 0.3 ? l + 0.22 : l));
      return hslToHex(h, s2, l2);
    } catch (e) { return hex; }
  }

  // (beat detection itself now lives in music-widget.js — see the
  // detectBeat()/getAmplitude() getters above)

  function buildRingBackground(angleDeg, reactive, animated, beat) {
    const { primary, secondary } = activeColors;
    const p = Math.min(1, 0.55 + beat * 0.5);
    const a1 = 0.85 + p * 0.15;
    const a2 = 0.7 + p * 0.3;

    if (prefs.gradient === "rainbow") {
      return `conic-gradient(from ${angleDeg}deg, hsla(0,95%,60%,${a1}), hsla(60,95%,60%,${a2}), hsla(120,95%,60%,${a1}), hsla(180,95%,60%,${a2}), hsla(240,95%,60%,${a1}), hsla(300,95%,60%,${a2}), hsla(360,95%,60%,${a1}))`;
    }
    if (prefs.gradient === "mono") {
      return `conic-gradient(from ${angleDeg}deg, ${colorToRgba(primary, a1)}, ${colorToRgba(primary, a2 * 0.55)}, ${colorToRgba(primary, a1)}, ${colorToRgba(primary, a2 * 0.55)}, ${colorToRgba(primary, a1)})`;
    }
    // "default" — one smooth, solid wrap of the two album colors, slowly
    // drifting (angleDeg), instead of separate traveling light spots.
    return `conic-gradient(from ${angleDeg}deg, ${colorToRgba(primary, a1)}, ${colorToRgba(secondary, a2)}, ${colorToRgba(primary, a1)}, ${colorToRgba(secondary, a2)}, ${colorToRgba(primary, a1)})`;
  }

  // ── ambient bloom wash — big soft blurred blooms of color bleeding in
  // from every edge of the screen (heaviest at the bottom, same as a
  // phone lock-screen now-playing widget tinting the whole screen from
  // the album art), not just a thin ring outline. This is the main
  // "does it look alive" layer. ─────────────────────────────────────
  function buildWashBackground(pulse, beat) {
    const { primary, secondary } = activeColors;
    const p = Math.min(1, pulse + beat * 0.6);
    // Sides + top are the dominant, biggest blooms (this is the part
    // that was too small before) — wide ellipses hugging the full
    // height of each side edge and the top edge, all at high opacity
    // so the color actually reads as a bold neon frame like image 2.
    // Bottom stays present but secondary, since the card sits there.
    const aSide = 0.62 + p * 0.34;
    const aTop = 0.5 + p * 0.32;
    const aCorner = 0.55 + p * 0.32;
    const aBottom = 0.34 + p * 0.28;
    return [
      `radial-gradient(ellipse 42% 100% at 0% 50%, ${colorToRgba(primary, aSide)} 0%, transparent 62%)`,
      `radial-gradient(ellipse 42% 100% at 100% 50%, ${colorToRgba(secondary, aSide)} 0%, transparent 62%)`,
      `radial-gradient(ellipse 70% 34% at 50% 0%, ${colorToRgba(secondary, aTop)} 0%, transparent 65%)`,
      `radial-gradient(ellipse 40% 34% at 0% 0%, ${colorToRgba(primary, aCorner)} 0%, transparent 65%)`,
      `radial-gradient(ellipse 40% 34% at 100% 0%, ${colorToRgba(secondary, aCorner)} 0%, transparent 65%)`,
      `radial-gradient(ellipse 40% 34% at 0% 100%, ${colorToRgba(secondary, aCorner)} 0%, transparent 65%)`,
      `radial-gradient(ellipse 40% 34% at 100% 100%, ${colorToRgba(primary, aCorner)} 0%, transparent 65%)`,
      `radial-gradient(ellipse 78% 40% at 50% 100%, ${colorToRgba(primary, aBottom)} 0%, transparent 68%)`,
    ].join(", ");
  }

  // ── art halo — a small colorful glowing "frame" hugging the album
  // art itself, same color scheme as the screen edge glow, so the
  // cover reads as sitting inside its own little glowing border. ────
  function buildArtHaloBackground(angleDeg, pulse, beat) {
    const { primary, secondary } = activeColors;
    const p = Math.min(1, pulse + beat * 0.6);
    return `conic-gradient(from ${angleDeg}deg, ${colorToRgba(primary, 0.9)}, ${colorToRgba(secondary, 0.9)}, ${colorToRgba(primary, 0.9)}), radial-gradient(circle, ${colorToRgba(primary, 0.5 + p * 0.4)} 0%, transparent 75%)`;
  }

  // ── main animation loop — the glow ring traces the rounded screen
  // edge as a handful of drifting/pulsing light spots (built above),
  // audio-reactive (real frequency data + beat detection) when possible,
  // gentle ambient motion otherwise, plus the bar visualizer. ─────────
  let rafId = null;
  let travelT = 0; // 0..1, converted to a 0..360deg rotation each frame

  function tick() {
    if (!overlay || !overlay.classList.contains("sm-visible")) { rafId = null; return; }

    const mode = prefs.animation;
    const reactive = !!window.MusicWidget?.getBeatData?.().reactive;
    const animated = mode !== "none";
    const amp = reactive ? getAmplitude() : 0;
    const beat = reactive && animated ? detectBeat() : 0;

    let speed, pulse, blurMult = 1, thicknessMult = 1;
    if (mode === "none") {
      speed = 0; pulse = 0.5; blurMult = 0.22; thicknessMult = 0.5;
    } else if (mode === "static") {
      speed = 0; pulse = 0.5 + Math.sin(Date.now() / 900) * 0.18;
    } else if (reactive) {
      speed = 0.05 + amp * 0.35 + beat * 0.4;
      pulse = 0.5 + amp * 0.5 + beat * 0.35;
    } else {
      speed = 0.045;
      pulse = 0.55 + Math.sin(Date.now() / 900) * 0.18;
    }

    travelT = (travelT + speed / 360) % 1;
    const angleDeg = travelT * 360;

    const thickness = Math.max(2, prefs.thickness * 0.28 * thicknessMult * (0.8 + pulse * 0.5));
    const blur = Math.max(4, prefs.glow * blurMult * (0.7 + pulse * 0.6));
    const opacity = mode === "none" ? 0.95 : Math.min(1, 0.8 + pulse * 0.4);

    const background = buildRingBackground(angleDeg, reactive, animated, beat);
    frameGlow.style.background = background;
    frameGlow.style.padding = thickness + "px";
    frameGlow.style.filter = `blur(${blur}px)`;
    frameGlow.style.opacity = opacity;
    frameCore.style.background = background;
    frameCore.style.padding = Math.max(1.5, thickness * 0.35) + "px";
    frameCore.style.opacity = Math.min(1, opacity + 0.15);

    if (washEl) {
      washEl.style.background = buildWashBackground(pulse, beat);
      washEl.style.opacity = mode === "none" ? 0.55 : 1;
    }

    if (artHaloEl && artHaloCoreEl) {
      const haloBg = buildArtHaloBackground(angleDeg, pulse, beat);
      artHaloEl.style.background = haloBg;
      artHaloEl.style.opacity = Math.min(1, 0.55 + pulse * 0.45);
      artHaloCoreEl.style.background = haloBg;
      artHaloCoreEl.style.opacity = Math.min(1, 0.7 + pulse * 0.3);
    }

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
