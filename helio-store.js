"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Helio Store (digital-product Pay Links)
//
// Lets Jarvis autonomously CREATE products and Helio Pay Links for
// them — that part is just an API call once you've connected an
// account. It does NOT create the Helio account itself. That's a
// one-time human step, same as the Supabase signup in persistence.js
// already is:
//
//   1. https://app.hel.io → sign up (your email, your identity)
//   2. Settings → Wallets → paste your Solana wallet address → Save
//   3. Settings → API → generate an API key + secret key
//   4. Put them in .env (see the block at the bottom of this file)
//
// Why that step stays manual: Helio is a payment processor. Creating
// an account there means accepting their ToS and, for real payouts,
// identity checks — that's a commitment tied to YOUR name and wallet,
// not something to hand to a bot filling out a signup form. Once the
// account + API key exist, everything below this point is genuinely
// autonomous: Jarvis can create as many products/Pay Links as it
// wants with zero further human clicks.
//
// Docs: https://docs.hel.io/reference/overview
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const API_KEY    = process.env.HELIO_API_KEY    || ""; // "public" key, goes in the query string
const SECRET_KEY = process.env.HELIO_SECRET_KEY || ""; // goes in the Authorization header — never expose client-side
const WALLET_ID  = process.env.HELIO_WALLET_ID  || ""; // from the Helio dashboard (Settings → Wallets), NOT the raw Solana address
const BASE_URL   = process.env.HELIO_API_BASE   || "https://api.hel.io/v1";

// Well-known Helio currency/engine IDs for "receive USDC on Solana"
// (the same pair Helio's own docs use as the default example).
// Override via env if your dashboard shows different IDs for your account.
const USDC_CURRENCY_ID = process.env.HELIO_USDC_CURRENCY_ID   || "6340313846e4f91b8abc519b";
const SOLANA_ENGINE_ID = process.env.HELIO_SOLANA_ENGINE_ID   || "63b6b1200cfb4b3f6131f2b4";

// Whether newly-created products go straight into the public catalog
// or sit in a queue for a human to approve first (default: queued —
// see store-routes.js for the approve endpoint). Flip to "true" once
// you trust the product-generation step enough to skip review.
const AUTO_PUBLISH = String(process.env.STORE_AUTO_PUBLISH || "false").toLowerCase() === "true";

const DATA_DIR    = path.join(__dirname, "data");
const CATALOG_PATH = path.join(DATA_DIR, "store-catalog.json");
const LEDGER_PATH  = path.join(DATA_DIR, "store-sales.json");

function isConfigured() {
  return !!(API_KEY && SECRET_KEY && WALLET_ID);
}

function configStatus() {
  const missing = [];
  if (!API_KEY)    missing.push("HELIO_API_KEY");
  if (!SECRET_KEY) missing.push("HELIO_SECRET_KEY");
  if (!WALLET_ID)  missing.push("HELIO_WALLET_ID");
  return missing.length
    ? { configured: false, missing }
    : { configured: true, autoPublish: AUTO_PUBLISH };
}

// ── LOCAL CATALOG ────────────────────────────────────────────────
function loadCatalog() {
  try {
    if (!fs.existsSync(CATALOG_PATH)) return { products: [] };
    return { products: [], ...JSON.parse(fs.readFileSync(CATALOG_PATH, "utf8") || "{}") };
  } catch {
    return { products: [] };
  }
}
function saveCatalog(catalog) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CATALOG_PATH, JSON.stringify(catalog, null, 2));
}

function loadSalesLedger() {
  try {
    if (!fs.existsSync(LEDGER_PATH)) return { sales: [] };
    return { sales: [], ...JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8") || "{}") };
  } catch {
    return { sales: [] };
  }
}
function saveSalesLedger(ledger) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger, null, 2));
}

function listProducts({ publishedOnly = false } = {}) {
  const { products } = loadCatalog();
  return publishedOnly ? products.filter(p => p.status === "published") : products;
}
function getProduct(id) {
  return loadCatalog().products.find(p => p.id === id) || null;
}
function getProductByPaylinkId(paylinkId) {
  return loadCatalog().products.find(p => p.paylinkId === paylinkId) || null;
}

