"use strict";
// ===================================================================
// J.A.R.V.I.S -- Scheduled Business Outreach Run (GitHub Actions)
//
// Works through data/outreach-queue.json (see outreach-agent.js's
// queueLead()/runQueuedOutreach()) -- pitches up to
// OUTREACH_MAX_PER_RUN businesses by phone (falling back to email if
// AgentPhone is out), same as a manual "run the outreach queue" would.
//
// Unlike the bounty/Superteam scans, there's no live listings API
// this can discover new work from on its own -- the queue only ever
// has what YOU (or Jarvis, via queue_business_outreach) put into it.
// An empty queue is a normal, silent no-op run, not an error.
// ===================================================================

const path = require("path");
const REPO_ROOT = path.join(__dirname, "..");

const Persistence = require(path.join(REPO_ROOT, "persistence.js"));
const Outreach     = require(path.join(REPO_ROOT, "outreach-agent.js"));

async function main() {
  if (!Persistence.isConfigured()) {
    console.error("[OUTREACH-RUN] SUPABASE_* not set -- nowhere to persist the queue/leads between runs.");
    process.exit(1);
  }

  console.log("[OUTREACH-RUN] Pulling latest state from Supabase...");
  await Persistence.pullAll();

  // Fully automatic: finds new businesses by itself (see lead-finder.js),
  // queues them, then contacts up to OUTREACH_MAX_PER_RUN. Set
  // OUTREACH_FORCE=1 on a manual run to ignore the calling-hours window.
  const force = process.env.OUTREACH_FORCE === "1";
  const result = await Outreach.runAutoOutreach({ force });
  if (result.skipped) console.log(`[OUTREACH-RUN] ${result.skipped}`);
  if (result.discovered?.error) console.error(`[OUTREACH-RUN] Discovery: ${result.discovered.error}`);
  else if (result.discovered) console.log(`[OUTREACH-RUN] Found ${result.discovered.queued.length} new business(es) in ${result.discovered.area} (scanned ${result.discovered.scanned}).`);
  if (result.ran) {
    for (const r of result.ran.processed) {
      if (r.error) console.error(`[OUTREACH-RUN] ${r.business}: failed -- ${r.error}`);
      else console.log(`[OUTREACH-RUN] ${r.business}: contacted by ${r.lead?.channel || "unknown channel"}` +
        (r.lead?.transcript ? ` -- "${String(r.lead.transcript).slice(0, 200)}..."` : ""));
    }
    console.log(`[OUTREACH-RUN] ${result.ran.remainingInQueue} still queued for next run.`);
  }

  console.log("[OUTREACH-RUN] Pushing updated state back to Supabase...");
  const pushed = await Persistence.flush();
  console.log(`[OUTREACH-RUN] Done. ${pushed} file(s) pushed.`);
}

main().catch(e => {
  console.error("[OUTREACH-RUN] Fatal error:", e.message);
  process.exit(1);
});
