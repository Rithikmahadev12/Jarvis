// ── Camb.ai key diagnostic ──────────────────────────────────────────
// Run this directly to test every CAMB_API_KEY* in your .env one at a
// time, with a generous timeout and full response detail. This bypasses
// tts.js's rotation logic entirely so you can see exactly what each key
// does on its own, instead of guessing from the interleaved app logs.
//
// Usage:
//   node test-camb-keys.js
//
// Requires: node_modules already installed (uses dotenv, already a
// dependency in package.json) and a .env file in this same folder.

require("dotenv").config();

const CAMB_URL = "https://client.camb.ai/apis/tts-stream";
const TIMEOUT_MS = 20000; // generous — we want to know if it EVER responds

function loadKeys() {
  const found = [];
  for (const envName of Object.keys(process.env)) {
    const m = envName.match(/^CAMB_API_KEY(\d*)$/);
    if (!m) continue;
    const raw = process.env[envName];
    if (!raw) continue;
    const key = raw.trim();
    if (key !== raw) console.warn(`  ⚠ ${envName} had whitespace trimmed`);
    const suffix = m[1];
    const voiceEnvName = suffix === "" ? "CAMB_VOICE_ID" : `CAMB_VOICE_ID${suffix}`;
    const voiceId = process.env[voiceEnvName] ? Number(process.env[voiceEnvName].trim()) : 20303;
    found.push({ envName, key, voiceId, sortKey: suffix === "" ? 0 : Number(suffix) });
  }
  found.sort((a, b) => a.sortKey - b.sortKey);
  return found;
}

async function testKey({ envName, key, voiceId }) {
  const masked = `${key.slice(0, 4)}…${key.slice(-4)} (len ${key.length})`;
  const started = Date.now();
  try {
    const res = await fetch(CAMB_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": key },
      body: JSON.stringify({
        text: "Testing.",
        voice_id: voiceId,
        language: "en-us",
        speech_model: "mars-8.1-flash-beta",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(`✅ ${envName} (${masked}) — HTTP ${res.status} in ${ms}ms, ${buf.length} bytes audio. Key is GOOD.`);
    } else {
      const body = await res.text().catch(() => "");
      console.log(`❌ ${envName} (${masked}) — HTTP ${res.status} in ${ms}ms. Body: ${body.slice(0, 200)}`);
    }
  } catch (e) {
    const ms = Date.now() - started;
    const kind = e.name || e.code || "Error";
    console.log(`💀 ${envName} (${masked}) — [${kind}] after ${ms}ms: ${e.message}`);
  }
}

(async () => {
  const keys = loadKeys();
  console.log(`Found ${keys.length} Camb.ai key(s). Testing one at a time (up to ${TIMEOUT_MS / 1000}s each)...\n`);
  for (const k of keys) {
    await testKey(k);
  }
  console.log("\nDone. Read this as:");
  console.log("  - Fast HTTP response (any status) = network to Camb.ai is fine, key itself is good/bad/out-of-credit.");
  console.log("  - 'TimeoutError' after the full 20s = Camb's server accepted the connection but never answered.");
  console.log("    If that happens for SOME keys but a different key gets a normal fast response, the problem is");
  console.log("    specific to those keys/accounts (unverified trial account, silent abuse throttle, etc.) —");
  console.log("    not your network. Worth emailing Camb.ai support with the affected key IDs.");
})();
