"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Solana Wallet (read-only, per-account)
//
// Lets Jarvis watch a Solana wallet's balance and incoming payments,
// and generate Solana Pay payment-request links to hand out (e.g. in
// a bounty offer comment — see github-bounty.js). Deliberately never
// handles a private key: only the PUBLIC address goes in .env/
// config.json/a profile, so Jarvis can check balances and watch for
// incoming transfers but can never move funds out of any wallet.
// Sending/spending stays a manual, human action in an actual wallet
// app — that's a feature, not a missing piece: an autonomous agent
// with signing authority over real money is a very different (and
// much riskier) thing than one that can check a balance and hand out
// a payment link.
//
// PER-ACCOUNT WALLETS: every enrolled Face-ID account (see
// server.js's PROFILE ROUTES / profiles.json) can have its own
// wallet.address, stored on that account's profile — same shape as
// the per-user googleTokens Gmail/Calendar already use. The owner's
// wallet is the one exception: it lives in config.json under
// owner.wallet.address instead of profiles.json, since the owner
// account itself is bootstrapped FROM config.json (see server.js's
// bootstrapOwnerAccount()). Every function below takes an optional
// userKey (the same lowercased-name key used everywhere else in this
// codebase — req.body.userName.toLowerCase().trim()):
//   - a specific userKey whose account has its own wallet -> that
//     wallet is used
//   - a specific userKey with no wallet of their own -> resolves to
//     nothing (never silently falls back to someone else's wallet),
//     UNLESS that account is the owner, in which case it falls
//     through to the owner-wallet/legacy chain below
//   - no userKey at all (existing global callers — the scheduled
//     GitHub Actions jobs, bounty scanning, etc.) -> the owner's
//     wallet is the default, exactly like before per-account wallets
//     existed
//
// Talks directly to a Solana JSON-RPC endpoint (no @solana/web3.js
// dependency needed for read-only calls like these).
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
// USDC mint on Solana mainnet — public, well-known constant.
const USDC_MINT = process.env.SOLANA_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const DATA_DIR          = path.join(__dirname, "data");
const LEDGER_PATH       = path.join(DATA_DIR, "wallet-ledger.json");
// Legacy single-wallet config, kept only as a fallback for setups
// from before per-account wallets existed — see legacyFallbackAddress().
const LEGACY_CONFIG_PATH = path.join(DATA_DIR, "wallet-config.json");
const PROFILES_PATH      = path.join(DATA_DIR, "profiles.json");
const OWNER_CONFIG_PATH  = path.join(__dirname, "config.json");

function loadProfiles() {
  try { return JSON.parse(fs.readFileSync(PROFILES_PATH, "utf8") || "{}"); }
  catch { return {}; }
}
function saveProfiles(profiles) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PROFILES_PATH, JSON.stringify(profiles, null, 2), "utf8");
}

function loadOwnerConfig() {
  try { return JSON.parse(fs.readFileSync(OWNER_CONFIG_PATH, "utf8") || "{}"); }
  catch { return {}; }
}
function saveOwnerConfig(cfg) {
  fs.writeFileSync(OWNER_CONFIG_PATH, JSON.stringify(cfg, null, 2), "utf8");
}

function ownerWalletAddress() {
  return loadOwnerConfig()?.owner?.wallet?.address || "";
}

// data/wallet-config.json, then SOLANA_WALLET_ADDRESS env — only
// reached if the owner has no wallet.address in config.json yet
// (e.g. a setup that predates per-account wallets and hasn't been
// migrated with setOwnerWallet() below).
function legacyFallbackAddress() {
  try {
    if (fs.existsSync(LEGACY_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(LEGACY_CONFIG_PATH, "utf8") || "{}");
      if (cfg.address) return cfg.address;
    }
  } catch { /* fall through to env */ }
  return process.env.SOLANA_WALLET_ADDRESS || "";
}

function normalizeKey(userKey) {
  return (userKey || "").toLowerCase().trim();
}

function isOwnerKey(key, profiles) {
  if (!key) return false;
  return profiles[key]?.role === "owner";
}

