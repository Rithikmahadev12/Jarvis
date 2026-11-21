/**
 * nus-electron.js
 * ───────────────
 * npm run nus  →  this file runs via `electron nus-electron.js`
 *
 * What it does:
 *   1. Spawns nus-server.js (full Jarvis brain) as a background node process
 *   2. Waits for the server to be ready
 *   3. Opens a fullscreen transparent BrowserWindow — the NUS knot overlay —
 *      loading the companion HTML from disk (like NUS desktop does)
 *   4. The knot floats over your desktop, click-through everywhere except
 *      the orb and glass panel
 *   5. Tray icon to quit
 */

const {
  app, BrowserWindow, Tray, Menu, ipcMain,
  screen, session, globalShortcut, nativeImage,
} = require('electron');
const path  = require('path');
const http  = require('http');
const { spawn } = require('child_process');

const ROOT         = __dirname;                                        // Jarvis root
const COMPANION_HTML = path.join(ROOT, 'public', 'nus-companion', 'index.html');
const ICON_PATH    = path.join(ROOT, 'public', 'icons', 'icon-192.png');
const PORT         = process.env.NUS_PORT || process.env.PORT || 3000;
const SERVER_URL   = `http://localhost:${PORT}`;

// GPU flags (same as main Jarvis electron shell)
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('enable-zero-copy');

// One instance only
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }

let overlayWin  = null;
let tray        = null;
let serverProc  = null;
let serverReady = false;

/* ── 1. Spawn nus-server.js ───────────────────────────────────────────────── */
function spawnServer() {
  console.log('[nus-electron] Starting nus-server.js …');
  serverProc = spawn(process.execPath, [path.join(ROOT, 'nus-server.js')], {
    cwd:   ROOT,
    env:   { ...process.env, PORT: String(PORT), ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
  });
  serverProc.on('exit', (code) => {
    console.log(`[nus-electron] nus-server.js exited (${code})`);
  });
}

/* ── 2. Poll until server is up ──────────────────────────────────────────── */
function pingServer(url) {
  return new Promise((resolve) => {
    const req = http.get(url + '/api/status', (res) => { res.resume(); resolve(true); });
    req.on('error', () => resolve(false));
    req.setTimeout(1200, () => { req.destroy(); resolve(false); });
  });
}

async function waitForServer(attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await pingServer(SERVER_URL)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

/* ── 3. Create the transparent overlay window ────────────────────────────── */
function overlayBounds() {
  const display = screen.getPrimaryDisplay();
  return display.workArea;
}

function createOverlay() {
  const area = overlayBounds();

  overlayWin = new BrowserWindow({
    x:      area.x,
    y:      area.y,
    width:  area.width,
    height: area.height,
    // ── Transparent, frameless, always on top ──
    frame:          false,
    transparent:    true,
    hasShadow:      false,
    resizable:      false,
    movable:        false,
    skipTaskbar:    true,
    alwaysOnTop:    true,
    fullscreenable: false,
    // ── Show after load, not immediately ──
    show: false,
    webPreferences: {
      preload:          path.join(ROOT, 'electron', 'nus-preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          false,                // need false so preload can require('electron')
    },
  });

  // Stay on top of everything — same level as NUS desktop
  if (process.platform === 'darwin') {
    overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  } else {
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }

  // No content protection so you can screenshot — remove this line if you want privacy mode
  overlayWin.setContentProtection(false);

  // Load the companion HTML DIRECTLY from disk (not via localhost)
  // This is key — same as NUS desktop's win.loadFile()
  overlayWin.loadFile(COMPANION_HTML);

  overlayWin.webContents.on('did-finish-load', () => {
    // Inject the server URL so jarvis-bridge.js knows where to call
    overlayWin.webContents.executeJavaScript(
      `window.JARVIS_BASE = "${SERVER_URL}";`
    ).catch(() => {});
    overlayWin.showInactive();
    console.log('[nus-electron] Knot overlay live ✓');
  });

  overlayWin.webContents.on('render-process-gone', (_e, d) => {
    console.error('[nus-electron] renderer gone:', d.reason);
  });

  // Rebound if display layout changes
  screen.on('display-metrics-changed', reboundOverlay);
  screen.on('display-added',           reboundOverlay);
  screen.on('display-removed',         reboundOverlay);

  overlayWin.on('closed', () => { overlayWin = null; });
}

function reboundOverlay() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  try { overlayWin.setBounds(overlayBounds()); } catch (_) {}
}

/* ── 4. Tray ──────────────────────────────────────────────────────────────── */
function buildTray() {
  try {
    tray = new Tray(ICON_PATH);
  } catch {
    // icon missing — use empty image
    tray = new Tray(nativeImage.createEmpty());
  }
  tray.setToolTip('J.A.R.V.I.S Companion');

  const rebuild = () => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'J.A.R.V.I.S — Companion', enabled: false },
      { type: 'separator' },
      {
        label: overlayWin && !overlayWin.isDestroyed() ? 'Hide Knot' : 'Show Knot',
        click: () => {
          if (!overlayWin || overlayWin.isDestroyed()) {
            createOverlay();
          } else if (overlayWin.isVisible()) {
            overlayWin.hide();
          } else {
            overlayWin.showInactive();
          }
          rebuild();
        },
      },
      {
        label: 'Open Jarvis (browser)',
        click: () => {
          const { shell } = require('electron');
          shell.openExternal(SERVER_URL);
        },
      },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() },
    ]));
  };

  rebuild();
  tray.on('click', () => {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.isVisible() ? overlayWin.hide() : overlayWin.showInactive();
    }
  });
}

/* ── IPC: click-through toggling (renderer tells main which areas are interactive) */
ipcMain.on('nus:set-ignore-mouse', (_e, ignore) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.setIgnoreMouseEvents(ignore, { forward: true });
  }
});

/* ── 5. App lifecycle ─────────────────────────────────────────────────────── */
Menu.setApplicationMenu(null);

app.whenReady().then(async () => {
  // Allow mic for voice capture
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  // Spawn the Jarvis brain server
  spawnServer();

  // Wait up to 30s for it to be ready
  console.log('[nus-electron] Waiting for nus-server.js …');
  const ok = await waitForServer();
  if (!ok) {
    console.error('[nus-electron] Server never came up — opening overlay anyway (will use direct Anthropic fallback)');
  } else {
    console.log('[nus-electron] Server ready ✓');
    serverReady = true;
  }

  createOverlay();
  buildTray();

  // Ctrl+Shift+K toggles the overlay (like NUS's Cmd+Shift+Space)
  const shortcut = process.platform === 'darwin' ? 'Command+Shift+K' : 'Control+Shift+K';
  globalShortcut.register(shortcut, () => {
    if (!overlayWin || overlayWin.isDestroyed()) { createOverlay(); return; }
    overlayWin.isVisible() ? overlayWin.hide() : overlayWin.showInactive();
  });

  app.on('second-instance', () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.showInactive();
  });
});

app.on('window-all-closed', () => {
  // Keep running in tray — don't quit
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (serverProc) {
    try { serverProc.kill(); } catch {}
  }
});
