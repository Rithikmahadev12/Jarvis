"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Wallet Ops (send SOL, with hard limits)
//
// The ONLY code that signs a transaction.
//   - Owner-only (other accounts can't move the owner's funds).
//   - Any destination, any amount, by default. No allowlist, no caps.
//   - You can tell Jarvis in chat to change any of this ("set a cap of
//     1 SOL", "stop asking me before you send", "only send to wallets
//     I've added") and it just does it — no extra card.
//   - By default each transfer still shows one Allow / Deny tap, because
//     Jarvis reads web pages and a tricked model could otherwise send
//     funds without you seeing it. Say "send without asking" to turn
//     that off; "ask me before sending" turns it back on.
//   - The key never leaves this file: read, sign, dropped.
//
// No @solana/web3.js needed: builds the System Program transfer by
// hand and signs with Node's built-in ed25519.
// ═══════════════════════════════════════════════════════════════
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const Approvals    = require("./approvals");
const SolanaWallet = require("./solana-wallet");

const DATA_DIR     = path.join(__dirname, "data");
const POLICY_PATH  = path.join(DATA_DIR, "wallet-policy.json");
const HISTORY_PATH = path.join(DATA_DIR, "wallet-transfers.json");
const RPC_URL      = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const LAMPORTS     = 1_000_000_000;
const FEE_LAMPORTS = 5000;

// 0 = no limit.
const DEFAULT_POLICY = { enabled: true, requireApproval: true, perTransferSol: 0, dailySol: 0, restrictToAllowlist: false, allowlist: [] };

// ── small helpers ───────────────────────────────────────────────
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function writeJson(p, v) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}
function getPolicy() { return { ...DEFAULT_POLICY, ...readJson(POLICY_PATH, {}) }; }
function getHistory() { return readJson(HISTORY_PATH, []); }

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58decode(str) {
  let n = 0n;
  for (const ch of String(str)) {
    const i = B58.indexOf(ch);
    if (i < 0) throw new Error("Invalid base58 character");
    n = n * 58n + BigInt(i);
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n & 0xffn)); n >>= 8n; }
  for (const ch of String(str)) { if (ch === "1") bytes.unshift(0); else break; }
  return Buffer.from(bytes);
}
function isValidAddress(a) {
  try { return b58decode(a).length === 32; } catch { return false; }
}

async function rpc(method, params = []) {
  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message || "RPC error");
  return j.result;
}

// ── transaction building (legacy format, one System transfer) ───
function buildMessage(fromPk, toPk, lamports, blockhash) {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0);                    // SystemInstruction::Transfer
  data.writeBigUInt64LE(BigInt(lamports), 4);
  return Buffer.concat([
    Buffer.from([1, 0, 1]),                    // header: 1 signer, 0 ro-signed, 1 ro-unsigned
    Buffer.from([3]), fromPk, toPk, Buffer.alloc(32), // accounts (System Program = 32 zero bytes)
    blockhash,
    Buffer.from([1]),                          // 1 instruction
    Buffer.from([2, 2, 0, 1, 12]), data,       // program idx 2, accts [0,1], data len 12
  ]);
}
function signerFromSecret(secretArray) {
  const secret = Buffer.from(secretArray);
  if (secret.length !== 64) throw new Error("Unexpected key format");
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), secret.subarray(0, 32)]);
  const key = crypto.createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  return { key, publicKey: secret.subarray(32, 64) };
}
function buildSignedTx(secretArray, toAddress, lamports, blockhash) {
  const { key, publicKey } = signerFromSecret(secretArray);
  const message = buildMessage(publicKey, b58decode(toAddress), lamports, blockhash);
  const signature = crypto.sign(null, message, key);
  return Buffer.concat([Buffer.from([1]), signature, message]);
}

function ownerKey() {
  try {
    const profiles = readJson(path.join(DATA_DIR, "profiles.json"), {});
    for (const [k, p] of Object.entries(profiles)) if (p?.role === "owner") return k;
  } catch {}
  return "owner";
}

// ── policy management (just talk to Jarvis — no cards) ──────────
async function addDestination(address, label = "") {
  if (!isValidAddress(address)) return { error: "That isn't a valid Solana address." };
  const pol = getPolicy();
  if (!pol.allowlist.some(a => a.address === address)) {
    pol.allowlist.push({ address, label, addedAt: new Date().toISOString() });
    writeJson(POLICY_PATH, pol);
  }
  return { ok: true, note: `Saved ${label || address} as a known destination.${pol.restrictToAllowlist ? "" : " (Sending to any address is allowed anyway.)"}` };
}
async function removeDestination(address) {
  const pol = getPolicy();
  pol.allowlist = pol.allowlist.filter(a => a.address !== address);
  writeJson(POLICY_PATH, pol);
  return { ok: true };
}
async function setLimits({ perTransferSol, dailySol, enabled, requireApproval, restrictToAllowlist } = {}) {
  const next = { ...getPolicy() };
  if (Number.isFinite(perTransferSol) && perTransferSol >= 0) next.perTransferSol = perTransferSol;
  if (Number.isFinite(dailySol) && dailySol >= 0) next.dailySol = dailySol;
  if (typeof enabled === "boolean") next.enabled = enabled;
  if (typeof requireApproval === "boolean") next.requireApproval = requireApproval;
  if (typeof restrictToAllowlist === "boolean") next.restrictToAllowlist = restrictToAllowlist;
  writeJson(POLICY_PATH, next);
  return { ok: true, policy: next };
}

