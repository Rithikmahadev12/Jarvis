name: Earn Cycle DEBUG

on:
  workflow_dispatch:
    inputs:
      focus:
        description: "Optional focus e.g. 'crypto bounties'"
        required: false
        default: ""

concurrency:
  group: earn-cycle-debug
  cancel-in-progress: true

jobs:
  earn-debug:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - name: Checkout repo
        uses: actions/checkout@v4

      - name: Set up Node
        uses: actions/setup-node@v4
        with:
          node-version: "22"

      - name: Install dependencies
        run: npm install --omit=dev

      - name: Write debug runner
        run: |
          cat > /tmp/earn-debug-runner.js << 'JSEOF'
          "use strict";
          const fs   = require("fs");
          const path = require("path");
          const ROOT = process.cwd();

          const C = {
            reset:"\x1b[0m", bold:"\x1b[1m", dim:"\x1b[2m",
            red:"\x1b[31m", green:"\x1b[32m", yellow:"\x1b[33m",
            cyan:"\x1b[36m", mag:"\x1b[35m", blue:"\x1b[34m",
          };
          const tag = (col, lbl, ...a) => console.log(`${col}${C.bold}[${lbl}]${C.reset}`, ...a);
          const log  = (...a) => tag(C.cyan,   "TRACE",  ...a);
          const ok   = (...a) => tag(C.green,  "OK",     ...a);
          const warn = (...a) => tag(C.yellow, "WARN",   ...a);
          const err  = (...a) => tag(C.red,    "ERR",    ...a);
          const step = (...a) => tag(C.mag,    "STEP",   ...a);
          const sl   = (...a) => tag(C.blue,   "SIGNUP", ...a);
          function jPath(f) { return path.join(ROOT, f); }

          async function main() {
            const REQUIRED = [
              "SUPABASE_URL","SUPABASE_SERVICE_ROLE_KEY","GROQ_API_KEY",
              "AGENTMAIL_API_KEY","E2B_API_KEY",
            ];
            const missing = REQUIRED.filter(k => !process.env[k]);
            if (missing.length) missing.forEach(k => warn(`Missing secret: ${k}`));
            else ok("All required secrets present ✓");

            process.env.JARVIS_HEADLESS = "1";
            process.env.EARN_FORCE      = "1";

            // ── Force sandbox Ollama FIRST, Groq as last resort ─
            try {
              const Hermes  = require(jPath("hermes-engine"));
              const Computer = require(jPath("computer"));

              // Intercept groqFetch — the single entry point earn-brain uses
              const origGroqFetch = Hermes.groqFetch.bind(Hermes);
              Hermes.groqFetch = async function(msgs, ...rest) {
                const last = [...msgs].reverse().find(m => m.role === "user");
                const isPick = String(last?.content || "").includes("signups");
                if (isPick) {
                  step("LLM → pickSignupCandidates fired");
                  log("Prompt snippet:", String(last.content).slice(0,200).replace(/\n/g," "));
                }

                // Try sandbox Ollama first
                if (Computer.isDesktopConfigured()) {
                  try {
                    log("[HERMES-PATCH] Trying sandbox Ollama first...");
                    const resp = await Computer.ollamaText(msgs);
                    if (isPick) log("Sandbox Ollama response:", String(resp).slice(0,500));
                    ok("[HERMES-PATCH] Sandbox Ollama succeeded ✓");
                    return resp;
                  } catch(e) {
                    warn("[HERMES-PATCH] Sandbox Ollama failed:", e.message, "— falling back to Groq");
                  }
                } else {
                  warn("[HERMES-PATCH] E2B not configured — sandbox Ollama unavailable, using Groq");
                }

                const resp = await origGroqFetch(msgs, ...rest);
                if (isPick) log("Groq fallback response:", String(resp).slice(0,500));
                return resp;
              };
              ok("Hermes patched — sandbox Ollama first ✓");
            } catch(e) { warn("Hermes patch failed:", e.message); }

            // ── Patch Signup ────────────────────────────────────
            let Signup;
            try {
              Signup = require(jPath("earn-signup"));
              const orig = Signup.runSignups.bind(Signup);

              Signup.runSignups = async function(opts) {
                const { candidates = [], isKnownBlocked } = opts || {};
                step(`runSignups called — ${candidates.length} candidate(s)`);

                if (candidates.length === 0) {
                  warn("ZERO candidates — diagnosing...");
                  const accts = Signup.listAccounts();
                  if (accts.length) {
                    warn(`Already have ${accts.length} account(s) — brain skipped re-signup:`);
                    accts.forEach(a => warn(`  • ${a.host}  status=${a.status}`));
                  } else {
                    warn("No existing accounts — LLM returned empty signups[] array.");
                    warn("Check GROQ_API_KEY and that brain found actual web results.");
                  }
                  return [];
                }

                for (const c of candidates) {
                  let host = "?";
                  try { host = new URL(c.url).hostname.replace(/^www\./, ""); } catch {}
                  const blocked = typeof isKnownBlocked === "function" ? isKnownBlocked(host) : false;
                  sl(`${blocked ? "🚫 BLOCKED" : "🟢 QUEUED"}  ${host}`);
                  sl(`   url="${c.url}"  why="${c.why}"`);
                }

                const results = await orig(opts);

                step(`runSignups done — ${results.length} result(s)`);
                for (const r of results) {
                  const icon =
                    r.status === "verified" || r.status === "created" ? "✅" :
                    r.status === "skipped"  ? "⏭️ " :
                    r.status === "blocked"  ? "🚫" : "❌";
                  sl(`${icon} ${r.host}  status=${r.status}  email=${r.email || "-"}  note=${r.note || "-"}`);
                }
                return results;
              };

              const accts = Signup.listAccounts();
              step(`Existing earn accounts: ${accts.length}`);
              accts.forEach(a => log(`  • ${a.host}  status=${a.status}  email=${a.email || "-"}`));
              ok("Signup patched ✓");
            } catch(e) { err("Signup patch failed:", e.message); }

            // ── Load Brain ──────────────────────────────────────
            let Brain;
            try {
              Brain = require(jPath("earn-brain"));
              if (typeof Brain.runCycle !== "function") {
                err("runCycle not found — earn-brain exports:", Object.keys(Brain).join(", "));
                process.exit(1);
              }
              ok(`earn-brain loaded ✓  exports: ${Object.keys(Brain).join(", ")}`);
            } catch(e) {
              err("earn-brain load failed:", e.message);
              process.exit(1);
            }

            // ── Dump earn status ────────────────────────────────
            try {
              const st = Brain.status();
              step("Earn status before run:");
              log("  enabled   :", st.enabled);
              log("  lastRunAt :", st.lastRunAt ? new Date(st.lastRunAt).toISOString() : "never");
              log("  accounts  :", (st.accounts || []).map(a => `${a.host}=${a.status}`).join(", ") || "none");
            } catch(e) { warn("status() failed:", e.message); }

            // ── Supabase pull ───────────────────────────────────
            try {
              const P = require(jPath("persistence.js"));
              if (P.isConfigured()) {
                step("Pulling state from Supabase...");
                await P.pullAll();
                ok("Supabase pull done ✓");
              } else {
                warn("Persistence not configured — SUPABASE vars missing");
              }
            } catch(e) { warn("Supabase pull failed:", e.message); }

            // ── Run ─────────────────────────────────────────────
            step("Calling EarnBrain.runCycle()...");
            try {
              const r = await Brain.runCycle({
                trigger: "debug-action",
                focus: process.env.EARN_FOCUS || "",
              });

              console.log();
              ok("runCycle completed ✓");
              log("ideas   :", (r.ideas   || []).length);
              log("signups :", (r.signups || []).length);
              log("summary :", r.summary  || "(none)");
              log("error   :", r.error    || "none");

              if ((r.signups || []).length === 0 && (r.ideas || []).length > 0) {
                warn("Had ideas but ZERO signups — possible causes:");
                warn("  1. All ideas were informational (no account needed)");
                warn("  2. LLM returned empty signups[] — verify GROQ_API_KEY works");
                warn("  3. EARN_MAX_SIGNUPS=0 or all candidates blocked by brain memory");
              }
            } catch(e) {
              err("runCycle THREW:", e.message);
              console.error(C.dim + (e.stack || "") + C.reset);
              process.exit(1);
            }
          }

          main();
          JSEOF

      - name: Run earn debug
        env:
          EARN_FORCE:                "1"
          EARN_FOCUS:                ${{ github.event.inputs.focus }}
          SUPABASE_URL:              ${{ secrets.SUPABASE_URL }}
          SUPABASE_SERVICE_ROLE_KEY: ${{ secrets.SUPABASE_SERVICE_ROLE_KEY }}
          SUPABASE_BUCKET:           ${{ secrets.SUPABASE_BUCKET }}
          E2B_API_KEY:               ${{ secrets.E2B_API_KEY }}
          FIRECRAWL_API_KEY:         ${{ secrets.FIRECRAWL_API_KEY }}
          AGENTMAIL_API_KEY:         ${{ secrets.AGENTMAIL_API_KEY }}
          AGENTMAIL_DOMAIN:          ${{ secrets.AGENTMAIL_DOMAIN }}
          EARN_VAULT_KEY:            ${{ secrets.EARN_VAULT_KEY }}
          EARN_MAX_SIGNUPS:          "2"
          JARVIS_SIGNUP_NAME:        "Jarvis"
          GROQ_API_KEY:              ${{ secrets.GROQ_API_KEY }}
          GROQ_API_KEY2:             ${{ secrets.GROQ_API_KEY2 }}
          GROQ_MODEL:                ${{ secrets.GROQ_MODEL }}
          GITHUB_TOKEN:              ${{ secrets.GH_PAT }}
          GITHUB_REPO:               ${{ github.repository }}
          GITHUB_BRANCH:             main
          SOLANA_RPC_URL:            ${{ secrets.SOLANA_RPC_URL }}
        run: node /tmp/earn-debug-runner.js
