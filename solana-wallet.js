"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Solana Wallet (read-only)
//
// Lets Jarvis watch a Solana wallet's balance and incoming payments,
// and generate Solana Pay payment-request links to hand out (e.g. in
// a bounty offer comment — see github-bounty.js). Deliberately never
// handles a private key: only the PUBLIC address goes in .env, so
// Jarvis can check balances and watch for incoming transfers but can
// never move funds out of the wallet. Sending/spending stays a
// manual, human action in an actual wallet app — that's a feature,
// not a missing piece: an autonomous agent with signing authority
// over real money is a very different (and much riskier) thing than
// one that can check a balance and hand out a payment link.
//
// Talks directly to a Solana JSON-RPC endpoint (no @solana/web3.js
// dependency needed for read-only calls like these).
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

// The wallet's PUBLIC address is not a secret, so instead of relying
// on it being copy-pasted into every environment's .env by hand, it
// lives in data/wallet-config.json — the same folder persistence.js
// already mirrors to Supabase every ~20s. That means the moment
// wallet-setup.js/make_wallet.py writes it here, it propagates
// automatically: the local server picks it up on its very next call
// (read live, not cached at startup), and the scheduled GitHub
// Actions job picks it up on its next Persistence.pullAll() — no
// manual .env edit and no GitHub secret needed for the address
// itself. SOLANA_WALLET_ADDRESS in .env still works as a manual
// override/fallback if you'd rather set it that way.
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
// USDC mint on Solana mainnet — public, well-known constant.
const USDC_MINT = process.env.SOLANA_USDC_MINT || "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const DATA_DIR     = path.join(__dirname, "data");
const LEDGER_PATH  = path.join(DATA_DIR, "wallet-ledger.json");
const CONFIG_PATH  = path.join(DATA_DIR, "wallet-config.json");

function getAddress() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8") || "{}");
      if (cfg.address) return cfg.address;
    }
  } catch { /* fall through to env */ }
  return process.env.SOLANA_WALLET_ADDRESS || "";
}

function isConfigured() {
  return !!getAddress();
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

async function getSolBalance() {
  const address = getAddress();
  if (!address) return { error: "No wallet address set (data/wallet-config.json empty and SOLANA_WALLET_ADDRESS unset)." };
  const lamports = await rpc("getBalance", [address]);
  const value = typeof lamports === "object" ? lamports.value : lamports;
  return { sol: value / 1e9, lamports: value };
}

async function getUsdcBalance() {
  const address = getAddress();
  if (!address) return { error: "No wallet address set (data/wallet-config.json empty and SOLANA_WALLET_ADDRESS unset)." };
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

async function getBalances() {
  const [sol, usdc] = await Promise.all([getSolBalance(), getUsdcBalance()]);
  return { address: getAddress() || null, sol, usdc };
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

function buildPaymentLink({ amount, token = "usdc", label = "Jarvis", message = "", reference } = {}) {
  const address = getAddress();
  if (!address) return { error: "No wallet address set (data/wallet-config.json empty and SOLANA_WALLET_ADDRESS unset)." };
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
async function checkIncomingPayments({ limit = 20 } = {}) {
  const address = getAddress();
  if (!address) return { error: "No wallet address set (data/wallet-config.json empty and SOLANA_WALLET_ADDRESS unset)." };
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
