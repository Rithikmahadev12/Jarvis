// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — MODE PICKER
// Swipe your hand RIGHT on the main screen → a confirm dialog asks
// "Open Mode Picker?" → on YES, a radial arc menu pops up around a
// center orb. Select a mode by holding your hand over it (dwell —
// same mechanic HandTracking already uses everywhere else) or by
// clicking with a mouse. Hovering a node plays a UI sound effect
// (handled centrally in hand-tracking.js's dwell loop, so it fires
// for hand hover the same way it does for every other dwell target
// on the app — mouse hover on these nodes also plays it here as a
// desktop-friendly fallback).
//
// Fully additive: doesn't touch existing IDs/functions, just calls
// the existing switchMode()/toggleListening() from jarvis.js.
// ═══════════════════════════════════════════════════════════════

(() => {

  const MODES = [
    {
      id: "chat", label: "CHAT", angle: -165, r: 200,
      svg: '<path d="M4 5.5h16a1 1 0 0 1 1 1V16a1 1 0 0 1-1 1H9l-4.4 3.3A.5.5 0 0 1 4 19.9V17H4a1 1 0 0 1-1-1V6.5a1 1 0 0 1 1-1Z"/>'
    },
    {
      id: "map", label: "MAP", angle: -125, r: 320,
      svg: '<path d="M9 4 4 6v14l5-2 6 2 5-2V4l-5 2-6-2Z"/><path d="M9 4v14M15 6v14"/>'
    },
    {
      id: "mic", label: "MIC", angle: -90, r: 380,
      svg: '<rect x="9" y="2.5" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>'
    },
    {
      id: "build", label: "BUILD", angle: -55, r: 320,
      svg: '<path d="M14.5 6.5 18 3l3 3-3.5 3.5M14.5 6.5 4 17v3h3L17.5 9.5M14.5 6.5l3 3"/>'
    },
    {
      id: "news", label: "NEWS", angle: -15, r: 200,
      svg: '<path d="M4 4.5h13a2 2 0 0 1 2 2V18a1.5 1.5 0 0 1-1.5 1.5H6A2 2 0 0 1 4 17.5V4.5Z"/><path d="M19 8h1.5A1.5 1.5 0 0 1 22 9.5v8a2 2 0 0 1-2 2"/><path d="M7 8h7M7 11.5h7M7 15h4"/>'
    },
  ];

  const LOGICAL_W = 680, LOGICAL_H = 440; // reference box the angle/radius numbers above were designed against

  let confirmEl, pickerEl, wrapEl, closeBtnEl;
  let built = false;
  let confirmOpen = false;
  let pickerOpen = false;
  let uiAudio = null;

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
    confirmEl.addEventListener("click", e => { if (e.target === confirmEl) closeConfirm(); });

    // ── RADIAL PICKER ──
    pickerEl = document.createElement("div");
    pickerEl.id = "mp-picker";
    pickerEl.innerHTML = `
      <div class="mp-backdrop"></div>
      <div class="mp-hint">HOLD A NODE TO <b>SELECT</b> — SWIPE LEFT, TAP OUTSIDE, OR ✕ TO CANCEL</div>
      <button class="mp-close-btn" title="Close" aria-label="Close mode picker">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <div class="mp-arc-wrap" id="mp-arc-wrap">
        <div class="mp-deco-arc a2"></div>
        <div class="mp-deco-arc a1"></div>
        <div class="mp-center">
          <div class="mp-center-ring"></div>
          <div class="mp-center-core"></div>
        </div>
      </div>`;
    document.body.appendChild(pickerEl);
    wrapEl = pickerEl.querySelector("#mp-arc-wrap");
    closeBtnEl = pickerEl.querySelector(".mp-close-btn");

    MODES.forEach(m => {
      const node = document.createElement("div");
      node.className = "mp-node";
      node.dataset.mode = m.id;
      node.innerHTML = `
        <div class="mp-node-line"></div>
        <div class="mp-node-dot"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${m.svg}</svg></div>
        <div class="mp-node-label">${m.label}</div>`;
      node.addEventListener("click", () => selectMode(m.id, node));
      node.addEventListener("mouseenter", playUiSound);
      wrapEl.appendChild(node);
    });

    pickerEl.querySelector(".mp-backdrop").addEventListener("click", closePicker);
    closeBtnEl.addEventListener("click", closePicker);
    closeBtnEl.addEventListener("mouseenter", playUiSound);
    confirmEl.querySelector(".mp-confirm-yes").addEventListener("mouseenter", playUiSound);
    confirmEl.querySelector(".mp-confirm-no").addEventListener("mouseenter", playUiSound);

    window.addEventListener("resize", () => { if (pickerOpen) layoutNodes(); });
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
  // including these mode-picker nodes.
  window.JarvisPlayUiSound = playUiSound;

  function layoutNodes() {
    const rect = wrapEl.getBoundingClientRect();
    const scaleX = rect.width / LOGICAL_W;
    const scaleY = rect.height / LOGICAL_H;
    const cx = rect.width / 2;
    const cy = rect.height;

    wrapEl.querySelectorAll(".mp-node").forEach(node => {
      const m = MODES.find(x => x.id === node.dataset.mode);
      if (!m) return;
      const rad = m.angle * Math.PI / 180;
      const r = m.r * ((scaleX + scaleY) / 2);
      const nx = cx + r * Math.cos(rad);
      const ny = cy + r * Math.sin(rad);
      node.style.setProperty("--nx", `${nx}px`);
      node.style.setProperty("--ny", `${ny}px`);
      node.style.setProperty("--llen", `${r}px`);
      node.style.setProperty("--lrot", `${m.angle + 180}deg`);
    });
  }

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
    requestAnimationFrame(layoutNodes);
  }
  function closePicker() {
    pickerOpen = false;
    pickerEl.classList.remove("mp-visible");
  }

  function selectMode(id, node) {
    node.classList.add("mp-selecting");
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
