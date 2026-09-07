"use strict";
// Run: node scripts/debug-superteam-listings.js <userKey>
//   node scripts/debug-superteam-listings.js rithik
//
// Shows exactly what the live listings endpoint returned and why
// each listing was kept or dropped by the reward/hours/submissions/
// skills filters — use this whenever a scheduled scan reports
// "scanned 0" and that seems wrong. It'll tell you whether that's
// genuinely zero live listings right now, or normalizeListing()
// reading a field name (reward/skills/deadline) the real API
// doesn't actually use.

require("dotenv").config();
const path = require("path");
const SuperteamAgent = require(path.join(__dirname, "..", "superteam-agent.js"));
const Persistence = require(path.join(__dirname, "..", "persistence.js"));

async function main() {
  const userKey = process.argv[2] || "owner";

  // If this account was registered by the scheduled GitHub Actions
  // run rather than locally, its config only exists in Supabase --
  // pull it down first or isConfigured() below will wrongly say
  // "not registered" even though it actually is.
  if (Persistence.isConfigured()) {
    console.log("Pulling latest state from Supabase first...");
    await Persistence.pullAll();
  } else {
    console.log("SUPABASE_* not set locally -- checking only what's on this machine's disk.");
  }

  if (!SuperteamAgent.isConfigured(userKey)) {
    console.error(`"${userKey}" isn't registered yet. Run scripts/register-superteam-agent.js ${userKey} first.`);
    process.exit(1);
  }

  console.log(`Fetching live listings for "${userKey}"...\n`);
  const result = await SuperteamAgent.debugDiscovery(userKey);

  console.log(`Endpoint: ${result.endpoint}`);
  console.log(`Raw listings returned by the API: ${result.rawCount}`);
  console.log(`Listings that pass your filters:   ${result.keptCount}`);
  console.log(`\nActive filters:`, result.filters);

  if (result.rawCount === 0) {
    console.log(
      "\nThe API itself returned zero listings — this isn't a filter problem. " +
      "Either there's genuinely nothing live right now, or the endpoint/auth needs a second look."
    );
    return;
  }

  if (result.firstRawListing) {
    console.log("\n--- First RAW listing, exactly as the API sent it (compare this against normalizeListing's field guesses in superteam-agent.js) ---");
    console.log(JSON.stringify(result.firstRawListing, null, 2));
  }

  console.log("\n--- Per-listing breakdown ---");
  for (const row of result.rows) {
    const status = row.kept ? "KEPT" : "DROPPED";
    console.log(`\n[${status}] ${row.title || row.slug}`);
    console.log(`  reward=${row.reward}  hoursLeft=${row.hoursLeft}  submissions=${row.submissionCount}  skills=[${row.skills.join(", ")}]`);
    if (!row.kept) {
      row.reasons.forEach(r => console.log(`  - ${r}`));
    }
    if (row.reward == null) {
      console.log(`  raw keys on this listing: ${row.sampleRawKeys.join(", ")}`);
      console.log(`  -> if the real reward field is in that list under a different name, update normalizeListing() in superteam-agent.js`);
    }
  }

  if (result.keptCount === 0 && result.rawCount > 0) {
    console.log(
      "\nEvery listing was dropped by a filter. If the reasons above are all reward/skills/ " +
      "hours-based, your SUPERTEAM_* env vars may just be narrower than what's live right now " +
      "-- widen SUPERTEAM_MIN_REWARD_USD/MAX_REWARD_USD/SUPERTEAM_SKILLS/SUPERTEAM_MAX_HOURS_LEFT " +
      "and rerun. If instead every listing shows 'reward field not found', normalizeListing()'s " +
      "field names need fixing to match the raw keys printed above."
    );
  }
}

main().catch(e => {
  console.error("Debug run failed:", e.message);
  process.exit(1);
});
