// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Desktop bridge (renderer side)
//
// Safe to include on every page. In a normal browser, or when this
// app is loaded from the Render deployment, `window.jarvisDesktop`
// simply doesn't exist, so everything below no-ops and the app
// behaves exactly as it did before this file existed.
//
// When running inside the Electron desktop shell, this adds:
//   - a small "Desktop HUD" toggle button (Ctrl/Cmd+Shift+J also
//     works globally, from anywhere, even outside the app)
//   - window.openDesktopWidget(name, opts) for other scripts /
//     future buttons to pop a widget out into a real floating OS
//     window instead of an in-page element
// ═══════════════════════════════════════════════════════════════
(function () {
  const isDesktop = !!(window.jarvisDesktop && window.jarvisDesktop.isDesktop);
  window.isDesktopApp = isDesktop;

  // Convenience global used by any widget's "pop out" button, present
  // or future. Falls back to the widget's normal in-page .show() if
  // we're not in the desktop app (e.g. plain browser / Render).
  window.openDesktopWidget = function (name, opts) {
    if (isDesktop) {
      return window.jarvisDesktop.openWidget(name, opts || {});
    }
    // Browser fallback — just trigger it in-page like before.
    try {
      if (name === "music" && window.MusicWidget) window.MusicWidget.play?.(opts);
      else if (name === "board" && window.BoardWidget) window.BoardWidget.show(opts);
      else if (name === "hologram" && window.HologramWidget) window.HologramWidget.show(opts?.key || "earth");
    } catch (e) { console.warn("[desktop-bridge] fallback open failed:", e); }
    return null;
  };

  if (!isDesktop) return; // nothing else to do outside the desktop app

  document.addEventListener("DOMContentLoaded", () => {
    const params = new URLSearchParams(location.search);
    // overlay.html and widget-host.html already drive themselves;
    // don't add the floating toggle button to those bare host pages.
    if (params.has("widget") || location.pathname.endsWith("overlay.html")) return;

    const btn = document.createElement("button");
    btn.textContent = "HUD";
    btn.title = "Toggle desktop HUD overlay (Ctrl/Cmd+Shift+J)";
    Object.assign(btn.style, {
      position: "fixed", bottom: "16px", right: "16px", zIndex: 999999,
      background: "rgba(0,20,30,0.85)", color: "#00c8ff",
      border: "1px solid #00c8ff", borderRadius: "8px",
      padding: "8px 14px", fontFamily: "'Share Tech Mono', monospace",
      fontSize: "12px", letterSpacing: "1px", cursor: "pointer",
      boxShadow: "0 0 12px rgba(0,200,255,0.35)",
    });
    btn.addEventListener("click", () => window.jarvisDesktop.toggleOverlay());
    document.body.appendChild(btn);
  });
})();
