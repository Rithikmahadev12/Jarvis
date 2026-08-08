"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — GitHub Deploy Helpers
// Thin wrapper around the GitHub REST API for branches/commits/PRs.
//
// v2 additions (for safe-deploy.js):
//   - getBranchSha()     exported (was internal-only before)
//   - updateBranchRef()  force-move a branch ref -> used for rollback
//   - getFileContent()   read a file's current content from a branch
// Nothing about the original behavior changed — only new exports added.
// ═══════════════════════════════════════════════════════════════
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const REPO   = process.env.GITHUB_REPO;   // "yourname/jarvis"
const BRANCH = process.env.GITHUB_BRANCH || "main";

async function gh(url, opts = {}) {
  const res = await fetch(`https://api.github.com${url}`, {
    ...opts,
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function getBranchSha(branch) {
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${branch}`);
  return ref.object.sha;
}

async function createFeatureBranch(name) {
  const baseSha = await getBranchSha(BRANCH);
  await gh(`/repos/${REPO}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${name}`, sha: baseSha }),
  });
  return name;
}

async function commitFile(filePath, content, message, branch = BRANCH) {
  const url = `/repos/${REPO}/contents/${filePath}`;
  let existingSha = null;
  try { existingSha = (await gh(`${url}?ref=${branch}`)).sha; } catch {}
  return gh(url, {
    method: "PUT",
    body: JSON.stringify({
      message, branch,
      content: Buffer.from(content).toString("base64"),
      sha: existingSha,
    }),
  });
}

async function openPullRequest(branch, title, body) {
  return gh(`/repos/${REPO}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body, head: branch, base: BRANCH }),
  });
}

async function mergePullRequest(prNumber) {
  return gh(`/repos/${REPO}/pulls/${prNumber}/merge`, { method: "PUT" });
}

// ── NEW ────────────────────────────────────────────────────────

// Force a branch's ref to point at a specific commit SHA.
// Used by safe-deploy.js to roll `main` back to a known-good backup
// commit if something ever needs to be undone after a merge.
async function updateBranchRef(branch, sha, force = true) {
  return gh(`/repos/${REPO}/git/refs/heads/${branch}`, {
    method: "PATCH",
    body: JSON.stringify({ sha, force }),
  });
}

// Read a file's current raw content + sha from a given branch (default: main).
async function getFileContent(filePath, branch = BRANCH) {
  const url = `/repos/${REPO}/contents/${filePath}?ref=${branch}`;
  const data = await gh(url);
  const content = Buffer.from(data.content, "base64").toString("utf8");
  return { content, sha: data.sha };
}

module.exports = {
  createFeatureBranch,
  commitFile,
  openPullRequest,
  mergePullRequest,
  getBranchSha,
  updateBranchRef,
  getFileContent,
  REPO,
  BRANCH,
};
