"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Scheduled Store Poll (runs inside GitHub Actions)
//
// Runs on GitHub's own servers on a schedule (see
// .github/workflows/store-poll.yml), so it works whether your PC is
// on, off, or asleep. Every 10 minutes it:
//
//   1. Pulls data/ down from Supabase so it sees the current orders
//      and catalog (same mechanism persistence.js uses on boot).
//   2. Lists all "pending" orders from direct-store.js and asks
//      solana-wallet.js's findTransactionByReference() whether a
//      payment tagged with that order's reference has landed on
//      chain yet. This is the poll step store-routes.js's comment
//      refers to — there's no processor, so nobody webhooks us.
//   3. For every order that's now paid: marks it paid, records the
//      sale in the ledger, and emails the buyer their deliverable
//      via agent-mail.js (from a "store-delivery" inbox Jarvis owns),
//      then marks the sale delivered.
//   4. Pushes the updated data/ back up to Supabase so the app/
//      dashboard picks up the new order/sale state next time it's
//      opened.
//
// Required Actions secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_BUCKET, SOLANA_WALLET_ADDRESS, SOLANA_RPC_URL (optional),
// AGENTMAIL_API_KEY, AGENTMAIL_DOMAIN (optional).
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const Persistence  = require(path.join(REPO_ROOT, "persistence.js"));
const Store         = require(path.join(REPO_ROOT, "direct-store.js"));
const SolanaWallet  = require(path.join(REPO_ROOT, "solana-wallet.js"));
const AgentMail      = require(path.join(REPO_ROOT, "agent-mail.js"));

const DELIVERY_INBOX_LABEL = "store-delivery";

// Emails the buyer their deliverable, attaching the file if there is
// one. Falls back to a plain "here's your download" text-only email
// if AgentMail isn't configured, so a missed delivery is loud in the
// logs instead of silently skipped.
async function deliverOrder(order, product) {
  if (!AgentMail.isConfigured()) {
    return { error: "AGENTMAIL_API_KEY not set — can't email the buyer their deliverable." };
  }

  const inbox = await AgentMail.getOrCreateInbox(DELIVERY_INBOX_LABEL, {
    displayName: "Jarvis Store",
  });
  if (inbox.error) return inbox;

  const subject = `Your purchase: ${product.name}`;
  const text =
    `Thanks for your order!\n\n` +
    `Product: ${product.name}\n` +
    (order.signature ? `Transaction: ${order.explorerUrl || order.signature}\n\n` : "\n") +
    `Your file is attached to this email.`;

  let attachments;
  const deliverable = product.deliverable;
  if (deliverable?.type === "file" && deliverable.path && fs.existsSync(deliverable.path)) {
    attachments = [{
      filename: path.basename(deliverable.path),
      content: fs.readFileSync(deliverable.path).toString("base64"),
      contentType: deliverable.contentType || "application/octet-stream",
    }];
  }

  return AgentMail.sendMessage(inbox.inbox_id, {
    to: order.buyerEmail,
    subject,
    text,
    attachments,
  });
}

async function main() {
  if (!Persistence.isConfigured()) {
    console.error("[STORE-POLL] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET not set.");
    process.exit(1);
  }

  console.log("[STORE-POLL] Pulling latest state from Supabase...");
  await Persistence.pullAll();

  // Checked AFTER the pull, not before — the wallet address lives in
  // data/wallet-config.json, which only exists locally once pullAll()
  // has fetched it down from Supabase. A fresh checkout (e.g. every
  // GitHub Actions run) has no data/ at all yet, so checking this
  // first would always fail even when a wallet really is configured.
  if (!SolanaWallet.isConfigured()) {
    console.error("[STORE-POLL] No wallet address configured yet — nothing to check payments against.");
    process.exit(1);
  }

  const pending = Store.listPendingOrders();
  console.log(`[STORE-POLL] ${pending.length} pending order(s) to check.`);

  let paidCount = 0;
  let deliveredCount = 0;

  for (const order of pending) {
    let found;
    try {
      found = await SolanaWallet.findTransactionByReference(order.reference);
    } catch (e) {
      console.warn(`[STORE-POLL] Reference lookup failed for order ${order.id}:`, e.message);
      continue;
    }
    if (found.error) {
      console.warn(`[STORE-POLL] Reference lookup error for order ${order.id}:`, found.error);
      continue;
    }
    if (!found.found) continue;

    console.log(`[STORE-POLL] Order ${order.id} paid — signature ${found.signature}`);
    const paidOrder = Store.markOrderPaid(order.id, {
      signature: found.signature,
      explorerUrl: found.explorerUrl,
    });
    if (paidOrder.error) {
      console.warn(`[STORE-POLL] Failed to mark order ${order.id} paid:`, paidOrder.error);
      continue;
    }
    paidCount++;

    const sale = Store.recordSale(paidOrder);
    const product = Store.getProduct(paidOrder.productId);
    if (!product) {
      console.warn(`[STORE-POLL] Order ${order.id} paid but product ${paidOrder.productId} is gone — can't deliver.`);
      continue;
    }

    const sendResult = await deliverOrder(paidOrder, product);
    if (sendResult.error) {
      console.warn(`[STORE-POLL] Delivery email failed for order ${order.id}:`, sendResult.error);
      continue;
    }
    Store.markDelivered(sale.id);
    deliveredCount++;
    console.log(`[STORE-POLL] Delivered "${product.name}" to ${paidOrder.buyerEmail}.`);
  }

  console.log(`[STORE-POLL] ${paidCount} order(s) newly paid, ${deliveredCount} delivered.`);

  console.log("[STORE-POLL] Pushing updated state to Supabase...");
  const pushed = await Persistence.flush();
  console.log(`[STORE-POLL] Done. ${pushed} file(s) pushed.`);
}

main().catch(e => {
  console.error("[STORE-POLL] Fatal error:", e.message);
  process.exit(1);
});
