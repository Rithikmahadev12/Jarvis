"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Business Website Outreach Agent
//
// Finds businesses that don't have a website, pitches building them
// one at a quoted price, and — once they say yes — actually
// generates a working frontend + backend, zips it up, and sends it
// back with a Solana payment link.
//
// TWO-STEP BY DESIGN, same shape as github-bounty.js's scan/approve
// split: pitchBusiness() only ever reaches out and reports what was
// said — it never charges anyone or sends code. buildAndDeliverSite()
// is the separate, explicit step that actually generates the site
// and (optionally) emails it out. Nothing here auto-charges a card
// or wallet; a Solana Pay link is just a request the business chooses
// whether to pay, same as everywhere else this app uses one.
//
// CHANNEL: phone first (AgentPhone), email fallback (AgentMail).
// AgentPhone's own withAccountFailover already cycles through every
// configured AgentPhone account before giving up — pitchBusiness()
// only switches to email once AgentPhone reports ALL of its accounts
// are out. If AgentMail then also fails, both failures are queued as
// "bring this up next time the owner checks their agenda" reminders
// (Reminders.addConditional(..., "next_agenda_check")) — the same
// mechanism set_conditional_reminder already uses elsewhere in this
// app — rather than silently going dark.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");

const AgentPhone   = require("./agentphone");
const AgentMail    = require("./agent-mail");
const SolanaWallet = require("./solana-wallet");
const Hermes       = require("./hermes-engine");
const Reminders    = require("./reminders");
const LeadFinder   = require("./lead-finder");

const REPO_ROOT   = __dirname;
const DATA_DIR    = path.join(REPO_ROOT, "data");
const LEADS_PATH  = path.join(DATA_DIR, "outreach-leads.json");
const QUEUE_PATH  = path.join(DATA_DIR, "outreach-queue.json");
const SITES_DIR   = path.join(DATA_DIR, "generated-sites");

const DEFAULT_PRICE_USD = Number(process.env.WEBSITE_BUILD_PRICE_USD || 400);
// Cap per scheduled run so a big queue doesn't place dozens of real
// phone calls / emails back-to-back in one go — tune via .env.
const MAX_OUTREACH_PER_RUN = Number(process.env.OUTREACH_MAX_PER_RUN || 5);

function normalizeKey(userKey) {
  return String(userKey || "owner").toLowerCase().trim();
}

function loadLeads() {
  try { return JSON.parse(fs.readFileSync(LEADS_PATH, "utf8") || "{}"); }
  catch { return {}; }
}
function saveLeads(leads) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEADS_PATH, JSON.stringify(leads, null, 2));
}
function leadId(business) {
  return `${(business.name || "lead").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now()}`;
}

// ── NEVER CONTACT TWICE / OPT-OUT ────────────────────────────────
// data/outreach-contacted.json remembers every business we've reached
// (by phone digits and normalized name) so auto-discovery never pitches
// the same place again. data/outreach-optout.json is the do-not-contact
// list: anyone who says stop is added here and is skipped forever.
const CONTACTED_PATH = path.join(DATA_DIR, "outreach-contacted.json");
const OPTOUT_PATH    = path.join(DATA_DIR, "outreach-optout.json");

function readList(p) { try { return JSON.parse(fs.readFileSync(p, "utf8") || "[]"); } catch { return []; } }
function writeList(p, arr) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(arr, null, 2));
}
function idsFor(b) {
  const ids = [];
  const phone = String(b.phone || "").replace(/\D/g, "");
  if (phone) ids.push("p:" + phone.slice(-10));
  if (b.email) ids.push("e:" + String(b.email).toLowerCase().trim());
  if (b.name)  ids.push("n:" + String(b.name).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim());
  return ids;
}
function isKnown(business) {
  const blocked = new Set([...readList(CONTACTED_PATH), ...readList(OPTOUT_PATH)]);
  for (const q of loadQueue()) idsFor(q.business).forEach(i => blocked.add(i));
  return idsFor(business).some(i => blocked.has(i));
}
function isOptedOut(business) {
  const out = new Set(readList(OPTOUT_PATH));
  return idsFor(business).some(i => out.has(i));
}
function markContacted(business) {
  const list = new Set(readList(CONTACTED_PATH));
  idsFor(business).forEach(i => list.add(i));
  writeList(CONTACTED_PATH, [...list]);
}
// "They said stop" — call with {name, phone, email} (any of them).
function addOptOut(business) {
  const list = new Set(readList(OPTOUT_PATH));
  idsFor(business).forEach(i => list.add(i));
  writeList(OPTOUT_PATH, [...list]);
  return { optedOut: true };
}

