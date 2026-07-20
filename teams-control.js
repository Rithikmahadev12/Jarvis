"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Teams Control v2.0 (NO Microsoft Graph API)
//
// Per explicit instruction: this does NOT call Microsoft Graph.
// It controls the real Teams desktop app on your machine the same
// way you would — opening it, clicking the search box, clicking a
// contact, clicking Call, reading the chat off the screen. You're
// already signed in, so there's no Azure app registration, no
// OAuth, no separate sign-in step.
//
// HONEST LIMITATIONS (read this before relying on it):
//   - This is UI automation, not an API. If Microsoft reflows the
//     Teams UI in an update, some steps here can start missing
//     their target. Vision-guided clicking (screen-vision.js) is
//     more resilient to that than hardcoded coordinates or
//     hardcoded keyboard shortcuts would be, but it's not bulletproof.
//   - Each step takes real screenshot+vision round-trips (roughly
//     1-3 seconds each), so a full "call X and tell them Y" sequence
//     takes several seconds, not instant.
//   - "Incoming call" detection (see watchForIncomingCalls) is
//     best-effort window-title polling — there is no push event
//     without Graph, so Jarvis is checking every few seconds, not
//     reacting instantly.
//
// SETUP: none beyond what's already in this repo. Teams just needs
// to already be installed and you signed in once, same as normal.
// ═══════════════════════════════════════════════════════════════

const { exec } = require("child_process");
const os = require("os");
const vision = require("./screen-vision");
const agent = require("./jarvis-agent");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isWindows() { return os.platform() === "win32"; }

// ── OPEN ────────────────────────────────────────────────────────
// Launches Teams via its own URI protocol where possible (fast,
// reliable, and it's what Windows itself uses for Teams links), and
// falls back to the plain app-alias launch on other platforms.
async function openTeams() {
  await agent.openTarget(isWindows() ? "ms-teams:" : "teams");
  await sleep(2500); // give the window time to come to the foreground
  return true;
}

async function openWhatsApp() {
  await agent.openTarget(isWindows() ? "whatsapp:" : "whatsapp");
  await sleep(2000);
  return true;
}

// ── FOCUS TEAMS' SEARCH BOX AND SEARCH FOR A PERSON ───────────────
// Ctrl+E is Teams' one genuinely stable shortcut across recent
// desktop versions (confirmed on both classic and new Teams as of
// this writing) — used here as the one hardcoded hotkey in this
// file, everything after it is vision-guided.
async function openChatWith(personName) {
  await openTeams();
  await agent.runCommand(isWindows()
    ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^e')"`
    : `osascript -e 'tell application "System Events" to keystroke "e" using command down'`);
  await sleep(500);
  await agent.typeText(personName);
  await sleep(1200); // let search results render

  const clicked = await vision.findAndClick(`the search result for a person or chat named "${personName}" in the Teams search dropdown`);
  if (!clicked) {
    throw new Error(`Couldn't find "${personName}" in the Teams search results, ${await friendlyReason()}`);
  }
  await sleep(1500); // let the chat pane load
  return true;
}

async function friendlyReason() {
  return "either the name didn't match anyone or the search dropdown wasn't visible when Jarvis looked.";
}

// ── READ THE LATEST MESSAGE IN A CHAT ────────────────────────────
async function checkChatWith(personName) {
  await openChatWith(personName);
  const answer = await vision.lookAtScreen(
    `This is a Microsoft Teams chat window. What is the most recent message in this conversation, and who sent it? ` +
    `If nothing meaningful is visible (empty chat, chat didn't load), say so plainly.`
  );
  return answer;
}

// ── SEND A TEXT MESSAGE ───────────────────────────────────────────
async function messageOnTeams(personName, text) {
  await openChatWith(personName);
  const clicked = await vision.findAndClick(`the message compose text box at the bottom of the Teams chat window`);
  if (!clicked) throw new Error("Couldn't find the message box in this chat.");
  await sleep(300);
  await agent.typeText(text);
  await sleep(200);
  // Enter sends in Teams by default (unless the tenant has changed
  // that setting, which Jarvis can't detect) — SendKeys ENTER is the
  // one hotkey step in the send path, matching the search-box hotkey
  // above.
  await agent.runCommand(isWindows()
    ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')"`
    : `osascript -e 'tell application "System Events" to key code 36'`);
  return true;
}

