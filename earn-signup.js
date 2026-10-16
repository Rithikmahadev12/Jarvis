"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Earn Signup
//
// Lets the earn cycle actually CREATE the free accounts its ideas need,
// using Jarvis's OWN email (AgentMail) and its own sandbox browser (e2b):
//
//   1. makes (or reuses) a dedicated AgentMail inbox for that service
//   2. opens the sign-up page in the sandbox browser and reads the form
//   3. asks the model which of Jarvis's identity values go in which field
//      (code checks every answer — it can't invent values)
//   4. submits, then watches the inbox for the confirmation email and
//      clicks the link / types the code itself
//   5. records the result in data/earn-accounts.json (synced to Supabase)
//
// Guard rails (not negotiable, they are enforced in code, not just in the
// prompt):
//   - one account per service; never a second/duplicate account
//   - it stops (and says so) on CAPTCHAs — it never tries to get past one
//   - it stops if the form needs a phone number, card, ID, address or date
//     of birth — those stay for the owner
//   - money / KYC sites (exchanges, banks, payment apps) are never touched
//   - it only ticks REQUIRED terms/privacy boxes, never marketing boxes
//   - the password is derived from a secret (EARN_VAULT_KEY), so no
//     password is ever written to disk or to Supabase
//
// Interactive (Render): shows an Allow card per service ("Always" works).
// Headless (GitHub Action): you asked for it to sign up on its own, so it
// goes ahead without a card, within the guard rails above.
// ═══════════════════════════════════════════════════════════════
const fs     = require("fs");
const path   = require("path");
const crypto = require("crypto");
const Approvals = require("./approvals");
const Computer  = require("./computer");
const AgentMail = require("./agent-mail");
const Groq      = require("./hermes-engine");

const DATA_DIR      = path.join(__dirname, "data");
const ACCOUNTS_PATH = path.join(DATA_DIR, "earn-accounts.json");
const MAX_PER_CYCLE = parseInt(process.env.EARN_MAX_SIGNUPS || "", 10) || 2;
const IDENTITY_NAME = process.env.JARVIS_SIGNUP_NAME || "Jarvis";
const RETRY_AFTER_MS = 7 * 24 * 3600 * 1000;
const OK_STATUSES = new Set(["created", "verified", "pending-verification"]);

// money / identity-verification sites are never touched automatically
const MONEY_HOST_RE = /(coinbase|binance|kraken|bybit|okx|kucoin|gemini\.com|paypal|stripe|wise\.com|revolut|venmo|cash\.app|robinhood|bank|payoneer|skrill|etoro|bitstamp)/i;
// a REQUIRED field matching this means the form wants something Jarvis doesn't have
const NEEDS_HUMAN_RE = /(phone|mobile|tel\b|card|cvv|cvc|ssn|social security|passport|iban|routing|account number|date of birth|birthday|\bdob\b|street|address|zip|postal|national id|driver)/i;

// ── small helpers ───────────────────────────────────────────────
function readJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fb; } }
function writeJson(p, v) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(v, null, 2), "utf8");
}
function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractJson(text) {
  const t = String(text || "").replace(/```json|```/g, "");
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("Model didn't return JSON");
  return JSON.parse(t.slice(a, b + 1));
}
async function llmJson(system, user, maxTokens = 900) {
  return extractJson(await Groq.groqFetch([
    { role: "system", content: system },
    { role: "user", content: user },
  ], undefined, 0.1, maxTokens));
}

// ── accounts ledger ─────────────────────────────────────────────
function loadAccounts() { return readJson(ACCOUNTS_PATH, {}); }
function saveAccount(host, rec) {
  const all = loadAccounts();
  all[host] = { ...(all[host] || {}), ...rec, host, at: new Date().toISOString() };
  writeJson(ACCOUNTS_PATH, all);
  return all[host];
}
function listAccounts() { return Object.values(loadAccounts()); }
function hasAccount(host) { const a = loadAccounts()[host]; return !!(a && OK_STATUSES.has(a.status)); }

