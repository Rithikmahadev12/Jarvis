"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Call Voice v2.0 (Windows)
//
// Two ways for Jarvis to actually get audio into a live Teams call.
// CALL_VOICE_METHOD in .env picks which one — defaults to
// "screenshare" (no extra install), set it to "cable" to use the
// VB-CABLE routing instead.
//
// ── METHOD 1: "screenshare" (DEFAULT) ─────────────────────────────
// No virtual audio driver, no PowerShell module — just Teams doing
// what Teams already does. The actual mechanics (opening the speak
// page, clicking Share, ticking "include audio", stopping the share
// after) live in teams-control.js since that's where all the other
// vision-guided Teams UI control already is; this file just times it
// (how long the clip runs) and dispatches to it. See
// teams-control.js's speakOnScreenShare() for the step-by-step.
// Honest tradeoff vs cable: the share picker itself is visible for a
// few seconds on your screen, and if Microsoft reflows Teams' UI this
// is the path most likely to need a description tweak.
//
// ── METHOD 2: "cable" (opt-in) ──────────────────────────────────────
// YES — Jarvis switches audio back to your own mic/speakers the
// moment it's done talking. Here's exactly how, so it's not a black
// box:
//
// ONE-TIME SETUP (you do this once, not Jarvis):
//   1. Install VB-CABLE (free): https://vb-audio.com/Cable/
//      This creates two virtual devices: "CABLE Input" (a playback
//      device) and "CABLE Output" (a recording device) — anything
//      played into CABLE Input is instantly readable from CABLE
//      Output, like a wire between them.
//   2. Install the AudioDeviceCmdlets PowerShell module (one time,
//      run as admin): Install-Module -Name AudioDeviceCmdlets
//      This is what lets Jarvis switch your default PLAYBACK device
//      from Node — the speaker/headphones half of the routing.
//   Nothing else — no "Same as System" setting needed in Teams. See
//   point 3 below for why.
//
// RUNTIME, every time Jarvis speaks into a call via the cable method:
//   1. Confirm the call actually connected (teams-control.js's
//      waitForCallConnected) — no point doing any of this into a call
//      that's still ringing.
//   2. Remember your CURRENT default playback device (real
//      speakers/headphones) AND whichever microphone is currently
//      selected inside Teams itself — read straight off Teams' own
//      device picker, not assumed.
//   3. Switch default playback -> "CABLE Input", AND switch Teams'
//      OWN in-app microphone selection (via its device-picker
//      dropdown, the little chevron next to the Mic button in the
//      call toolbar — teams-control.js's switchTeamsMicTo) -> "CABLE
//      Output". Driving Teams' own picker directly, instead of
//      relying on Windows' default-communications-device setting,
//      means this doesn't depend on a "Same as System" setting inside
//      Teams that could silently drift.
//   4. Play the TTS audio (through the now-redirected default
//      playback device, so it flows into the cable -> Teams mic).
//   5. The MOMENT playback finishes, switch playback back to your
//      real speakers AND switch Teams' mic picker back to whatever it
//      actually had selected in step 2 — not a guessed default. This
//      is not "eventually" or "on a timer" — it's driven directly off
//      the audio file's actual duration, so it's back to you as fast
//      as the audio itself.
//
// TIMING CAVEAT (applies to both methods): CALL_SPEAK_DELAY_MS
// (default 6000ms) is now a settle beat AFTER the call is confirmed
// connected (see step 1), not a blind guess at when someone might
// pick up — tune it down if that still feels slow.
// ═══════════════════════════════════════════════════════════════

const { exec } = require("child_process");
const os = require("os");
const fs = require("fs");
const path = require("path");

const CALL_SPEAK_DELAY_MS = Number(process.env.CALL_SPEAK_DELAY_MS) || 1500;
const CALL_VOICE_METHOD = String(process.env.CALL_VOICE_METHOD || "screenshare").trim().toLowerCase();
const CABLE_PLAYBACK_NAME = process.env.VB_CABLE_PLAYBACK_NAME || "CABLE Input";
const CABLE_RECORDING_NAME = process.env.VB_CABLE_RECORDING_NAME || "CABLE Output";
// What Jarvis looks for inside TEAMS' OWN mic picker (fuzzy-matched —
// doesn't need Teams' full parenthetical, e.g. "CABLE Output (VB-Audio
// Virtual Cable)" — just enough to be unambiguous).
const TEAMS_CABLE_MIC_LABEL = process.env.TEAMS_CABLE_MIC_LABEL || CABLE_RECORDING_NAME;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isWindows() { return os.platform() === "win32"; }

