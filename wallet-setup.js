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

const REPO_ROOT   = __dirname;
const SCRIPT_PATH = path.join(REPO_ROOT, "make_wallet.py");
const ENV_PATH    = path.join(REPO_ROOT, ".env");

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

module.exports = { generateWallet, hasExistingWallet };
