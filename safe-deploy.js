"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Safe Self-Healing v2
//
// Flow for every fix attempt:
//   1. BACKUP     — snapshot current `main` (zip + record its commit SHA)
//                   before touching anything, so we can always roll back.
//   2. CLONE      — fresh clone of the repo into /tmp/test-clone (never
//                   touches your real working copy or the live server).
//   3. FIX        — ask the model for a fix, giving it the FULL original
//                   file and an explicit "do not remove anything else"
//                   instruction.
//   4. GUARD      — reject the fix automatically if it:
//                     a) has a syntax error (`node --check`)
//                     b) drops any function / export that existed before
//                        (checked both by static analysis AND by actually
//                        requiring the module and diffing its real exports)
//                     c) shrinks the file suspiciously (looks like content
//                        got deleted rather than a bug getting fixed)
//                     d) crashes the app on boot (short smoke-test boot
//                        of the whole server in the clone, on a throwaway
//                        port)
//   5. SHIP       — only if every guard passes: commit to a new branch,
//                   open a PR, and (optionally) merge it. If ANY guard
//                   fails, main is never touched — you get a report
//                   explaining exactly what was rejected and why.
//
// Every attempt (pass or fail) is logged to data/self-heal-log.json.
// ═══════════════════════════════════════════════════════════════
const fs   = require("fs");
const path = require("path");
const { execSync, spawn } = require("child_process");
const archiver = require("archiver");
const Groq   = require("./hermes-engine");
const LocalLLM = require("./local-llm");
const Deploy = require("./github-deploy");

const LIVE_DIR    = __dirname;
const TEST_CLONE  = "/tmp/test-clone";
const DATA_DIR    = path.join(LIVE_DIR, "data");
const BACKUP_DIR  = path.join(DATA_DIR, "self-heal-backups");
const LOG_FILE    = path.join(DATA_DIR, "self-heal-log.json");
const PROBE_FILE  = "__self_heal_probe.js";

const REPO   = process.env.GITHUB_REPO;
const BRANCH = process.env.GITHUB_BRANCH || "main";

function ensureDirs() {
  [DATA_DIR, BACKUP_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "[]", "utf8");
}

function log(entry) {
  ensureDirs();
  let all = [];
  try { all = JSON.parse(fs.readFileSync(LOG_FILE, "utf8")); } catch {}
  all.push({ ...entry, timestamp: new Date().toISOString() });
  if (all.length > 300) all = all.slice(-300);
  fs.writeFileSync(LOG_FILE, JSON.stringify(all, null, 2), "utf8");
}

function redact(str = "") {
  const token = process.env.GITHUB_TOKEN;
  return token ? String(str).split(token).join("[REDACTED]") : String(str);
}

function cloneUrl() {
  if (!process.env.GITHUB_TOKEN || !REPO) {
    throw new Error("GITHUB_TOKEN / GITHUB_REPO must be set in .env before running safe-deploy");
  }
  return `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${REPO}.git`;
}

// ── 1. BACKUP ─────────────────────────────────────────────────
// Zips the current local working copy AND records the current remote
// commit SHA of `main`, so there are two independent ways to recover:
// the zip (file-level) and the SHA (for a GitHub-side rollback).
async function backupCurrentMain() {
  ensureDirs();
  const sha = await Deploy.getBranchSha(BRANCH);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const zipPath = path.join(BACKUP_DIR, `backup-${stamp}-${sha.slice(0, 7)}.zip`);

  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", resolve);
    archive.on("error", reject);
    archive.pipe(output);
    archive.glob("**/*", {
      cwd: LIVE_DIR,
      ignore: ["node_modules/**", ".git/**", "data/self-heal-backups/**", "/tmp/**"],
      dot: true,
    });
    archive.finalize();
  });

  // Keep only the last 20 backups so this doesn't grow forever.
  const backups = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".zip")).sort();
  while (backups.length > 20) fs.unlinkSync(path.join(BACKUP_DIR, backups.shift()));

  return { sha, zipPath };
}

