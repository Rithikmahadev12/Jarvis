"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — WhatsApp Routes
//
// Mounts the WhatsApp multi-user system onto server.js.
// Call mount(app) from server.js once — it starts all polling loops,
// the weekly earn reporter, and exposes REST endpoints for:
//
//   GET  /api/whatsapp/accounts        — list all accounts (owner only)
//   POST /api/whatsapp/accounts        — register/update an account
//   DEL  /api/whatsapp/accounts/:key   — remove an account
//   GET  /api/whatsapp/status          — polling loop health check
//
// Also patches the face-ID system in server.js so that the face
// image stored per WhatsApp account is usable for site login.
// ═══════════════════════════════════════════════════════════════

const Manager    = require("./whatsapp-manager");
const Poller     = require("./whatsapp-poller");
const EarnReport = require("./whatsapp-earn-reporter");

// ── boot: start everything ────────────────────────────────────────
function boot() {
  // Start polling loops for all pre-existing accounts
  Poller.startAll();

  // Start weekly earn reporter
  EarnReport.startWeeklyReporter();

  // If NO accounts at all exist yet, the owner's first WhatsApp message
  // triggers the setup flow in whatsapp-setup-flow.js — but we need to
  // start a "bootstrap" poller that listens on the owner's key BEFORE
  // they're registered. The owner adds WHATSAPP_OWNER_API_KEY to .env
  // for this bootstrap phase.
  const ownerKey = process.env.WHATSAPP_OWNER_API_KEY;
  const owner    = Manager.getOwnerAccount();

  if (ownerKey && !owner) {
    // Bootstrap: listen on owner key with no registered account yet
    // The setup flow in whatsapp-setup-flow.js handles name collection
    console.log("[WA-ROUTES] No owner account yet — starting bootstrap listener on WHATSAPP_OWNER_API_KEY");
    Poller.startPollingForAccount({
      userKey:        "__bootstrap_owner__",
      name:           "Owner (unregistered)",
      whatsappApiKey: ownerKey,
      role:           "owner",
    });
  } else if (!ownerKey && !owner) {
    console.log("[WA-ROUTES] Set WHATSAPP_OWNER_API_KEY in .env to enable WhatsApp — this is your WhatsApp Agent API key.");
  }
}

// ── REST endpoints ────────────────────────────────────────────────
function mount(app) {
  // List all accounts
  app.get("/api/whatsapp/accounts", (req, res) => {
    const accounts = Manager.getAllAccounts().map(a => ({
      userKey:      a.userKey,
      name:         a.name,
      role:         a.role,
      hasFaceImage: !!a.faceImageBase64,
      walletAddress: a.walletAddress,
      earnEnabled:  a.earnEnabled,
      registeredAt: a.registeredAt,
      lastActiveAt: a.lastActiveAt,
      lastWeeklyReportAt: a.lastWeeklyReportAt,
    }));
    res.json({ accounts });
  });

  // Register / update an account (also used by admin UI)
  app.post("/api/whatsapp/accounts", async (req, res) => {
    const { name, whatsappApiKey, faceImageBase64, role } = req.body || {};
    if (!name || !whatsappApiKey) {
      return res.status(400).json({ error: "name and whatsappApiKey are required." });
    }
    try {
      const result = Manager.registerAccount({ name, whatsappApiKey, faceImageBase64, role });
      Poller.onAccountAdded(result.userKey);

      // Provision wallet if needed
      let walletResult = null;
      try {
        const WalletSetup = require("../wallet-setup");
        walletResult = await WalletSetup.ensureUserWallet(Manager.toKey(name));
        if (walletResult?.address) {
          Manager.setWalletAddress(Manager.toKey(name), walletResult.address);
        }
      } catch (e) {
        walletResult = { error: e.message };
      }

      res.json({ ...result, wallet: walletResult });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Remove an account
  app.delete("/api/whatsapp/accounts/:key", (req, res) => {
    const removed = Manager.removeAccount(req.params.key);
    if (removed) Poller.onAccountRemoved(req.params.key);
    res.json({ removed });
  });

  // Status / health
  app.get("/api/whatsapp/status", (req, res) => {
    const accounts = Manager.getAllAccounts();
    res.json({
      enabled:       true,
      totalAccounts: accounts.length,
      ownerSet:      !!Manager.getOwnerAccount(),
      accounts:      accounts.map(a => ({
        name:        a.name,
        role:        a.role,
        lastActive:  a.lastActiveAt,
      })),
    });
  });

  // Boot all services
  boot();

  console.log("[WA-ROUTES] WhatsApp multi-user system mounted. ✅");
}

module.exports = { mount };