// Only place calls during normal business hours in OUTREACH_TZ
// (default America/New_York), Mon-Fri 9:00-17:00. Pass force to skip.
function insideCallingHours(now = new Date()) {
  const tz = process.env.OUTREACH_TZ || "America/New_York";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", hour12: false }).formatToParts(now);
  const wd = parts.find(p => p.type === "weekday")?.value;
  const hr = Number(parts.find(p => p.type === "hour")?.value) % 24;
  return !["Sat", "Sun"].includes(wd) && hr >= 9 && hr < 17;
}

// ── THE QUEUE — what makes a scheduled run possible at all ───────
// Unlike github-bounty.js/superteam-agent.js, there's no API this app
// can poll for "businesses with no website" on its own — that list
// has to come from you. queueLead() is how a business gets added
// (one at a time via chat/API, or in bulk by editing
// data/outreach-queue.json directly); runQueuedOutreach() is what the
// scheduled job below calls to work through whatever's waiting.
function loadQueue() {
  try { return JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8") || "[]"); }
  catch { return []; }
}
function saveQueue(queue) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(QUEUE_PATH, JSON.stringify(queue, null, 2));
}

function queueLead(business, { userKey, price } = {}) {
  if (!business || !business.name) return { error: "Missing business name." };
  if (!business.phone && !business.email) return { error: "Need at least a phone or an email for this business." };
  const queue = loadQueue();
  const entry = { id: leadId(business), business, userKey: normalizeKey(userKey), price: price || null, queuedAt: new Date().toISOString() };
  queue.push(entry);
  saveQueue(queue);
  return { queued: entry, queueLength: queue.length };
}

function listQueue() { return loadQueue(); }

// Called by scripts/scheduled-outreach-run.js. Pitches up to
// MAX_OUTREACH_PER_RUN queued businesses (oldest first) and removes
// each from the queue once contact has been attempted — successfully
// or not; a hard failure (no channel available at all) is what
// notifyOwnerLater() below is for, not an infinite silent retry.
async function runQueuedOutreach() {
  const queue = loadQueue();
  const batch = queue.slice(0, MAX_OUTREACH_PER_RUN);
  const remaining = queue.slice(MAX_OUTREACH_PER_RUN);
  const results = [];
  for (const entry of batch) {
    try {
      const res = await pitchBusiness(entry.business, { userKey: entry.userKey, price: entry.price });
      results.push({ business: entry.business.name, ...res });
    } catch (e) {
      results.push({ business: entry.business.name, error: e.message });
    }
  }
  saveQueue(remaining);
  return { processed: results, remainingInQueue: remaining.length };
}

// Queues a "tell the owner about this next time they check in" note,
// same reminder mechanism used app-wide — see the header comment.
function notifyOwnerLater(text) {
  try { Reminders.addConditional(text, "next_agenda_check"); }
  catch (e) { console.error("[OUTREACH] Couldn't queue owner notice:", e.message); }
}

function isAllAgentPhoneAccountsExhausted(err) {
  return /all \d+ agentphone account/i.test(String(err && err.message || ""));
}

