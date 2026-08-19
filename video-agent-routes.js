"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Video Ad Campaigns (orchestration + routes)
//
// Ties together, in order:
//   business-clients.js  (who the ad is for)
//   video-script.js      (the brain writes the script)
//   video-producer.js    (screen-recorded slideshow + Camb.ai narration)
//   postiz-agent.js      (posts the finished video)
//
// Runs as a background job (same shape as site-builder.js's
// startBuild()/status-polling pattern) since a real video takes real
// time (TTS + a full-length screen recording) — the tool call that
// kicks this off returns instantly with a campaignId, the frontend
// polls GET /api/video-ads/campaigns/:id for progress.
//
// The finished .mp4 is written to data/videos/ and served statically
// at /videos/<id>.mp4 — Postiz's own container needs a URL it can
// fetch the file from itself, not a local sandbox path, since Postiz
// runs as a separate process (see postiz-agent.js's header for why it
// can't live in Jarvis's own ephemeral sandbox).
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const express = require("express");

const BusinessClients = require("./business-clients");
const VideoScript = require("./video-script");
const VideoProducer = require("./video-producer");
const Postiz = require("./postiz-agent");

const DATA_DIR  = path.join(__dirname, "data");
const VIDEO_DIR = path.join(DATA_DIR, "videos");

function ensureVideoDir() {
  if (!fs.existsSync(VIDEO_DIR)) fs.mkdirSync(VIDEO_DIR, { recursive: true });
}

function publicBaseUrl() {
  return String(process.env.PUBLIC_BASE_URL || process.env.STORE_BASE_URL || "").trim().replace(/\/+$/, "");
}

// ── IN-MEMORY JOB STATE (process-local — fine for a single-instance
// deploy; a campaign in progress just gets re-run if the process
// restarts mid-job, same tradeoff site-builder.js already accepts) ──
const campaigns = new Map(); // id -> { id, clientId, status, step, error, videoUrl, postizResult, createdAt }

