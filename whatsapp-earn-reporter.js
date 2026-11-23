"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Earn Reporter
//
// Every 7 days, for every registered WhatsApp user:
//   1. Checks their earn-brain journal to see what they made
//   2. If earnings are low / zero → AI brainstorms a new idea
//   3. Texts the USER with the idea, asks "want me to try this?"
//   4. If user says yes → texts the OWNER on WhatsApp
//   5. Owner says yes → owner commands Jarvis to build/deploy idea
//      (same earn-lab.js → safe-deploy.js approval pipeline as normal)
//
// The weekly check runs as a setInterval from startWeeklyReporter().
// User replies ("yes" / "no") are intercepted in the poller via
// processEarnReply() exported here.
// ═══════════════════════════════════════════════════════════════

const Manager = require("./whatsapp-manager");
const Sender  = require("./whatsapp-send");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// How much weekly SOL is "good enough" — below this we suggest ideas
const LOW_EARN_THRESHOLD_SOL = 0.01;

// Pending earn-idea proposals waiting for user YES/NO
// userKey -> { idea, proposedAt }
const pendingProposals = new Map();

// Pending owner approvals waiting for owner YES/NO
// ownerKey -> { targetUserKey, idea }
const pendingOwnerApprovals = new Map();

// ── lazy-load heavy modules ───────────────────────────────────────
let _earnBrain = null;
function getEarnBrain() {
  if (!_earnBrain) _earnBrain = require("../earn-brain");
  return _earnBrain;
}

let _brain = null;
function getBrain() {
  if (!_brain) _brain = require("../hermes-engine");
  return _brain;
}

let _solanaWallet = null;
function getSolanaWallet() {
  if (!_solanaWallet) _solanaWallet = require("../solana-wallet");
  return _solanaWallet;
}

// ── get this week's earnings for a user ──────────────────────────
async function getWeeklyEarnings(userKey) {
  try {
    const journal = getEarnBrain().getJournal() || [];
    const cutoff  = Date.now() - WEEK_MS;
    const recent  = journal.filter(e => e.userKey === userKey && new Date(e.recordedAt || 0).getTime() > cutoff);
    const total   = recent.reduce((sum, e) => sum + (parseFloat(e.amountSol) || 0), 0);
    return { entries: recent, totalSol: total };
  } catch {
    return { entries: [], totalSol: 0 };
  }
}