// ── THE PITCH SCRIPT ──────────────────────────────────────────────
function buildPhonePitch({ business, price, callerName }) {
  return `You are ${callerName || "Jarvis"}, calling ${business.name} on behalf of a small web-design service. This business currently has no website. Your goal, in a short, friendly, low-pressure call:
1. Introduce yourself and say you noticed their business doesn't have a website.
2. Offer to build them a real website (a working homepage plus a simple contact/booking backend) for a flat price of $${price}.
3. Ask what kind of business they run and what they'd want visitors to be able to do on the site (see hours, book something, see a menu/services, contact them, etc).
4. Ask for the best email to send the finished site and a payment link to.
5. If they say yes, confirm the price and email back to them clearly before ending the call. If they say no or aren't interested, thank them politely and end the call — never pressure them.
Be honest and transparent throughout: you are an AI assistant, this is a real paid service, and there is no obligation. Keep the whole call under 3 minutes.`;
}

function buildEmailPitch({ business, price, callerName }) {
  const subject = `A website for ${business.name}?`;
  const text = `Hi${business.contactName ? ` ${business.contactName}` : ""},

I'm ${callerName || "Jarvis"}, reaching out because I noticed ${business.name} doesn't have a website yet. I build websites (a real working homepage plus a simple contact/booking backend) for a flat $${price}.

If that's of interest, just reply with:
- A quick description of what you'd want the site to do (show your hours/menu/services, take bookings, a contact form, etc.)
- The best email to send the finished site and a payment link to

No obligation at all — happy to answer questions first if you'd rather.

Best,
${callerName || "Jarvis"} (an AI assistant)

If you'd rather not hear from me, just reply "stop" and I won't contact you again.`;
  return { subject, text };
}

// ── STEP 1: REACH OUT ─────────────────────────────────────────────
// business: { name, phone, email, contactName? }
async function pitchBusiness(business, { userKey, price, callerName } = {}) {
  const key = normalizeKey(userKey);
  const quotedPrice = price || DEFAULT_PRICE_USD;
  if (isOptedOut(business)) return { lead: null, error: `${business.name} asked not to be contacted — skipped.` };
  const lead = {
    id: leadId(business),
    userKey: key,
    business,
    price: quotedPrice,
    status: "contacted",
    channel: null,
    transcript: null,
    contactedAt: new Date().toISOString(),
  };

  if (business.phone && AgentPhone.isConfigured()) {
    try {
      const call = await AgentPhone.placeOutboundCall({
        toNumber: business.phone,
        systemPrompt: buildPhonePitch({ business, price: quotedPrice, callerName }),
        ownerName: callerName,
      });
      const finished = await AgentPhone.waitForCallCompletion(call.id || call.callId);
      lead.channel = "phone";
      lead.transcript = finished.transcript || finished.summary || null;
      const leads = loadLeads();
      leads[lead.id] = lead;
      saveLeads(leads);
      markContacted(business);
      return { lead, notice: AgentPhone.consumeSwitchNotice() };
    } catch (e) {
      if (!isAllAgentPhoneAccountsExhausted(e)) throw e;
      notifyOwnerLater(`The calling API (AgentPhone) ran out while trying to reach ${business.name} — needs a new one.`);
      // fall through to email below
    }
  }

  if (!business.email) {
    return { lead: null, error: `Couldn't reach ${business.name}: no phone (or AgentPhone unavailable) and no email on file.` };
  }
  if (!AgentMail.isConfigured()) {
    notifyOwnerLater(`Tried to email-pitch ${business.name} after the calling API ran out, but AgentMail isn't configured — needs an API key.`);
    return { lead: null, error: `AgentPhone is out and AgentMail isn't configured — add AGENTMAIL_API_KEY to .env.` };
  }

  try {
    const inbox = await AgentMail.getOrCreateInbox("business-outreach", { displayName: `${callerName || "Jarvis"} - Outreach` });
    if (inbox.error) throw new Error(inbox.error);
    const { subject, text } = buildEmailPitch({ business, price: quotedPrice, callerName });
    const sent = await AgentMail.sendMessage(inbox.inbox_id, { to: business.email, subject, text });
    if (sent.error) throw new Error(sent.error);
    lead.channel = "email";
    lead.transcript = null;
    const leads = loadLeads();
    leads[lead.id] = lead;
    saveLeads(leads);
    markContacted(business);
    return { lead };
  } catch (e) {
    notifyOwnerLater(`AgentMail also failed trying to reach ${business.name} (${e.message}) — both outreach channels are down.`);
    return { lead: null, error: `Couldn't reach ${business.name} by phone or email: ${e.message}` };
  }
}