function newCampaignId() {
  return `camp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function getCampaign(id) {
  return campaigns.get(id) || null;
}

function listCampaigns(clientId) {
  const all = Array.from(campaigns.values()).sort((a, b) => b.createdAt - a.createdAt);
  return clientId ? all.filter((c) => c.clientId === clientId) : all;
}

function setStatus(id, patch) {
  const c = campaigns.get(id);
  if (!c) return;
  Object.assign(c, patch);
}

/**
 * Kick off a full campaign for a client already stored in
 * business-clients.js: generate the script, produce the video,
 * (best-effort) post it via Postiz. Returns immediately with the
 * campaignId — poll getCampaign(id) for progress.
 */
function startCampaign(clientId, opts = {}) {
  const client = BusinessClients.getClient(clientId);
  if (!client) throw new Error(`No business client found with id "${clientId}".`);

  const id = newCampaignId();
  campaigns.set(id, {
    id,
    clientId,
    clientName: client.name,
    status: "running",
    step: "script",
    error: null,
    script: null,
    videoUrl: null,
    postizResult: null,
    postizSkippedReason: null,
    createdAt: Date.now(),
  });

  runCampaign(id, client, opts).catch((e) => {
    setStatus(id, { status: "failed", error: e.message });
    console.error(`[VIDEO-ADS] Campaign ${id} failed at some point: ${e.message}`);
  });

  return id;
}

async function runCampaign(id, client, opts) {
  // 1. Script
  setStatus(id, { step: "script" });
  const script = await VideoScript.generateVideoScript(client, opts);
  setStatus(id, { script });

  // 2. Video
  setStatus(id, { step: "recording" });
  const video = await VideoProducer.produceVideo(script);
  if (video.failedScenes.length) {
    console.warn(`[VIDEO-ADS] Campaign ${id}: ${video.failedScenes.length} scene(s) fell back to silence (TTS failed for those).`);
  }

  // 3. Save + expose publicly
  setStatus(id, { step: "saving" });
  ensureVideoDir();
  const filename = `${id}.mp4`;
  fs.writeFileSync(path.join(VIDEO_DIR, filename), video.videoBuffer);
  const base = publicBaseUrl();
  const videoUrl = base ? `${base}/videos/${filename}` : `/videos/${filename}`;
  setStatus(id, { videoUrl, videoSeconds: video.seconds, failedScenes: video.failedScenes });

  if (!base) {
    console.warn(`[VIDEO-ADS] Campaign ${id}: PUBLIC_BASE_URL/STORE_BASE_URL isn't set — the video is only reachable at a relative path, which won't work for Postiz posting from a different host. Set one of those env vars for posting to actually work.`);
  }

  // 4. Post via Postiz — best effort. A campaign that produced a real,
  // downloadable video is still a WIN even if posting isn't wired up
  // yet, so this never turns the whole campaign into a failure.
  setStatus(id, { step: "posting" });
  if (!Postiz.isConfigured()) {
    setStatus(id, { status: "done", step: "done", postizSkippedReason: "Postiz isn't set up yet — run the Postiz setup, connect your accounts, and save an API key to post automatically next time." });
    return;
  }
  if (!base) {
    setStatus(id, { status: "done", step: "done", postizSkippedReason: "No public URL configured for Jarvis (PUBLIC_BASE_URL/STORE_BASE_URL) — Postiz's own server can't fetch the video to post it." });
    return;
  }

  try {
    const integrations = client.platforms && client.platforms.length ? client.platforms : null;
    if (!integrations) {
      setStatus(id, { status: "done", step: "done", postizSkippedReason: `${client.name} has no platforms selected to post to yet.` });
      return;
    }
    const postizResult = await Postiz.createPost({
      content: script.caption || script.title,
      mediaUrl: videoUrl,
      platforms: integrations,
    });
    setStatus(id, { status: "done", step: "done", postizResult });
  } catch (e) {
    // Posting failed but the video itself is fine and downloadable —
    // surface the posting error without discarding the finished asset.
    setStatus(id, { status: "done", step: "done", postizSkippedReason: `Video's ready, but posting via Postiz failed: ${e.message}` });
  }
}

// ── ROUTES ──────────────────────────────────────────────────────
function mount(app) {
  ensureVideoDir();

  // Public — Postiz's own server (wherever it's running) needs to be
  // able to GET this without auth to actually fetch the media.
  app.use("/videos", express.static(VIDEO_DIR));

  app.post("/api/video-ads/clients", (req, res) => {
    try {
      const client = BusinessClients.upsertClient(req.body || {});
      res.json({ ok: true, client });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/video-ads/clients", (_req, res) => {
    res.json({ ok: true, clients: BusinessClients.listClients() });
  });

  app.post("/api/video-ads/campaigns", (req, res) => {
    try {
      const { clientId, targetSeconds } = req.body || {};
      if (!clientId) return res.status(400).json({ ok: false, error: "clientId is required." });
      const id = startCampaign(clientId, { targetSeconds });
      res.json({ ok: true, campaignId: id });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.get("/api/video-ads/campaigns/:id", (req, res) => {
    const c = getCampaign(req.params.id);
    if (!c) return res.status(404).json({ ok: false, error: "No campaign with that id." });
    res.json({ ok: true, campaign: c });
  });

  app.get("/api/video-ads/campaigns", (req, res) => {
    res.json({ ok: true, campaigns: listCampaigns(req.query.clientId) });
  });

  app.post("/api/video-ads/postiz/setup", async (_req, res) => {
    try {
      const result = await Postiz.ensurePostiz();
      res.json({ ok: true, result });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });

  app.post("/api/video-ads/postiz/api-key", (req, res) => {
    try {
      Postiz.savePostizApiKey((req.body || {}).apiKey);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
}

module.exports = {
  mount,
  startCampaign,
  getCampaign,
  listCampaigns,
};
