"use strict";

// ═══════════════════════════════════════════════════════════════
// ── CAST  (a.k.a. "Home Talk")
// Publishes a synthesized audio clip on the LAN and tells a
// Chromecast-compatible speaker (e.g. a Google Home / Nest Mini)
// to play it, via a small Python helper (pychromecast).
// ═══════════════════════════════════════════════════════════════

const fs     = require("fs");
const path   = require("path");
const os     = require("os");
const { spawn } = require("child_process");

const CONFIG_PATH = path.join(__dirname, "config.json");
const CACHE_DIR   = path.join(__dirname, "public", "tts-cache");
const CAST_SCRIPT = path.join(__dirname, "voice-server", "cast.py");

if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")); }
  catch { return {}; }
}

function deviceName() {
  const name = loadConfig().castDevice;
  return name && name.trim() ? name.trim() : null;
}

function isConfigured() {
  return !!deviceName();
}

// Best-effort LAN IP — the phone and the speaker both need to be able
// to reach this address, so loopback/internal interfaces don't count.
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

// Writes the audio buffer into /public/tts-cache (already statically
// served by Express) and returns a LAN-reachable URL for it.
function publishAudio(buffer, port) {
  // Detect format by magic bytes: MP3 starts with 0xFF 0xFB/0xF3/0xF2 or ID3
  const isMP3 = buffer[0] === 0xFF && (buffer[1] & 0xE0) === 0xE0
             || buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33; // ID3
  const ext      = isMP3 ? "mp3" : "wav";
  const filename = `home-talk-${Date.now()}.${ext}`;
  const filePath = path.join(CACHE_DIR, filename);
  fs.writeFileSync(filePath, buffer);

  // Clean up older clips so the cache folder doesn't grow forever.
  for (const f of fs.readdirSync(CACHE_DIR)) {
    if (f !== filename) {
      try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch { /* ignore */ }
    }
  }

  return `http://${getLocalIP()}:${port}/tts-cache/${filename}`;
}

// Spawns the Python cast helper. Resolves once playback has started,
// rejects if the device can't be found or pychromecast errors out.
function playOnDevice(mediaUrl) {
  return new Promise((resolve, reject) => {
    const name = deviceName();
    if (!name) return reject(new Error("No castDevice set in config.json"));
    if (!fs.existsSync(CAST_SCRIPT)) return reject(new Error("voice-server/cast.py is missing"));

    const proc = spawn("python3", [CAST_SCRIPT, name, mediaUrl]);
    let stderr = "";
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(true);
      else reject(new Error(stderr.trim() || `cast.py exited with code ${code}`));
    });
  });
}

module.exports = { deviceName, isConfigured, publishAudio, playOnDevice, getLocalIP };
