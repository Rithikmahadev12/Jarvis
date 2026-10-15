"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Earning Lab
//
// Lets Jarvis improve its own EARNING code safely:
//   1. Asks the model for small find/replace patches (not a whole-file
//      rewrite, so big files can't get truncated).
//   2. Applies them inside safe-deploy.js's throwaway clone and runs
//      every existing guard (syntax, nothing removed, exports intact,
//      app still boots).
//   3. Extra checks here: no routes lost, and the new code may not
//      reach for wallet keys, the approval gate, the deploy pipeline,
//      shell access or eval.
//   4. Shows an Allow / Deny card with a plain summary of the change.
//      Only on Allow does it push (branch → PR → merge) via
//      github-deploy.js. There is no "Always" for code updates.
//
// Only files in ALLOWED_TARGETS can be edited, and safe-deploy.js
// refuses anything on its PROTECTED_FILES list regardless.
// ═══════════════════════════════════════════════════════════════
const Approvals  = require("./approvals");
const SafeDeploy = require("./safe-deploy");
const Groq       = require("./hermes-engine");

const ALLOWED_TARGETS = new Set([
  "earn-brain.js", "github-bounty.js", "bounty-coder.js", "superteam-agent.js",
  "helio-store.js", "store-routes.js", "direct-store.js", "lead-finder.js",
  "outreach-agent.js", "business-clients.js", "sixtyfour.js", "site-builder.js",
]);