// ── STEP 2: BUILD + DELIVER, once a business has said yes ────────
// requirements: free-text description of what they want on the site
// (from the call transcript or their reply email).
async function buildAndDeliverSite(business, requirements, { userKey, price, deliver = true } = {}) {
  const key = normalizeKey(userKey);
  const quotedPrice = price || DEFAULT_PRICE_USD;

  const htmlPrompt = `Write a complete, single-file index.html for "${business.name}", a real business. What they want on the site: ${requirements || "a clean homepage with their info, hours, and a way to contact them."}\nInline all CSS and JS in this one file. Make it look like a real, modern small-business site (not a template placeholder) — use the business's actual name and the details given above. Include a contact form that POSTs to /api/contact.`;
  const serverPrompt = `Write a complete Node.js Express backend (server.js) for "${business.name}"'s website. It must: serve index.html and any static assets from the current directory, expose POST /api/contact that accepts {name, email, message} and logs it to a local contact-submissions.json file (append, create if missing) and responds with a success JSON, and listen on process.env.PORT || 3000. No database, no external services — this needs to run standalone on any VPS with just "npm install && node server.js".`;

  const [html, serverJs] = await Promise.all([
    Hermes.generateCode(htmlPrompt, "Output only the HTML file contents."),
    Hermes.generateCode(serverPrompt, "Output only the server.js file contents."),
  ]);

  const packageJson = JSON.stringify({
    name: business.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "business-site",
    version: "1.0.0",
    private: true,
    scripts: { start: "node server.js" },
    dependencies: { express: "^4.19.2" },
  }, null, 2);

  const readme = `# ${business.name} — website

Everything you need is in this folder.

## Run it yourself (any VPS, or a machine you control)
1. Install Node.js (v18+).
2. In this folder: \`npm install\`
3. Start it: \`npm start\` (or \`node server.js\`)
4. Point your domain's DNS at the server, or use the VPS provider's
   free subdomain/IP to see it live.

You own this code outright — host it on any VPS or domain you like,
or hand it to a developer to customize further.

## Files
- index.html — the site itself
- server.js — the backend (serves the site + handles the contact form)
- package.json — dependencies

Contact-form submissions are appended to contact-submissions.json
next to server.js.`;

  const siteDir = path.join(SITES_DIR, `${leadId(business)}`);
  fs.mkdirSync(siteDir, { recursive: true });
  fs.writeFileSync(path.join(siteDir, "index.html"), html, "utf8");
  fs.writeFileSync(path.join(siteDir, "server.js"), serverJs, "utf8");
  fs.writeFileSync(path.join(siteDir, "package.json"), packageJson, "utf8");
  fs.writeFileSync(path.join(siteDir, "README.md"), readme, "utf8");

  let AdmZip = null;
  try { AdmZip = require("adm-zip"); } catch { /* optional dep, see package.json */ }
  let zipPath = null;
  if (AdmZip) {
    const zip = new AdmZip();
    zip.addLocalFolder(siteDir);
    zipPath = `${siteDir}.zip`;
    zip.writeZip(zipPath);
  }

  // Per-account payment link — buildPaymentLink resolves the address
  // from THIS caller's own linked wallet (userKey), so a different
  // enrolled account running its own outreach gets its own correct
  // address here, never someone else's. See solana-wallet.js.
  const payment = SolanaWallet.buildPaymentLink({
    amount: quotedPrice,
    token: "usdc",
    label: business.name,
    message: `Website build for ${business.name}`,
    userKey: key,
  });
  if (payment.error) {
    return { error: `Site built, but couldn't generate a payment link: ${payment.error} — link ${key}'s wallet first.`, siteDir, zipPath };
  }

  let emailed = false;
  if (deliver && business.email && AgentMail.isConfigured()) {
    try {
      const inbox = await AgentMail.getOrCreateInbox("business-outreach");
      const attachments = zipPath
        ? [{ filename: `${business.name.replace(/[^a-z0-9]+/gi, "-")}-website.zip`, content: fs.readFileSync(zipPath).toString("base64"), contentType: "application/zip" }]
        : [];
      const sent = await AgentMail.sendMessage(inbox.inbox_id, {
        to: business.email,
        subject: `${business.name}'s website is ready`,
        text: `Hi,\n\nYour website is attached (a zip with everything — code, a README with hosting instructions). It's yours to host anywhere: any VPS, or a domain of your choice.\n\nTo settle up ($${quotedPrice}), pay here: ${payment.uri}\n\nQuestions welcome any time.`,
        attachments,
      });
      emailed = !sent.error;
      if (sent.error) notifyOwnerLater(`Built ${business.name}'s site but couldn't email it — AgentMail error: ${sent.error}`);
    } catch (e) {
      notifyOwnerLater(`Built ${business.name}'s site but couldn't email it: ${e.message}`);
    }
  }

  return { siteDir, zipPath, paymentLink: payment.uri, price: quotedPrice, emailed };
}