// The core resolver — see the header comment above for the full
// fallback chain this implements.
function getAddress(userKey) {
  const key = normalizeKey(userKey);
  const profiles = loadProfiles();

  if (key && profiles[key]?.wallet?.address) {
    return profiles[key].wallet.address;
  }
  if (key && !isOwnerKey(key, profiles)) {
    // A specific non-owner account was asked for but hasn't linked a
    // wallet of their own yet — never silently hand back someone
    // else's address.
    return "";
  }
  // No userKey given, or it's the owner without a wallet backfilled
  // onto their profile yet: the owner's wallet (config.json) is the
  // default, same as the single global wallet used to be.
  return ownerWalletAddress() || legacyFallbackAddress();
}

function isConfigured(userKey) {
  return !!getAddress(userKey);
}

// Links a wallet address to a specific enrolled account (profiles.json).
// Use for anyone EXCEPT the owner — the owner's wallet lives in
// config.json instead (see setOwnerWallet()).
function setWalletForUser(userKey, address) {
  const key = normalizeKey(userKey);
  if (!key) return { error: "Missing userName." };
  if (!address || typeof address !== "string") return { error: "Missing wallet address." };
  const profiles = loadProfiles();
  if (!profiles[key]) return { error: `No account found for "${userKey}".` };
  profiles[key].wallet = { ...(profiles[key].wallet || {}), address: address.trim(), linkedAt: new Date().toISOString() };
  profiles[key].updatedAt = new Date().toISOString();
  saveProfiles(profiles);
  return { success: true, userKey: key, address: address.trim() };
}

// Sets/updates the owner's wallet in config.json directly (not
// profiles.json — the owner account is bootstrapped FROM this file,
// see server.js's bootstrapOwnerAccount()).
function setOwnerWallet(address) {
  if (!address || typeof address !== "string") return { error: "Missing wallet address." };
  const cfg = loadOwnerConfig();
  if (!cfg.owner) return { error: "config.json has no owner section yet." };
  cfg.owner.wallet = { ...(cfg.owner.wallet || {}), address: address.trim(), linkedAt: new Date().toISOString() };
  saveOwnerConfig(cfg);

  // Backfill the already-bootstrapped owner profile too, if it
  // exists, so profile reads (GET /api/profile/:name) reflect it
  // immediately without waiting for a restart.
  const profiles = loadProfiles();
  const ownerKey = Object.keys(profiles).find((k) => profiles[k]?.role === "owner");
  if (ownerKey) {
    profiles[ownerKey].wallet = { ...(profiles[ownerKey].wallet || {}), address: address.trim(), linkedAt: new Date().toISOString() };
    profiles[ownerKey].updatedAt = new Date().toISOString();
    saveProfiles(profiles);
  }

  return { success: true, address: address.trim() };
}

function loadLedger() {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return { entries: [], lastCheckedSignature: null };
    return { entries: [], lastCheckedSignature: null, ...JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8") || "{}") };
  } catch {
    return { entries: [], lastCheckedSignature: null };
  }
}
function saveLedger(ledger) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

// ── RPC HELPER ──────────────────────────────────────────────────
let rpcId = 1;
async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || `RPC error calling ${method}`);
  return data.result;
}

async function getSolBalance(userKey) {
  const address = getAddress(userKey);
  if (!address) return { error: "No wallet address set for this account." };
  const lamports = await rpc("getBalance", [address]);
  const value = typeof lamports === "object" ? lamports.value : lamports;
  return { sol: value / 1e9, lamports: value };
}

async function getUsdcBalance(userKey) {
  const address = getAddress(userKey);
  if (!address) return { error: "No wallet address set for this account." };
  const result = await rpc("getTokenAccountsByOwner", [
    address,
    { mint: USDC_MINT },
    { encoding: "jsonParsed" },
  ]);
  const accounts = result?.value || [];
  const total = accounts.reduce((sum, acc) => {
    const amt = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
    return sum + amt;
  }, 0);
  return { usdc: total, accountCount: accounts.length };
}

async function getBalances(userKey) {
  const [sol, usdc] = await Promise.all([getSolBalance(userKey), getUsdcBalance(userKey)]);
  return { address: getAddress(userKey) || null, sol, usdc };
}

// ── PAYMENT REQUEST LINKS (Solana Pay URI scheme) ────────────────
// A "reference" is how Solana Pay lets you tell orders apart without
// any third-party processor: it's just 32 random bytes, base58-
// encoded like a Solana address. Wallets that support the spec (all
// major ones — Phantom, Solflare, Backpack, etc.) automatically
// include it as an extra tagged account in the transfer transaction.
// findTransactionByReference() below then searches the chain for
// exactly that tag, whether or not it holds any funds itself.
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58Encode(bytes) {
  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) { digits.push(carry % 58); carry = Math.floor(carry / 58); }
  }
  for (const byte of bytes) { if (byte === 0) digits.push(0); else break; }
  return digits.reverse().map(d => BASE58_ALPHABET[d]).join("");
}
function generateReference() {
  const crypto = require("crypto");
  return base58Encode(crypto.randomBytes(32));
}

