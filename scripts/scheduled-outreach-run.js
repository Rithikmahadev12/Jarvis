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

  const queued = Outreach.listQueue();
  if (queued.length === 0) {
    console.log("[OUTREACH-RUN] Queue is empty -- nothing to do this run.");
  } else {
    console.log(`[OUTREACH-RUN] ${queued.length} business(es) queued -- processing up to OUTREACH_MAX_PER_RUN...`);
    const { processed, remainingInQueue } = await Outreach.runQueuedOutreach();
    for (const r of processed) {
      if (r.error) {
        console.error(`[OUTREACH-RUN] ${r.business}: failed -- ${r.error}`);
      } else {
        console.log(`[OUTREACH-RUN] ${r.business}: contacted by ${r.lead?.channel || "unknown channel"}` +
          (r.lead?.transcript ? ` -- "${String(r.lead.transcript).slice(0, 200)}..."` : ""));
      }
    }
    console.log(`[OUTREACH-RUN] ${remainingInQueue} still queued for next run.`);
  }

  console.log("[OUTREACH-RUN] Pushing updated state back to Supabase...");
  const pushed = await Persistence.flush();
  console.log(`[OUTREACH-RUN] Done. ${pushed} file(s) pushed.`);
}

main().catch(e => {
  console.error("[OUTREACH-RUN] Fatal error:", e.message);
  process.exit(1);
});
