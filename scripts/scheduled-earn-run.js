"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Scheduled Earn Cycle (runs inside GitHub Actions)
//
// Runs on GitHub's servers (see .github/workflows/earn-cycle.yml), so it
// works whether your PC is on, off or asleep, and whether or not Render
// is awake. It runs the full earn brain:
//   review results (asking its OWN brain first) → search the web → open pages
//   on Jarvis's own computer (e2b) → rank ideas → sign up for the free
//   accounts those ideas need, using its own AgentMail email → teach the
//   brain what happened → (optionally) build a code upgrade in a sandbox.
//
// There's no screen here, so approvals are decided by policy
// (JARVIS_HEADLESS, see approvals.js): page-reading is auto-approved,
// code upgrades open a PULL REQUEST that is NOT merged (you merge it —
// that's your approval), and anything involving money is denied. Free
// sign-ups are pre-approved here (earn-signup.js enforces its own guard
// rails: no CAPTCHAs, no phone/card/ID, no money sites, one account each).
// Results land in data/earn-journal.json and are pushed back to Supabase,
// so ask Jarvis "earn status" to hear them.
// ═══════════════════════════════════════════════════════════════
process.env.JARVIS_HEADLESS = "1";
const path = require("path");
const ROOT = path.join(__dirname, "..");

const Persistence = require(path.join(ROOT, "persistence.js"));
const EarnBrain   = require(path.join(ROOT, "earn-brain.js"));
const OwnBrain    = require(path.join(ROOT, "own-brain.js"));

const MIN_GAP_MS = 20 * 3600 * 1000; // don't repeat if Render already ran one today

async function main() {
  if (!Persistence.isConfigured()) {
    console.error("[EARN-RUN] SUPABASE_* not set -- nowhere to read/save Jarvis's state.");
    process.exit(1);
  }
  console.log("[EARN-RUN] Pulling latest state from Supabase...");
  await Persistence.pullAll();

  const force = process.env.EARN_FORCE === "1";
  const st = EarnBrain.status();
  if (!force) {
    if (!st.enabled) { console.log("[EARN-RUN] Daily earn cycle is switched off -- nothing to do."); return; }
    if (st.lastRunAt && Date.now() - st.lastRunAt < MIN_GAP_MS) {
      console.log(`[EARN-RUN] A cycle already ran ${((Date.now() - st.lastRunAt) / 3600000).toFixed(1)}h ago -- skipping.`);
      return;
    }
  }

  console.log("[EARN-RUN] Starting earn cycle...");
  const r = await EarnBrain.runCycle({ trigger: "github-action", focus: process.env.EARN_FOCUS || "" });
  console.log(EarnBrain.speakSummary(r));

  // Save the brain's weights + memory so what it just learned is in data/ before the push.
  try {
    OwnBrain.flushIfDirty();
    const b = OwnBrain.getStats();
    console.log(`[EARN-RUN] Own brain: ${b.memoryEntries} memories, ${b.totalCharsTrained} chars trained.`);
  } catch (e) { console.warn("[EARN-RUN] Couldn't save the brain:", e.message); }
  const tried = (r.signups || []).filter(x => x.status !== "skipped");
  if (tried.length) console.log(`[EARN-RUN] Sign-ups: ${tried.map(x => `${x.host}=${x.status}`).join(", ")}`);

  console.log("[EARN-RUN] Pushing updated state back to Supabase...");
  const pushed = await Persistence.flush();
  console.log(`[EARN-RUN] Done. ${pushed} file(s) pushed.`);
  if (r.error) process.exit(1);
}

main().catch(e => {
  console.error("[EARN-RUN] Fatal error:", e.message);
  process.exit(1);
});