// ── identity: nothing here is stored, it is derived on demand ───
function vaultSecret() {
  return process.env.EARN_VAULT_KEY || process.env.WALLET_ENCRYPTION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
}
function hmac(host, tag) {
  return crypto.createHmac("sha256", vaultSecret()).update(`jarvis-earn-signup:${tag}:${host}`).digest("hex");
}
function passwordFor(host) {
  if (!vaultSecret()) return null;
  const h = crypto.createHmac("sha256", vaultSecret()).update(`jarvis-earn-signup:pw:${host}`).digest("base64url");
  return `Jv!${h.slice(0, 18)}9a`;               // upper + lower + digit + symbol, 23 chars
}
function usernameFor(host) {
  if (!vaultSecret()) return null;
  return `jarvis_${hmac(host, "user").slice(0, 7)}`;
}

// ── page scripts that run inside the e2b sandbox ────────────────
// (kept as plain strings; String.raw so regex backslashes survive)
const COMMON = String.raw`
const fs = require('fs');
const { chromium } = require('playwright');
const ARGS = JSON.parse(fs.readFileSync('/home/user/_jv_args.json', 'utf8'));
const STATE = '/home/user/_jv_state.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function scan(page) {
  return await page.evaluate(() => {
    const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
    const labelOf = (el) => {
      let t = '';
      if (el.id) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) t = l.innerText; } catch (e) {} }
      if (!t) { const l = el.closest('label'); if (l) t = l.innerText; }
      if (!t) t = el.getAttribute('aria-label') || '';
      return String(t).replace(/\s+/g, ' ').trim().slice(0, 140);
    };
    document.querySelectorAll('[data-jv],[data-jvb]').forEach((e) => { e.removeAttribute('data-jv'); e.removeAttribute('data-jvb'); });
    const fields = [];
    document.querySelectorAll('input, select, textarea').forEach((el) => {
      const type = (el.getAttribute('type') || el.tagName).toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file'].indexOf(type) >= 0) return;
      if (!vis(el)) return;
      const i = fields.length;
      el.setAttribute('data-jv', String(i));
      const f = {
        i: i, tag: el.tagName.toLowerCase(), type: type, name: el.name || '', id: el.id || '',
        placeholder: el.placeholder || '', label: labelOf(el), autocomplete: el.getAttribute('autocomplete') || '',
        required: !!(el.required || el.getAttribute('aria-required') === 'true'),
      };
      if (el.tagName === 'SELECT') f.options = Array.prototype.slice.call(el.options, 0, 25).map((o) => o.textContent.trim());
      fields.push(f);
    });
    const buttons = [];
    document.querySelectorAll('button, input[type=submit], [role=button]').forEach((el) => {
      if (!vis(el)) return;
      const i = buttons.length;
      el.setAttribute('data-jvb', String(i));
      buttons.push({ i: i, type: (el.getAttribute('type') || '').toLowerCase(),
        text: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60) });
    });
    const captcha = !!document.querySelector('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"], iframe[src*="arkoselabs"], .g-recaptcha, .h-captcha, .cf-turnstile');
    return { fields: fields, buttons: buttons, captcha: captcha, text: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 1800) };
  });
}

// If the page has no password box yet, click the most obvious "Sign up" control once.
async function openSignup(page) {
  let s = await scan(page);
  if (s.fields.some((f) => f.type === 'password')) return s;
  const clicked = await page.evaluate(() => {
    const re = /^(sign ?up|register|create( an)? account|join( now| free)?|get started( free)?|try (it )?free)\b/i;
    const els = Array.prototype.slice.call(document.querySelectorAll('a, button, [role=button]'));
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 40 && re.test(t)) { el.click(); return t; }
    }
    return null;
  });
  if (clicked) { await page.waitForTimeout(3000); s = await scan(page); s.clicked = clicked; }
  return s;
}

async function launch(useState) {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const opts = { userAgent: UA, viewport: { width: 1280, height: 900 } };
  if (useState && fs.existsSync(STATE)) opts.storageState = STATE;
  const context = await browser.newContext(opts);
  const page = await context.newPage();
  return { browser: browser, context: context, page: page };
}
function finish(file, out) { fs.writeFileSync(file, JSON.stringify(out)); }
`;