function sentLast24h() {
  const since = Date.now() - 24 * 3600 * 1000;
  return getHistory()
    .filter(h => h.status !== "failed" && new Date(h.at).getTime() >= since)
    .reduce((s, h) => s + (Number(h.sol) || 0), 0);
}

// ── the transfer ────────────────────────────────────────────────
async function send({ toAddress, amountSol, reason = "", isOwnerRequester = false } = {}) {
  if (!isOwnerRequester) return { error: "Only the owner account can move funds." };
  const pol = getPolicy();
  if (!pol.enabled) return { error: "Transfers are switched off in the wallet policy." };

  const amount = Number(amountSol);
  if (!(amount > 0)) return { error: "Amount must be a positive number of SOL." };
  if (!isValidAddress(toAddress)) return { error: "That destination isn't a valid Solana address." };
  if (pol.perTransferSol > 0 && amount > pol.perTransferSol) return { error: `That's above the per-transfer cap of ${pol.perTransferSol} SOL (you can tell me to change or remove it).` };
  const used = sentLast24h();
  if (pol.dailySol > 0 && used + amount > pol.dailySol) return { error: `That would pass the 24h cap (${used.toFixed(4)} of ${pol.dailySol} SOL already used). You can tell me to change or remove it.` };
  if (pol.restrictToAllowlist && !pol.allowlist.some(a => a.address === toAddress)) {
    return { error: "I'm set to only send to saved destinations, and that one isn't saved. Tell me to save it, or to allow any address." };
  }

  const owner = ownerKey();
  const fromAddress = SolanaWallet.getAddress(owner);
  const lamports = Math.round(amount * LAMPORTS);

  let balance;
  try { balance = await rpc("getBalance", [fromAddress]); balance = balance.value; }
  catch (e) { return { error: `Couldn't read the balance: ${e.message}` }; }
  if (balance < lamports + FEE_LAMPORTS) {
    return { error: `Not enough SOL: balance is ${(balance / LAMPORTS).toFixed(6)} SOL.` };
  }

  const label = pol.allowlist.find(a => a.address === toAddress)?.label;
  const detailText = [
    `To: ${toAddress}${label ? ` (${label})` : ""}`,
    `From: ${fromAddress}`,
    reason ? `Why: ${reason}` : "",
    `Balance after: ~${((balance - lamports - FEE_LAMPORTS) / LAMPORTS).toFixed(6)} SOL (network fee ~0.000005)`,
  ].filter(Boolean).join("\n");
  if (pol.requireApproval) {
    const decision = await Approvals.request({
      kind: "transfer", risk: "high",
      title: `Send ${amount} SOL`,
      detail: detailText,
      // no ruleKey: use "send without asking" to turn the card off instead
    });
    if (decision === "deny") return { error: "Denied — nothing was sent." };
  } else {
    Approvals.step(`Sending ${amount} SOL`, detailText, "running");
  }

  const rec = { at: new Date().toISOString(), to: toAddress, sol: amount, reason, status: "pending" };
  try {
    const { getKey } = lazyKey();
    const secret = getKey(owner);
    if (!secret) throw new Error("Jarvis doesn't hold a key for the owner wallet.");
    const { publicKey } = signerFromSecret(secret);
    if (require("./solana-wallet").base58Encode(Uint8Array.from(publicKey)) !== fromAddress) {
      throw new Error("Stored key doesn't match the wallet address — refusing to sign.");
    }
    const bh = await rpc("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const tx = buildSignedTx(secret, toAddress, lamports, b58decode(bh.value.blockhash));
    const signature = await rpc("sendTransaction", [tx.toString("base64"), { encoding: "base64", preflightCommitment: "confirmed" }]);
    rec.signature = signature;
    let confirmed = false;
    for (let i = 0; i < 20 && !confirmed; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const st = (await rpc("getSignatureStatuses", [[signature]])).value[0];
      if (st?.err) throw new Error("Transaction failed on-chain.");
      if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) confirmed = true;
    }
    rec.status = confirmed ? "confirmed" : "sent";
    pushHistory(rec);
    Approvals.step(`Sent ${amount} SOL`, `${toAddress}\n${signature}`, "done");
    return { ok: true, signature, status: rec.status, explorer: `https://solscan.io/tx/${signature}` };
  } catch (e) {
    rec.status = "failed"; rec.error = e.message;
    pushHistory(rec);
    Approvals.step("Transfer failed", e.message, "error");
    return { error: `Transfer failed: ${e.message}` };
  }
}
function pushHistory(rec) {
  const h = getHistory(); h.push(rec); writeJson(HISTORY_PATH, h.slice(-200));
}
// Required lazily so a missing wallet-setup never breaks boot.
function lazyKey() {
  return { getKey: (userKey) => { const r = require("./wallet-setup").getPrivateKey(userKey); return r && r.secretArray; } };
}

function status() {
  const pol = getPolicy();
  return { policy: pol, sentLast24hSol: sentLast24h(), history: getHistory().slice(-10).reverse() };
}

module.exports = { send, addDestination, removeDestination, setLimits, status, getPolicy, isValidAddress, _test: { buildSignedTx, b58decode, signerFromSecret } };