// ── 2. CLONE ──────────────────────────────────────────────────
function cloneForTesting() {
  if (fs.existsSync(TEST_CLONE)) fs.rmSync(TEST_CLONE, { recursive: true, force: true });
  execSync(`git clone --branch ${BRANCH} --single-branch --depth 1 "${cloneUrl()}" "${TEST_CLONE}"`,
    { stdio: "pipe" });

  // Bring in .env and node_modules from the live copy so the clone can
  // actually boot (both are gitignored, so a fresh clone won't have them).
  const envSrc = path.join(LIVE_DIR, ".env");
  if (fs.existsSync(envSrc)) fs.copyFileSync(envSrc, path.join(TEST_CLONE, ".env"));

  const nmSrc = path.join(LIVE_DIR, "node_modules");
  if (fs.existsSync(nmSrc)) {
    fs.cpSync(nmSrc, path.join(TEST_CLONE, "node_modules"), { recursive: true });
  } else {
    try { execSync("npm install --omit=dev", { cwd: TEST_CLONE, stdio: "pipe" }); } catch {}
  }

  return TEST_CLONE;
}

function cleanupClone() {
  try { if (fs.existsSync(TEST_CLONE)) fs.rmSync(TEST_CLONE, { recursive: true, force: true }); } catch {}
}

// ── 3. FIX ────────────────────────────────────────────────────
// Ollama Cloud first, Groq second. Reversed from hermes-engine's
// normal default (Groq first, Ollama Cloud only as a last-resort
// fallback) specifically for self-heal fixes — deliberate per-call
// choice here, not a global change to how the rest of the app talks
// to the model.
async function generateFixRaw(systemPrompt, userPrompt, relFilePath) {
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ];

  if (LocalLLM.isCloudConfigured()) {
    try {
      const msg = await LocalLLM.ollamaCloudChat(messages, { temperature: 0.3, maxTokens: 2048 });
      const content = (msg.content || "").trim();
      if (content) return content;
      throw new Error("Ollama Cloud returned an empty response");
    } catch (e) {
      console.warn(`[SAFE-DEPLOY] Ollama Cloud fix attempt failed (${e.message}) — falling back to Groq...`);
    }
  }

  if (!Groq.isConfigured()) throw new Error("No Groq/Hermes key configured — can't generate a fix (and Ollama Cloud wasn't available or failed)");
  // Matches the original call shape: (prompt, context) where context
  // is just the filename, appended into Groq's own system prompt.
  return Groq.generateCode(userPrompt, relFilePath);
}

async function generateFix(relFilePath, bugDescription, originalCode) {
  const systemPrompt = `You are an expert developer fixing a bug in one file of a larger Node.js application called J.A.R.V.I.S. Return ONLY the code — no markdown backticks, no explanation.`;
  const prompt = `FILE: ${relFilePath}
BUG TO FIX: ${bugDescription}

RULES — these are not optional:
1. Fix ONLY the described bug. Do not refactor, rename, reorganize, or "clean up" anything else.
2. Do NOT remove any existing function, class, variable, or module.exports key, even if it looks
   unused or unrelated to the bug. Every feature currently in this file must still be present and
   still work after your fix.
3. Do NOT shorten or simplify the file. If the fix is small, the resulting file should be almost
   identical in size to the original, just with the bug corrected.
4. Output the COMPLETE corrected file, start to finish. No markdown code fences, no explanation,
   no "// rest of file unchanged" placeholders — the full literal file content only.

ORIGINAL FILE:
${originalCode}`;

  let code = await generateFixRaw(systemPrompt, prompt, relFilePath);
  if (!code) throw new Error("Model returned no fix");

  // Strip markdown fences if the model added them anyway.
  code = code.trim();
  const fenceMatch = code.match(/^```(?:javascript|js)?\n([\s\S]*?)\n```$/);
  if (fenceMatch) code = fenceMatch[1];

  if (code.length < 50) throw new Error("Generated fix looks empty/too short — refusing");
  return code;
}