const SCRIPT_INSPECT = COMMON + String.raw`
(async () => {
  const OUT = '/home/user/_jv_inspect_out.json';
  const out = { ok: false };
  let b;
  try {
    b = await launch(false);
    await b.page.goto(ARGS.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await b.page.waitForTimeout(2500);
    const s = await openSignup(b.page);
    out.ok = true; out.finalUrl = b.page.url(); out.fields = s.fields; out.buttons = s.buttons;
    out.captcha = s.captcha; out.text = s.text; out.clicked = s.clicked || null;
  } catch (e) { out.error = String((e && e.message) || e); }
  try { if (b) await b.browser.close(); } catch (e) {}
  finish(OUT, out);
})();
`;

const SCRIPT_FILL = COMMON + String.raw`
(async () => {
  const OUT = '/home/user/_jv_fill_out.json';
  const out = { ok: false };
  let b;
  try {
    b = await launch(false);
    const page = b.page;
    await page.goto(ARGS.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    const s = await openSignup(page);
    if (s.fields.length !== ARGS.expectedFields) throw new Error('The page changed since I read it (' + s.fields.length + ' fields vs ' + ARGS.expectedFields + ').');
    let lastFilled = null;
    for (const f of ARGS.fills) {
      const loc = page.locator('[data-jv="' + f.i + '"]');
      if (s.fields[f.i].tag === 'select') {
        try { await loc.selectOption({ label: String(f.value) }, { timeout: 6000 }); } catch (e) { await loc.selectOption(String(f.value), { timeout: 6000 }); }
      } else {
        await loc.fill(String(f.value), { timeout: 8000 });
        lastFilled = loc;
      }
    }
    for (const i of ARGS.checks) {
      try { await page.locator('[data-jv="' + i + '"]').check({ timeout: 5000, force: true }); } catch (e) {}
    }
    if (ARGS.submit !== null && ARGS.submit !== undefined) {
      const btn = page.locator('[data-jvb="' + ARGS.submit + '"]');
      try { await btn.click({ timeout: 8000 }); } catch (e) { await btn.dispatchEvent('click'); }
    } else if (lastFilled) {
      await lastFilled.press('Enter');
    } else { throw new Error('Nothing to submit with.'); }
    await page.waitForTimeout(5500);
    const after = await scan(page);
    try { await b.context.storageState({ path: STATE }); } catch (e) {}
    out.ok = true; out.finalUrl = page.url(); out.text = after.text; out.captchaAfter = after.captcha;
    out.passwordStillShown = after.fields.some((f) => f.type === 'password');
  } catch (e) { out.error = String((e && e.message) || e); }
  try { if (b) await b.browser.close(); } catch (e) {}
  finish(OUT, out);
})();
`;

const SCRIPT_CODE = COMMON + String.raw`
(async () => {
  const OUT = '/home/user/_jv_code_out.json';
  const out = { ok: false };
  let b;
  try {
    b = await launch(true);
    const page = b.page;
    await page.goto(ARGS.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2500);
    const s = await scan(page);
    const boxes = s.fields.filter((f) => ['text', 'tel', 'number', 'input', ''].indexOf(f.type) >= 0);
    const code = String(ARGS.code);
    if (boxes.length === 1) {
      await page.locator('[data-jv="' + boxes[0].i + '"]').fill(code, { timeout: 8000 });
    } else if (boxes.length === code.length) {
      for (let k = 0; k < boxes.length; k++) await page.locator('[data-jv="' + boxes[k].i + '"]').fill(code[k], { timeout: 5000 });
    } else { throw new Error('Could not tell where the code goes (' + boxes.length + ' candidate boxes).'); }
    const btn = s.buttons.find((x) => /verify|confirm|continue|submit|next|activate/i.test(x.text));
    if (btn) { try { await page.locator('[data-jvb="' + btn.i + '"]').click({ timeout: 8000 }); } catch (e) { await page.keyboard.press('Enter'); } }
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(4500);
    const after = await scan(page);
    out.ok = true; out.finalUrl = page.url(); out.text = after.text;
  } catch (e) { out.error = String((e && e.message) || e); }
  try { if (b) await b.browser.close(); } catch (e) {}
  finish(OUT, out);
})();
`;