function runPS(cmd, timeout = 10000) {
  return new Promise((resolve, reject) => {
    exec(`powershell -NoProfile -Command "${cmd.replace(/"/g, '\\"')}"`, { windowsHide: true, timeout }, (err, stdout) => {
      if (err) return reject(err);
      resolve(String(stdout || "").trim());
    });
  });
}

// ── DEVICE SWITCHING (AudioDeviceCmdlets) ─────────────────────────
async function getCurrentDevices() {
  const playback = await runPS(`(Get-AudioDevice -Playback).Name`);
  const recording = await runPS(`(Get-AudioDevice -RecordingCommunication).Name`);
  return { playback, recording };
}

async function setDevices(playbackName, recordingName) {
  if (playbackName) await runPS(`Set-AudioDevice -PlaybackID (Get-AudioDevice -List | Where-Object {$_.Name -eq "${playbackName}" -and $_.Type -eq "Playback"} | Select-Object -First 1 -ExpandProperty ID)`).catch(() => {});
  if (recordingName) await runPS(`Set-AudioDevice -CommunicationID (Get-AudioDevice -List | Where-Object {$_.Name -eq "${recordingName}" -and $_.Type -eq "Recording"} | Select-Object -First 1 -ExpandProperty ID)`).catch(() => {});
}

async function checkCableInstalled() {
  const list = await runPS(`Get-AudioDevice -List | Select-Object -ExpandProperty Name`).catch(() => "");
  return list.includes(CABLE_PLAYBACK_NAME) && list.includes(CABLE_RECORDING_NAME);
}

// ── PLAY AUDIO AND WAIT FOR IT TO ACTUALLY FINISH ─────────────────
// Uses ffplay (ships with ffmpeg, already a common dependency in
// voice-assistant setups) so duration-based waiting is exact rather
// than a guessed timeout. If ffplay isn't on PATH this throws — see
// the setup note in WHATS_NEW.md.
function playAndWait(filePath) {
  return new Promise((resolve, reject) => {
    exec(`ffplay -nodisp -autoexit -loglevel quiet "${filePath}"`, { windowsHide: true }, (err) => {
      if (err) return reject(new Error("ffplay failed — is ffmpeg installed and on PATH?"));
      resolve();
    });
  });
}

// ── MAIN: SPEAK A LINE INTO THE ACTIVE CALL ───────────────────────
// audioFilePath: a WAV/MP3 already rendered by tts.js — this module
// doesn't do text-to-speech itself, it just routes and plays it.
//
// Two devices get switched here, by two different mechanisms:
//   - PLAYBACK (speakers/headphones -> CABLE Input): switched via
//     Windows' AudioDeviceCmdlets, same as before — Jarvis's TTS
//     playback has to leave your machine's audio output somehow, and
//     that's a Windows-level default, not something Teams exposes.
//   - MICROPHONE (-> CABLE Output): switched via Teams' OWN in-app
//     device picker (teams-control.js's switchTeamsMicTo), not a
//     Windows default — this is what makes it not depend on Teams
//     being set to "Same as System".
async function speakIntoCall(audioFilePath, opts = {}) {
  if (!isWindows()) {
    throw new Error("Speaking into a live call via a virtual cable is only wired up for Windows right now.");
  }
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Audio file not found: ${audioFilePath}`);
  }
  const cableReady = await checkCableInstalled();
  if (!cableReady) {
    throw new Error(
      `VB-CABLE devices ("${CABLE_PLAYBACK_NAME}" / "${CABLE_RECORDING_NAME}") weren't found. ` +
      `Install VB-CABLE first — see call-voice.js setup notes.`
    );
  }

  const teams = require("./teams-control"); // required lazily — keeps this file's own require list to what the cable method needs

  const micLabel = opts.micLabel || TEAMS_CABLE_MIC_LABEL;
  const originalPlayback = (await getCurrentDevices()).playback;
  let previousMicLabel = null;

  try {
    // Mic first (via Teams' own picker), then playback (via Windows) —
    // order doesn't functionally matter, but doing the Teams-UI step
    // first means if it throws (mic option not found, call not
    // active), Jarvis never touches your speakers at all.
    previousMicLabel = await teams.switchTeamsMicTo(micLabel);
    await setDevices(CABLE_PLAYBACK_NAME, null); // playback only — recording is handled inside Teams now, not via Windows default
    await sleep(150); // let Windows settle the device switch before playing
    await playAndWait(audioFilePath);
  } finally {
    // ALWAYS restore both, even if something above threw — this is
    // the "switch back to my mic and speakers" guarantee. Runs
    // whether speech succeeded, failed partway, or ffplay errored out.
    await setDevices(originalPlayback, null);
    if (previousMicLabel) {
      await teams.switchTeamsMicBack(previousMicLabel).catch(() => {});
    }
  }

  return { restoredPlaybackTo: originalPlayback, restoredMicTo: previousMicLabel };
}