// ── LOW-LEVEL API HELPER ───────────────────────────────────────
async function api(pathSuffix, { method = "GET", body, query = {} } = {}) {
  if (!isConfigured()) {
    return { error: `Helio isn't configured yet. Missing: ${configStatus().missing.join(", ")}. ` +
      "Create the account + API key manually at app.hel.io first — see the comment at the top of helio-store.js." };
  }
  const qs = new URLSearchParams({ apiKey: API_KEY, ...query }).toString();
  try {
    const res = await fetch(`${BASE_URL}${pathSuffix}?${qs}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SECRET_KEY}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
    if (!res.ok) {
      return { error: data?.message || data?.error || `Helio API returned ${res.status}` };
    }
    return data;
  } catch (e) {
    return { error: `Network error talking to Helio: ${e.message}` };
  }
}

// ── CREATE A PAY LINK ────────────────────────────────────────────
// priceUsd: e.g. 5 for "$5". Helio wants USDC base units (6 decimals).
async function createPayLink({ name, priceUsd, description = "", requireEmail = true }) {
  if (!name || !(priceUsd > 0)) return { error: "name and a positive priceUsd are required." };
  const priceBaseUnits = String(Math.round(priceUsd * 1_000_000));

  const result = await api("/paylink/create/api-key", {
    method: "POST",
    body: {
      template: "OTHER",
      name,
      description,
      price: priceBaseUnits,
      pricingCurrency: USDC_CURRENCY_ID,
      features: { requireEmail },
      recipients: [
        { walletId: WALLET_ID, currencyId: USDC_CURRENCY_ID, sourceBlockchainEngine: SOLANA_ENGINE_ID },
      ],
    },
  });
  return result;
}

async function deletePayLink(paylinkId) {
  if (!paylinkId) return { error: "Missing paylinkId." };
  return api(`/paylink/${encodeURIComponent(paylinkId)}`, { method: "DELETE" });
}

// ── REGISTER A WEBHOOK FOR A PAY LINK (call once per paylink, or ──
// reuse targetUrl across all of them — Helio allows either) ───────
async function createWebhook(paylinkId, targetUrl) {
  if (!paylinkId || !targetUrl) return { error: "Missing paylinkId or targetUrl." };
  return api("/webhook/paylink/transaction", {
    method: "POST",
    body: { paylinkId, targetUrl, events: ["CREATED"] },
  });
}

// ── HIGH-LEVEL: create a product end-to-end ──────────────────────
// deliverable: { type: "file", path: "/abs/path/to/file.pdf" } or
//              { type: "text", content: "..." } — whatever the buyer
// receives on auto-delivery (see store-routes.js webhook handler).
async function publishProduct({ name, priceUsd, description = "", deliverable, webhookUrl }) {
  const payLink = await createPayLink({ name, priceUsd, description });
  if (payLink.error) return payLink;

  const paylinkId = payLink.id || payLink._id;
  if (webhookUrl && paylinkId) {
    const hook = await createWebhook(paylinkId, webhookUrl);
    if (hook.error) console.error("[helio-store] webhook registration failed:", hook.error);
  }

  const catalog = loadCatalog();
  const product = {
    id: `prod_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    description,
    priceUsd,
    paylinkId,
    payUrl: payLink.payUrl || (paylinkId ? `https://app.hel.io/pay/${paylinkId}` : null),
    deliverable,
    status: AUTO_PUBLISH ? "published" : "pending_review",
    createdAt: new Date().toISOString(),
    sold: 0,
  };
  catalog.products.unshift(product);
  saveCatalog(catalog);
  return product;
}

// ── HUMAN APPROVAL (mirrors github-bounty.js's approve pattern) ──
function approveProduct(id) {
  const catalog = loadCatalog();
  const product = catalog.products.find(p => p.id === id);
  if (!product) return { error: "No such product." };
  product.status = "published";
  product.approvedAt = new Date().toISOString();
  saveCatalog(catalog);
  return product;
}
function rejectProduct(id, reason = "") {
  const catalog = loadCatalog();
  const product = catalog.products.find(p => p.id === id);
  if (!product) return { error: "No such product." };
  product.status = "rejected";
  product.rejectReason = reason;
  saveCatalog(catalog);
  return product;
}

// ── RECORD A SALE (called from the webhook handler on payment) ───
function recordSale({ paylinkId, amountUsd, buyerEmail, txSignature }) {
  const product = getProductByPaylinkId(paylinkId);
  const ledger = loadSalesLedger();
  const sale = {
    id: `sale_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    productId: product?.id || null,
    productName: product?.name || "(unknown product)",
    paylinkId,
    amountUsd,
    buyerEmail: buyerEmail || null,
    txSignature: txSignature || null,
    delivered: false,
    at: new Date().toISOString(),
  };
  ledger.sales.unshift(sale);
  saveSalesLedger(ledger);

  if (product) {
    const catalog = loadCatalog();
    const p = catalog.products.find(x => x.id === product.id);
    if (p) { p.sold = (p.sold || 0) + 1; saveCatalog(catalog); }
  }
  return sale;
}
function markDelivered(saleId) {
  const ledger = loadSalesLedger();
  const sale = ledger.sales.find(s => s.id === saleId);
  if (!sale) return { error: "No such sale." };
  sale.delivered = true;
  sale.deliveredAt = new Date().toISOString();
  saveSalesLedger(ledger);
  return sale;
}
function listSales() { return loadSalesLedger().sales; }
function totalSalesUsd() {
  return loadSalesLedger().sales.reduce((sum, s) => sum + (Number(s.amountUsd) || 0), 0);
}

module.exports = {
  isConfigured,
  configStatus,
  listProducts,
  getProduct,
  getProductByPaylinkId,
  createPayLink,
  deletePayLink,
  createWebhook,
  publishProduct,
  approveProduct,
  rejectProduct,
  recordSale,
  markDelivered,
  listSales,
  totalSalesUsd,
};

// ── .env additions ────────────────────────────────────────────
// HELIO_API_KEY=            # Settings -> API in the Helio dashboard (public key)
// HELIO_SECRET_KEY=         # same page (secret key — server-side only)
// HELIO_WALLET_ID=          # Settings -> Wallets (the Helio wallet ID, not your raw address)
// HELIO_WEBHOOK_SHARED_TOKEN=  # returned once when a webhook is created — used to verify incoming webhooks
// STORE_AUTO_PUBLISH=false  # "true" to skip the human-approval queue for new products
