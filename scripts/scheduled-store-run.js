"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Scheduled Store Run (runs inside GitHub Actions)
//
// Runs on GitHub's own servers on a schedule (see
// .github/workflows/store-manager.yml), so it works whether your PC
// is on, off, or asleep. Each run:
//
//   1. Pulls data/ down from Supabase so it sees the existing catalog.
//   2. Picks a topic it hasn't made a product for yet, asks Groq to
//      write it, and saves it as a markdown file.
//   3. Calls Store.publishProduct() — purely local, no external
//      account/API needed (see direct-store.js: this sells straight
//      to your wallet, no processor in the loop).
//   4. By default the product lands as "pending_review" — open the
//      dashboard and approve/reject it. Set STORE_AUTO_PUBLISH=true
//      as a repo secret if you want it to go live with zero review.
//   5. Pushes data/ back up to Supabase.
//
// Required Actions secrets: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// SUPABASE_BUCKET, GROQ_API_KEY, and optionally STORE_AUTO_PUBLISH,
// STORE_PRICE_USD.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const REPO_ROOT = path.join(__dirname, "..");
const Persistence = require(path.join(REPO_ROOT, "persistence.js"));
const Store        = require(path.join(REPO_ROOT, "direct-store.js"));
const Groq         = require(path.join(REPO_ROOT, "hermes-engine.js"));

const PRODUCTS_DIR = path.join(REPO_ROOT, "data", "store", "products");
const PRICE_USD = Number(process.env.STORE_PRICE_USD) || 5;

// Rotate through a small list of topics so consecutive runs don't
// duplicate each other. Edit this list to match what you actually
// want to sell — it's deliberately generic as a starting point.
const TOPICS = [
  "A one-page cheat sheet of keyboard shortcuts and workflow tips for a specific popular piece of software",
  "A structured prompt pack (10 prompts) for a specific creative or productivity use case",
  "A short checklist/template for a common planning task (e.g. a trip, a move, a launch)",
];

function pickTopic(existingNames) {
  const unused = TOPICS.filter(t => !existingNames.some(n => n.includes(t.slice(0, 20))));
  return (unused[0] || TOPICS[Math.floor(Math.random() * TOPICS.length)]);
}

async function generateProduct(topic) {
  const prompt = `Write a genuinely useful, well-organized digital product in Markdown based on this brief: "${topic}". ` +
    `Give it a specific, catchy product name (first line, as a level-1 heading) and real, non-generic content — ` +
    `something worth paying $${PRICE_USD} for. 300-700 words. Output ONLY the markdown, no preamble.`;
  const markdown = await Groq.groqFetch([{ role: "user", content: prompt }]);
  const nameMatch = markdown.match(/^#\s+(.+)$/m);
  const name = nameMatch ? nameMatch[1].trim() : topic.slice(0, 60);
  return { name, markdown };
}

async function main() {
  if (!Persistence.isConfigured()) {
    console.error("[STORE-RUN] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_BUCKET not set.");
    process.exit(1);
  }
  if (!Store.isConfigured()) {
    console.error("[STORE-RUN] No wallet address configured yet — nothing to sell to. Run make_wallet.py first.");
    process.exit(1);
  }

  console.log("[STORE-RUN] Pulling latest state from Supabase...");
  await Persistence.pullAll();

  const existing = Store.listProducts().map(p => p.name);
  const topic = pickTopic(existing);
  console.log(`[STORE-RUN] Generating product for topic: ${topic}`);

  const { name, markdown } = await generateProduct(topic);

  fs.mkdirSync(PRODUCTS_DIR, { recursive: true });
  const filePath = path.join(PRODUCTS_DIR, `${Date.now()}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50)}.md`);
  fs.writeFileSync(filePath, markdown, "utf8");

  const product = Store.publishProduct({
    name,
    priceUsd: PRICE_USD,
    description: `Instant digital download: ${name}`,
    deliverable: { type: "file", path: filePath, contentType: "text/markdown" },
  });

  if (product.error) {
    console.error("[STORE-RUN] Failed to publish product:", product.error);
    process.exit(1);
  }
  const checkoutUrl = `${process.env.STORE_BASE_URL || "https://your-app.onrender.com"}/store/${product.id}`;
  console.log(`[STORE-RUN] Created "${product.name}" — status: ${product.status} — checkout: ${checkoutUrl}`);

  console.log("[STORE-RUN] Pushing updated state to Supabase...");
  await Persistence.flush();
  console.log("[STORE-RUN] Done.");
}

main().catch(e => {
  console.error("[STORE-RUN] Fatal error:", e);
  process.exit(1);
});
