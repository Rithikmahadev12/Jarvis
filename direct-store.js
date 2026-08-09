"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Direct Store (peer-to-wallet, no processor)
//
// Sells digital products by generating a Solana Pay link straight to
// YOUR wallet — no Helio/MoonPay Commerce, no company custody of
// funds, and therefore no KYC/identity verification to do. This is
// the same reasoning solana-wallet.js already documents for itself:
// less capability (no hosted checkout page, no card on-ramp for
// buyers who don't already hold crypto), but a much simpler trust
// picture — nobody but the buyer's own wallet ever touches the money
// before it lands in yours.
//
// Trade-offs vs. a hosted processor, so you're choosing this on
// purpose and not surprised later:
//   - Buyer needs an existing Solana wallet (Phantom, Solflare, etc.)
//     with SOL or USDC already in it — no "pay with a card" option.
//   - No hosted, branded checkout page from a third party — this
//     module serves its own simple one (see store-routes.js).
//   - No webhook from anyone — Jarvis has to poll the chain to find
//     out an order was paid (see scripts/scheduled-store-poll.js).
//   - Refunds/disputes are 100% on you — there's no processor to
//     mediate, same as any peer-to-peer crypto transfer.
//
// Each product's checkout page collects the buyer's email (needed
// for delivery — there's no processor-side "requireEmail" feature
// here), generates a one-time Solana Pay "reference" tag for that
// specific order, and stores the pairing. The poller then just asks
// "has anything paid to my wallet included THIS reference yet?"
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const SolanaWallet = require("./solana-wallet");

const DATA_DIR      = path.join(__dirname, "data");
const CATALOG_PATH  = path.join(DATA_DIR, "store-catalog.json");
const ORDERS_PATH   = path.join(DATA_DIR, "store-orders.json");
const LEDGER_PATH   = path.join(DATA_DIR, "store-sales.json");

const AUTO_PUBLISH = String(process.env.STORE_AUTO_PUBLISH || "false").toLowerCase() === "true";

function isConfigured() {
  return SolanaWallet.isConfigured();
}

// ── CATALOG (unchanged shape from the Helio version, minus paylinkId) ──
function loadCatalog() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return { products: [] };
    return { products: [], ...JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8") || "{}") };
  } catch { return { products: [] }; }
}
function saveCatalog(c) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(c, null, 2));
}
function listProducts({ publishedOnly = false } = {}) {
  const { products } = loadCatalog();
  return publishedOnly ? products.filter(p => p.status === "published") : products;
}
function getProduct(id) { return loadCatalog().products.find(p => p.id === id) || null; }

function publishProduct({ name, priceUsd, description = "", deliverable }) {
  if (!name || !(priceUsd > 0)) return { error: "name and a positive priceUsd are required." };
  const catalog = loadCatalog();
  const product = {
    id: `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name, description, priceUsd, deliverable,
    status: AUTO_PUBLISH ? "published" : "pending_review",
    createdAt: new Date().toISOString(),
    sold: 0,
  };
  catalog.products.unshift(product);
  saveCatalog(catalog);
  return product;
}
function approveProduct(id) {
  const catalog = loadCatalog();
  const p = catalog.products.find(x => x.id === id);
  if (!p) return { error: "No such product." };
  p.status = "published"; p.approvedAt = new Date().toISOString();
  saveCatalog(catalog);
  return p;
}
function rejectProduct(id, reason = "") {
  const catalog = loadCatalog();
  const p = catalog.products.find(x => x.id === id);
  if (!p) return { error: "No such product." };
  p.status = "rejected"; p.rejectReason = reason;
  saveCatalog(catalog);
  return p;
}

// ── ORDERS (pending payment, one per checkout attempt) ────────────
function loadOrders() {
  try {
    if (!fs.existsSync(ORDERS_PATH)) return { orders: [] };
    return { orders: [], ...JSON.parse(fs.readFileSync(ORDERS_PATH, "utf8") || "{}") };
  } catch { return { orders: [] }; }
}
function saveOrders(o) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ORDERS_PATH, JSON.stringify(o, null, 2));
}

// Called when a buyer lands on the checkout page and submits their email.
function createOrder({ productId, buyerEmail }) {
  const product = getProduct(productId);
  if (!product) return { error: "No such product." };
  if (product.status !== "published") return { error: "Product isn't published yet." };
  if (!buyerEmail) return { error: "buyerEmail is required — there's no processor to collect it for us." };

  const reference = SolanaWallet.generateReference();
  const link = SolanaWallet.buildPaymentLink({
    amount: product.priceUsd,
    token: "usdc",
    label: product.name,
    message: `Order for ${product.name}`,
    reference,
  });
  if (link.error) return link;

  const orders = loadOrders();
  const order = {
    id: `order_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    productId,
    buyerEmail,
    reference,
    payUri: link.uri,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
  orders.orders.unshift(order);
  saveOrders(orders);
  return order;
}

function listPendingOrders() {
  return loadOrders().orders.filter(o => o.status === "pending");
}
function getOrder(id) { return loadOrders().orders.find(o => o.id === id) || null; }
function markOrderPaid(id, { signature, explorerUrl } = {}) {
  const orders = loadOrders();
  const order = orders.orders.find(o => o.id === id);
  if (!order) return { error: "No such order." };
  order.status = "paid";
  order.paidAt = new Date().toISOString();
  order.signature = signature || null;
  order.explorerUrl = explorerUrl || null;
  saveOrders(orders);

  const catalog = loadCatalog();
  const p = catalog.products.find(x => x.id === order.productId);
  if (p) { p.sold = (p.sold || 0) + 1; saveCatalog(catalog); }

  return order;
}

// ── SALES LEDGER (for the dashboard / totalSalesUsd) ──────────────
function loadSalesLedger() {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return { sales: [] };
    return { sales: [], ...JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8") || "{}") };
  } catch { return { sales: [] }; }
}
function saveSalesLedger(l) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2));
}
function recordSale(order) {
  const product = getProduct(order.productId);
  const ledger = loadSalesLedger();
  const sale = {
    id: `sale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    orderId: order.id,
    productId: order.productId,
    productName: product?.name || "(unknown product)",
    amountUsd: product?.priceUsd || null,
    buyerEmail: order.buyerEmail,
    txSignature: order.signature,
    delivered: false,
    at: new Date().toISOString(),
  };
  ledger.sales.unshift(sale);
  saveSalesLedger(ledger);
  return sale;
}
function markDelivered(saleId) {
  const ledger = loadSalesLedger();
  const sale = ledger.sales.find(s => s.id === saleId);
  if (!sale) return { error: "No such sale." };
  sale.delivered = true; sale.deliveredAt = new Date().toISOString();
  saveSalesLedger(ledger);
  return sale;
}
function listSales() { return loadSalesLedger().sales; }
function totalSalesUsd() {
  return loadSalesLedger().sales.reduce((sum, s) => sum + (Number(s.amountUsd) || 0), 0);
}

module.exports = {
  isConfigured,
  listProducts, getProduct, publishProduct, approveProduct, rejectProduct,
  createOrder, listPendingOrders, getOrder, markOrderPaid,
  recordSale, markDelivered, listSales, totalSalesUsd,
};
