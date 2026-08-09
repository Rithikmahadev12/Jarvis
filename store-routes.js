"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Store Routes (mount into server.js)
//
// Add these two lines near the other `require`s / route registrations
// in server.js — that's the only edit server.js needs:
//
//   const StoreRoutes = require("./store-routes");
//   StoreRoutes.mount(app);
//
// Endpoints:
//   GET  /api/store/products              — full catalog (dashboard)
//   POST /api/store/products/:id/approve  — publish a pending product
//   POST /api/store/products/:id/reject
//   GET  /api/store/sales                 — sales ledger
//   POST /api/store/webhook/helio         — Helio payment webhook,
//        verifies HELIO_WEBHOOK_SHARED_TOKEN, records the sale, and
//        auto-delivers the product by email via AgentMail.
// ═══════════════════════════════════════════════════════════════

const express    = require("express");
const HelioStore = require("./helio-store");
const AgentMail  = require("./agent-mail");

const WEBHOOK_TOKEN = process.env.HELIO_WEBHOOK_SHARED_TOKEN || "";

function mount(app) {
  app.get("/api/store/products", (req, res) => {
    res.json({ products: HelioStore.listProducts() });
  });

  app.post("/api/store/products/:id/approve", (req, res) => {
    res.json(HelioStore.approveProduct(req.params.id));
  });

  app.post("/api/store/products/:id/reject", (req, res) => {
    res.json(HelioStore.rejectProduct(req.params.id, req.body?.reason || ""));
  });

  app.get("/api/store/sales", (req, res) => {
    res.json({ sales: HelioStore.listSales(), totalUsd: HelioStore.totalSalesUsd() });
  });

  // Needs the RAW body to compare against the shared token cleanly —
  // express.json() elsewhere in server.js is fine, this route just
  // reads the parsed body since Helio's auth is a header, not an
  // HMAC-over-raw-body signature (see helio-store.js comment for the
  // upgrade path to HMAC verification if you register webhooks that way).
  app.post("/api/store/webhook/helio", express.json(), async (req, res) => {
    if (WEBHOOK_TOKEN) {
      const auth = req.headers["authorization"] || "";
      const token = auth.replace(/^Bearer\s+/i, "");
      if (token !== WEBHOOK_TOKEN) {
        console.warn("[store-webhook] rejected: bad/missing Authorization token");
        return res.status(401).json({ error: "invalid webhook token" });
      }
    } else {
      console.warn("[store-webhook] HELIO_WEBHOOK_SHARED_TOKEN not set — accepting unverified webhook. Set it in .env.");
    }

    // Always 200 quickly so Helio doesn't retry-storm us; do the real
    // work after responding is fine here since it's just file I/O + one
    // outbound email call, nothing that needs to block the response.
    res.status(200).json({ received: true });

    try {
      const body = req.body || {};
      const txn = body.transactionObject || body.transaction || body;
      const paylinkId = txn.paylinkId || txn.paylink || body.paylink;
      const status = txn.transactionStatus || body.event;
      if (!paylinkId || (status && status !== "SUCCESS" && status !== "CREATED")) return;

      const amountRaw = Number(txn.totalAmount ?? txn.meta?.amount ?? 0);
      const amountUsd = amountRaw > 0 ? amountRaw / 1_000_000 : null;
      const buyerEmail = txn.customerDetails?.email || txn.meta?.email || body.email || null;

      const sale = HelioStore.recordSale({
        paylinkId,
        amountUsd,
        buyerEmail,
        txSignature: txn.transactionSignature || null,
      });

      const product = HelioStore.getProductByPaylinkId(paylinkId);
      if (product && buyerEmail && product.deliverable) {
        await deliverProduct(product, buyerEmail, sale.id);
      } else if (!buyerEmail) {
        console.warn(`[store-webhook] sale ${sale.id} has no buyer email — "requireEmail" may be off for this Pay Link. Deliver manually.`);
      }
    } catch (e) {
      console.error("[store-webhook] error processing payment:", e.message);
    }
  });
}

async function deliverProduct(product, buyerEmail, saleId) {
  const inbox = await AgentMail.getOrCreateInbox("store-delivery", { displayName: "Jarvis Store" });
  if (inbox.error) {
    console.error("[store-webhook] can't deliver — AgentMail inbox unavailable:", inbox.error);
    return;
  }

  const attachments = [];
  if (product.deliverable?.type === "file" && product.deliverable.path) {
    const fs = require("fs");
    try {
      const content = fs.readFileSync(product.deliverable.path).toString("base64");
      attachments.push({
        filename: require("path").basename(product.deliverable.path),
        content,
        contentType: product.deliverable.contentType || "application/octet-stream",
      });
    } catch (e) {
      console.error("[store-webhook] couldn't read deliverable file:", e.message);
    }
  }

  const textBody = product.deliverable?.type === "text"
    ? product.deliverable.content
    : `Thanks for your purchase of "${product.name}"! Your file is attached.`;

  const sent = await AgentMail.sendMessage(inbox.inbox_id, {
    to: buyerEmail,
    subject: `Your purchase: ${product.name}`,
    text: textBody,
    attachments: attachments.length ? attachments : undefined,
  });

  if (sent.error) {
    console.error(`[store-webhook] delivery email failed for sale ${saleId}:`, sent.error);
  } else {
    HelioStore.markDelivered(saleId);
  }
}

module.exports = { mount };