let browserReady = false;
async function runPage(name, script, args, timeoutMs = 75000) {
  if (!browserReady) {
    // browsePage installs Playwright + Chromium into the sandbox on first use.
    await Computer.browsePage("about:blank", { waitMs: 100 });
    browserReady = true;
  }
  const outPath = `/home/user/_jv_${name}_out.json`;
  await Computer.runCommand(`rm -f ${outPath}`, { timeoutMs: 15000 });
  await Computer.writeFile("/home/user/_jv_args.json", JSON.stringify(args));
  await Computer.writeFile(`/home/user/_jv_${name}.js`, script);
  const run = await Computer.runCommand(`cd /home/user && node _jv_${name}.js`, { timeoutMs });
  try {
    return JSON.parse(await Computer.readFile(outPath));
  } catch {
    return { ok: false, error: (run.stderr || run.stdout || "the page script produced no output").slice(0, 300) };
  }
}

// ── deciding what goes in each box ──────────────────────────────
function describeFields(fields) {
  return fields.map(f =>
    `#${f.i} [${f.type}] label="${f.label}" name="${f.name}" placeholder="${f.placeholder}"` +
    `${f.required ? " REQUIRED" : ""}${f.options ? ` options=${JSON.stringify(f.options)}` : ""}`).join("\n");
}

// Things in the form that mean "a human has to do this" — checked in code, not by the model.
function findBlocker(snap) {
  if (snap.captcha) return { permanent: true, why: "the sign-up has a CAPTCHA (I don't get past those)" };
  for (const f of snap.fields) {
    if (!f.required || f.type === "checkbox") continue;
    const hay = `${f.label} ${f.name} ${f.placeholder} ${f.type} ${f.autocomplete}`;
    if (f.type === "tel" || NEEDS_HUMAN_RE.test(hay)) {
      return { permanent: true, why: `the form requires "${f.label || f.name || f.type}", which only the owner can provide` };
    }
  }
  return null;
}

async function planFill(host, snap, identity) {
  const plan = await llmJson(
    "You fill out a website's free account sign-up form for an AI agent called Jarvis. Reply with JSON only. " +
    "You may ONLY use the identity values given. Fields you have no value for: leave them out. " +
    "Never choose a 'Continue with Google/GitHub/Apple' style button. " +
    "Tick ONLY checkboxes that are required terms-of-service / privacy-policy agreements — never marketing, newsletter or 'keep me updated' boxes. " +
    "Pick the single button that creates the account.",
    `Site: ${host}\nIDENTITY: ${JSON.stringify({ email: identity.email, password: identity.password, username: identity.username, fullName: identity.fullName, firstName: identity.firstName, lastName: identity.lastName })}\n\n` +
    `FIELDS:\n${describeFields(snap.fields)}\n\nBUTTONS:\n${snap.buttons.map(b => `#${b.i} "${b.text}" ${b.type}`).join("\n")}\n\n` +
    `Return {"fills":[{"i":0,"value":"..."}],"checks":[2],"submit":3,"skip":null} — or {"skip":"reason"} if you can't do this safely.`, 900);
  return plan;
}

