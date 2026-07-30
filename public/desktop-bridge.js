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

  // ── Open in real browser (native mic) ──
  // The desktop app's mic runs on MediaRecorder + Whisper because
  // Electron's bundled Chromium can't reach Google's speech servers
  // (see the big comment in jarvis.js above USE_CLOUD_STT — this is a
  // Google-side restriction, not something fixable from in here).
  // The only way to get the exact same native webkitSpeechRecognition
  // behavior as the website is to run the page in an actual installed
  // browser instead of Electron's window. This opens the same backend
  // URL externally so voice works identically to jarvis-render.com.
  window.openInBrowser = async function () {
    if (!isDesktop) { window.open(location.href, "_blank"); return; }
    try {
      const url = await window.jarvisDesktop.getBackendUrl();
      await window.jarvisDesktop.openExternal(url || location.origin);
    } catch (e) { console.warn("[desktop-bridge] openInBrowser failed:", e); }
  };

  if (isDesktop) {
    document.addEventListener("DOMContentLoaded", () => {
      const btn = document.createElement("button");
      btn.textContent = "🎙 Open in Browser (native mic)";
      btn.title = "Runs Jarvis in your real browser so voice recognition works exactly like the website, instead of the app's Whisper fallback.";
      Object.assign(btn.style, {
        position: "fixed", bottom: "12px", right: "12px", zIndex: 999999,
        padding: "8px 12px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.25)",
        background: "rgba(20,20,24,0.85)", color: "#fff", fontSize: "12px",
        cursor: "pointer", backdropFilter: "blur(6px)",
      });
      btn.onclick = () => window.openInBrowser();
      document.body.appendChild(btn);
    });
  }
})();
