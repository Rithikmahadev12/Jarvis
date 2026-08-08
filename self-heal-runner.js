"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Safe Self-Healing CLI
//
// Usage:
//   node self-heal-runner.js <relative/path/to/file.js> "description of the bug"
//   node self-heal-runner.js <relative/path/to/file.js> "description of the bug" --no-merge
//   node self-heal-runner.js --log            (show recent attempts)
//   node self-heal-runner.js --backups        (list available backups)
//   node self-heal-runner.js --rollback <sha> (force main back to a commit)
// ═══════════════════════════════════════════════════════════════
require("dotenv").config();
const SafeDeploy = require("./safe-deploy");

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === "--log") {
    console.log(JSON.stringify(SafeDeploy.getLog(20), null, 2));
    return;
  }
  if (args[0] === "--backups") {
    console.log(SafeDeploy.listBackups().join("\n") || "(no backups yet)");
    return;
  }
  if (args[0] === "--rollback") {
    const sha = args[1];
    if (!sha) { console.error("Usage: --rollback <sha>"); process.exit(1); }
    const result = await SafeDeploy.rollbackTo(sha);
    console.log("main rolled back:", result.ref, "->", result.object.sha);
    return;
  }

  const [relFilePath, bugDescription, flag] = args;
  if (!relFilePath || !bugDescription) {
    console.log(`Usage:
  node self-heal-runner.js <relative/path/to/file.js> "description of the bug" [--no-merge]
  node self-heal-runner.js --log
  node self-heal-runner.js --backups
  node self-heal-runner.js --rollback <sha>`);
    process.exit(1);
  }

  const autoMerge = flag !== "--no-merge";
  console.log(`\n[SELF-HEAL] Starting on ${relFilePath}`);
  console.log(`[SELF-HEAL] Bug: ${bugDescription}`);
  console.log(`[SELF-HEAL] Auto-merge: ${autoMerge}\n`);

  const report = await SafeDeploy.runSafeSelfHeal({ relFilePath, bugDescription, autoMerge });

  console.log("\n──────── REPORT ────────");
  console.log(JSON.stringify(report, null, 2));
  console.log("─────────────────────────\n");

  if (report.success) {
    console.log(`✅ Fixed and shipped. PR #${report.ship.pr.number}${report.ship.merged ? " (merged)" : " (open, not merged)"}`);
  } else {
    console.log(`❌ Not shipped — stopped at "${report.failedAt}": ${report.reason}`);
    console.log(`   main was never touched. Backup saved at: ${report.backup?.zipPath || "n/a"}`);
  }
}

main().catch(e => {
  console.error("[SELF-HEAL] Fatal error:", e.message);
  process.exit(1);
});
