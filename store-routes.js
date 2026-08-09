"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Store Routes (direct wallet-to-wallet, no processor)
//
// Add these two lines near the other route registrations in server.js
// (this is the only server.js edit needed):
//
//   const StoreRoutes = require("./store-routes");
//   StoreRoutes.mount(app);
//
// Endpoints:
//   GET  /store/:productId               — public checkout page (email + QR)
//   POST /api/store/checkout             — { productId, buyerEmail } -> order + pay URI
//   GET  /api/store/order/:id/status     — poll from the checkout page itself
//   GET  /api/store/products             — full catalog (dashboard)
//   POST /api/store/products/:id/approve
//   POST /api/store/products/:id/reject
//   GET  /api/store/sales                — sales ledger
//
// Actual payment DETECTION happens out-of-band in
// scripts/scheduled-store-poll.js, not here — there's no webhook to
// receive since there's no processor. This file just creates orders
// and lets the checkout page ask "am I paid yet?".
// ═══════════════════════════════════════════════════════════════

const express = require("express");
const Store   = require("./direct-store");

function mount(app) {
  app.get("/api/store/products", (req, res) => {
    res.json({ products: Store.listProducts() });
  });

  app.post("/api/store/products/:id/approve", (req, res) => {
    res.json(Store.approveProduct(req.params.id));
  });

  app.post("/api/store/products/:id/reject", (req, res) => {
    res.json(Store.rejectProduct(req.params.id, req.body?.reason || ""));
  });

  app.get("/api/store/sales", (req, res) => {
    res.json({ sales: Store.listSales(), totalUsd: Store.totalSalesUsd() });
  });

  app.post("/api/store/checkout", express.json(), (req, res) => {
    const { productId, buyerEmail } = req.body || {};
    const order = Store.createOrder({ productId, buyerEmail });
    res.json(order);
  });

  app.get("/api/store/order/:id/status", (req, res) => {
    const order = Store.getOrder(req.params.id);
    if (!order) return res.status(404).json({ error: "No such order." });
    res.json({ status: order.status, signature: order.signature || null });
  });

  app.get("/store/:productId", (req, res) => {
    const product = Store.getProduct(req.params.productId);
    if (!product || product.status !== "published") {
      return res.status(404).send("<h1>Product not found</h1>");
    }
    res.send(checkoutPageHtml(product));
  });
}

function checkoutPageHtml(product) {
  const escapedName = String(product.name).replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedName}</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 60px auto; padding: 0 20px; color: #111; }
  h1 { font-size: 1.4rem; } .price { font-size: 2rem; font-weight: 700; margin: 8px 0 24px; }
  input { width: 100%; padding: 12px; font-size: 1rem; box-sizing: border-box; border: 1px solid #ccc; border-radius: 8px; }
  button { width: 100%; padding: 12px; font-size: 1rem; margin-top: 12px; background: #111; color: #fff; border: none; border-radius: 8px; cursor: pointer; }
  #qr { margin: 24px auto; width: 220px; }
  #status { margin-top: 16px; text-align: center; color: #666; }
</style></head>
<body>
  <h1>${escapedName}</h1>
  <div class="price">$${product.priceUsd} USDC</div>
  <p>${(product.description || "").replace(/</g, "&lt;")}</p>

  <div id="emailStep">
    <input id="email" type="email" placeholder="Your email (for delivery)" />
    <button onclick="startCheckout()">Continue</button>
  </div>

  <div id="payStep" style="display:none; text-align:center;">
    <p>Scan with a Solana wallet app (Phantom, Solflare, etc.) to pay:</p>
    <div id="qr"></div>
    <p><a id="payLink" href="#">Or open in your wallet app</a></p>
    <div id="status">Waiting for payment...</div>
  </div>

<script>
async function startCheckout() {
  const buyerEmail = document.getElementById('email').value;
  if (!buyerEmail) return alert('Enter an email so we know where to send it.');
  const res = await fetch('/api/store/checkout', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ productId: '${product.id}', buyerEmail })
  });
  const order = await res.json();
  if (order.error) return alert(order.error);

  document.getElementById('emailStep').style.display = 'none';
  document.getElementById('payStep').style.display = 'block';
  new QRCode(document.getElementById('qr'), { text: order.payUri, width: 220, height: 220 });
  document.getElementById('payLink').href = order.payUri;

  const poll = setInterval(async () => {
    const s = await (await fetch('/api/store/order/' + order.id + '/status')).json();
    if (s.status === 'paid') {
      clearInterval(poll);
      document.getElementById('status').textContent = 'Paid! Check your email for your download.';
    }
  }, 5000);
}
</script>
</body></html>`;
}

module.exports = { mount };
