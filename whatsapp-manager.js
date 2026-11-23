"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Manager
//
// Manages all WhatsApp Agent accounts. Each user creates their own
// WhatsApp Agent inside the WhatsApp app (Settings → Agents → Create),
// gets an API key from that agent's chat info, and hands it to the
// owner. The owner texts their Jarvis on WhatsApp to register users.
//
// Per-user data stored here:
//   - name, userKey (lowercase slug)
//   - whatsappApiKey  ← their WhatsApp Agent API key
//   - faceImageBase64 ← for site face-ID login
//   - role (owner | user)
//   - registeredAt, lastActiveAt
//   - walletAddress   ← their Solana wallet (set after ensureUserWallet)
//   - earnEnabled     ← whether earn-brain is running for them
//
// All accounts live in data/whatsapp-accounts.json
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const DATA_DIR      = path.join(__dirname, "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "whatsapp-accounts.json");

// ── helpers ──────────────────────────────────────────────────────
function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function load() {
  ensureDir();
  try { return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf8")); }
  catch { return {}; }
}

function save(accounts) {
  ensureDir();
  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf8");
}

function toKey(name) {
  return String(name || "").toLowerCase().trim().replace(/\s+/g, "_");
}

// ── public API ───────────────────────────────────────────────────

/**
 * Register or update a WhatsApp account.
 * @param {object} opts
 * @param {string} opts.name           - display name ("Ajay")
 * @param {string} opts.whatsappApiKey - their WhatsApp Agent API key
 * @param {string} [opts.faceImageBase64] - base64 face photo for site login
 * @param {string} [opts.role]         - "owner" | "user"  (default "user")
 * @returns {{ userKey: string, created: boolean }}
 */
function registerAccount({ name, whatsappApiKey, faceImageBase64 = null, role = "user" }) {
  if (!name || !whatsappApiKey) throw new Error("name and whatsappApiKey are required.");
  const userKey  = toKey(name);
  const accounts = load();
  const existing = accounts[userKey] || {};
  const isNew    = !existing.whatsappApiKey;

  accounts[userKey] = {
    ...existing,
    name,
    userKey,
    whatsappApiKey,
    faceImageBase64: faceImageBase64 ?? existing.faceImageBase64 ?? null,
    role: role || existing.role || "user",
    earnEnabled: existing.earnEnabled ?? true,
    registeredAt: existing.registeredAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActiveAt: existing.lastActiveAt || null,
    walletAddress: existing.walletAddress || null,
  };

  save(accounts);
  return { userKey, created: isNew };
}

/**
 * Get one account by name or userKey.
 */
function getAccount(nameOrKey) {
  const accounts = load();
  const key = toKey(nameOrKey);
  return accounts[key] || null;
}

/**
 * Get account by its WhatsApp API key (used by the poller to route messages).
 */
function getAccountByApiKey(apiKey) {
  const accounts = load();
  return Object.values(accounts).find(a => a.whatsappApiKey === apiKey) || null;
}

/**
 * Get ALL accounts as an array.
 */
function getAllAccounts() {
  return Object.values(load());
}

/**
 * Get owner account.
 */
function getOwnerAccount() {
  return getAllAccounts().find(a => a.role === "owner") || null;
}

/**
 * Update the wallet address for a user after ensureUserWallet runs.
 */
function setWalletAddress(nameOrKey, address) {
  const accounts = load();
  const key = toKey(nameOrKey);
  if (!accounts[key]) return false;
  accounts[key].walletAddress = address;
  accounts[key].updatedAt = new Date().toISOString();
  save(accounts);
  return true;
}

/**
 * Update face image for a user.
 */
function setFaceImage(nameOrKey, faceImageBase64) {
  const accounts = load();
  const key = toKey(nameOrKey);
  if (!accounts[key]) return false;
  accounts[key].faceImageBase64 = faceImageBase64;
  accounts[key].updatedAt = new Date().toISOString();
  save(accounts);
  return true;
}

/**
 * Touch lastActiveAt for a user.
 */
function touchActive(nameOrKey) {
  const accounts = load();
  const key = toKey(nameOrKey);
  if (!accounts[key]) return;
  accounts[key].lastActiveAt = new Date().toISOString();
  save(accounts);
}

/**
 * Remove a user account.
 */
function removeAccount(nameOrKey) {
  const accounts = load();
  const key = toKey(nameOrKey);
  if (!accounts[key]) return false;
  delete accounts[key];
  save(accounts);
  return true;
}

/**
 * Set earn enabled flag for a user.
 */
function setEarnEnabled(nameOrKey, enabled) {
  const accounts = load();
  const key = toKey(nameOrKey);
  if (!accounts[key]) return false;
  accounts[key].earnEnabled = !!enabled;
  accounts[key].updatedAt = new Date().toISOString();
  save(accounts);
  return true;
}

/**
 * Save last-sent weekly report timestamp for earn review.
 */
function setLastWeeklyReport(nameOrKey, isoTimestamp) {
  const accounts = load();
  const key = toKey(nameOrKey);
  if (!accounts[key]) return false;
  accounts[key].lastWeeklyReportAt = isoTimestamp;
  accounts[key].updatedAt = new Date().toISOString();
  save(accounts);
  return true;
}

module.exports = {
  registerAccount,
  getAccount,
  getAccountByApiKey,
  getAllAccounts,
  getOwnerAccount,
  setWalletAddress,
  setFaceImage,
  touchActive,
  removeAccount,
  setEarnEnabled,
  setLastWeeklyReport,
  toKey,
};
