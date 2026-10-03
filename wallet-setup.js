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

// ── DURABLE ENCRYPTED KEY BACKUP (Supabase) ──────────────────────
// Every private key this module creates is also encrypted and saved to
// Supabase (see persistence.js putSecret) and restored at boot, so a
// Render redeploy can't destroy it. Needs SUPABASE_* plus
// WALLET_ENCRYPTION_SECRET. On Render we refuse to create a key we
// can't back up, because an un-backed-up key would vanish on redeploy
// along with any funds sent to it.
const Persistence = require("./persistence");
const ON_RENDER = !!process.env.RENDER;

function keysAreDurable() {
  return Persistence.encryptionReady();
}
function durabilityBlocker() {
  if (!ON_RENDER || keysAreDurable()) return null;
  return "Refusing to create a wallet: this server's disk is wiped on every redeploy and encrypted Supabase key backup isn't set up. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_BUCKET and WALLET_ENCRYPTION_SECRET in Render, then try again.";
}
async function backupKeyFile(name, filePath) {
  try {
    return await Persistence.putSecret(name, fs.readFileSync(filePath));
  } catch (e) {
    console.warn(`[KEY-BACKUP] ${name}: ${e.message}`);
    return false;
  }
}
async function backupAllKeys() {
  let n = 0;
  if (fs.existsSync(USER_KEYS_DIR)) {
    for (const f of fs.readdirSync(USER_KEYS_DIR)) {
      if (f.endsWith(".json") && await backupKeyFile(f, path.join(USER_KEYS_DIR, f))) n++;
    }
  }
  const root = path.join(REPO_ROOT, "wallet.json");
  if (fs.existsSync(root) && await backupKeyFile("_root-wallet.json", root)) n++;
  return n;
}
// Call once at boot, after Persistence.pullAll().
async function restoreKeys() {
  if (!keysAreDurable()) {
    if (ON_RENDER) console.warn("[KEY-BACKUP] WALLET_ENCRYPTION_SECRET not set — wallet keys are NOT backed up and will be lost on redeploy.");
    return;
  }
  const restored = await Persistence.restoreSecrets(USER_KEYS_DIR);
  const rootBackup = path.join(USER_KEYS_DIR, "_root-wallet.json");
  const root = path.join(REPO_ROOT, "wallet.json");
  if (fs.existsSync(rootBackup) && !fs.existsSync(root)) {
    fs.copyFileSync(rootBackup, root);
    try { fs.chmodSync(root, 0o600); } catch {}
  }
  // Upload anything that exists locally but isn't backed up yet (e.g. keys created before this feature).
  const pushed = await backupAllKeys();
  console.log(`[KEY-BACKUP] Restored ${restored} key file(s); ${pushed} encrypted backup(s) up to date in Supabase.`);
}

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

// Runs make_user_wallet.py and returns the parsed {address, secret}
// keypair. Shared by both the owner (regenerateOwnerWallet) and
// per-account (ensureUserWallet) paths below so there's one place
// that actually talks to the Python generator.
async function createWalletKeypair() {
  await ensureSolders();
  const stdout = await run(`python3 "${USER_SCRIPT_PATH}"`);
  const parsed = JSON.parse(stdout.trim());
  if (!parsed.address || !Array.isArray(parsed.secret)) {
    throw new Error("Wallet generator returned an unexpected shape.");
  }
  return parsed;
}

function writeKeyFile(key, secret) {
  if (!fs.existsSync(USER_KEYS_DIR)) fs.mkdirSync(USER_KEYS_DIR, { recursive: true });
  const keyPath = path.join(USER_KEYS_DIR, `${key}.json`);
  fs.writeFileSync(keyPath, JSON.stringify(secret), "utf8");
  try { fs.chmodSync(keyPath, 0o600); } catch { /* Windows: no-op */ }
  return keyPath;
}

// Generates a new keypair via make_wallet.py, which saves the private
// key to wallet.json (local, gitignored) and writes the public
// address into .env itself. Returns the address this process parsed
// out of the script's own stdout — never reads wallet.json.
async function generateWallet({ overwrite = false } = {}) {
  if (!fs.existsSync(SCRIPT_PATH)) {
    return { error: "make_wallet.py not found next to server.js." };
  }
  const blocked = durabilityBlocker();
  if (blocked) return { error: blocked };
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

  const backedUp = await backupKeyFile("_root-wallet.json", keyPath);
  if (ON_RENDER && !backedUp) {
    return { error: "Wallet was created but the encrypted Supabase backup failed, so it was NOT activated. Check your Supabase settings.", address };
  }
  return {
    address,
    keyFile: keyPath,
    backedUpToSupabase: backedUp,
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

  const blocked = durabilityBlocker();
  if (blocked) return { error: blocked };

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

  // Back up BEFORE linking: if the backup fails on Render, discard the key
  // so no one ever sends funds to an address we can't recover.
  const backedUp = await backupKeyFile(`${key}.json`, keyPath);
  if (ON_RENDER && !backedUp) {
    try { fs.unlinkSync(keyPath); } catch {}
    return { error: "Couldn't back up the new wallet key to Supabase, so it was discarded. Check your Supabase settings and try again." };
  }

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
    backedUpToSupabase: backedUp,
    warning: "Jarvis generated this account's private key, saved it in wallet-keys/ and (if configured) an AES-256-GCM encrypted copy in Supabase. Anyone with disk access to this server can spend from it — for real money, having the user link their own existing wallet instead is safer.",
  };
}

