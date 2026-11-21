/**
 * nus-preload.js
 * Preload for the NUS knot overlay BrowserWindow.
 * Exposes a minimal bridge so the renderer can toggle click-through
 * (setIgnoreMouseEvents) on the main process window.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('nusElectron', {
  // Called by jarvis-bridge.js to make transparent areas click-through
  setIgnoreMouse: (ignore) => ipcRenderer.send('nus:set-ignore-mouse', ignore),
  isElectron: true,
  platform: process.platform,
});
