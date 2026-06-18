"use strict";
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

module.exports = { createFeatureBranch, commitFile, openPullRequest, mergePullRequest };