// The model's plan is only accepted if every value is one we own (or a real option of a dropdown).
function validatePlan(plan, snap, identity) {
  if (plan.skip) return { error: String(plan.skip).slice(0, 160) };
  const allowed = new Set([identity.email, identity.password, identity.username, identity.fullName, identity.firstName, identity.lastName]);
  const byIdx = new Map(snap.fields.map(f => [f.i, f]));
  const fills = [];
  for (const f of (plan.fills || [])) {
    const meta = byIdx.get(Number(f.i));
    if (!meta || meta.type === "checkbox" || meta.type === "radio") continue;
    const v = String(f.value ?? "");
    const ok = allowed.has(v) || (meta.tag === "select" && (meta.options || []).includes(v));
    if (!ok) return { error: `the plan tried to type a value I don't own into "${meta.label || meta.name}"` };
    fills.push({ i: meta.i, value: v });
  }
  // only REQUIRED checkboxes (terms / privacy) are ever ticked — marketing boxes are dropped here, whatever the model said
  const checks = (plan.checks || []).map(Number).filter(i => byIdx.get(i)?.type === "checkbox" && byIdx.get(i).required);
  const filled = new Set(fills.map(f => f.i));
  const checked = new Set(checks);
  const missing = snap.fields.find(f => f.required && !filled.has(f.i) && !(f.type === "checkbox" && checked.has(f.i)) && f.type !== "radio");
  if (missing) return { error: `I have no value for the required field "${missing.label || missing.name || missing.type}"` };
  const submit = Number.isInteger(Number(plan.submit)) && snap.buttons.some(b => b.i === Number(plan.submit)) ? Number(plan.submit) : null;
  return { fills, checks, submit };
}