function buildPaymentLink({ amount, token = "usdc", label = "Jarvis", message = "", reference, userKey } = {}) {
  const address = getAddress(userKey);
  if (!address) return { error: "No wallet address set for this account." };
  const params = new URLSearchParams();
  if (amount != null) params.set("amount", String(amount));
  if (token === "usdc") params.set("spl-token", USDC_MINT);
  if (label) params.set("label", label);
  if (message) params.set("message", message);
  if (reference) params.set("reference", reference);
  return { uri: `solana:${address}?${params.toString()}`, reference: reference || null };
}

// ── FIND A PAYMENT BY ITS REFERENCE TAG ──────────────────────────
// Searches the chain for a transaction that included this reference
// account — i.e. "has THIS specific order been paid yet?" Read-only,
// same as everything else in this file.
async function findTransactionByReference(reference) {
  if (!reference) return { error: "Missing reference." };
  const sigs = await rpc("getSignaturesForAddress", [reference, { limit: 5 }]);
  const confirmed = (sigs || []).find(s => !s.err);
  if (!confirmed) return { found: false };
  return {
    found: true,
    signature: confirmed.signature,
    blockTime: confirmed.blockTime ? new Date(confirmed.blockTime * 1000).toISOString() : null,
    explorerUrl: `https://explorer.solana.com/tx/${confirmed.signature}`,
  };
}

// ── INCOMING PAYMENT WATCHER ──────────────────────────────────────
// Polls recent transaction signatures for the wallet and records any
// new ones as ledger entries. Purely observational — reads the chain,
// never signs or sends anything.
async function checkIncomingPayments({ limit = 20, userKey } = {}) {
  const address = getAddress(userKey);
  if (!address) return { error: "No wallet address set for this account." };
  const ledger = loadLedger();
  const sigs = await rpc("getSignaturesForAddress", [address, { limit }]);
  const newSigs = [];
  for (const s of sigs) {
    if (s.signature === ledger.lastCheckedSignature) break;
    newSigs.push(s);
  }
  if (newSigs.length === 0) return { newEntries: [] };

  const newEntries = [];
  for (const s of newSigs.reverse()) {
    if (s.err) continue;
    newEntries.push({
      signature: s.signature,
      blockTime: s.blockTime ? new Date(s.blockTime * 1000).toISOString() : null,
      note: "Detected on-chain — check the explorer link to see amount/sender.",
      explorerUrl: `https://explorer.solana.com/tx/${s.signature}`,
      recordedAt: new Date().toISOString(),
    });
  }
  ledger.entries.push(...newEntries);
  ledger.lastCheckedSignature = sigs[0]?.signature || ledger.lastCheckedSignature;
  saveLedger(ledger);
  return { newEntries };
}

// ── MANUAL EARNINGS LEDGER ────────────────────────────────────────
// For recording earnings from sources that don't land as an on-chain
// transfer to this address (PayPal, a platform payout, etc.) so
// there's one place that tracks what Jarvis has actually earned.
function recordEarning({ source, amountUsd, note = "" } = {}) {
  if (!source || !(amountUsd > 0)) return { error: "source and a positive amountUsd are required." };
  const ledger = loadLedger();
  const entry = { type: "manual", source, amountUsd: Number(amountUsd), note, recordedAt: new Date().toISOString() };
  ledger.entries.push(entry);
  saveLedger(ledger);
  return entry;
}

function listEarnings() {
  return loadLedger().entries.slice().reverse();
}

function totalEarningsUsd() {
  return loadLedger().entries.reduce((sum, e) => sum + (Number(e.amountUsd) || 0), 0);
}

module.exports = {
  isConfigured,
  getAddress,
  setWalletForUser,
  setOwnerWallet,
  getSolBalance,
  getUsdcBalance,
  getBalances,
  buildPaymentLink,
  generateReference,
  findTransactionByReference,
  checkIncomingPayments,
  recordEarning,
  listEarnings,
  totalEarningsUsd,
};