// ── PLACE A CALL ──────────────────────────────────────────────────
// callType: "audio" | "video"
async function callOnTeams(personName, callType = "audio") {
  await openChatWith(personName);
  const label = callType === "video" ? "video call button (camera icon)" : "audio call button (phone icon)";
  const clicked = await vision.findAndClick(`the ${label} in the top-right toolbar of this Teams chat window`);
  if (!clicked) throw new Error(`Couldn't find the ${callType} call button in this chat's toolbar.`);
  return true;
}

// ── JOIN TODAY'S MEETING ─────────────────────────────────────────
// Opens the Calendar tab and clicks whatever "Join" button is
// visible. This finds a currently-live or imminent meeting, not a
// specific one by name — if you have several meetings close
// together, tell it which one ("join the standup") and it'll try
// to match that in the visible meeting list first.
async function joinMeeting(meetingHint) {
  await openTeams();
  await vision.findAndClick(`the Calendar icon in the left sidebar of Teams`);
  await sleep(1500);

  const target = meetingHint
    ? `the "Join" button next to the meeting whose title matches or relates to "${meetingHint}"`
    : `the "Join" button on the meeting that is currently live or starting soonest`;
  const clicked = await vision.findAndClick(target);
  if (!clicked) throw new Error("Couldn't find a joinable meeting on screen. Is Teams' Calendar tab showing today's meetings?");

  await sleep(1500);
  // Pre-join screen usually needs a second confirm click.
  await vision.findAndClick(`the "Join now" button on the meeting pre-join screen`).catch(() => {});
  return true;
}

// ── INCOMING CALL: ACCEPT / DECLINE ───────────────────────────────
async function respondToIncomingCall(accept) {
  const label = accept ? `the green "Accept" call button` : `the red "Decline" call button`;
  const clicked = await vision.findAndClick(`${label} on the incoming Teams call notification`);
  if (!clicked) throw new Error("No incoming call notification found on screen right now.");
  return true;
}

// ── INCOMING CALL WATCHER (best-effort) ───────────────────────────
// No push events without Graph, so this polls window titles for
// something that looks like an incoming-call toast. Windows-only.
// Off by default — call startIncomingCallWatch() to enable, e.g.
// from server.js at startup if JARVIS_AUTO_WATCH_CALLS=true in .env.
let watchTimer = null;

function listWindowTitles() {
  return new Promise((resolve) => {
    if (!isWindows()) return resolve([]);
    exec(
      `powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object -ExpandProperty MainWindowTitle"`,
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => resolve(err ? [] : String(stdout || "").split(/\r?\n/).filter(Boolean))
    );
  });
}

function startIncomingCallWatch(onIncomingCall, intervalMs = 4000) {
  if (watchTimer) return; // already running
  let lastFlagged = 0;
  watchTimer = setInterval(async () => {
    try {
      const titles = listWindowTitles ? await listWindowTitles() : [];
      const ringing = titles.find((t) => /incoming (video |audio )?call/i.test(t));
      if (ringing && Date.now() - lastFlagged > 15000) {
        lastFlagged = Date.now();
        onIncomingCall(ringing);
      }
    } catch { /* swallow — this is a best-effort background poll */ }
  }, intervalMs);
}

function stopIncomingCallWatch() {
  if (watchTimer) { clearInterval(watchTimer); watchTimer = null; }
}

module.exports = {
  openTeams,
  openWhatsApp,
  openChatWith,
  checkChatWith,
  messageOnTeams,
  callOnTeams,
  joinMeeting,
  respondToIncomingCall,
  startIncomingCallWatch,
  stopIncomingCallWatch,
};
