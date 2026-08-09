"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Bounty Coder
//
// The last step in the bounty pipeline. Only runs on candidates
// github-bounty.js has already marked status:"awaiting_code" — which
// only happens after (a) YOU approved the offer and (b) the model
// read the maintainer's actual reply and classified it as a clear
// yes. See github-bounty.js's checkPostedForReplies().
//
// What this does, per candidate:
//   1. Shallow-clones the TARGET repo (someone else's, not this one)
//      into a throwaway /tmp folder.
//   2. Hands the model the issue text + a listing of the repo so it
//      can point at the one file it thinks needs to change, then
//      asks for a full corrected version of that file.
//   3. Guards the result: syntax-checks JS/TS files, rejects any fix
//      that shrinks the file drastically (usually means content got
//      deleted instead of fixed) or looks like a no-op.
//   4. Commits to a new branch, pushes to a fork (or the same repo if
//      the token has write access to it), and opens a DRAFT pull
//      request explaining it's an AI-assisted fix that needs review.
//
// What this deliberately never does:
//   - Never pushes to the target repo's main/default branch.
//   - Never marks a PR ready-for-review or merges it — that's a
//     human call, every time, on someone else's codebase.
//   - Never touches more than one file per attempt. Multi-file fixes
//     get flagged for you instead of guessed at.
//
// Needs the same GITHUB_BOUNTY_TOKEN as github-bounty.js, but that
// token now also needs WRITE access to the target repo (or the
// ability to fork it) to push a branch — read/write "Issues" alone,
// which is enough for approveCandidate(), is NOT enough for this
// step. See the note this prints if the push fails with a 403.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const GithubBounty = require("./github-bounty");
const Groq = require("./hermes-engine");

const GITHUB_TOKEN = GithubBounty.GITHUB_TOKEN;
const WORK_DIR = "/tmp/bounty-coder-clone";

function run(cmd, opts = {}) {
  return execSync(cmd, { stdio: ["pipe", "pipe", "pipe"], ...opts }).toString().trim();
}

function cloneUrl(owner, repo) {
  return `https://x-access-token:${GITHUB_TOKEN}@github.com/${owner}/${repo}.git`;
}

// ── 1. CLONE ────────────────────────────────────────────────────
function cloneRepo(owner, repo) {
  if (fs.existsSync(WORK_DIR)) fs.rmSync(WORK_DIR, { recursive: true, force: true });
  run(`git clone --depth 1 "${cloneUrl(owner, repo)}" "${WORK_DIR}"`);
  run(`git config user.email "jarvis-bounty-bot@users.noreply.github.com"`, { cwd: WORK_DIR });
  run(`git config user.name "jarvis-bounty-bot"`, { cwd: WORK_DIR });
}

// Cheap repo map so the model can point at a real file instead of
// guessing a path that doesn't exist. Skips the usual noise dirs.
function listRepoFiles(maxFiles = 400) {
  const skip = new Set(["node_modules", ".git", "dist", "build", "vendor", ".next", "coverage"]);
  const out = [];
  (function walk(dir) {
    if (out.length >= maxFiles) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) return;
      if (skip.has(entry.name) || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(WORK_DIR, full));
    }
  })(WORK_DIR);
  return out;
}

// ── 2. GENERATE FIX ─────────────────────────────────────────────
async function pickTargetFile(candidate, fileList) {
  const prompt = `Repo file listing (truncated):\n${fileList.slice(0, 300).join("\n")}\n\nIssue title: ${candidate.title}\nIssue summary (from earlier triage): ${candidate.summary}\nIssue URL: ${candidate.url}\n\nWhich single file in the listing above almost certainly needs to change to fix this? Reply with ONLY the exact relative path, nothing else. If you can't tell from the listing alone, reply with exactly: UNKNOWN`;
  const { reply } = await Groq.codeChat(prompt, { userTitle: "Sir" });
  const target = reply.trim().split("\n")[0].trim();
  if (target === "UNKNOWN" || !fileList.includes(target)) return null;
  return target;
}

async function generateFix(candidate, relFilePath) {
  const fullPath = path.join(WORK_DIR, relFilePath);
  const original = fs.readFileSync(fullPath, "utf8");
  const prompt = `You are fixing a real GitHub issue. Output ONLY the complete corrected file content for ${relFilePath} — no markdown fences, no explanation, no diff format, just the full file exactly as it should be after the fix.

Issue title: ${candidate.title}
Issue summary: ${candidate.summary}
Full issue URL for context: ${candidate.url}

Rules:
- Make the smallest change that plausibly fixes the described issue.
- Do not remove or rewrite unrelated code, comments, or formatting.
- If you are not confident you can fix this correctly from the info given, output exactly: CANNOT_FIX

──── ORIGINAL FILE (${relFilePath}) ────
${original}`;
  const { reply } = await Groq.codeChat(prompt, { userTitle: "Sir" });
  const fixed = reply.trim();
  if (fixed === "CANNOT_FIX" || fixed.length === 0) return null;
  return { original, fixed, fullPath };
}