// ── reading the confirmation email ──────────────────────────────
function bodyOf(msg) { return String(msg.extracted_text || msg.text || msg.html || ""); }
function pickVerifyLink(body) {
  const urls = [...String(body).matchAll(/https?:\/\/[^\s"'<>)\]]+/gi)].map(m => m[0].replace(/&amp;/g, "&"));
  const good = urls.find(u => /verif|confirm|activate|validate|magic|token|email-?check/i.test(u) && !/unsubscribe|optout/i.test(u));
  return good || null;
}
function pickCode(msg) {
  const body = bodyOf(msg);
  const near = body.match(/(?:code|otp|pin)[^0-9]{0,40}(\d{4,8})/i);
  if (near) return near[1];
  return AgentMail.extractVerificationCode(msg.subject || "");
}
async function seenIds(inboxId) {
  const r = await AgentMail.listMessages(inboxId, { limit: 30 });
  return new Set((!r.error && Array.isArray(r.messages) ? r.messages : []).map(m => m.message_id || m.id));
}
async function waitForNewMail(inboxId, seen, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await AgentMail.listMessages(inboxId, { limit: 30 });
    if (!r.error && Array.isArray(r.messages)) {
      const fresh = r.messages.find(m => !seen.has(m.message_id || m.id));
      if (fresh) {
        const full = await AgentMail.getMessage(inboxId, fresh.message_id || fresh.id);
        if (!full.error) return full;
      }
    }
    await sleep(4000);
  }
  return null;
}

async function classifyResult(text) {
  const t = String(text || "");
  try {
    const c = await llmJson("Reply with JSON only.",
      `This is the text of a web page right after someone submitted a sign-up form:\n"""${t.slice(0, 1500)}"""\n` +
      `What happened? Return {"status":"created"|"needs_verification"|"error"|"unclear","note":"one short sentence"}`, 200);
    if (["created", "needs_verification", "error", "unclear"].includes(c.status)) return c;
  } catch {}
  if (/already (exists|registered|taken|in use)|invalid|error|failed|try again/i.test(t)) return { status: "error", note: "the site reported a problem" };
  if (/verify|confirm|check your (e-?)?mail|sent (you )?an? (e-?)?mail|verification/i.test(t)) return { status: "needs_verification", note: "the site wants the email confirmed" };
  return { status: "unclear", note: "couldn't tell from the page" };
}

// ── one service, start to finish ────────────────────────────────
async function attemptSignup(cand, { isKnownBlocked } = {}) {
  const host = hostOf(cand.url);
  const rec = (status, note, extra = {}) => ({ host, url: cand.url, status, note, ...extra });
  const finish = (status, note, extra = {}) => { saveAccount(host, { signupUrl: cand.url, status, note, ...extra }); return rec(status, note, extra); };

  if (!host) return rec("skipped", "not a usable address");
  if (MONEY_HOST_RE.test(host)) return rec("skipped", "money / identity-verification sites stay manual");
  if (hasAccount(host)) return rec("skipped", "I already have an account there", { already: true, email: loadAccounts()[host]?.email });
  const prior = loadAccounts()[host];
  if (prior && Date.now() - Date.parse(prior.at || "") < RETRY_AFTER_MS && /blocked|failed/.test(prior.status)) {
    return rec("skipped", `tried recently (${prior.status}: ${prior.note || ""})`);
  }
  const known = isKnownBlocked ? isKnownBlocked(host) : null;
  if (known) return rec("skipped", `my own memory says no: ${known}`);

  const password = passwordFor(host), username = usernameFor(host);
  if (!password) return rec("failed", "no EARN_VAULT_KEY (or other secret) set, so I can't make a password I could re-derive later");

  // approval
  if (process.env.JARVIS_HEADLESS === "1") {
    Approvals.step("Signing up (headless, pre-approved)", `${host} — with my own AgentMail address`, "info");
  } else {
    const d = await Approvals.request({
      kind: "signup", risk: "medium",
      title: `Sign up on ${host} with my own email`,
      detail: `${cand.url}\n${cand.why || ""}\nI'll use my own AgentMail address and a password only I can re-derive. I won't pay, enter a phone/card/ID, solve CAPTCHAs, or tick marketing boxes.`,
      ruleKey: `earn-signup:${host}`,
    });
    if (d === "deny") return rec("skipped", "you said no");
  }

  // my own email for this service
  const inbox = await AgentMail.signupAddressFor(host);
  if (inbox.error) return finish("failed", `couldn't get an inbox: ${inbox.error}`);
  const identity = {
    email: inbox.email, password, username,
    fullName: `${IDENTITY_NAME} (AI assistant)`, firstName: IDENTITY_NAME, lastName: "Assistant",
  };

  // look at the form
  Approvals.step("Signing up", `Reading the sign-up form on ${host}`, "running");
  const snap = await runPage("inspect", SCRIPT_INSPECT, { url: cand.url });
  if (!snap.ok) return finish("failed", `couldn't open the page: ${snap.error || "unknown error"}`, { email: inbox.email, inbox_id: inbox.inbox_id });
  if (!snap.fields?.length) return finish("failed", "no sign-up form found on that page", { email: inbox.email, inbox_id: inbox.inbox_id });

  const blocker = findBlocker(snap);
  if (blocker) return finish("blocked", blocker.why, { email: inbox.email, inbox_id: inbox.inbox_id, permanent: blocker.permanent });

  // decide + verify what to type
  let plan;
  try { plan = validatePlan(await planFill(host, snap, identity), snap, identity); }
  catch (e) { return finish("failed", `couldn't plan the form: ${e.message}`, { email: inbox.email, inbox_id: inbox.inbox_id }); }
  if (plan.error) return finish("blocked", plan.error, { email: inbox.email, inbox_id: inbox.inbox_id, permanent: /required|own/.test(plan.error) });

  // submit
  const seen = await seenIds(inbox.inbox_id);
  Approvals.step("Signing up", `Submitting the form on ${host} as ${identity.email}`, "running");
  const sub = await runPage("fill", SCRIPT_FILL, { url: cand.url, expectedFields: snap.fields.length, fills: plan.fills, checks: plan.checks, submit: plan.submit });
  if (!sub.ok) return finish("failed", `couldn't submit: ${sub.error || "unknown error"}`, { email: inbox.email, inbox_id: inbox.inbox_id });
  if (sub.captchaAfter) return finish("blocked", "a CAPTCHA appeared after I submitted (I don't get past those)", { email: inbox.email, inbox_id: inbox.inbox_id, permanent: true });

  const verdict = await classifyResult(sub.text);
  if (verdict.status === "error") return finish("failed", verdict.note || "the site rejected the form", { email: inbox.email, inbox_id: inbox.inbox_id });

  // confirmation email (long wait if the site said it's coming, short peek otherwise)
  const wait = verdict.status === "needs_verification" ? 90000 : 15000;
  const mail = await waitForNewMail(inbox.inbox_id, seen, wait);
  let status = verdict.status === "needs_verification" ? "pending-verification" : "created";
  let note = verdict.note || "";
  if (mail) {
    const link = pickVerifyLink(bodyOf(mail));
    if (link) {
      Approvals.step("Signing up", `Confirming my email for ${host}`, "running");
      try {
        const page = await Computer.browsePage(link, { waitMs: 3000 });
        status = page && page.ok === false ? "pending-verification" : "verified";
        note = status === "verified" ? "account created and email confirmed" : "I got the confirmation email but the link didn't load";
      } catch (e) { status = "pending-verification"; note = `confirmation link failed: ${e.message}`; }
    } else {
      const code = pickCode(mail);
      if (code) {
        const c = await runPage("code", SCRIPT_CODE, { url: sub.finalUrl, code });
        if (c.ok && !/invalid|incorrect|wrong|expired/i.test(c.text || "")) { status = "verified"; note = "account created and email confirmed with a code"; }
        else { status = "pending-verification"; note = `got a code but couldn't enter it${c.error ? `: ${c.error}` : ""}`; }
      } else if (verdict.status === "needs_verification") {
        note = "confirmation email arrived but had no link or code I could use";
      }
    }
  } else if (verdict.status === "needs_verification") {
    note = "the confirmation email never arrived within 90s";
  }
  return finish(status, note, { email: inbox.email, inbox_id: inbox.inbox_id, username });
}

// ── public: run up to MAX_PER_CYCLE sign-ups ────────────────────
async function runSignups({ candidates = [], isKnownBlocked } = {}) {
  const out = [];
  if (!candidates.length) return out;
  if (!Computer.isConfigured()) {
    Approvals.step("Can't sign up yet", "No E2B_API_KEY, so I have no browser of my own.", "info");
    return [{ status: "skipped", note: "no E2B_API_KEY (no browser)" }];
  }
  if (!AgentMail.isConfigured()) {
    Approvals.step("Can't sign up yet", "No AGENTMAIL_API_KEY, so I have no email of my own.", "info");
    return [{ status: "skipped", note: "no AGENTMAIL_API_KEY (no email)" }];
  }
  let tried = 0;
  for (const cand of candidates) {
    if (tried >= MAX_PER_CYCLE) break;
    let r;
    try { r = await attemptSignup(cand, { isKnownBlocked }); }
    catch (e) { r = { host: hostOf(cand.url), url: cand.url, status: "failed", note: e.message }; }
    if (r.status !== "skipped") tried++;
    out.push(r);
    Approvals.step(
      r.status === "verified" || r.status === "created" ? "Signed up" : r.status === "skipped" ? "Skipped sign-up" : "Sign-up didn't finish",
      `${r.host || cand.url}: ${r.status}${r.note ? ` — ${r.note}` : ""}`,
      r.status === "verified" || r.status === "created" ? "done" : r.status === "skipped" ? "info" : "error");
  }
  return out;
}

module.exports = {
  runSignups, attemptSignup, listAccounts, hasAccount, passwordFor, usernameFor,
  _test: { findBlocker, validatePlan, pickVerifyLink, pickCode, SCRIPT_INSPECT, SCRIPT_FILL, SCRIPT_CODE, MONEY_HOST_RE },
};