function listLeads(userKey) {
  const leads = Object.values(loadLeads());
  if (!userKey) return leads;
  const key = normalizeKey(userKey);
  return leads.filter((l) => l.userKey === key);
}

// ── AUTOMATIC MODE: find businesses by itself, then pitch them ───
// Rotates through OUTREACH_AREAS (one area per run), finds businesses
// with a phone and no website, skips anyone already contacted/opted
// out/queued, queues them, and the caller then works the queue.
async function discoverAndQueue({ area, limit, userKey, price } = {}) {
  const settings = LeadFinder.loadSettings();
  if (!settings.areas.length && !area) {
    return { error: "No area set. Set OUTREACH_AREAS (e.g. \"Austin, TX\") in your env, or tell Jarvis \"search for businesses in Austin, TX\"." };
  }
  const chosen = area || settings.areas[settings.nextAreaIndex % settings.areas.length];
  const want = limit || MAX_OUTREACH_PER_RUN;
  const { found, scanned, area: resolved } = await LeadFinder.findBusinessesWithoutWebsite({
    area: chosen, limit: want, exclude: isKnown,
  });
  if (!area) LeadFinder.saveSettings({ nextAreaIndex: (settings.nextAreaIndex + 1) % settings.areas.length });
  const queued = [];
  for (const b of found) {
    const r = queueLead(b, { userKey, price });
    if (!r.error) queued.push(b.name);
  }
  return { area: resolved || chosen, scanned, queued, queueLength: loadQueue().length };
}

// What the scheduled job calls. Tops up the queue if it's short, then
// contacts up to MAX_OUTREACH_PER_RUN. force skips the calling-hours check.
async function runAutoOutreach({ force = false, userKey } = {}) {
  const settings = LeadFinder.loadSettings();
  const out = { discovered: null, ran: null, skipped: null };
  if (!force && !insideCallingHours()) {
    out.skipped = "Outside calling hours (Mon-Fri 9-5 in OUTREACH_TZ) — nothing contacted this run.";
    return out;
  }
  if (settings.autoEnabled && loadQueue().length < MAX_OUTREACH_PER_RUN) {
    try { out.discovered = await discoverAndQueue({ userKey }); }
    catch (e) { out.discovered = { error: e.message }; }
  }
  out.ran = await runQueuedOutreach();
  return out;
}

module.exports = {
  discoverAndQueue,
  runAutoOutreach,
  addOptOut,
  insideCallingHours,
  pitchBusiness,
  buildAndDeliverSite,
  listLeads,
  queueLead,
  listQueue,
  runQueuedOutreach,
};
