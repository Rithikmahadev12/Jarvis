// ═══════════════════════════════════════════════════════════════
// earn-cycle-debug.js  —  JARVIS Earn Pipeline Full Tracer
//
// Drop this next to earn-brain.js and run:
//   node earn-cycle-debug.js
//
// Patches EarnBrain, EarnSignup, and the Supabase sync so every
// step prints exactly what it does and WHY signup fires (or doesn't).
// ═══════════════════════════════════════════════════════════════
"use strict";

const fs   = require("fs");
const path = require("path");

// ── ANSI helpers ────────────────────────────────────────────────
const C = {
  reset  : "\x1b[0m",
  bold   : "\x1b[1m",
  dim    : "\x1b[2m",
  red    : "\x1b[31m",
  green  : "\x1b[32m",
  yellow : "\x1b[33m",
  cyan   : "\x1b[36m",
  mag    : "\x1b[35m",
  blue   : "\x1b[34m",
};
const tag = (color, label, ...args) =>
  console.log(`${color}${C.bold}[${label}]${C.reset}`, ...args);

const log  = (...a) => tag(C.cyan,   "TRACE",   ...a);
const ok   = (...a) => tag(C.green,  "OK",      ...a);
const warn = (...a) => tag(C.yellow, "WARN",    ...a);
const err  = (...a) => tag(C.red,    "ERR",     ...a);
const step = (...a) => tag(C.mag,    "STEP",    ...a);
const signup_log = (...a) => tag(C.blue, "SIGNUP", ...a);

// ── PATCH: intercept require() for earn modules ──────────────────
const Module = require("module");
const _orig  = Module._resolveFilename.bind(Module);

// Resolve paths relative to the Jarvis root
const JARVIS_ROOT = path.resolve(__dirname);
function jPath(name) { return path.join(JARVIS_ROOT, name); }

// ── ENV GUARD: warn about missing vars ─────────────────────────
const REQUIRED_ENV = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "GROQ_API_KEY",
  "EARN_VAULT_KEY",
  "AGENTMAIL_API_KEY",
  "E2B_API_KEY",
];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  warn("Missing env vars — some steps will be skipped or fail:");
  missingEnv.forEach(k => warn(`  • ${k}`));
  console.log();
}

// ── MONKEY-PATCH: Signup.runSignups ─────────────────────────────
function patchSignup() {
  const Signup = require(jPath("earn-signup"));
  const origRunSignups = Signup.runSignups.bind(Signup);

  Signup.runSignups = async function patchedRunSignups(opts) {
    const { candidates = [], isKnownBlocked } = opts || {};

    step("earn-signup.runSignups() CALLED");
    log(`Candidate count: ${candidates.length}`);

    if (candidates.length === 0) {
      warn("⚠️  NO CANDIDATES — this is why signup never fires.");
      warn("   Brain step ran but either:");
      warn("   1. All ideas already have accounts (check data/earn-accounts.json)");
      warn("   2. pickSignupCandidates() returned empty — LLM said nothing to sign up for");
      warn("   3. signup feature is disabled via EARN_MAX_SIGNUPS=0");
      return [];
    }

    for (const c of candidates) {
      signup_log(`Candidate: ${c.url}  why="${c.why}"  idea=${c.idea}`);
      const blocked = typeof isKnownBlocked === "function"
        ? isKnownBlocked(new URL(c.url).hostname.replace(/^www\./, ""))
        : false;
      if (blocked) {
        signup_log(`  ↳ BLOCKED by brain memory — skipping`);
      }
    }

    signup_log("Calling real runSignups now...");
    let results;
    try {
      results = await origRunSignups(opts);
    } catch (e) {
      err("runSignups threw:", e.message);
      throw e;
    }

    step(`Signup results (${results.length}):`);
    for (const r of results) {
      const icon = r.status === "verified" || r.status === "created" ? "✅" :
                   r.status === "skipped"  ? "⏭️ " :
                   r.status === "blocked"  ? "🚫" : "❌";
      signup_log(`  ${icon}  ${r.host}  status=${r.status}  email=${r.email || "-"}  note=${r.note || "-"}`);
    }
    return results;
  };

  return Signup;
}

// ── MONKEY-PATCH: EarnBrain.run ──────────────────────────────────
function patchBrain(Signup) {
  const Brain = require(jPath("earn-brain"));
  const origRun = Brain.run.bind(Brain);

  Brain.run = async function patchedRun(opts) {
    step("earn-brain.run() CALLED", JSON.stringify(opts || {}));

    // Shadow: also log every writeJson so we see when the journal updates
    const origWriteFileSync = fs.writeFileSync.bind(fs);
    fs.writeFileSync = function(p, data, enc) {
      if (typeof p === "string" && p.includes("earn")) {
        log(`fs.writeFileSync → ${path.basename(p)}  (${String(data).length} bytes)`);
      }
      return origWriteFileSync(p, data, enc);
    };

    let result;
    try {
      result = await origRun(opts);
    } catch (e) {
      err("earn-brain.run() threw:", e.message);
      fs.writeFileSync = origWriteFileSync; // restore
      throw e;
    }
    fs.writeFileSync = origWriteFileSync; // restore

    step("earn-brain.run() DONE");
    return result;
  };

  return Brain;
}

