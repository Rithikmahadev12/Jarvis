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

  // Full-desktop HUD overlay (one transparent window per monitor)
  toggleOverlay: () => ipcRenderer.invoke("desktop:toggle-overlay"),
  showOverlay: () => ipcRenderer.invoke("desktop:show-overlay"),
  hideOverlay: () => ipcRenderer.invoke("desktop:hide-overlay"),
  setClickThrough: (on) => ipcRenderer.invoke("desktop:set-click-through", on),

  // Pop a widget out into its own floating, draggable OS window that
  // can sit on any monitor. name: "music" | "board" | "hologram" | "news" | "hud"
  openWidget: (name, opts) => ipcRenderer.invoke("desktop:open-widget", name, opts || {}),
  closeWidget: (id) => ipcRenderer.invoke("desktop:close-widget", id),

  getDisplays: () => ipcRenderer.invoke("desktop:get-displays"),
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),
  quit: () => ipcRenderer.send("desktop:quit"),
});