// ── AI brainstorms a new earning idea ────────────────────────────
async function brainstormIdea(account, weeklyData) {
  const Brain = getBrain();
  const { entries, totalSol } = weeklyData;

  const pastIdeas = entries.map(e => e.strategy || e.idea || e.description).filter(Boolean).join("; ") || "none yet";

  const prompt = [
    `You are Jarvis, an AI earning strategist for ${account.name}.`,
    `Their Solana wallet: ${account.walletAddress || "not set"}.`,
    `This past week they earned ${totalSol.toFixed(4)} SOL via automated strategies.`,
    `Past strategies tried: ${pastIdeas}.`,
    ``,
    `Suggest ONE new, concrete earning idea that is:`,
    `- Legal and legitimate`,
    `- Automatable by an AI agent (no human manual work)`,
    `- Likely to earn more than ${LOW_EARN_THRESHOLD_SOL} SOL/week`,
    `- Different from what's already been tried`,
    ``,
    `Reply in this exact JSON format, nothing else:`,
    `{"idea": "one sentence idea", "why": "one sentence reason it will work", "firstStep": "first concrete action to take"}`,
  ].join("\n");

  try {
    const res = await Brain.chat({
      system:    "You are a concise earning strategist. Reply ONLY in the JSON format requested.",
      messages:  [{ role: "user", content: prompt }],
      userKey:   account.userKey,
      maxTokens: 400,
    });
    const text = typeof res === "string" ? res : res?.content?.[0]?.text || "{}";
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch {
    return {
      idea:      "Try submitting to AI bounty platforms like AgentBounty.org",
      why:       "They pay SOL for completed AI tasks and Jarvis can tackle them automatically.",
      firstStep: "Register on AgentBounty.org and scan for available bounties.",
    };
  }
}

// ── format the weekly report message ─────────────────────────────
function formatReportMessage(account, weeklyData, ideaObj) {
  const { totalSol } = weeklyData;
  const earnedLine = totalSol > LOW_EARN_THRESHOLD_SOL
    ? `✅ You earned *${totalSol.toFixed(4)} SOL* this week — solid.`
    : `📉 This week's earnings: *${totalSol.toFixed(4)} SOL* — lower than expected.`;

  return [
    `Hey ${account.name}, here's your weekly Jarvis earnings report:`,
    ``,
    earnedLine,
    ``,
    `💡 *New idea I want to try for you:*`,
    `${ideaObj.idea}`,
    ``,
    `*Why it'll work:* ${ideaObj.why}`,
    `*First step:* ${ideaObj.firstStep}`,
    ``,
    `Want me to pitch this to the owner to get it built? Reply *yes* or *no*.`,
  ].join("\n");
}

// ── run the weekly check for one account ─────────────────────────
async function runWeeklyCheckForUser(account) {
  if (!account.earnEnabled) return;
  if (!account.whatsappApiKey) return;

  // Check if we already sent a report this week
  const lastReport = account.lastWeeklyReportAt ? new Date(account.lastWeeklyReportAt).getTime() : 0;
  if (Date.now() - lastReport < WEEK_MS) return;

  console.log(`[WA-EARN] Running weekly check for ${account.name}`);

  const weeklyData = await getWeeklyEarnings(account.userKey);

  // Always send report + idea (even if earning well — give them options)
  const ideaObj = await brainstormIdea(account, weeklyData);
  const message = formatReportMessage(account, weeklyData, ideaObj);

  try {
    await Sender.sendText(account.whatsappApiKey, message);
    pendingProposals.set(account.userKey, { idea: ideaObj, proposedAt: Date.now() });
    Manager.setLastWeeklyReport(account.userKey, new Date().toISOString());
    console.log(`[WA-EARN] Sent weekly report to ${account.name}`);
  } catch (e) {
    console.error(`[WA-EARN] Failed to send report to ${account.name}:`, e.message);
  }
}

// ── run weekly check for ALL users ───────────────────────────────
async function runAllWeeklyChecks() {
  const accounts = Manager.getAllAccounts().filter(a => a.role !== "owner");
  for (const account of accounts) {
    await runWeeklyCheckForUser(account).catch(e =>
      console.error(`[WA-EARN] Weekly check error for ${account.userKey}:`, e.message)
    );
  }
}

// ── handle user reply to earn proposal (yes/no) ───────────────────
/**
 * Call this from the poller when a user sends a message and there's a pending proposal.
 * Returns a reply string if this was an earn-reply, null otherwise.
 */
async function processEarnReply(account, text) {
  const proposal = pendingProposals.get(account.userKey);
  if (!proposal) return null;

  const lower = (text || "").toLowerCase().trim();
  const isYes = /^(yes|yeah|yep|sure|ok|okay|do it|go|yup|absolutely)/.test(lower);
  const isNo  = /^(no|nope|nah|not|skip|pass|dont|don't)/.test(lower);

  if (!isYes && !isNo) return null; // not a yes/no — not an earn reply

  if (isNo) {
    pendingProposals.delete(account.userKey);
    return "Got it — skipping that idea. I'll come up with something new next week. 👍";
  }

  // YES — ping the owner
  const owner = Manager.getOwnerAccount();
  if (!owner || !owner.whatsappApiKey) {
    pendingProposals.delete(account.userKey);
    return "I'll pass this along to the owner — no owner WhatsApp set up yet though. Tell them directly!";
  }

  // Store pending owner approval
  pendingOwnerApprovals.set(owner.userKey, {
    targetUserKey: account.userKey,
    idea:          proposal.idea,
  });

  const ownerMsg = [
    `💡 *Earn Idea Request from ${account.name}:*`,
    ``,
    `*Idea:* ${proposal.idea.idea}`,
    `*Why:* ${proposal.idea.why}`,
    `*First step:* ${proposal.idea.firstStep}`,
    ``,
    `${account.name} said YES to pitching this. Want me to build it?`,
    `Reply *yes* to approve or *no* to pass.`,
  ].join("\n");

  try {
    await Sender.sendText(owner.whatsappApiKey, ownerMsg);
  } catch (e) {
    console.error(`[WA-EARN] Failed to message owner:`, e.message);
  }

  pendingProposals.delete(account.userKey);
  return `I've sent the idea to the owner for approval. I'll let you know what they say! 🚀`;
}

// ── handle owner reply to earn approval (yes/no) ──────────────────
/**
 * Call this from the poller when the OWNER sends a message and there's a pending approval.
 * Returns a reply string if this was an owner-approval, null otherwise.
 */
async function processOwnerEarnApproval(account, text) {
  if (account.role !== "owner") return null;
  const approval = pendingOwnerApprovals.get(account.userKey);
  if (!approval) return null;

  const lower  = (text || "").toLowerCase().trim();
  const isYes  = /^(yes|yeah|yep|sure|ok|okay|do it|go|yup|absolutely)/.test(lower);
  const isNo   = /^(no|nope|nah|not|skip|pass|dont|don't)/.test(lower);

  if (!isYes && !isNo) return null;

  pendingOwnerApprovals.delete(account.userKey);

  if (isNo) {
    // Notify the user
    const targetAccount = Manager.getAccount(approval.targetUserKey);
    if (targetAccount?.whatsappApiKey) {
      await Sender.sendText(targetAccount.whatsappApiKey, "The owner passed on that idea for now — but I'll keep thinking of new ones for you! 💪").catch(() => {});
    }
    return "Got it — passed on that idea. I'll suggest a different one next cycle.";
  }

  // YES — trigger earn-lab to actually build/deploy the idea
  const EarnBrain = getEarnBrain();
  try {
    EarnBrain.runCycle({ trigger: "whatsapp-approved-idea", focus: approval.idea.idea }).catch(() => {});
  } catch (e) {
    console.error(`[WA-EARN] Failed to trigger earn cycle:`, e.message);
  }

  // Notify the target user
  const targetAccount = Manager.getAccount(approval.targetUserKey);
  if (targetAccount?.whatsappApiKey) {
    await Sender.sendText(
      targetAccount.whatsappApiKey,
      `✅ Owner approved it! Jarvis is now working on: *${approval.idea.idea}*\n\nI'll update you on progress. 🚀`
    ).catch(() => {});
  }

  return `✅ Approved! Triggering earn cycle for: *${approval.idea.idea}*`;
}

// ── start the weekly scheduler ────────────────────────────────────
let _weeklyTimer = null;

function startWeeklyReporter() {
  if (_weeklyTimer) return;
  // Run once after 60s to catch any missed checks on restart
  setTimeout(() => runAllWeeklyChecks().catch(() => {}), 60 * 1000);
  // Then every 6 hours — the per-user check skips if < 7 days since last report
  _weeklyTimer = setInterval(() => {
    runAllWeeklyChecks().catch(() => {});
  }, 6 * 60 * 60 * 1000);
  console.log("[WA-EARN] Weekly earn reporter started.");
}

module.exports = {
  startWeeklyReporter,
  processEarnReply,
  processOwnerEarnApproval,
  runWeeklyCheckForUser,
  runAllWeeklyChecks,
};