// Newly-introduced references that an earning-code change must never contain.
const FORBIDDEN_NEW = [
  /wallet-keys|wallet\.json|getPrivateKey|secretArray|secretBase58|WALLET_ENCRYPTION_SECRET/,
  /wallet-ops|wallet-policy|approval-rules|safe-deploy|github-deploy|earn-lab/,
  /child_process|\beval\s*\(|new\s+Function\s*\(/,
  /process\.env\.(GITHUB_TOKEN|SUPABASE_SERVICE_ROLE_KEY)/,
];

let running = false;

function extractJson(text) {
  const t = String(text || "").replace(/```json|```/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Model didn't return JSON");
  return JSON.parse(t.slice(a, b + 1));
}

// ── outline of top-level declarations, used for big files ───────
function outline(code) {
  const lines = code.split("\n");
  const marks = [];
  lines.forEach((ln, i) => {
    const m = ln.match(/^(?:async\s+)?function\s+(\w+)/) || ln.match(/^(?:const|let|var)\s+(\w+)\s*=/);
    if (m) marks.push({ name: m[1], line: i });
  });
  return marks.map((m, k) => ({
    name: m.name,
    start: m.line,
    end: k + 1 < marks.length ? marks[k + 1].line : lines.length,
  }));
}
function sectionText(code, sec) { return code.split("\n").slice(sec.start, sec.end).join("\n"); }

function routesOf(code) {
  const set = new Set();
  const re = /\b(?:app|router)\.(get|post|put|delete|patch|use)\(\s*["'`]([^"'`]+)/g;
  let m; while ((m = re.exec(code))) set.add(`${m[1].toUpperCase()} ${m[2]}`);
  return set;
}

function applyPatches(code, patches) {
  let out = code;
  for (const p of patches) {
    if (typeof p.find !== "string" || typeof p.replace !== "string" || !p.find) throw new Error("A patch was malformed");
    const first = out.indexOf(p.find);
    if (first < 0) throw new Error("A patch's 'find' text wasn't in the file");
    if (out.indexOf(p.find, first + 1) >= 0) throw new Error("A patch's 'find' text matched more than once");
    out = out.slice(0, first) + p.replace + out.slice(first + p.find.length);
  }
  return out;
}

function lineStats(a, b) {
  const A = new Map(), B = new Map();
  a.split("\n").forEach(l => A.set(l, (A.get(l) || 0) + 1));
  b.split("\n").forEach(l => B.set(l, (B.get(l) || 0) + 1));
  let added = 0, removed = 0;
  for (const [l, n] of B) added += Math.max(0, n - (A.get(l) || 0));
  for (const [l, n] of A) removed += Math.max(0, n - (B.get(l) || 0));
  return { added, removed };
}

// ── patch generation ────────────────────────────────────────────
async function askForPatches(file, change, code) {
  let context;
  if (code.length <= 26000) {
    context = `FULL FILE (${file}):\n${code}`;
  } else {
    const sections = outline(code);
    const listing = sections.map(s => `${s.name} (lines ${s.start + 1}-${s.end})`).join("\n");
    const pick = extractJson(await Groq.groqFetch([
      { role: "system", content: "Reply with JSON only." },
      { role: "user", content: `File ${file} is large. Task: ${change}\n\nDeclarations:\n${listing}\n\nReturn {"names":["up to 3 declaration names most relevant to the task"]}` },
    ], undefined, 0.1, 300));
    const names = new Set((pick.names || []).slice(0, 3));
    const chosen = sections.filter(s => names.has(s.name));
    if (!chosen.length) throw new Error("Couldn't work out which part of the file to change");
    context = `EXCERPTS from ${file} (the rest of the file exists but isn't shown):\n` +
      chosen.map(s => `// ---- ${s.name} ----\n${sectionText(code, s)}`).join("\n\n");
  }
  const raw = await Groq.groqFetch([
    { role: "system", content: "You make minimal, careful code edits. Reply with JSON only." },
    { role: "user", content:
`IMPROVEMENT TO MAKE (this is code that earns money legitimately for its owner — bounties, store sales, freelance leads):
${change}

${context}

RULES:
1. Make the smallest change that does the job. Do not refactor or rename anything else.
2. Never remove or rename an existing function, export or route.
3. Do not touch wallets, private keys, approvals, deploys, shell access or env secrets.
4. Reply with JSON: {"summary":"one plain sentence","patches":[{"find":"EXACT existing text, unique in the file","replace":"new text"}]}
   Each "find" must be copied exactly from the file shown above and occur once. Max 4 patches.` },
  ], undefined, 0.2, 3500);
  const parsed = extractJson(raw);
  if (!Array.isArray(parsed.patches) || !parsed.patches.length) throw new Error("Model proposed no changes");
  return { patches: parsed.patches.slice(0, 4), summary: String(parsed.summary || change).slice(0, 300) };
}

// ── the public entry point ──────────────────────────────────────
async function run({ file, change, why = "" } = {}) {
  if (running) return { error: "The lab is already working on a change." };
  const rel = String(file || "").replace(/\\/g, "/").replace(/^\.?\//, "");
  if (!change || String(change).length < 10) return { error: "Describe the change you want (a sentence or two)." };
  if (SafeDeploy.isProtected(rel)) return { error: `${rel} is protected (money, keys, approvals or deploy) — the lab can't edit it.` };
  if (!ALLOWED_TARGETS.has(rel)) return { error: `The lab only edits earning files: ${[...ALLOWED_TARGETS].join(", ")}.` };
  if (!process.env.GITHUB_TOKEN || !process.env.GITHUB_REPO) return { error: "GITHUB_TOKEN and GITHUB_REPO must be set for the lab to push changes." };

  running = true;
  Approvals.step("Earning lab", `Preparing a change to ${rel} in a sandbox copy`, "running");
  let proposal = null;
  try {
    const report = await SafeDeploy.runSafeSelfHeal({
      relFilePath: rel,
      bugDescription: String(change).slice(0, 200),
      autoMerge: process.env.JARVIS_HEADLESS !== "1",   // headless = open a PR, never merge
      generate: async (orig) => {
        proposal = await askForPatches(rel, change, orig);
        return applyPatches(orig, proposal.patches);
      },
      beforeShip: async ({ originalCode, fixedCode }) => {
        // routes must survive
        const before = routesOf(originalCode), after = routesOf(fixedCode);
        const lost = [...before].filter(r => !after.has(r));
        if (lost.length) return { ok: false, reason: `The change would remove routes: ${lost.join(", ")}` };
        // no new sensitive references
        for (const re of FORBIDDEN_NEW) {
          if (re.test(fixedCode) && !re.test(originalCode)) {
            return { ok: false, reason: `The change introduced a forbidden reference (${re}). Rejected.` };
          }
        }
        const { added, removed } = lineStats(originalCode, fixedCode);
        const touched = outline(fixedCode)
          .filter(sec => !outline(originalCode).some(o => o.name === sec.name && sectionText(originalCode, o) === sectionText(fixedCode, sec)))
          .map(s => s.name).slice(0, 6);
        const detail = [
          proposal?.summary || change,
          why ? `Why: ${why}` : "",
          `File: ${rel}   (+${added} / −${removed} lines)`,
          touched.length ? `Touches: ${touched.join(", ")}` : "",
          "Checked in a sandbox: syntax OK, nothing removed, routes intact, app boots.",
          "Allow = push to your repo and merge. Render redeploys from it.",
        ].filter(Boolean).join("\n");
        const decision = await Approvals.request({
          kind: "code-update", risk: "high",
          title: `Update ${rel}?`,
          detail,
          // no ruleKey: code updates can never be "Always allowed"
        });
        return decision === "deny" ? { ok: false, reason: "You denied the update." } : { ok: true };
      },
    });
    if (report.success) {
      const url = report.ship?.pr?.html_url || "";
      const merged = !!report.ship?.merged;
      Approvals.step(merged ? "Earning lab: update shipped" : "Earning lab: pull request opened (waiting for you to merge)", `${rel}${url ? "\n" + url : ""}`, "done");
      return { success: true, file: rel, summary: proposal?.summary, pr: url, merged };
    }
    Approvals.step("Earning lab: stopped", `${report.failedAt || "error"}: ${report.reason || ""}`, "error");
    return { success: false, stage: report.failedAt, reason: report.reason };
  } catch (e) {
    Approvals.step("Earning lab: error", e.message, "error");
    return { success: false, reason: e.message };
  } finally {
    running = false;
  }
}

module.exports = { run, ALLOWED_TARGETS, _test: { applyPatches, routesOf, outline, lineStats, FORBIDDEN_NEW } };
