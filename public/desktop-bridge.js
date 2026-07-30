// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Desktop bridge (renderer side)
//
// Safe to include on every page. In a normal browser, or when this
// app is loaded from the Render deployment, `window.jarvisDesktop`
// simply doesn't exist, so everything below no-ops and the app
// behaves exactly as it did before this file existed.
//
// When running inside the Electron desktop shell, this exposes
// window.openDesktopWidget(name, opts) so other scripts / buttons
// can pop a widget (music, board, hologram, news) out into a real
// floating OS window instead of an in-page element.
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
})();