// ── CANDIDATE INTERCEPTOR: patch pickSignupCandidates indirectly
//    by wrapping the Groq call and logging LLM output for that step ─
function patchGroq() {
  try {
    const Groq = require(jPath("hermes-engine"));
    const origFetch = Groq.groqFetch.bind(Groq);

    Groq.groqFetch = async function patchedGroqFetch(msgs, ...rest) {
      const lastUser = [...msgs].reverse().find(m => m.role === "user");
      const snippet = lastUser
        ? String(lastUser.content).slice(0, 120).replace(/\n/g, " ")
        : "(no user msg)";

      const isSignupPick = String(lastUser?.content || "").includes("signups");
      if (isSignupPick) {
        step("LLM → pickSignupCandidates call detected");
        log("User msg snippet:", snippet + "...");
      }

      let resp;
      try {
        resp = await origFetch(msgs, ...rest);
      } catch (e) {
        err("groqFetch threw:", e.message);
        throw e;
      }

      if (isSignupPick) {
        log("LLM signup-pick response:", String(resp).slice(0, 400));
      }
      return resp;
    };
  } catch (e) {
    warn("Could not patch hermes-engine:", e.message);
  }
}

// ── SUPABASE SYNC TRACER ─────────────────────────────────────────
function traceSupabase() {
  try {
    const mem = require(jPath("memory-sync"));
    const methods = ["push", "pull", "pushFile", "pullFile"].filter(k => typeof mem[k] === "function");
    for (const m of methods) {
      const orig = mem[m].bind(mem);
      mem[m] = async function(...args) {
        log(`memory-sync.${m}() →`, String(args[0] || "").slice(0, 60));
        return orig(...args);
      };
    }
    ok("Supabase sync tracer attached");
  } catch {
    warn("memory-sync not patchable — skipping Supabase trace");
  }
}

// ── ACCOUNTS DUMP ────────────────────────────────────────────────
function dumpAccounts(Signup) {
  try {
    const accounts = Signup.listAccounts();
    step(`Existing earn accounts (${accounts.length}):`);
    if (accounts.length === 0) {
      log("  (none yet — first run will try to create some)");
    } else {
      for (const a of accounts) {
        const icon = a.status === "verified" ? "✅" : a.status === "blocked" ? "🚫" : "⏳";
        log(`  ${icon}  ${a.host}  status=${a.status}  email=${a.email || "-"}`);
      }
    }
  } catch (e) {
    warn("Could not list accounts:", e.message);
  }
}

// ── EARN STATE DUMP ──────────────────────────────────────────────
function dumpEarnState() {
  try {
    const statePath = path.join(JARVIS_ROOT, "data", "earn-state.json");
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    step("Earn state:");
    log("  enabled   :", s.enabled);
    log("  lastRunAt :", s.lastRunAt ? new Date(s.lastRunAt).toISOString() : "never");
    log("  nextRunAt :", s.lastRunAt
      ? new Date(s.lastRunAt + 24 * 3600 * 1000).toISOString()
      : "immediately");
    if (!s.enabled) {
      warn("⚠️  Earn is DISABLED — set enabled=true in earn-state.json to run");
    }
  } catch {
    log("  earn-state.json not found yet (first run)");
  }
}

// ── JOURNAL DUMP ────────────────────────────────────────────────
function dumpJournal() {
  try {
    const jp = path.join(JARVIS_ROOT, "data", "earn-journal.json");
    const entries = JSON.parse(fs.readFileSync(jp, "utf8"));
    const last = entries[entries.length - 1];
    if (!last) { log("Journal empty"); return; }
    step("Last journal entry:");
    log("  startedAt :", last.startedAt);
    log("  ideas     :", (last.ideas || []).length);
    log("  signups   :", JSON.stringify(last.signups || []));
    const signups = last.signups || [];
    if (signups.length === 0) {
      warn("  → Last run had 0 signup attempts.");
      warn("    Brain output either had no signup-eligible ideas");
      warn("    or all candidates were already in earn-accounts.json.");
    }
  } catch {
    log("  earn-journal.json not found yet");
  }
}

// ── FORCE-RUN OPTION ─────────────────────────────────────────────
// Pass --force to bypass the 24-hour cooldown and run right now
async function forceResetCooldown() {
  const statePath = path.join(JARVIS_ROOT, "data", "earn-state.json");
  try {
    const s = JSON.parse(fs.readFileSync(statePath, "utf8"));
    s.lastRunAt = 0; // reset cooldown
    fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
    ok("Cooldown reset — earn cycle will run immediately");
  } catch {
    // file doesn't exist yet, that's fine
  }
}

// ── MAIN ─────────────────────────────────────────────────────────
(async () => {
  console.log(`\n${C.bold}${C.cyan}════════════════════════════════════════${C.reset}`);
  console.log(`${C.bold}  JARVIS EARN CYCLE — FULL PIPELINE TRACE${C.reset}`);
  console.log(`${C.cyan}════════════════════════════════════════${C.reset}\n`);

  const args   = process.argv.slice(2);
  const force  = args.includes("--force");
  const dryRun = args.includes("--dry");

  if (force) {
    step("--force flag detected — resetting 24h cooldown");
    await forceResetCooldown();
  }

  // Pre-flight dumps
  dumpEarnState();
  console.log();
  dumpJournal();
  console.log();

  // Patch everything
  patchGroq();
  traceSupabase();
  const Signup = patchSignup();
  const Brain  = patchBrain(Signup);
  dumpAccounts(Signup);
  console.log();

  if (dryRun) {
    warn("--dry flag: skipping actual run. Remove --dry to execute.");
    process.exit(0);
  }

  step("Triggering earn-brain.run()...\n");
  try {
    const result = await Brain.run({ trigger: "debug-trace", focus: null });
    console.log();
    ok("Earn cycle completed.");
    if (result) {
      log("Ideas found  :", (result.ideas  || []).length);
      log("Signups done :", (result.signups || []).length);
      log("Summary      :", result.summary || "(none)");
    }
  } catch (e) {
    console.log();
    err("Earn cycle FAILED:", e.message);
    if (e.stack) console.error(C.dim + e.stack + C.reset);
    process.exit(1);
  }

  console.log(`\n${C.cyan}════════════════════════════════════════${C.reset}\n`);
})();
