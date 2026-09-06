"use strict";
// Run once PER USER: node scripts/register-superteam-agent.js <userKey> [agentName]
//   node scripts/register-superteam-agent.js owner
//   node scripts/register-superteam-agent.js alice jarvis-alice
//
// Saves that user's apiKey/claimCode/agentId to
// data/superteam-configs/<userKey>.json and links a bookkeeping
// wallet via wallet-setup.js's ensureUserWallet(). Each user needs
// their own registration -- a claimCode can only go to one human.

const path = require("path");
const SuperteamAgent = require(path.join(__dirname, "..", "superteam-agent.js"));

async function main() {
  const userKey = process.argv[2];
  if (!userKey) {
    console.error("Usage: node scripts/register-superteam-agent.js <userKey> [agentName]");
    process.exit(1);
  }
  const name = process.argv[3];
  console.log(`Registering Superteam agent for "${userKey}"...`);
  const res = await SuperteamAgent.registerAgent(userKey, name);
  console.log(`\nRegistered. SAVE ${userKey}'s claimCode somewhere safe:\n`);
  console.log("  agentId   :", res.agentId);
  console.log("  username  :", res.username);
  console.log("  claimCode :", res.claimCode, "  <-- this user needs it at superteam.fun/earn/claim/<code>");
  console.log(`\nSaved to data/superteam-configs/${SuperteamAgent.normalizeKey(userKey)}.json`);
}

main().catch(e => {
  console.error("Registration failed:", e.message);
  process.exit(1);
});
