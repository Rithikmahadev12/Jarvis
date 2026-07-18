// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Nav Transition Overlay
// Full-screen "JARVIS" ring played over a real page navigation
// (window.location.href changes, not an in-app panel switch), so
// commands like "jarvis, what's the news" feel like one continuous
// motion instead of a hard page-load flash.
//
// Usage:
//   window.JarvisTransition.goTo("/news")   // show ring, then navigate
//   window.JarvisTransition.show() / .hide() // manual control
//
// The destination page just needs to include this same script —
// it automatically detects it was reached via a transition and
// fades the ring out once the page is ready, instead of flashing
// the raw unstyled page first.
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const FLAG_KEY = "jarvis_nav_transition";
  let overlayEl = null;

  function ensureOverlay() {
    if (overlayEl && document.body.contains(overlayEl)) return overlayEl;
    overlayEl = document.createElement("div");
    overlayEl.id = "nav-transition-overlay";
    overlayEl.className = "nav-transition-overlay";
    overlayEl.innerHTML =
      '<div class="nt-grid"></div>' +
      '<div class="nt-corner nt-tl"></div>' +
      '<div class="nt-corner nt-tr"></div>' +
      '<div class="nt-corner nt-bl"></div>' +
      '<div class="nt-corner nt-br"></div>' +
      '<div class="nt-ring-wrap">' +
        '<div class="nt-ring nt-r1"></div>' +
        '<div class="nt-ring nt-r2"></div>' +
        '<div class="nt-core"></div>' +
        '<div class="nt-label">JARVIS</div>' +
      "</div>";
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function show() {
    const el = ensureOverlay();
    // Force layout so the opacity transition actually plays even if
    // the element was just created this tick.
    void el.offsetWidth;
    el.classList.add("active");
    return el;
  }

  function hide() {
    if (overlayEl) overlayEl.classList.remove("active", "no-fade-in");
  }

  // Show the ring, hold briefly, then perform a real navigation.
  function goTo(url, holdMs) {
    holdMs = typeof holdMs === "number" ? holdMs : 650;
    try { sessionStorage.setItem(FLAG_KEY, "1"); } catch (e) {}
    show();
    setTimeout(() => { window.location.href = url; }, holdMs);
  }

  // Called automatically on script load. If this page was reached via
  // goTo(), keep the ring up instantly (no fade-in flash of the raw
  // page underneath) and fade it out once things are ready.
  function consumeOnLoad(readyDelay) {
    let flagged = false;
    try {
      flagged = sessionStorage.getItem(FLAG_KEY) === "1";
      sessionStorage.removeItem(FLAG_KEY);
    } catch (e) {}
    if (!flagged) return;
    const el = ensureOverlay();
    el.classList.add("active", "no-fade-in");
    setTimeout(() => { hide(); }, typeof readyDelay === "number" ? readyDelay : 550);
  }

  window.JarvisTransition = { show, hide, goTo, consumeOnLoad };

  function boot() { consumeOnLoad(); }
  if (document.body) boot();
  else document.addEventListener("DOMContentLoaded", boot);
})();