// ── 3. GUARDRAILS ────────────────────────────────────────────────
function passesGuardrails(relFilePath, original, fixed) {
  if (fixed === original) return { ok: false, reason: "Model made no change." };
  if (fixed.length < original.length * 0.5) {
    return { ok: false, reason: "Fix shrinks the file by more than half — looks like deletion, not a fix." };
  }
  if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(relFilePath)) {
    const tmp = path.join(WORK_DIR, `__bounty_check_${Date.now()}.js`);
    try {
      fs.writeFileSync(tmp, fixed);
      run(`node --check "${tmp}"`);
    } catch (e) {
      return { ok: false, reason: `Fixed file fails syntax check: ${e.message.slice(0, 200)}` };
    } finally {
      if (fs.existsSync(tmp)) fs.rmSync(tmp);
    }
  }
  return { ok: true };
}

// ── 4. COMMIT + DRAFT PR ────────────────────────────────────────
async function openDraftPr(candidate, relFilePath) {
  const branch = `jarvis-bounty-${candidate.issueNumber}-${Date.now()}`;
  run(`git checkout -b "${branch}"`, { cwd: WORK_DIR });
  run(`git add "${relFilePath}"`, { cwd: WORK_DIR });
  run(`git commit -m "Fix: ${candidate.title.slice(0, 60)} (closes #${candidate.issueNumber})"`, { cwd: WORK_DIR });
  run(`git push origin "${branch}"`, { cwd: WORK_DIR });

  const body = [
    `Draft PR proposing a fix for #${candidate.issueNumber}.`,
    ``,
    `This was drafted by an AI assistant after the maintainer indicated the offer in that issue was welcome. It has NOT been tested against your suite beyond a syntax check, and is left as a **draft** on purpose — please review the diff carefully before merging, and treat this as a starting point rather than a finished fix.`,
    ``,
    `Closes #${candidate.issueNumber}.`,
  ].join("\n");

  return GithubBounty.ghFetch(`/repos/${candidate.owner}/${candidate.repo}/pulls`, {
    method: "POST",
    body: {
      title: `Fix: ${candidate.title}`,
      head: branch,
      base: "main",
      body,
      draft: true,
    },
  });
}

// ── ENTRY POINT ──────────────────────────────────────────────────
async function codeCandidate(id) {
  const candidate = GithubBounty.listAwaitingCode().find(c => c.id === Number(id));
  if (!candidate) return { error: `No candidate with id ${id} awaiting code.` };
  if (!GITHUB_TOKEN) return { error: "No GITHUB_BOUNTY_TOKEN configured." };

  try {
    cloneRepo(candidate.owner, candidate.repo);
    const fileList = listRepoFiles();
    const target = await pickTargetFile(candidate, fileList);
    if (!target) {
      GithubBounty.updateCandidateStatus(id, { status: "needs_manual_code", codeNote: "Could not identify a single target file from the repo listing." });
      return { error: "Could not confidently identify which file to change — flagged for manual work.", candidateId: id };
    }

    const fix = await generateFix(candidate, target);
    if (!fix) {
      GithubBounty.updateCandidateStatus(id, { status: "needs_manual_code", codeNote: `Model could not produce a confident fix for ${target}.` });
      return { error: "Model could not produce a confident fix — flagged for manual work.", candidateId: id };
    }

    const guard = passesGuardrails(target, fix.original, fix.fixed);
    if (!guard.ok) {
      GithubBounty.updateCandidateStatus(id, { status: "needs_manual_code", codeNote: guard.reason });
      return { error: `Guardrail rejected the fix: ${guard.reason}`, candidateId: id };
    }

    fs.writeFileSync(fix.fullPath, fix.fixed);
    const pr = await openDraftPr(candidate, target);

    GithubBounty.updateCandidateStatus(id, {
      status: "pr_opened",
      prUrl: pr.html_url,
      prNumber: pr.number,
      codedFile: target,
      codedAt: new Date().toISOString(),
    });
    return { candidateId: id, prUrl: pr.html_url, file: target };
  } catch (e) {
    const note = /403|permission/i.test(e.message)
      ? `Push/PR failed (${e.message}). GITHUB_BOUNTY_TOKEN likely only has Issues read/write — it also needs Contents: write (or fork) permission on the target repo to open a PR.`
      : e.message;
    GithubBounty.updateCandidateStatus(id, { status: "needs_manual_code", codeNote: note });
    return { error: note, candidateId: id };
  } finally {
    if (fs.existsSync(WORK_DIR)) fs.rmSync(WORK_DIR, { recursive: true, force: true });
  }
}

// Runs codeCandidate() for every awaiting_code candidate — called
// from scheduled-bounty-scan.js after checkPostedForReplies().
async function codeAllAwaiting() {
  const results = [];
  for (const c of GithubBounty.listAwaitingCode()) {
    results.push(await codeCandidate(c.id));
  }
  return results;
}

module.exports = { codeCandidate, codeAllAwaiting };
