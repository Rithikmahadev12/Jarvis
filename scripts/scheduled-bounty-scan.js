"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Scheduled Bounty Scan (runs inside GitHub Actions)
//
// Runs on GitHub's own servers on a schedule (see
// .github/workflows/bounty-hunt.yml), so it works whether your PC is
// on, off, or asleep. Twice a day it:
//
//   1. Pulls data/ down from Supabase (same mechanism persistence.js
//      uses on every normal boot) so it sees whatever the app already
//      knows about (which issues it's seen before, the existing
//      queue, the wallet ledger).
//   2. Runs github-bounty.js's scanForBounties() — searches, has Groq
//      triage each issue, drafts offer comments for the feasible
//      ones. This step ONLY WRITES TO THE QUEUE. It never posts a
//      GitHub comment — approveCandidate() is the only thing that
//      does that, and nothing here calls it. You still approve or
//      reject each candidate yourself, from the app, whenever you
//      next open it.
//   3. Runs solana-wallet.js's checkIncomingPayments() — read-only,
//      just watches the public address for new transactions. No
//      private key exists anywhere in this process or this repo.
//   4. Pushes the updated data/ back up to Supabase so the app picks
//      up the new queue/ledger next time it (or you) opens it.
//
// Requires the same SUPABASE_* secrets as night-shift-research.js,
// plus GROQ_API_KEY and GITHUB_BOUNTY_TOKEN. Add these under repo
// Settings -> Secrets and variables -> Actions. The wallet address
// itself does NOT need a secret — it lives in data/wallet-config.json,
// which Persistence.pullAll() below pulls down automatically.
// ═══════════════════════════════════════════════════════════════

const path = require("path");
const REPO_ROOT = path.join(__dirname, "..");

const Persistence   = require(path.join(REPO_ROOT, "persistence.js"));
const GithubBounty   = require(path.join(REPO_ROOT, "github-bounty.js"));
const SolanaWallet    = require(path.join(REPO_ROOT, "solana-wallet.js"));

async function main() {
  if (!Persistence.isConfigured()) {
    console.error("[BOUNTY-SCAN] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET not set — " +
      "without these there's nowhere to persist the queue between runs. Set them as Actions secrets.");
    process.exit(1);
  }

  console.log("[BOUNTY-SCAN] Pulling latest state from Supabase...");
  await Persistence.pullAll();

  if (!GithubBounty.isConfigured()) {
    console.error("[BOUNTY-SCAN] No GITHUB_BOUNTY_TOKEN (or GITHUB_TOKEN) set — skipping the scan.");
  } else {
    console.log("[BOUNTY-SCAN] Scanning for bounty candidates...");
    const result = await GithubBounty.scanForBounties({});
    if (result.error) {
      console.error("[BOUNTY-SCAN] Scan error:", result.error);
    } else {
      console.log(`[BOUNTY-SCAN] Queued ${result.queued.length} easy candidate(s), ` +
        `${result.flagged_medium.length} medium (flagged for closer review), ` +
        `skipped ${result.skipped.length}, ${result.errors.length} error(s).`);
    }
  }

  if (SolanaWallet.isConfigured()) {
    console.log("[BOUNTY-SCAN] Checking wallet for new incoming payments...");
    try {
      const { newEntries, error } = await SolanaWallet.checkIncomingPayments({});
      if (error) console.warn("[BOUNTY-SCAN] Wallet check error:", error);
      else console.log(`[BOUNTY-SCAN] ${newEntries.length} new on-chain transaction(s) recorded.`);
    } catch (e) {
      console.warn("[BOUNTY-SCAN] Wallet check failed:", e.message);
    }
  } else {
    console.log("[BOUNTY-SCAN] No SOLANA_WALLET_ADDRESS set — skipping wallet check.");
  }

  console.log("[BOUNTY-SCAN] Pushing updated state back to Supabase...");
  const pushed = await Persistence.flush();
  console.log(`[BOUNTY-SCAN] Done. ${pushed} file(s) pushed.`);
}

main().catch(e => {
  console.error("[BOUNTY-SCAN] Fatal error:", e.message);
  process.exit(1);
});
