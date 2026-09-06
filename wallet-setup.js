"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Wallet Setup
//
// Lets Jarvis generate its own Solana wallet by running make_wallet.py
// on the machine it's actually running on. Deliberately kept separate
// from solana-wallet.js (which is the read-only, private-key-free
// module everything else in the app uses) — this is the ONE place in
// the codebase that ever touches a private key, and it only touches
// it long enough to hand off to the Python script, which writes it
// straight to a local, gitignored file and never returns it to this
// process. generateWallet() below never reads wallet.json — it only
// captures the PUBLIC address printed to stdout and writes that into
// .env.
//
// This only ever runs locally, on demand, when you explicitly ask for
// it — it is never called from a scheduled/cloud job (see
// scripts/scheduled-bounty-scan.js, which only ever reads the public
// address, never generates one).
// ═══════════════════════════════════════════════════════════════

const { exec } = require("child_process");
const fs   = require("fs");
const path = require("path");
const SolanaWallet = require("./solana-wallet");

const REPO_ROOT   = __dirname;
const SCRIPT_PATH = path.join(REPO_ROOT, "make_wallet.py");
const USER_SCRIPT_PATH = path.join(REPO_ROOT, "make_user_wallet.py");
const ENV_PATH    = path.join(REPO_ROOT, ".env");
// Deliberately its OWN directory, separate from data/ — persistence.js
// syncs the whole data/ folder to Supabase, and a private key has no
// business leaving this machine, ever, for any reason. Gitignored too
// (see .gitignore). If this key file leaves this disk by any path,
// treat every fund in that wallet as gone.
const USER_KEYS_DIR = path.join(REPO_ROOT, "wallet-keys");

function run(cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    exec(cmd, { cwd: REPO_ROOT, timeout: 30000, ...opts }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.trim() || err.message));
      resolve(stdout);
    });
  });
}

async function ensureSolders() {
  try {
    await run(`python3 -c "import solders"`);
  } catch {
    await run(`pip install solders --break-system-packages`);
  }
}

// Generates a new keypair via make_wallet.py, which saves the private
// key to wallet.json (local, gitignored) and writes the public
// address into .env itself. Returns the address this process parsed
// out of the script's own stdout — never reads wallet.json.
async function generateWallet({ overwrite = false } = {}) {
  if (!fs.existsSync(SCRIPT_PATH)) {
    return { error: "make_wallet.py not found next to server.js." };
  }
  const keyPath = path.join(REPO_ROOT, "wallet.json");
  if (fs.existsSync(keyPath) && !overwrite) {
    return { error: "wallet.json already exists. A wallet's already been generated — pass overwrite to replace it (this abandons the old address's funds unless you've backed up wallet.json)." };
  }

  try {
    await ensureSolders();
  } catch (e) {
    return { error: `Couldn't install the "solders" Python package: ${e.message}` };
  }

  let stdout;
  try {
    stdout = await run(`python3 make_wallet.py`);
  } catch (e) {
    return { error: `Wallet generation failed: ${e.message}` };
  }

  const match = stdout.match(/ADDRESS \(safe to share\):\s*(\S+)/);
  const address = match ? match[1] : null;
  if (!address) {
    return { error: "Script ran but I couldn't parse an address out of its output.", raw: stdout };
  }

  return {
    address,
    keyFile: keyPath,
    envUpdated: fs.existsSync(ENV_PATH) && fs.readFileSync(ENV_PATH, "utf8").includes(address),
    warning: "Private key saved locally to wallet.json — back it up somewhere safe (a password manager, not another cloud sync) and never commit or share that file.",
  };
}

function hasExistingWallet() {
  return fs.existsSync(path.join(REPO_ROOT, "wallet.json"));
}

// ── AUTO-PROVISIONING (per enrolled account) ─────────────────────
// Unlike generateWallet() above — which is the ONE deliberately
// manual, local-only, "you have to run this yourself" step for the
// owner's own wallet — this is meant to be called automatically by
// app code (e.g. github-bounty.js's approveCandidate()) whenever an
// account needs a payment link but hasn't linked a wallet yet.
//
// IMPORTANT TRADE-OFF, read before relying on this in production:
// generateWallet() exists as a separate, manual step specifically so
// a private key only ever gets created on a machine a human chose,
// on purpose, in the moment. Calling this function automatically
// means Jarvis creates AND holds a private key on whatever machine
// this code happens to run on — which, per render.yaml/STORE_BASE_URL,
// may be a cloud box (Render), not your own PC. That's a materially
// different trust model: it turns Jarvis into a small custodial
// wallet provider for its users, on a server, unattended. Mitigations
// in place here:
//   - Keys are written to wallet-keys/, NOT data/ — persistence.js
//     only syncs data/ to Supabase, so keys are never uploaded there.
//   - wallet-keys/ is gitignored, so `git push` never sends them out.
//   - Each key file is chmod 600 where the OS supports it.
// None of that changes the fact that anyone who gets shell/disk
// access to wherever this runs can drain every auto-created wallet.
// For anything beyond small/test amounts, the safer pattern is
// having each user paste in their OWN existing wallet address
// (SolanaWallet.setWalletForUser) instead of Jarvis custodying a key
// on their behalf.
async function ensureUserWallet(userKey) {
  const key = String(userKey || "").toLowerCase().trim();
  if (!key) return { error: "Missing userName." };

  // Already has one — never overwrite silently.
  if (SolanaWallet.isConfigured(key)) {
    return { address: SolanaWallet.getAddress(key), created: false };
  }

  try {
    await ensureSolders();
  } catch (e) {
    return { error: `Couldn't install the "solders" Python package: ${e.message}` };
  }

  let stdout;
  try {
    stdout = await run(`python3 "${USER_SCRIPT_PATH}"`);
  } catch (e) {
    return { error: `Wallet generation failed: ${e.message}` };
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    return { error: "Couldn't parse the wallet generator's output.", raw: stdout };
  }
  const { address, secret } = parsed;
  if (!address || !Array.isArray(secret)) {
    return { error: "Wallet generator returned an unexpected shape.", raw: stdout };
  }

  if (!fs.existsSync(USER_KEYS_DIR)) fs.mkdirSync(USER_KEYS_DIR, { recursive: true });
  const keyPath = path.join(USER_KEYS_DIR, `${key}.json`);
  fs.writeFileSync(keyPath, JSON.stringify(secret), "utf8");
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows: no-op */ }

  const link = SolanaWallet.isOwner(key)
    ? SolanaWallet.setOwnerWallet(address)
    : SolanaWallet.setWalletForUser(key, address);

  if (link.error) {
    return { error: `Generated a wallet but couldn't link it to the account: ${link.error}`, address, keyFile: keyPath };
  }

  return {
    address,
    created: true,
    keyFile: keyPath,
    warning: "Jarvis generated and now holds this account's private key in wallet-keys/ (gitignored, never synced to Supabase, chmod 600). Anyone with disk access to this server can spend from it — for real money, having the user link their own existing wallet instead is safer.",
  };
}

module.exports = { generateWallet, hasExistingWallet, ensureUserWallet };
