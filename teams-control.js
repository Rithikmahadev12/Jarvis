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
const { URL } = require("url");
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
// Returns the name Jarvis actually opened a chat with — usually just
// personName echoed back, but see the closest-match fallback below,
// where it can differ from what was asked for.
async function openChatWith(personName) {
  await openTeams();
  await agent.runCommand(isWindows()
    ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^e')"`
    : `osascript -e 'tell application "System Events" to keystroke "e" using command down'`);
  await sleep(500);
  await agent.typeText(personName);
  await sleep(1200); // let search results render

  let clicked = await vision.findAndClick(`the search result for a person or chat named exactly "${personName}" in the Teams search dropdown`);
  let matchedName = personName;

  // ── CLOSEST-MATCH FALLBACK ───────────────────────────────────
  // No exact hit — rather than give up, ask the vision model to
  // read whatever names ARE actually showing in the dropdown and
  // pick whichever one is closest to what was asked for (nickname,
  // misspelling, partial name, contact saved under a different
  // display name, etc.), then click that instead. One extra
  // screenshot round-trip, only spent when the exact match already
  // missed.
  if (!clicked) {
    const closest = (await vision.lookAtScreen(
      `This is a Microsoft Teams search dropdown that should be listing people/chats matching "${personName}", but nothing matched exactly. ` +
      `Look at the actual names visible in the dropdown right now and tell me ONLY the single closest matching name to "${personName}" ` +
      `(could be a nickname, a misspelling, a first-name-only match, or a saved display name that's just different). ` +
      `Reply with just that name and nothing else. If genuinely nothing in the list is a plausible match, reply exactly: NONE.`
    )).trim().replace(/^["']|["']$/g, "");

    if (closest && !/^none$/i.test(closest)) {
      clicked = await vision.findAndClick(`the search result for a person or chat named "${closest}" in the Teams search dropdown`);
      if (clicked) matchedName = closest;
    }
  }

  if (!clicked) {
    throw new Error(`Couldn't find "${personName}" in the Teams search results, ${await friendlyReason()}`);
  }
  await sleep(1500); // let the chat pane load
  return matchedName;
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
// Returns the matched contact name (see openChatWith's closest-match
// fallback — may differ from personName if the exact text didn't hit).
async function messageOnTeams(personName, text) {
  const matchedName = await openChatWith(personName);
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
  return matchedName;
}

// ── PLACE A CALL ──────────────────────────────────────────────────
// callType: "audio" | "video"
// Returns the matched contact name (see openChatWith's closest-match
// fallback — may differ from personName if the exact text didn't hit).
async function callOnTeams(personName, callType = "audio") {
  const matchedName = await openChatWith(personName);
  const label = callType === "video" ? "video call button (camera icon)" : "audio call button (phone icon)";
  const clicked = await vision.findAndClick(`the ${label} in the top-right toolbar of this Teams chat window`);
  if (!clicked) throw new Error(`Couldn't find the ${callType} call button in this chat's toolbar.`);
  return matchedName;
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

// ── JOIN A MEETING VIA A DIRECT LINK (any platform) ────────────────
// Unlike joinMeeting() above (which needs Teams already open, with a
// matching meeting visible in the Calendar tab), this takes any
// meeting URL you were sent — a Teams "join a meeting" link, a Zoom
// link, a Google Meet link, whatever — opens it in the default
// browser, and vision-guides through that platform's join flow.
//
// v2: this used to be a single fixed pass (dismiss dialog -> click
// continue -> click name field -> click join), each step best-effort
// and skipped on a miss. The problem: real join flows don't always
// show those screens in that order, or at all, or on the first
// screenshot (something can still be animating in) — so a one-shot
// pass could sail past a screen that hadn't rendered yet and then
// have nothing left to try, leaving Jarvis stuck. This version
// re-screenshots after every click and keeps going — asking the
// vision model both "are we in yet?" and "what's the one most
// important thing to click right now?" — for up to maxSteps rounds,
// so it can work through dialogs however many there are and in
// whatever order they actually show up.
async function joinMeetingByLink(url, opts = {}) {
  const clean = String(url || "").trim();
  if (!/^https?:\/\//i.test(clean)) {
    throw new Error(`That doesn't look like a meeting link — expected it to start with http:// or https://.`);
  }

  await agent.openTarget(clean);
  await sleep(4000); // give the browser + meeting page time to load

  const maxSteps = opts.maxSteps || 10;
  const stepDelayMs = opts.stepDelayMs || 1200;
  let namedTyped = false;

  for (let step = 0; step < maxSteps; step++) {
    // First question every round: did the last click already get us
    // in? Checked before trying to click anything else so Jarvis
    // stops the moment it's actually done instead of clicking around
    // inside a meeting it already joined.
    const status = (await vision.lookAtScreen(
      `This is a browser mid-flow for joining an online meeting (Teams, Zoom, or Google Meet — could be any of them). ` +
      `Reply with exactly ONE of these words, nothing else: ` +
      `IN_MEETING if this already looks like the live meeting room (camera preview or other participants' video, a mic/camera toolbar, a "leave call" button); ` +
      `WAITING_ROOM if this is a lobby/waiting-room screen saying something like "waiting for host to let you in"; ` +
      `or NOT_YET if there's still a dialog, prompt, or pre-join screen standing between us and the meeting.`
    )).trim().toUpperCase();

    if (status.includes("IN_MEETING") || status.includes("WAITING_ROOM")) {
      return true; // joined, or successfully waiting to be let in — Jarvis's job here is done either way
    }

    // Not in yet — ask what the single most-blocking clickable thing
    // is right now, rather than guessing a fixed order. This covers
    // native "this site is trying to open X app" dialogs, "continue
    // on this browser" links, cookie/permission popups, name fields,
    // and the actual join button, whichever one is actually on
    // screen this round.
    const next = await vision.locateElement(
      `The single most important clickable UI element to move toward joining this online meeting, given everything currently visible. ` +
      `In priority order, if more than one thing is visible: (1) the "Cancel" or "Close" button on a native browser popup asking to open a desktop app — dismiss it, don't click "Open", Jarvis wants to stay in-browser; ` +
      `(2) a "Continue on this browser", "Use the web app instead", or "Join on the web" link/button; ` +
      `(3) a cookie-consent or permissions dialog's dismiss/allow button if it's covering the page; ` +
      `(4) a text field asking for a display name to join, IF it does not already have text typed into it; ` +
      `(5) the button to actually join or enter the meeting now (commonly "Join now", "Join meeting", or "Ask to join"). ` +
      `Pick whichever ONE of these is actually visible and highest in that priority order.`
    );

    if (!next || !next.found) {
      // Nothing obviously clickable this round — could just be a
      // beat where the page is still loading between screens. Wait
      // and look again rather than giving up on the first blank read.
      await sleep(stepDelayMs);
      continue;
    }

    await vision.clickAt(next.x, next.y);
    await sleep(400);

    // If what got clicked looks like it was a name field, type the
    // owner's name into it once (not every round, in case the click
    // above wasn't actually the name field this time).
    if (!namedTyped) {
      const looksLikeNameField = (await vision.lookAtScreen(
        `Does the screen right now show a text input field that's focused/has a text cursor in it, specifically one asking for a name to join a meeting? Reply with only YES or NO.`
      )).trim().toUpperCase();
      if (looksLikeNameField.startsWith("YES")) {
        let ownerName = "Jay";
        try { ownerName = require("./config.json")?.owner?.username || ownerName; } catch { /* fall back to default */ }
        await agent.typeText(ownerName);
        namedTyped = true;
        await sleep(300);
      }
    }

    await sleep(stepDelayMs);
  }

  throw new Error(`Tried for a while but couldn't get all the way into the meeting — the join flow on this page had something Jarvis couldn't work through (maybe a waiting room, a sign-in wall, or an unusual layout). It may need to be finished manually this time.`);
}

// ── SPEAK INTO A LIVE CALL VIA SCREEN SHARE (no VB-CABLE needed) ──
// The alternative to call-voice.js's virtual-cable routing: instead
// of redirecting audio devices, Jarvis opens a small dedicated
// browser window that plays the TTS clip, shares THAT WINDOW (with
// audio) into the active Teams call, waits for the clip to finish,
// then stops sharing. Nothing to install beyond Teams and a browser.
//
// This window's title has to match JARVIS_SPEAK_TITLE exactly — it's
// how the later vision.findAndClick call tells Teams' share picker
// which thumbnail is "the Jarvis one" out of everything else open on
// the screen. Keep it in sync with public/call-speak.html's <title>.
const JARVIS_SPEAK_TITLE = "Jarvis — Speaking";

// Opens the speak page in its own app-mode window (not just a tab in
// whatever browser window is already open) so it shows up in Teams'
// share picker as a single, unambiguous, easy-to-spot entry.
async function openSpeakTab(mediaUrl) {
  const origin = new URL(mediaUrl).origin;
  const pageUrl = `${origin}/call-speak.html?src=${encodeURIComponent(mediaUrl)}`;

  const command = isWindows()
    ? `start "" /B msedge --new-window --app="${pageUrl}"`
    : `open -na "Google Chrome" --args --new-window --app="${pageUrl}"`;

  try {
    await agent.runCommand(command);
  } catch {
    // Edge/Chrome app mode not available for some reason — fall back
    // to whatever the default browser does with a plain URL. Less
    // identifiable in the share picker, but still functional.
    await agent.openTarget(pageUrl);
  }
  await sleep(2000); // let the window actually open and the page load
  return pageUrl;
}

// Best-effort close of the dedicated speak window once Jarvis is done
// with it. Non-fatal if it misses — a leftover window is untidy, not
// broken.
async function closeSpeakTab() {
  if (!isWindows()) return;
  try {
    await agent.runCommand(
      `powershell -NoProfile -Command "Get-Process | Where-Object {$_.MainWindowTitle -eq '${JARVIS_SPEAK_TITLE}'} | Stop-Process -Force"`
    );
  } catch { /* leaving the window open is harmless, just untidy */ }
}

// mediaUrl: HTTP URL to the rendered TTS clip, servable to a local
// browser (server.js publishes this via cast.js's publishAudio()).
// durationMs: how long the clip actually runs, so Jarvis knows how
// long to keep sharing before stopping.
async function speakOnScreenShare(mediaUrl, durationMs) {
  if (!isWindows()) {
    throw new Error("Screen-share speaking is only wired up for Windows right now.");
  }

  await openSpeakTab(mediaUrl);

  // Click the on-page "Speak" button ourselves rather than relying on
  // autoplay — this IS the user gesture browsers' autoplay policies
  // want, and it means Jarvis controls exactly when the clip starts.
  const played = await vision.findAndClick(`the "Speak" play button in the center of this page`);
  if (!played) throw new Error(`Couldn't find the Speak button on the "${JARVIS_SPEAK_TITLE}" page.`);
  await sleep(300);

  const shareOpened = await vision.findAndClick(`the "Share content" or "Share screen" button in the Microsoft Teams in-call toolbar`);
  if (!shareOpened) throw new Error("Couldn't find Teams' Share content button — is a call actually active and connected?");
  await sleep(1000);

  // Some Teams versions default the picker to a "Screen" tab — make
  // sure we're looking at the per-window list instead. Best-effort:
  // if there's no such tab (already on the right view), that's fine.
  await vision.findAndClick(`the "Window" tab in the Teams share picker`).catch(() => {});
  await sleep(300);

  const windowPicked = await vision.findAndClick(`the thumbnail for the browser window titled "${JARVIS_SPEAK_TITLE}" in the Teams share picker`);
  if (!windowPicked) throw new Error(`Couldn't find the "${JARVIS_SPEAK_TITLE}" window in Teams' share picker.`);
  await sleep(300);

  // "Include audio" isn't always on by default — the whole point of
  // this method is that the audio actually reaches the call, so check
  // it explicitly rather than assuming. Best-effort: if it's already
  // checked, clicking again would toggle it off, but findAndClick
  // only fires on a genuine match, so an already-checked toggle
  // described this way should be a no-op miss rather than a false
  // click in practice.
  await vision.findAndClick(`the unchecked "Include audio" toggle in the Teams share picker`).catch(() => {});
  await sleep(200);

  const shared = await vision.findAndClick(`the "Share" button that confirms sharing the selected window`);
  if (!shared) throw new Error("Couldn't confirm the share — Teams' picker may not have opened as expected.");

  // Let the clip actually finish, plus a small buffer so the tail
  // isn't cut off by stopping the share a beat too early.
  await sleep(Math.max(1000, durationMs) + 800);

  await vision.findAndClick(`the "Stop presenting" or "Stop sharing" button in the Teams call toolbar`).catch(() => {});
  await closeSpeakTab();

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
  joinMeetingByLink,
  respondToIncomingCall,
  startIncomingCallWatch,
  stopIncomingCallWatch,
  speakOnScreenShare,
  openSpeakTab,
  closeSpeakTab,
  JARVIS_SPEAK_TITLE,
};