// ── 4a. Static "did anything get deleted" guard ─────────────────
function extractTopLevelNames(code) {
  const names = new Set();
  const patterns = [
    /^\s*function\s+([A-Za-z0-9_$]+)\s*\(/gm,
    /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm,
    /^\s*const\s+([A-Za-z0-9_$]+)\s*=/gm,
    /^\s*let\s+([A-Za-z0-9_$]+)\s*=/gm,
    /^\s*class\s+([A-Za-z0-9_$]+)/gm,
    /exports\.([A-Za-z0-9_$]+)\s*=/gm,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(code))) names.add(m[1]);
  }
  // module.exports = { a, b, c: fn, ... } — grab the object keys too
  const exportsBlock = code.match(/module\.exports\s*=\s*{([\s\S]*?)}\s*;?\s*$/m);
  if (exportsBlock) {
    const keyRe = /(?:^|[,{\s])([A-Za-z0-9_$]+)\s*(?::|,|\n|$)/g;
    let m;
    while ((m = keyRe.exec(exportsBlock[1]))) names.add(m[1]);
  }
  return names;
}

function staticFeatureGuard(originalCode, fixedCode) {
  const before = extractTopLevelNames(originalCode);
  const after  = extractTopLevelNames(fixedCode);
  const missing = [...before].filter(n => !after.has(n));

  const sizeDrop = (originalCode.length - fixedCode.length) / originalCode.length;

  if (missing.length > 0) {
    return { ok: false, reason: `Fix appears to remove existing code: ${missing.join(", ")}` };
  }
  if (originalCode.length > 500 && sizeDrop > 0.4) {
    return { ok: false, reason: `Fixed file is ${Math.round(sizeDrop * 100)}% smaller than the original — looks like content was deleted, not just a bug fixed` };
  }
  return { ok: true };
}

// ── 4b. Syntax guard ─────────────────────────────────────────────
function syntaxGuard(absPath) {
  try {
    execSync(`node --check "${absPath}"`, { stdio: "pipe" });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `Syntax error: ${redact(e.stderr?.toString() || e.message)}` };
  }
}

// ── 4c. Runtime exports guard ─────────────────────────────────────
// Actually requires the module (in a throwaway child process, from the
// clone) and compares its real exported keys before vs after the fix.
// Catches cases the static regex guard could miss (e.g. dynamically
// built export objects).
function probeExports(cloneDir, relFilePath) {
  const probeCode = `
    try {
      const m = require(${JSON.stringify(path.join(cloneDir, relFilePath))});
      const type = typeof m;
      const keys = (type === "object" && m !== null) ? Object.keys(m) : [];
      console.log(JSON.stringify({ ok: true, type, keys }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e.message }));
    }
  `;
  const probePath = path.join(cloneDir, PROBE_FILE);
  fs.writeFileSync(probePath, probeCode, "utf8");
  try {
    const out = execSync(`node "${probePath}"`, { cwd: cloneDir, stdio: "pipe", timeout: 10000 }).toString();
    return JSON.parse(out.trim().split("\n").pop());
  } catch (e) {
    return { ok: false, error: redact(e.stderr?.toString() || e.message) };
  } finally {
    try { fs.unlinkSync(probePath); } catch {}
  }
}

function runtimeFeatureGuard(cloneDir, relFilePath, originalKeysSnapshot) {
  const after = probeExports(cloneDir, relFilePath);
  if (!after.ok) {
    return { ok: false, reason: `Fixed file fails to load at all: ${after.error}` };
  }
  if (originalKeysSnapshot.ok && originalKeysSnapshot.type === "object") {
    const missing = originalKeysSnapshot.keys.filter(k => !after.keys.includes(k));
    if (missing.length > 0) {
      return { ok: false, reason: `Fix drops these exports that other files rely on: ${missing.join(", ")}` };
    }
  }
  return { ok: true };
}

// ── 4d. Boot smoke test ───────────────────────────────────────────
// Actually boots the whole app in the clone on a throwaway port and
// watches for a crash in the first few seconds.
function bootSmokeTest(cloneDir, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const child = spawn("node", ["server.js"], {
      cwd: cloneDir,
      env: { ...process.env, PORT: "39871" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let settled = false;
    child.stderr.on("data", (d) => { stderr += d.toString(); });

    child.on("exit", (codeNum) => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, reason: `Server crashed on boot (exit code ${codeNum}): ${redact(stderr.slice(-800))}` });
    });

    setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      resolve({ ok: true });
    }, timeoutMs);
  });
}

