// Standalone AgentPhone diagnostic — does NOT use any Jarvis code.
// Run from the Jarvis-main folder (so it can read .env):
//
//   node agentphone-diagnose.js                      -> read-only checks (no call placed, no cost)
//   node agentphone-diagnose.js --call +15035551234  -> ALSO places ONE real test call to that
//                                                       number (use your own phone). May cost money.
//
// It tries the same requests against BOTH api.agentphone.ai and api.agentphone.to
// and prints status + body, so you can see whether the 402 comes from the account
// (code is fine) or from something the code does.

const fs = require("fs");
const path = require("path");

// Minimal .env loader (no dependencies). Real env vars win over .env.
try {
  const raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith("#")) continue;
    if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
} catch { /* no .env — rely on real env vars */ }

const KEY = (process.env.AGENTPHONE_API_KEY || "").trim();
const AGENT_ID = (process.env.AGENTPHONE_AGENT_ID || "").trim();
const NUMBER_ID = (process.env.AGENTPHONE_NUMBER_ID || "").trim();
const tail = (v) => (v ? `…${String(v).slice(-4)}` : "NOT SET");

const callIdx = process.argv.indexOf("--call");
const TEST_TO = callIdx > -1 ? process.argv[callIdx + 1] : null;

const BASES = ["https://api.agentphone.ai/v1", "https://api.agentphone.to/v1"];

async function hit(base, method, urlPath, body) {
  try {
    const res = await fetch(base + urlPath, {
      method,
      headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let shown = text;
    try { shown = JSON.stringify(JSON.parse(text)).slice(0, 600); } catch { shown = text.slice(0, 600); }
    console.log(`   ${method} ${urlPath} -> ${res.status}  ${shown}`);
    return { status: res.status, text };
  } catch (e) {
    console.log(`   ${method} ${urlPath} -> NETWORK ERROR: ${e.message}`);
    return { status: 0, text: "" };
  }
}

(async () => {
  if (!KEY) { console.error("AGENTPHONE_API_KEY not found in .env / environment."); process.exit(1); }
  console.log(`Using key ${tail(KEY)}, agent ${tail(AGENT_ID)}, number ${tail(NUMBER_ID)}`);
  if (!AGENT_ID) console.log("(no AGENTPHONE_AGENT_ID set — agent checks will be skipped)");

  for (const base of BASES) {
    console.log(`\n=== ${base} ===`);
    if (AGENT_ID) {
      await hit(base, "GET", `/agents/${AGENT_ID}`);
      await hit(base, "GET", `/agents/${AGENT_ID}/numbers`);
    }
    if (TEST_TO) {
      console.log("   placing ONE minimal test call (exactly the fields from AgentPhone's docs)...");
      await hit(base, "POST", "/calls", {
        agentId: AGENT_ID,
        toNumber: TEST_TO,
        systemPrompt: "You are a test. Say hello, say this is a connectivity test, then say goodbye and end the call.",
        initialGreeting: "Hi, this is a quick test call.",
      });
    }
  }

  console.log(`
How to read this:
 - Direct call also returns 402 on a host      -> the account/billing side is rejecting it; the Jarvis code is NOT the cause.
                                                  Ask AgentPhone support exactly what "add funds to place outbound calls" needs.
 - Direct call works (200/201) on a host       -> the code/config is the problem. If it's only the .to host, set
                                                  AGENTPHONE_BASE_URL=https://api.agentphone.to/v1 (and the same secret in GitHub/Render).
 - GET /agents/<id>/numbers returns an empty list -> the agent has no number attached; attach one in the dashboard.
 - Network errors on both hosts                -> you're offline or blocked; run it from your PC.
`);
})();