// ── REFRESH THE OWNER'S WALLET (one-time, explicit) ──────────────
// Generates a brand-new keypair for the owner and switches
// config.json/profiles.json over to it. The OLD wallet.json is never
// just overwritten and discarded — if it held any funds, that
// private key is the only way to ever move them, so it's renamed
// into wallet-keys/ as a timestamped backup first. Also drops the
// new secret into wallet-keys/<ownerKey>.json (chmod 600) so it's
// retrievable the same way as any other account's key — see
// getPrivateKey() below.
async function regenerateOwnerWallet(userKey) {
  const blocked = durabilityBlocker();
  if (blocked) return { error: blocked };
  const key = String(userKey || "owner").toLowerCase().trim();
  const oldKeyPath = path.join(REPO_ROOT, "wallet.json");
  let backupPath = null;
  if (fs.existsSync(oldKeyPath)) {
    backupPath = path.join(USER_KEYS_DIR, `owner-backup-${Date.now()}.json`);
    if (!fs.existsSync(USER_KEYS_DIR)) fs.mkdirSync(USER_KEYS_DIR, { recursive: true });
    fs.copyFileSync(oldKeyPath, backupPath);
    try { fs.chmodSync(backupPath, 0o600); } catch { /* Windows: no-op */ }
  }

  let kp;
  try {
    kp = await createWalletKeypair();
  } catch (e) {
    return { error: `Wallet generation failed: ${e.message}`, oldKeyBackedUpAt: backupPath };
  }

  // Overwrite the legacy root wallet.json too, so anything still
  // reading it (e.g. hasExistingWallet()) sees the new key.
  fs.writeFileSync(oldKeyPath, JSON.stringify(kp.secret), "utf8");
  try { fs.chmodSync(oldKeyPath, 0o600); } catch { /* Windows: no-op */ }
  const keyFile = writeKeyFile(key, kp.secret);
  await backupAllKeys(); // includes the old-wallet backup file and the new key

  const SolanaWallet = require("./solana-wallet");
  const link = SolanaWallet.setOwnerWallet(kp.address);
  if (link.error) {
    return { error: `Generated a wallet but couldn't link it to the account: ${link.error}`, address: kp.address, keyFile, oldKeyBackedUpAt: backupPath };
  }

  return {
    address: kp.address,
    keyFile,
    oldKeyBackedUpAt: backupPath,
    warning: backupPath
      ? `The old owner wallet's key is preserved at ${backupPath} in case it still holds funds — move anything out of it, then delete that file when you're done. This new key is now the active owner wallet everywhere in the app.`
      : "This new key is now the active owner wallet everywhere in the app.",
  };
}

// ── HAND A WALLET'S PRIVATE KEY BACK TO ITS OWNER ─────────────────
// Deliberately separate from solana-wallet.js (still read-only/
// address-only, used everywhere else in the app) — this is the one
// path that ever returns a secret key to a caller instead of just
// writing it to disk. Returns it base58-encoded, the format Phantom/
// Solflare/Backpack expect for "import private key", plus the raw
// byte array for tools that want that instead.
//
// SECURITY NOTE, read before wiring this up to anything: whoever can
// trigger this call for a given key gets full, irreversible spending
// control over that wallet — there is no way to revoke a key once
// it's been shown. Restrict which account can request which key at
// the call site (a non-owner asking for someone else's key should
// never reach this function) and treat every place this value
// travels through (logs, chat history, screen) as sensitive.
function getPrivateKey(userKey) {
  const SolanaWallet = require("./solana-wallet");
  const key = String(userKey || "owner").toLowerCase().trim();
  if (!key) return { error: "Missing userName." };

  let secret = null;
  const perAccountPath = path.join(USER_KEYS_DIR, `${key}.json`);
  if (fs.existsSync(perAccountPath)) {
    secret = JSON.parse(fs.readFileSync(perAccountPath, "utf8"));
  } else if (SolanaWallet.isOwner(key) && fs.existsSync(path.join(REPO_ROOT, "wallet.json"))) {
    // Legacy path: an owner wallet made by generateWallet() before
    // this function existed only ever lived in root wallet.json.
    secret = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "wallet.json"), "utf8"));
  }

  if (!Array.isArray(secret)) {
    return { error: `Jarvis doesn't hold a private key for "${key}" — either no wallet's been generated for this account, or they linked their own existing wallet instead (in which case only they have that key, by design).` };
  }

  return {
    userKey: key,
    address: SolanaWallet.getAddress(key),
    secretBase58: SolanaWallet.base58Encode(Uint8Array.from(secret)),
    secretArray: secret,
    warning: "This is a full private key — anyone who has it can spend everything in this wallet, permanently and irreversibly. Never paste it anywhere but a wallet app's own 'import private key' field.",
  };
}

module.exports = { restoreKeys, backupAllKeys, generateWallet, hasExistingWallet, ensureUserWallet, regenerateOwnerWallet, getPrivateKey };