// ── 5. SHIP ────────────────────────────────────────────────────
async function shipFix(relFilePath, fixedCode, bugDescription, autoMerge) {
  const branchName = `self-heal/${relFilePath.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-${Date.now()}`;
  await Deploy.createFeatureBranch(branchName);
  await Deploy.commitFile(
    relFilePath,
    fixedCode,
    `fix: ${bugDescription.slice(0, 72)} [auto self-heal]`,
    branchName
  );
  const pr = await Deploy.openPullRequest(
    branchName,
    `Self-heal: ${relFilePath}`,
    `**Automated fix** for: ${bugDescription}\n\nAll guard checks passed:\n- ✅ syntax check\n- ✅ no existing exports/functions removed\n- ✅ boots cleanly in isolated test clone\n\nThis was generated and verified in \`/tmp/test-clone\` before being pushed.`
  );
  let merged = null;
  if (autoMerge) {
    merged = await Deploy.mergePullRequest(pr.number);
  }
  return { branchName, pr, merged };
}

// ── ORCHESTRATOR ───────────────────────────────────────────────
async function runSafeSelfHeal({ relFilePath, bugDescription, autoMerge = true }) {
  ensureDirs();
  const report = { relFilePath, bugDescription, steps: {} };

  let backup;
  try {
    backup = await backupCurrentMain();
    report.backup = backup;
  } catch (e) {
    report.success = false;
    report.failedAt = "backup";
    report.reason = redact(e.message);
    log(report);
    return report;
  }

  try {
    cloneForTesting();
    report.steps.clone = { ok: true };

    const absPath = path.join(TEST_CLONE, relFilePath);
    if (!fs.existsSync(absPath)) throw new Error(`${relFilePath} does not exist in the repo`);
    const originalCode = fs.readFileSync(absPath, "utf8");
    const originalExports = probeExports(TEST_CLONE, relFilePath);

    const fixedCode = await generateFix(relFilePath, bugDescription, originalCode);
    report.steps.generateFix = { ok: true };

    // Write the fix into the clone (NOT the live repo, NOT GitHub yet).
    fs.writeFileSync(absPath, fixedCode, "utf8");

    const checks = [
      ["staticFeatureGuard", staticFeatureGuard(originalCode, fixedCode)],
      ["syntaxGuard", syntaxGuard(absPath)],
      ["runtimeFeatureGuard", runtimeFeatureGuard(TEST_CLONE, relFilePath, originalExports)],
    ];
    for (const [name, result] of checks) {
      report.steps[name] = result;
      if (!result.ok) {
        report.success = false;
        report.failedAt = name;
        report.reason = result.reason;
        cleanupClone();
        log(report);
        return report;
      }
    }

    const bootResult = await bootSmokeTest(TEST_CLONE);
    report.steps.bootSmokeTest = bootResult;
    if (!bootResult.ok) {
      report.success = false;
      report.failedAt = "bootSmokeTest";
      report.reason = bootResult.reason;
      cleanupClone();
      log(report);
      return report;
    }

    // Every guard passed — safe to ship.
    const shipResult = await shipFix(relFilePath, fixedCode, bugDescription, autoMerge);
    report.success = true;
    report.ship = shipResult;
    cleanupClone();
    log(report);
    return report;
  } catch (e) {
    report.success = false;
    report.failedAt = report.steps.generateFix ? "unknown" : "clone_or_fix";
    report.reason = redact(e.message);
    cleanupClone();
    log(report);
    return report;
  }
}

// ── ROLLBACK (manual safety valve) ─────────────────────────────
// Points `main` back at a previous backup's commit SHA. Use this if a
// merged fix turns out to have broken something the guards didn't catch.
async function rollbackTo(sha) {
  return Deploy.updateBranchRef(BRANCH, sha, true);
}

function listBackups() {
  ensureDirs();
  return fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith(".zip")).sort().reverse();
}

function getLog(limit = 20) {
  ensureDirs();
  try {
    const all = JSON.parse(fs.readFileSync(LOG_FILE, "utf8"));
    return all.slice(-limit).reverse();
  } catch { return []; }
}

module.exports = {
  runSafeSelfHeal,
  backupCurrentMain,
  rollbackTo,
  listBackups,
  getLog,
};
