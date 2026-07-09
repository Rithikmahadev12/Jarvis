// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — MODE PICKER
// Swipe your hand RIGHT on the main screen → a confirm dialog asks
// "Open Mode Picker?" → on YES, a circular segmented wheel (proper
// pie wedges around a center hub) appears dead-center on screen.
// Select a mode by holding your hand over its wedge (dwell — same
// mechanic HandTracking already uses everywhere else) or by
// clicking with a mouse. Hovering a wedge plays a UI sound effect
// (fired centrally from hand-tracking.js's dwell loop for hand
// hover; mirrored here on mouseenter as a desktop fallback).
//
// Fully additive: doesn't touch existing IDs/functions, just calls
// the existing switchMode()/toggleListening() from jarvis.js.
// ═══════════════════════════════════════════════════════════════

(() => {

  const SVG_NS = "http://www.w3.org/2000/svg";
  const CX = 220, CY = 220;       // viewBox center (viewBox is 0 0 440 440)
  const OUTER_R = 204, INNER_R = 108;
  const GAP_DEG = 2.5;            // visual gap between wedges
  const SEGMENT_COUNT = 6;        // 5 modes + 1 close wedge
  const SEGMENT_SPAN = 360 / SEGMENT_COUNT;

  // First five wedges are real modes, the sixth is CLOSE — keeping it
  // as a wedge (not a floating button) means it's reachable by dwell
  // exactly the same way as every other option, which is the point.
  const MODES = [
    { id: "chat",  label: "CHAT",  svg: '<path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.4 3.3A.5.5 0 0 1 4 19.9V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z"/>' },
    { id: "map",   label: "MAP",   svg: '<path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2Z"/><path d="M9 4v14M15 6v14"/>' },
    { id: "mic",   label: "MIC",   svg: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>' },
    { id: "build", label: "BUILD", svg: '<path d="M14.5 6.5 18 3l3 3-3.5 3.5M14.5 6.5 4 17v3h3L17.5 9.5M14.5 6.5l3 3"/>' },
    { id: "news",  label: "NEWS",  svg: '<path d="M4 4.5h13a2 2 0 0 1 2 2V18a1.5 1.5 0 0 1-1.5 1.5H6A2 2 0 0 1 4 17.5V4.5Z"/><path d="M19 8h1.5A1.5 1.5 0 0 1 22 9.5v8a2 2 0 0 1-2 2"/><path d="M7 8h7M7 11.5h7M7 15h4"/>' },
    { id: "close", label: "CLOSE", close: true, svg: '<path d="M6 6l12 12M18 6L6 18"/>' },
  ];

  let confirmEl, pickerEl, hubEl;
  let built = false;
  let confirmOpen = false;
  let pickerOpen = false;
  let uiAudio = null;

  // ── geometry helpers ──
  function polar(cx, cy, r, angleDeg) {
    const rad = angleDeg * Math.PI / 180;
    return { x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad) };
  }
  function donutWedgePath(startAngle, endAngle) {
    const a0 = startAngle + GAP_DEG / 2;
    const a1 = endAngle - GAP_DEG / 2;
    const startOuter = polar(CX, CY, OUTER_R, a0);
    const endOuter   = polar(CX, CY, OUTER_R, a1);
    const startInner = polar(CX, CY, INNER_R, a1);
    const endInner   = polar(CX, CY, INNER_R, a0);
    const largeArc = (a1 - a0) > 180 ? 1 : 0;
    return [
      "M", startOuter.x, startOuter.y,
      "A", OUTER_R, OUTER_R, 0, largeArc, 1, endOuter.x, endOuter.y,
      "L", startInner.x, startInner.y,
      "A", INNER_R, INNER_R, 0, largeArc, 0, endInner.x, endInner.y,
      "Z",
    ].join(" ");
  }
  function svgEl(tag, attrs) {
    const el = document.createElementNS(SVG_NS, tag);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  }

  function build() {
    if (built) return;
    built = true;

    // ── UI sound effect (mouse-hover fallback; hand-hover is handled
    //    globally by hand-tracking.js so it works everywhere, this app included) ──
    uiAudio = new Audio("/soundeffects/UI-soundeffect.mp3");
    uiAudio.preload = "auto";

    // ── CONFIRM DIALOG ──
    confirmEl = document.createElement("div");
    confirmEl.id = "mp-confirm";
    confirmEl.innerHTML = `
      <div class="mp-confirm-box">
        <div class="mp-confirm-icon">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M13 5l7 7-7 7M4 12h15"/></svg>
        </div>
        <div class="mp-confirm-title">OPEN MODE PICKER?</div>
        <div class="mp-confirm-sub">Hand swipe detected — hold a button to confirm</div>
        <div class="mp-confirm-btns">
          <button class="hud-btn mp-confirm-yes">YES</button>
          <button class="hud-btn secondary mp-confirm-no">NO</button>
        </div>
      </div>`;
    document.body.appendChild(confirmEl);
    confirmEl.querySelector(".mp-confirm-yes").addEventListener("click", () => { closeConfirm(); openPicker(); });
    confirmEl.querySelector(".mp-confirm-no").addEventListener("click", closeConfirm);
    confirmEl.querySelector(".mp-confirm-yes").addEventListener("mouseenter", playUiSound);
    confirmEl.querySelector(".mp-confirm-no").addEventListener("mouseenter", playUiSound);
    confirmEl.addEventListener("click", e => { if (e.target === confirmEl) closeConfirm(); });

    // ── RADIAL WHEEL PICKER ──
    pickerEl = document.createElement("div");
    pickerEl.id = "mp-picker";
    pickerEl.innerHTML = `
      <div class="mp-backdrop"></div>
      <div class="mp-hint">HOLD A WEDGE TO <b>SELECT</b> — SWIPE LEFT OR TAP OUTSIDE TO CANCEL</div>
      <button class="mp-close-btn" title="Close" aria-label="Close mode picker">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <div class="mp-wheel-wrap">
        <svg class="mp-wheel-svg" viewBox="0 0 440 440">
          <circle class="mp-deco-ring" cx="220" cy="220" r="216"/>
          <circle class="mp-deco-ring" cx="220" cy="220" r="98"/>
        </svg>
        <div class="mp-hub">
          <div class="mp-hub-text">SELECT</div>
          <div class="mp-hub-sub">MODE</div>
        </div>
      </div>`;
    document.body.appendChild(pickerEl);

    const svg = pickerEl.querySelector(".mp-wheel-svg");
    hubEl = pickerEl.querySelector(".mp-hub");

    MODES.forEach((m, i) => {
      const startAngle = -90 + i * SEGMENT_SPAN - SEGMENT_SPAN / 2;
      const endAngle   = startAngle + SEGMENT_SPAN;
      const midAngle   = (startAngle + endAngle) / 2;
      const midR       = (OUTER_R + INNER_R) / 2;
      const pos        = polar(CX, CY, midR, midAngle);

      const g = svgEl("g", { class: "mp-segment-group", "data-mode": m.id });

      const path = svgEl("path", {
        class: "mp-segment" + (m.close ? " mp-node-close" : ""),
        d: donutWedgePath(startAngle, endAngle),
      });
      path.addEventListener("click", () => selectMode(m.id, path));
      path.addEventListener("mouseenter", playUiSound);
      g.appendChild(path);

      const labelG = svgEl("g", { class: "mp-seg-label" });
      const iconSvg = svgEl("svg", {
        class: "mp-seg-icon", x: pos.x - 11, y: pos.y - 22, width: 22, height: 22, viewBox: "0 0 24 24",
        fill: "none", stroke: "currentColor", "stroke-width": "1.6", "stroke-linecap": "round", "stroke-linejoin": "round",
      });
      iconSvg.innerHTML = m.svg;
      labelG.appendChild(iconSvg);

      const text = svgEl("text", { class: "mp-seg-text", x: pos.x, y: pos.y + 20 });
      text.textContent = m.label;
      labelG.appendChild(text);

      g.appendChild(labelG);
      svg.appendChild(g);
    });

    pickerEl.querySelector(".mp-backdrop").addEventListener("click", closePicker);
    const closeBtnEl = pickerEl.querySelector(".mp-close-btn");
    closeBtnEl.addEventListener("click", closePicker);
    closeBtnEl.addEventListener("mouseenter", playUiSound);
  }

  function playUiSound() {
    if (!uiAudio) return;
    try {
      const a = uiAudio.cloneNode();
      a.volume = 0.35;
      a.play().catch(() => {});
    } catch (e) {}
  }
  // Exposed so hand-tracking.js's dwell loop can play the exact same
  // sound the moment a hand hovers onto ANY new clickable element —
  // including these wedges.
  window.JarvisPlayUiSound = playUiSound;

  // ── CONFIRM DIALOG open/close ──
  function openConfirm() {
    if (!mainScreenActive() || confirmOpen || pickerOpen) return;
    build();
    confirmOpen = true;
    confirmEl.classList.add("mp-visible");
  }
  function closeConfirm() {
    confirmOpen = false;
    confirmEl.classList.remove("mp-visible");
  }

  // ── PICKER open/close ──
  function openPicker() {
    build();
    pickerOpen = true;
    pickerEl.classList.add("mp-visible");
  }
  function closePicker() {
    pickerOpen = false;
    pickerEl.classList.remove("mp-visible");
  }

  function selectMode(id, path) {
    if (id === "close") { closePicker(); return; }
    path.classList.add("mp-selecting");
    playUiSound();
    setTimeout(() => {
      if (id === "mic") {
        if (typeof toggleListening === "function") toggleListening();
      } else if (typeof switchMode === "function") {
        switchMode(id);
      }
      closePicker();
    }, 180);
  }

  function mainScreenActive() {
    const el = document.getElementById("main-screen");
    return !!(el && el.classList.contains("active"));
  }

  // ── SWIPE-RIGHT → open confirm dialog ──
  window.addEventListener("jarvis:swipe", e => {
    if (e.detail && e.detail.dir === "right") {
      openConfirm();
    } else if (e.detail && e.detail.dir === "left") {
      if (pickerOpen) closePicker();
      else if (confirmOpen) closeConfirm();
    }
  });

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (pickerOpen) closePicker();
    else if (confirmOpen) closeConfirm();
  });

  build();
})();
