"use strict";
// ===================================================================
// J.A.R.V.I.S -- Scheduled Superteam Earn Scan (GitHub Actions)
//
// Runs scanAndSubmitAll() -- loops over EVERY registered user in
// data/superteam-configs/ (each already registered locally via
// scripts/register-superteam-agent.js <userKey>), not just the owner.
// Each user's drafts/submissions use their OWN Superteam agent
// identity, pulled from Supabase like everything else in data/.
// ===================================================================

const path = require("path");
const REPO_ROOT = path.join(__dirname, "..");

const Persistence    = require(path.join(REPO_ROOT, "persistence.js"));
const SuperteamAgent = require(path.join(REPO_ROOT, "superteam-agent.js"));

async function main() {
  if (!Persistence.isConfigured()) {
    console.error("[SUPERTEAM-SCAN] SUPABASE_* not set -- nowhere to persist agent identities between runs.");
    process.exit(1);
  }

  console.log("[SUPERTEAM-SCAN] Pulling latest state from Supabase...");
  await Persistence.pullAll();

  console.log("[SUPERTEAM-SCAN] Checking for known users without a Superteam identity yet...");
  const registrations = await SuperteamAgent.ensureAllRegistered();
  for (const r of registrations) {
    if (r.alreadyRegistered) continue;
    if (r.error) {
      console.error(`[SUPERTEAM-SCAN] Auto-registration failed for "${r.userKey}": ${r.error}`);
    } else {
      console.log(`[SUPERTEAM-SCAN] Auto-registered "${r.userKey}" -- claim code: ${r.claimCode} ` +
        `(ask Jarvis "what's my Superteam claim code" to get this again later)`);
    }
  }

  const users = SuperteamAgent.listRegisteredUsers();
  if (users.length === 0) {
    console.log("[SUPERTEAM-SCAN] Still no registered users -- nothing in config.json/profiles.json yet, " +
      "or every registration attempt above failed.");
  } else {
    console.log(`[SUPERTEAM-SCAN] Running for ${users.length} registered user(s): ${users.join(", ")}`);
    const results = await SuperteamAgent.scanAndSubmitAll();
    for (const r of results) {
      if (r.error) {
        console.error(`[SUPERTEAM-SCAN] ${r.userKey}: ${r.error}`);
        continue;
      }
      console.log(`[SUPERTEAM-SCAN] ${r.userKey}: scanned ${r.scanned}, submitted ${r.submitted.length}, ` +
        `queued ${r.queued.length}, errors ${r.errors.length}`);
      for (const q of r.queued) {
        console.log(`[SUPERTEAM-SCAN]   ${r.userKey} queued draft -- ${q.slug}:\n${String(q.draft).slice(0, 300)}...`);
      }
      for (const s of r.submitted) {
        console.log(`[SUPERTEAM-SCAN]   ${r.userKey} submitted -- ${s.slug}`);
      }
      for (const e of r.errors) {
        console.error(`[SUPERTEAM-SCAN]   ${r.userKey} error -- ${e.slug}: ${e.error}`);
      }
    }
  }

  console.log("[SUPERTEAM-SCAN] Pushing updated state back to Supabase...");
  const pushed = await Persistence.flush();
  console.log(`[SUPERTEAM-SCAN] Done. ${pushed} file(s) pushed.`);
}

main().catch(e => {
  console.error("[SUPERTEAM-SCAN] Fatal error:", e.message);
  process.exit(1);
});
