"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Self-Heal On Deploy (runs inside GitHub Actions)
//
// This solves the chicken-and-egg problem with the old flow: if a bad
// deploy breaks JARVIS badly enough that it can't even boot on your
// PC, JARVIS can't be talked to in order to ask it to fix itself.
//
// This script does NOT run on your PC. It runs on GitHub's own
// servers, triggered automatically right after every push to main
// (i.e. right after every deploy) — so it works whether your machine
// is on, off, asleep, or the app is completely broken locally.
//
// What it does, in order:
//   1. Boot the exact code that was just deployed (this checkout, on
//      a throwaway port) and watch for an immediate crash. This is
//      the same signal a real broken deploy gives you.
//   2. If it boots fine — log that and stop. Nothing to heal.
//   3. If it crashes — pull the crashing file out of the stack trace,
//      then hand off to the EXISTING safe-deploy.js pipeline, which:
//        - clones a fresh copy of the repo (separate from this
//          checkout, so nothing here gets touched directly)
//        - asks the model for a fix, giving it the full original file
//        - rejects the fix if it has a syntax error, drops any
//          existing function/export, shrinks suspiciously, or still
//          crashes on boot in that fresh clone
//        - only if every guard passes: opens a PR and merges it
//   4. Loop guard: if the last commit on main was itself an auto
//      self-heal fix, skip running entirely. Otherwise a fix that
//      merges cleanly but doesn't actually fix the crash could
//      trigger this workflow again, forever.
// ═══════════════════════════════════════════════════════════════
require("dotenv").config();

const fs   = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");

const SafeDeploy = require(path.join(__dirname, "..", "safe-deploy"));

const REPO_ROOT   = path.join(__dirname, "..");
const PROBE_PORT  = "39872";
const BOOT_TIMEOUT_MS = 12000;

// ── Loop guard ────────────────────────────────────────────────
function lastCommitIsSelfHeal() {
  try {
    const msg = execSync("git log -1 --pretty=%B", { cwd: REPO_ROOT }).toString();
    return msg.includes("[auto self-heal]");
  } catch {
    return false;
  }
}

// ── 1. Boot health check on the code that was JUST deployed ─────
function bootHealthCheck(timeoutMs = BOOT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = spawn("node", ["server.js"], {
      cwd: REPO_ROOT,
      env: { ...process.env, PORT: PROBE_PORT },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      resolve({ healthy: false, stderr, code });
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ healthy: true });
    }, timeoutMs);
  });
}

// ── 2. Pull the actual crashing file out of the stack trace ─────
// Heuristic: first repo-relative .js path mentioned in the crash
// output that isn't inside node_modules and actually exists. This is
// almost always the file that either threw the error or required
// whatever's missing/broken.
function findCulpritFile(stderr) {
  const lines = stderr.split("\n");
  for (const line of lines) {
    const match = line.match(/([A-Za-z0-9_\-./\\]+\.js):\d+/);
    if (!match) continue;
    let file = match[1];
    if (file.includes("node_modules")) continue;
    file = file.replace(REPO_ROOT + path.sep, "").replace(/^\.[/\\]/, "");
    file = file.split(path.sep).join("/").split("\\").join("/");
    if (fs.existsSync(path.join(REPO_ROOT, file))) return file;
  }

  const modMatch = stderr.match(/Cannot find module ['"](\.[^'"]+)['"]/);
  if (modMatch) {
    let file = modMatch[1].replace(/^\.\//, "");
    if (!file.endsWith(".js")) file += ".js";
    if (fs.existsSync(path.join(REPO_ROOT, file))) return file;
  }

  // Last resort: the entry point itself.
  return "server.js";
}

async function main() {
  if (lastCommitIsSelfHeal()) {
    console.log("[SELF-HEAL-DEPLOY] Last commit on main was itself an auto self-heal fix — skipping this run to avoid a heal loop.");
    return;
  }

  console.log("[SELF-HEAL-DEPLOY] Booting the just-deployed code to check it's healthy...");
  const health = await bootHealthCheck();

  if (health.healthy) {
    console.log("[SELF-HEAL-DEPLOY] Deploy boots cleanly. Nothing to heal.");
    return;
  }

  console.log(`[SELF-HEAL-DEPLOY] Deploy FAILED to boot (exit code ${health.code}). Crash output:`);
  console.log(health.stderr.slice(-2000));

  const relFilePath = findCulpritFile(health.stderr);
  const bugDescription = `App crashes on boot immediately after the latest deploy to main. Crash output:\n${health.stderr.slice(-1500)}`;

  console.log(`[SELF-HEAL-DEPLOY] Suspected culprit file: ${relFilePath}`);
  console.log("[SELF-HEAL-DEPLOY] Handing off to the safe-deploy self-heal pipeline (fresh clone, guarded fix, boot-tested before shipping)...");

  const report = await SafeDeploy.runSafeSelfHeal({ relFilePath, bugDescription, autoMerge: true });

  console.log("\n──────── REPORT ────────");
  console.log(JSON.stringify(report, null, 2));
  console.log("─────────────────────────\n");

  if (report.success) {
    console.log(`✅ Fixed and shipped. PR #${report.ship.pr.number}${report.ship.merged ? " (merged)" : " (open, not merged)"}`);
  } else {
    console.error(`❌ Could not auto-fix — stopped at "${report.failedAt}": ${report.reason}`);
    console.error("Main was never touched by the failed fix attempt. This needs a human look.");
    process.exitCode = 1; // fail the Action run so you get a GitHub notification
  }
}

main().catch((e) => {
  console.error("[SELF-HEAL-DEPLOY] Fatal error:", e.message);
  process.exitCode = 1;
});
