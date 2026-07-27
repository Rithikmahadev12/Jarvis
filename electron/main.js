// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Desktop Shell (Electron)
//
// This turns Jarvis from "a website you open in a browser" into a
// real local piece of software:
//   - Spawns the existing server.js locally (same code as the web
//     version — nothing about server.js changes) OR points at a
//     remote deployment (e.g. Render) if you'd rather not run the
//     backend on this machine.
//   - Gives you a normal app window for the main chat/home UI.
//   - Gives you a real "HUD overlay" — a transparent, click-through,
//     always-on-top, frameless window that sits ON TOP OF your
//     entire desktop (over any app), on any monitor. This is a real
//     OS-level window, not just a div inside a browser tab.
//   - Lets you pop any widget (board, music, hologram, news, HUD
//     panels) out into its own small floating window that can be
//     dragged to any screen.
//
// Nothing here modifies server.js or how the app behaves when it's
// simply loaded in a normal browser (e.g. hitting the Render URL) —
// this is a pure addition. If you never run `npm run desktop`, none
// of this code executes at all.
// ═══════════════════════════════════════════════════════════════

const { app, BrowserWindow, screen, globalShortcut, Tray, Menu, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "jarvis.config.json");

// ── CONFIG ──────────────────────────────────────────────────────
// mode: "auto"   -> try to run server.js locally; if that fails to
//                   boot, fall back to remoteUrl if one is set
//       "local"  -> always spawn server.js locally
//       "remote" -> never spawn anything locally, just point every
//                   window at remoteUrl (e.g. your Render deploy)
function loadConfig() {
  const defaults = {
    mode: "auto",
    localPort: 3000,
    remoteUrl: "", // e.g. "https://jarvis.onrender.com"
    hudHotkey: "CommandOrControl+Shift+J",
    startHudOnLaunch: false,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return { ...defaults, ...raw };
  } catch {
    return defaults;
  }
}

const config = loadConfig();

let mainWindow = null;
let overlayWindows = []; // one per display, the full-desktop HUD layer
let widgetWindows = new Map(); // id -> BrowserWindow
let tray = null;
let backendChild = null;
let backendUrl = null;
let clickThroughOn = false;
let widgetIdCounter = 0;

// ── BACKEND RESOLUTION ──────────────────────────────────────────
function pingUrl(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function waitForLocalServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i++) {
    if (await pingUrl(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function spawnLocalBackend() {
  console.log("[DESKTOP] Starting local Jarvis backend (server.js)...");
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(config.localPort), ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  child.on("exit", (code) => {
    console.log(`[DESKTOP] Local backend exited (code ${code})`);
  });
  return child;
}

async function resolveBackend() {
  const localUrl = `http://localhost:${config.localPort}`;

  if (config.mode === "remote") {
    if (!config.remoteUrl) {
      throw new Error("jarvis.config.json has mode:'remote' but no remoteUrl set.");
    }
    console.log("[DESKTOP] Using remote backend:", config.remoteUrl);
    return config.remoteUrl.replace(/\/$/, "");
  }

  if (config.mode === "local" || config.mode === "auto") {
    // If something's already running on that port (e.g. you started
    // it yourself with `npm start`), just use it instead of double-spawning.
    const alreadyUp = await pingUrl(localUrl);
    if (!alreadyUp) {
      backendChild = spawnLocalBackend();
    } else {
      console.log("[DESKTOP] Local server already running, reusing it.");
    }
    const ok = await waitForLocalServer(localUrl);
    if (ok) return localUrl;

    if (config.mode === "auto" && config.remoteUrl) {
      console.warn("[DESKTOP] Local backend didn't come up, falling back to remoteUrl.");
      return config.remoteUrl.replace(/\/$/, "");
    }
    throw new Error("Local backend never came up and no remoteUrl configured to fall back to.");
  }

  throw new Error(`Unknown mode in jarvis.config.json: ${config.mode}`);
}

// ── WINDOWS ─────────────────────────────────────────────────────
function preloadPath() {
  return path.join(__dirname, "preload.js");
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: "#0a0e14",
    title: "J.A.R.V.I.S",
    icon: path.join(ROOT, "public", "icons", "icon-512.png"),
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: false,
    },
  });
  mainWindow.loadURL(`${backendUrl}/index.html`);
  mainWindow.on("closed", () => { mainWindow = null; });
  return mainWindow;
}

// One transparent, click-through-able, always-on-top window per
// display, stretched to that display's full bounds. This is what
// makes the HUD show up "anywhere" — over your desktop, over other
// apps, on whichever monitor you're looking at.
function createOverlayWindows() {
  closeOverlayWindows();
  const displays = screen.getAllDisplays();
  overlayWindows = displays.map((display) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      focusable: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: preloadPath(),
        contextIsolation: true,
        sandbox: false,
      },
    });
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    win.loadURL(`${backendUrl}/overlay.html`);
    win.setIgnoreMouseEvents(clickThroughOn, { forward: true });
    win.hide(); // start hidden; toggled via hotkey/tray
    return win;
  });
}

function closeOverlayWindows() {
  overlayWindows.forEach((w) => { try { w.close(); } catch {} });
  overlayWindows = [];
}

function toggleOverlay() {
  if (!overlayWindows.length) createOverlayWindows();
  const show = overlayWindows[0] && !overlayWindows[0].isVisible();
  overlayWindows.forEach((w) => (show ? w.showInactive() : w.hide()));
  return show;
}