// ── AUDIO DURATION (used to time the screen-share method) ─────────
// ffprobe ships with the same ffmpeg install the cable method already
// relies on for ffplay, so no new dependency. Falls back to a
// conservative flat guess if ffprobe isn't on PATH rather than
// throwing — a slightly-off timer is much better than a hard failure
// on what's otherwise a working call.
function getAudioDurationMs(filePath, fallbackMs = 4000) {
  return new Promise((resolve) => {
    exec(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${filePath}"`, { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err) return resolve(fallbackMs);
      const secs = parseFloat(String(stdout || "").trim());
      resolve(Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : fallbackMs);
    });
  });
}

// ── MAIN: SPEAK A LINE INTO THE ACTIVE CALL VIA SCREEN SHARE ──────
// mediaUrl must be reachable by a browser on this machine (server.js
// publishes it via cast.js's publishAudio()) — teams-control.js opens
// it in a dedicated "Jarvis — Speaking" window, shares that window
// with audio into the live Teams call, waits out the clip, then stops
// sharing.
async function speakIntoCallViaScreenShare(audioFilePath, mediaUrl) {
  if (!isWindows()) {
    throw new Error("Speaking into a live call is only wired up for Windows right now.");
  }
  if (!fs.existsSync(audioFilePath)) {
    throw new Error(`Audio file not found: ${audioFilePath}`);
  }
  if (!mediaUrl) {
    throw new Error("speakIntoCallViaScreenShare needs a mediaUrl a browser can actually open.");
  }
  const durationMs = await getAudioDurationMs(audioFilePath);
  const teams = require("./teams-control"); // required lazily — no cycle, just keeps this file's own require list to what the cable method needs
  return teams.speakOnScreenShare(mediaUrl, durationMs);
}

// Convenience wrapper matching the "call X and tell them Y" flow:
// confirms the call actually connected, waits a short settle delay,
// then speaks — via whichever method CALL_VOICE_METHOD selects.
//   opts.filePath: local path to the rendered TTS audio (both methods need this)
//   opts.mediaUrl: HTTP URL to that same audio (screenshare method only)
//   opts.skipConnectCheck: set true for flows that already verified
//     connection themselves (e.g. joining a meeting via link, where
//     "in the meeting" was already confirmed before this is called).
async function speakAfterDialing(opts = {}, delayMs = CALL_SPEAK_DELAY_MS) {
  const filePath = typeof opts === "string" ? opts : opts.filePath; // tolerate the old string-arg call shape
  const skipConnectCheck = typeof opts === "object" && opts.skipConnectCheck;

  if (!skipConnectCheck) {
    // Neither method should switch mics or start playing into a call
    // that's still ringing — check first, rather than just guessing
    // off a timer whether anyone's actually picked up yet.
    const teams = require("./teams-control");
    const connected = await teams.waitForCallConnected();
    if (!connected) {
      throw new Error("Nobody appears to have picked up the call — never saw it connect, so Jarvis didn't switch mics or try to speak.");
    }
  }

  await sleep(delayMs); // short settle beat after connecting, before speaking

  if (CALL_VOICE_METHOD === "cable") {
    if (!filePath) throw new Error("speakAfterDialing needs opts.filePath for the cable method.");
    return speakIntoCall(filePath);
  }
  // Default: screenshare
  const mediaUrl = typeof opts === "object" ? opts.mediaUrl : null;
  if (!filePath || !mediaUrl) {
    throw new Error("speakAfterDialing needs opts.filePath and opts.mediaUrl for the screenshare method.");
  }
  return speakIntoCallViaScreenShare(filePath, mediaUrl);
}

module.exports = {
  speakIntoCall,
  speakIntoCallViaScreenShare,
  speakAfterDialing,
  checkCableInstalled,
  getCurrentDevices,
  getAudioDurationMs,
  CALL_SPEAK_DELAY_MS,
  CALL_VOICE_METHOD,
};
