// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Desktop bridge (preload)
//
// Exposes a small, safe API to every page loaded in the Electron
// app as `window.jarvisDesktop`. Regular browser/Render usage never
// loads this file, so `window.jarvisDesktop` is simply undefined
// there — any code that checks for it first (see
// public/desktop-bridge.js) behaves exactly as it always has.
// ═══════════════════════════════════════════════════════════════
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvisDesktop", {
  isDesktop: true,

  getBackendUrl: () => ipcRenderer.invoke("desktop:get-backend-url"),

  // Pop a widget out into its own floating, draggable OS window that
  // can sit on any monitor. name: "music" | "board" | "hologram" | "news"
  openWidget: (name, opts) => ipcRenderer.invoke("desktop:open-widget", name, opts || {}),
  closeWidget: (id) => ipcRenderer.invoke("desktop:close-widget", id),

  getDisplays: () => ipcRenderer.invoke("desktop:get-displays"),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  quit: () => ipcRenderer.send("desktop:quit"),

  // Used only by the approvals overlay (public/approval-pill.html) to
  // tell the main process when to show/hide and how tall to be.
  approvalResize: (info) => ipcRenderer.send("desktop:approval-resize", info),

  // ── NOTCH BAR ──────────────────────────────────────────────────
  // Tells main process the notch window's current rendered height so
  // it can resize the BrowserWindow to match (collapsed pill vs expanded panel).
  notchResize: (info) => ipcRenderer.send("desktop:notch-resize", info),

  // Captures a screenshot of the primary display via Electron's
  // desktopCapturer (not available in the renderer directly due to
  // contextIsolation). Returns a base64 data URL or null.
  captureScreen: () => ipcRenderer.invoke("desktop:capture-screen"),
});
