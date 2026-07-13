"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — User Settings (persisted, syncs to Render too)
//
// Small key/value store for toggles like "face detection on/off",
// stored at data/settings.json — the SAME data/ folder persistence.js
// already mirrors to Supabase Storage. That means:
//   - locally: settings survive restarts as long as data/settings.json
//     exists on disk
//   - on Render: settings survive redeploys/spin-downs too, as long as
//     SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET are
//     set (see persistence.js header) — persistence.js's existing
//     pull-on-boot / push-every-20s loop handles this file exactly
//     like it already handles profiles.json, no extra wiring needed.
//
// Add new settings by just adding a new key to DEFAULTS below — no
// migration needed, get()/save() merge with defaults automatically.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR      = path.join(__dirname, "data");
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json");

const DEFAULTS = {
  faceDetection: true,
  // add more toggles here as needed, e.g.:
  // notifications: true,
  // homeTalk: false,
};

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDataDir();
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf8"));
    return { ...DEFAULTS, ...saved };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const current = load();
  const updated = { ...current, ...partial };
  ensureDataDir();
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), "utf8");
  return updated;
}

module.exports = { load, save, DEFAULTS };