function setClickThrough(on) {
  clickThroughOn = !!on;
  overlayWindows.forEach((w) => w.setIgnoreMouseEvents(clickThroughOn, { forward: true }));
}

// A single floating widget (board / music / hologram / news / a
// custom HUD panel) in its own small always-on-top window that can
// be dragged to any spot on any monitor.
function openWidgetWindow(widgetName, opts = {}) {
  const displays = screen.getAllDisplays();
  const target = displays[opts.displayIndex] || screen.getPrimaryDisplay();
  const width = opts.width || 380;
  const height = opts.height || 260;
  const x = opts.x != null ? target.bounds.x + opts.x : target.bounds.x + 80;
  const y = opts.y != null ? target.bounds.y + opts.y : target.bounds.y + 80;

  const id = `widget-${++widgetIdCounter}`;
  const win = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const query = new URLSearchParams({ widget: widgetName, ...(opts.params || {}) }).toString();
  win.loadURL(`${backendUrl}/widget-host.html?${query}`);
  win.on("closed", () => widgetWindows.delete(id));
  widgetWindows.set(id, win);
  return id;
}

function closeWidgetWindow(id) {
  const win = widgetWindows.get(id);
  if (win) { try { win.close(); } catch {} widgetWindows.delete(id); }
}

// ── TRAY ────────────────────────────────────────────────────────
function buildTray() {
  const iconPath = path.join(ROOT, "public", "icons", "icon-192.png");
  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.warn("[DESKTOP] Tray icon failed to load, continuing without tray:", e.message);
    return;
  }
  const rebuildMenu = () => {
    const menu = Menu.buildFromTemplate([
      { label: "J.A.R.V.I.S", enabled: false },
      { label: `Backend: ${backendUrl}`, enabled: false },
      { type: "separator" },
      {
        label: overlayWindows.length && overlayWindows[0].isVisible() ? "Hide HUD" : "Show HUD",
        click: () => { toggleOverlay(); rebuildMenu(); },
      },
      {
        label: clickThroughOn ? "Disable click-through" : "Enable click-through",
        click: () => { setClickThrough(!clickThroughOn); rebuildMenu(); },
      },
      { type: "separator" },
      { label: "Open widget: Music", click: () => openWidgetWindow("music") },
      { label: "Open widget: Board", click: () => openWidgetWindow("board") },
      { label: "Open widget: Hologram", click: () => openWidgetWindow("hologram") },
      { label: "Open widget: News", click: () => openWidgetWindow("news") },
      { type: "separator" },
      { label: "Show main window", click: () => { if (mainWindow) mainWindow.show(); else createMainWindow(); } },
      { label: "Quit", click: () => app.quit() },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip("J.A.R.V.I.S");
  rebuildMenu();
}

// ── IPC (exposed to renderer via preload.js as window.jarvisDesktop) ──
ipcMain.handle("desktop:get-backend-url", () => backendUrl);
ipcMain.handle("desktop:toggle-overlay", () => toggleOverlay());
ipcMain.handle("desktop:set-click-through", (_e, on) => { setClickThrough(on); return clickThroughOn; });
ipcMain.handle("desktop:open-widget", (_e, name, opts) => openWidgetWindow(name, opts));
ipcMain.handle("desktop:close-widget", (_e, id) => closeWidgetWindow(id));
ipcMain.handle("desktop:get-displays", () => screen.getAllDisplays());
ipcMain.handle("desktop:open-external", (_e, url) => shell.openExternal(url));
ipcMain.on("desktop:quit", () => app.quit());

// ── LIFECYCLE ───────────────────────────────────────────────────
app.whenReady().then(async () => {
  try {
    backendUrl = await resolveBackend();
  } catch (err) {
    console.error("[DESKTOP] Could not resolve a backend:", err.message);
    // Show a minimal window explaining what to fix rather than a
    // silent crash — most likely cause is a missing GROQ_API_KEY or
    // both mode:'local' failing and no remoteUrl set as a fallback.
    const errWin = new BrowserWindow({ width: 640, height: 360 });
    errWin.loadURL(
      "data:text/html," +
        encodeURIComponent(`<body style="font-family:sans-serif;background:#111;color:#eee;padding:24px">
          <h2>J.A.R.V.I.S couldn't start</h2>
          <p>${err.message}</p>
          <p>Check <code>jarvis.config.json</code> — set <code>mode</code> to
          <code>"local"</code>, <code>"remote"</code> (with a <code>remoteUrl</code>),
          or <code>"auto"</code>.</p>
        </body>`)
    );
    return;
  }

  createMainWindow();
  createOverlayWindows();
  buildTray();

  globalShortcut.register(config.hudHotkey, () => toggleOverlay());
  // Alt+Shift+C toggles click-through on the HUD overlay so you can
  // click "into" it to interact, or click "through" it to use
  // whatever's underneath.
  globalShortcut.register("CommandOrControl+Shift+C", () => setClickThrough(!clickThroughOn));

  if (config.startHudOnLaunch) toggleOverlay();

  screen.on("display-added", createOverlayWindows);
  screen.on("display-removed", createOverlayWindows);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  // Keep running in the tray on Windows/Linux (the HUD/tray is the
  // point of the desktop app); fully quit on macOS only if the user
  // explicitly quits from the tray/menu, matching normal mac apps.
  if (process.platform !== "darwin") {
    // no-op: tray keeps the app alive intentionally
  }
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (backendChild) { try { backendChild.kill(); } catch {} }
});
