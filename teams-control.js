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

// ── CONTACTS PAGE LOOKUP ───────────────────────────────────────────
// Rather than a separate names→emails file to keep in sync by hand,
// this reads Teams' own People > All Contacts list directly off the
// screen — it's already the current, authoritative list of who you
// actually have added, so there's nothing else to maintain.
//
// Flow: open Teams -> click the Contacts/People icon in the left
// rail -> make sure "All contacts" is the selected tab -> scan down
// the rows for a name match -> click the chat or call icon on THAT
// row. If a full pass through the list finds nobody, wait a moment
// and check again once (covers a contact added recently that hadn't
// rendered into the list yet), then give up and fall back to the old
// search-box flow.
async function openContactsPage() {
  await openTeams();
  const clicked = await vision.findAndClick(
    `the Contacts/People icon in the left sidebar of Teams — a small person/ID-card icon, ` +
    `part of a vertical stack of icons that also includes Chat, Video meetings, an app icon, Teams/community, and Calendar`,
    { forceVision: true }
  );
  if (!clicked) return false;
  await sleep(1500);

  // Teams lands on "Active now" by default when you open Contacts —
  // that list only shows people currently online/active, it's NOT the
  // full contacts list, and its rows don't lay out the same way. If
  // Jarvis proceeds to scan for a name here instead of on "All
  // contacts", it ends up clicking around inside "Active now" (wrong
  // list, sometimes no call icon on the row at all, sometimes a
  // different person entirely) instead of the actual call icon on the
  // right contact. So: click "All contacts", then VERIFY it actually
  // became the selected tab before doing anything else — don't just
  // assume the click landed.
  const switchedToAllContacts = await ensureAllContactsTabSelected();
  if (!switchedToAllContacts) {
    // Couldn't confirm "All contacts" is selected — don't let a
    // caller scan "Active now" thinking it's the full list. Bail out
    // to the search-box flow instead, which doesn't depend on this
    // tab at all.
    return false;
  }

  // Confirm we're actually looking at the People/Contacts list before
  // handing back to a caller that's about to spend up to ~2 full
  // scroll-passes (14+ screenshots) scanning for a name here. Without
  // this check, a click that missed the sidebar icon (wrong pixel,
  // scaling issue, a flyout that hadn't rendered yet) used to send
  // callers into that entire slow scan against whatever screen Teams
  // actually landed on, find nothing, and only THEN fall back to the
  // search box — several seconds wasted for a failure that was
  // already knowable right here.
  const onContactsPage = (await vision.lookAtScreen(
    `Does this look like Microsoft Teams' Contacts/People page — a list of contact names, with tabs like "All contacts" / "Active now" near the top? Reply with only YES or NO.`
  )).trim().toUpperCase();
  return onContactsPage.startsWith("YES");
}

// Clicks the "All contacts" tab and re-checks the screen afterward to
// confirm it actually became the selected tab — "Active now" is
// Teams' default landing tab, so a click that missed (wrong pixel, a
// flyout still animating in, etc.) used to silently leave the caller
// on "Active now" with no error to show for it. One retry before
// giving up, since a missed click on the first try is usually just
// timing (panel still rendering).
async function ensureAllContactsTabSelected() {
  for (let attempt = 0; attempt < 2; attempt++) {
    await vision.findAndClick(
      `the "All contacts" tab/button near the top of the Teams People panel — NOT the "Active now" tab, even though "Active now" may currently be the selected/highlighted one`,
      { forceVision: true }
    ).catch(() => {});
    await sleep(700);
    const state = (await vision.lookAtScreen(
      `In this Microsoft Teams People/Contacts panel, which tab is currently selected/highlighted — "All contacts" or "Active now"? Reply with only ALL_CONTACTS or ACTIVE_NOW or NEITHER.`
    )).trim().toUpperCase();
    if (state.includes("ALL_CONTACTS")) return true;
  }
  return false;
}

// Page Down to scroll further into the list, Home to jump back to
// the top for a fresh pass.
function scrollContactsList(direction) {
  const key = direction === "top" ? "{HOME}" : "{PGDN}";
  return agent.runCommand(isWindows()
    ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${key}')"`
    : `osascript -e 'tell application "System Events" to key code ${direction === "top" ? 115 : 121}'`
  ).catch(() => {});
}

// Scans the "All contacts" list for personName and clicks that row's
// chat/call/more-options icon. action: "chat" | "call" | "more".
// Scrolls down a few screens for long lists; does a second full pass
// after a short pause if nothing hits the first time (recently-added
// contact that hadn't synced into view yet). Returns true/false —
// never throws — so callers can decide whether to fall back.
async function findContactRowAndClick(personName, action) {
  const iconLabel = action === "chat" ? `the chat/message bubble icon`
    : action === "more" ? `the "..." (more options) icon`
    : `the phone/call icon`;
  const maxScrolls = 6;

  for (let pass = 0; pass < 2; pass++) {
    await scrollContactsList("top");
    await sleep(300);
    for (let i = 0; i <= maxScrolls; i++) {
      // Teams only renders a row's chat/call/more icons once the
      // mouse is actually hovering that row — a screenshot taken cold
      // simply doesn't have them in it. Find the row by its name text
      // first (cheap, works off plain OCR since the name is always
      // visible), hover there, give the hover state a beat to render,
      // THEN look for the icon. Without this, "find the phone icon"
      // was being asked of a screenshot where no phone icon actually
      // existed yet — which is how the model ended up guessing at the
      // nearest plausible thing, including the tab bar above the list.
      const rowLoc = await vision.locateElement(
        `the contact name ${JSON.stringify(personName)} (or the single closest visible match) as it appears in ` +
        `the row/list of actual contacts in this Teams People page — the name text itself, not any icon, and NOT ` +
        `the "All contacts" or "Active now" navigation items in the left sidebar.`,
        { forceVision: true }
      );
      if (!rowLoc || !rowLoc.found) {
        await scrollContactsList("down");
        await sleep(500);
        continue;
      }
      await vision.moveMouseTo(rowLoc.x, rowLoc.y);
      await sleep(400); // let the row's hover-reveal icons actually render

      const clicked = await vision.findAndClick(
        `In this Microsoft Teams "All contacts" list, the mouse is currently hovering the row for "${personName}" ` +
        `(or the closest match), which should now be showing its hover icons. Click ${iconLabel} that appears on ` +
        `THAT SPECIFIC hovered row — the icons sit to the right of the name, roughly level with it vertically. ` +
        `Don't click the name/avatar itself, and don't click an icon belonging to a different row. ` +
        `IMPORTANT: do NOT click the "All contacts" or "Active now" tab buttons near the top of this panel — those ` +
        `are page tabs, not contact rows, even if the hovered row sits close beneath them.`,
        { forceVision: true, skipCache: true }
      );
      // A reported click isn't proof it hit the right target — verify
      // the screen actually changed the way this action should change
      // it before counting it as a hit. Without this, a click that
      // landed on the row itself (opening a profile card) or on
      // "Active now" content used to get reported back as a working
      // call/chat/menu when nothing of the sort had actually happened.
      if (clicked && (await verifyRowActionTookEffect(action))) return true;

      // If that miss actually knocked the panel back onto "Active
      // now" (the tab bar sits right above the topmost row, so an
      // imprecise click near that first row can land on the tab above
      // it instead), the rest of this scan would silently keep
      // scrolling through the wrong list. Catch that here and fix the
      // tab before continuing, rather than burning the remaining
      // scroll passes on "Active now".
      const stillOnAllContacts = (await vision.lookAtScreen(
        `In this Microsoft Teams People panel, which tab is currently selected/highlighted — "All contacts" or "Active now"? Reply with only ALL_CONTACTS or ACTIVE_NOW or NEITHER.`
      )).trim().toUpperCase();
      if (stillOnAllContacts.includes("ACTIVE_NOW")) {
        if (!(await ensureAllContactsTabSelected())) return false; // can't recover — let the caller fall back
        await scrollContactsList("top");
        await sleep(300);
        continue; // re-scan this same screen now that we're back on the right tab
      }

      await scrollContactsList("down");
      await sleep(500);
    }
    // Nobody matched anywhere in the list this pass — give Teams a
    // moment in case the contact was just added and re-check once.
    if (pass === 0) await sleep(1500);
  }
  return false;
}

// After clicking a row's chat/call/more icon, confirm the screen
// actually reflects that action before trusting the click. If it
// doesn't, whatever got clicked wasn't the right target (a profile
// card, a no-op tap on "Active now", a miss) — worth another scan
// pass rather than reporting a false success.
async function verifyRowActionTookEffect(action) {
  await sleep(600);
  if (action === "chat") {
    const opened = (await vision.lookAtScreen(
      `Does this look like an open Microsoft Teams 1:1 chat conversation — a message compose box at the bottom, and either past messages or an empty conversation area? Reply with only YES or NO.`
    )).trim().toUpperCase();
    return opened.startsWith("YES");
  }
  if (action === "more") {
    const menuOpen = (await vision.lookAtScreen(
      `Does this look like a small context/dropdown menu is currently open in Microsoft Teams (options like "Video call", "Chat", "Remove from contacts", etc.)? Reply with only YES or NO.`
    )).trim().toUpperCase();
    return menuOpen.startsWith("YES");
  }
  // action === "call"
  const callStarting = (await vision.lookAtScreen(
    `Does this look like a Teams pre-call/lobby screen (camera preview, "Join now"/"Call" button) OR an active call already dialing/connected (a "Calling..." screen or an in-call toolbar with Mic/Camera/hang-up)? Reply with only YES or NO.`
  )).trim().toUpperCase();
  return callStarting.startsWith("YES");
}

// After clicking a call icon, Teams can land on one of two different
// screens depending on how the call was placed — this handles both:
//
//   1. A pre-call LOBBY screen (camera preview, device picker, a
//      "Join now"/"Call" button) — seen before the call is placed.
//   2. Already dialing — a "Calling..." screen with the in-call
//      toolbar visible at the top (Chat / View / More / Camera / Mic /
//      Share), no lobby step at all. This is what calling straight
//      from a Contacts row actually does — there's no "Join now" to
//      click here, so the old lobby-only check silently did nothing
//      and a muted mic would stay muted for the whole call.
//
// Note: the dropdown arrow next to the in-call Mic button opens a
// device picker (which mic/speaker to USE — see openMicPicker below);
// the plain Mic button itself is mute/unmute. This function only
// handles mute/unmute — switching to a specific device is what
// switchTeamsMicTo() further down is for.
async function handlePreCallScreen() {
  const onLobbyScreen = (await vision.lookAtScreen(
    `Does this look like a Teams pre-call/lobby screen — camera preview, audio device options, a "Join now" or "Call" button? Reply with only YES or NO.`
  )).trim().toUpperCase();

  if (onLobbyScreen.startsWith("YES")) {
    await vision.findAndClick(`the "Computer audio" option on this pre-call screen, if it isn't already selected`).catch(() => {});
    await sleep(200);
    const micLooksOff = (await vision.lookAtScreen(
      `On this Teams pre-call screen, does the microphone toggle look OFF/muted (crossed-out mic icon, or a toggle in the off position)? Reply with only YES or NO.`
    )).trim().toUpperCase();
    if (micLooksOff.startsWith("YES")) {
      await vision.findAndClick(`the muted microphone toggle on this pre-call screen, to turn it on`).catch(() => {});
      await sleep(200);
    }
    await vision.findAndClick(`the "Join now" or "Call" button to start the call`).catch(() => {});
    return true;
  }

  // Not a lobby — check whether we're actually dialing/live (a
  // "Calling..." screen or an already-connected call, in-call toolbar
  // showing at top) before assuming the call button click did
  // anything. Previously this branch just assumed "not lobby = must
  // be dialing" and returned success either way — so a click that
  // landed on the wrong pixel (missed the call button entirely, hit
  // nothing) still got reported back to the user as "Calling X now,
  // Sir," even though nothing was actually happening. That's the
  // "it said calling but never called them" symptom.
  const isDialingOrLive = (await vision.lookAtScreen(
    `Does this look like an active Teams call — a "Calling..." screen, or a live call with an in-call toolbar (Chat/Camera/Mic/Share buttons) visible at the top? Reply with only YES or NO.`
  )).trim().toUpperCase();
  if (!isDialingOrLive.startsWith("YES")) return false;

  const micMuted = (await vision.lookAtScreen(
    `Look at the "Mic" button in the Teams in-call toolbar at the top of the screen (next to the Camera button). Does it look muted/crossed-out? Reply with only YES or NO.`
  )).trim().toUpperCase();
  if (micMuted.startsWith("YES")) {
    await vision.findAndClick(`the "Mic" button itself (not its small dropdown arrow) in the Teams in-call toolbar, to unmute it`).catch(() => {});
  }
  return true;
}

// ── OPEN ────────────────────────────────────────────────────────
// Launches Teams via its own URI protocol where possible (fast,
// reliable, and it's what Windows itself uses for Teams links), and
// falls back to the plain app-alias launch on other platforms.
// Forces the Teams window into a genuine maximized state via Win32
// ShowWindow — launching via the ms-teams: protocol brings the
// window to the foreground but does NOT control its size/state, so
// Teams stays wherever it was last left: minimized, a small floating
// window, snapped to half the screen, whatever. Vision models are
// trained on overwhelmingly full-screen Teams screenshots, so when
// the real window is smaller or positioned differently, they tend to
// answer with where the sidebar icon "normally" sits in a maximized
// layout instead of carefully grounding in the actual (differently
// shaped) screenshot — which looks exactly like "it clicked where
// the icon would be if this were full-screened." Forcing a real
// maximize here removes that whole failure mode instead of trying to
// out-prompt it.
function ensureTeamsMaximized() {
  if (!isWindows()) return Promise.resolve();
  const ps = `
$p = Get-Process | Where-Object { $_.MainWindowTitle -like '*Teams*' -and $_.MainWindowHandle -ne 0 } | Select-Object -First 1;
if ($p) {
  Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class Win32Show { [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd); }';
  [Win32Show]::ShowWindow($p.MainWindowHandle, 9) | Out-Null;
  Start-Sleep -Milliseconds 150;
  [Win32Show]::ShowWindow($p.MainWindowHandle, 3) | Out-Null;
  [Win32Show]::SetForegroundWindow($p.MainWindowHandle) | Out-Null;
}
`.replace(/\r?\n/g, " ");
  return new Promise((resolve) => {
    exec(`powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`, { windowsHide: true, timeout: 10000 }, () => resolve());
  });
}

async function openTeams() {
  await agent.openTarget(isWindows() ? "ms-teams:" : "teams");
  await sleep(2500); // give the window time to come to the foreground
  await ensureTeamsMaximized();
  await sleep(400); // let the maximize animation actually finish before any screenshot
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
async function openChatViaSearchBox(personName) {
  await openTeams();
  await agent.runCommand(isWindows()
    ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^e')"`
    : `osascript -e 'tell application "System Events" to keystroke "e" using command down'`);
  await sleep(500);
  await agent.typeText(personName);
  await sleep(1600); // let search results render (bumped from 1200ms — a too-early screenshot on slower machines was part of what caused the stall)

  // Prefer a "People" section entry over "Group Chats"/"Meeting with X"
  // entries — the dropdown often lists the same name multiple times
  // (a 1:1 person AND one or more meeting/group chats that happen to
  // mention them), and a bare "named exactly X" description leaves the
  // vision model to guess between them, which is how this used to stall
  // with the dropdown just sitting there. Being explicit about section
  // priority removes that ambiguity.
  // forceVision: the same name legitimately appears multiple times in
  // this dropdown (the typed query itself, a "People" entry, one or
  // more "Meeting with X" / Group Chats entries) — telling them apart
  // requires reading WHICH SECTION each occurrence sits under, which
  // is exactly what the OCR fast-path can't do (it just grabs the
  // first literal text match top-to-bottom, which is often the
  // search box itself). This needs the vision model every time.
  let clicked = await vision.findAndClick(
    `In this Microsoft Teams search dropdown, find the result for "${personName}". ` +
    `If there is an entry under a "People" section heading whose name matches "${personName}", click THAT one — ` +
    `prefer it over any "Group Chats" or "Meeting with ${personName}" entries even if those also contain the name. ` +
    `Only click a Group Chats/meeting entry if no plain "People" entry for this name exists. ` +
    `Do not click the search box or the "Press enter to view all results" row at the top — only an actual result entry lower in the list.`,
    { forceVision: true }
  );
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
      `Look at the actual names visible in the dropdown right now, under the "People" section specifically if one exists, and tell me ONLY ` +
      `the single closest matching name to "${personName}" (could be a nickname, a misspelling, a first-name-only match, or a saved display ` +
      `name that's just different). Ignore "Group Chats"/"Meeting with X" entries unless there is no People entry at all. ` +
      `Reply with just that name and nothing else. If genuinely nothing in the list is a plausible match, reply exactly: NONE.`
    )).trim().replace(/^["']|["']$/g, "");

    if (closest && !/^none$/i.test(closest)) {
      clicked = await vision.findAndClick(
        `the "People" section search result whose name is "${closest}" in the Teams search dropdown — ` +
        `not a "Group Chats" or "Meeting with" entry, the plain person entry`,
        { forceVision: true }
      );
      if (clicked) matchedName = closest;
    }
  }

  if (!clicked) {
    throw new Error(`Couldn't find "${personName}" in the Teams search results, ${await friendlyReason()}`);
  }
  await sleep(1500); // let the chat pane load
  return matchedName;
}

// Public entry point: try the Contacts page first (reliable — a real
// list of actual contacts, no dropdown ambiguity), and only fall back
// to the search-box flow if they genuinely aren't in Contacts yet.
async function openChatWith(personName) {
  if (await openContactsPage() && (await findContactRowAndClick(personName, "chat"))) {
    await sleep(1500); // let the chat pane load
    return personName;
  }
  return openChatViaSearchBox(personName);
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
  const onContacts = await openContactsPage();

  if (onContacts && callType === "video") {
    // The contacts row only shows a plain phone icon directly — video
    // call lives one level in, behind "..." (more options).
    if (await findContactRowAndClick(personName, "more")) {
      await sleep(500);
      const videoClicked = await vision.findAndClick(
        `the "Video call" option in the menu that just opened`,
        { forceVision: true }
      );
      if (videoClicked) {
        await sleep(1500);
        if (await handlePreCallScreen()) {
          await ensureRealMicSelected().catch(() => {});
          return personName;
        }
        throw new Error(`Clicked to call ${personName} on Teams, but the call never actually started — no lobby or dialing screen appeared. It's possible the click landed in the wrong place.`);
      }
    }
  } else if (onContacts && await findContactRowAndClick(personName, "call")) {
    await sleep(1500);
    if (await handlePreCallScreen()) {
      await ensureRealMicSelected().catch(() => {});
      return personName;
    }
    throw new Error(`Clicked to call ${personName} on Teams, but the call never actually started — no lobby or dialing screen appeared. It's possible the click landed in the wrong place.`);
  }

  // Not found in Contacts (or the video submenu didn't work out) —
  // fall back to opening the chat and using the toolbar call button.
  const matchedName = await openChatViaSearchBox(personName);
  const label = callType === "video" ? "video call button (camera icon)" : "audio call button (phone icon)";
  const clicked = await vision.findAndClick(`the ${label} in the top-right toolbar of this Teams chat window`);
  if (!clicked) throw new Error(`Couldn't find the ${callType} call button in this chat's toolbar.`);
  if (!(await handlePreCallScreen())) {
    throw new Error(`Clicked the ${callType} call button for ${matchedName}, but the call never actually started — no lobby or dialing screen appeared. It's possible the click landed in the wrong place.`);
  }
  await ensureRealMicSelected().catch(() => {});
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
  let lastClickKey = null;
  let repeatCount = 0;

  for (let step = 0; step < maxSteps; step++) {
    // First question every round: did the last click already get us
    // in? Checked before trying to click anything else so Jarvis
    // stops the moment it's actually done instead of clicking around
    // inside a meeting it already joined.
    const status = (await vision.lookAtScreen(
      `This is a browser mid-flow for joining an online meeting (Teams, Zoom, or Google Meet — could be any of them). ` +
      `Reply with exactly ONE of these words, nothing else: ` +
      `IN_MEETING if this already looks like the live meeting room (camera preview or other participants' video, a mic/camera toolbar, a "leave call" button); ` +
      `WAITING_ROOM if this is a lobby/waiting-room screen saying something like "waiting for host to let you in" or "someone will let you in shortly", AFTER a name/join step has already been completed; ` +
      `or NOT_YET for anything else — including a native "this site is trying to open [app]" popup, an "Open"/"Cancel" dialog, a "Continue on this browser" / "Join on the Teams app" choice screen, a "Join your Teams meeting" pre-join page, a cookie/permissions prompt, or a name-entry field. ` +
      `If you see ANY popup, dialog, or button still asking to be clicked or dismissed, that is NOT_YET — do not answer IN_MEETING or WAITING_ROOM just because the page title or heading mentions "meeting" or "Teams".`
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
    // forceVision: this prompt names "Open" specifically as something
    // NOT to click (right next to "Cancel", which the user DOES want
    // clicked). The OCR fast-path treats every quoted phrase as an
    // equally valid click target with no concept of negation or
    // priority order — it's how Jarvis was ending up clicking "Open"
    // on the native "trying to open Microsoft Teams" dialog instead
    // of "Cancel", re-triggering that same dialog in a loop. Only the
    // vision model actually reads "don't click Open".
    const next = await vision.locateElement(
      `The single most important clickable UI element to move toward joining this online meeting, given everything currently visible. ` +
      `In priority order, if more than one thing is visible: (1) the "Cancel" or "Close" button on a native browser popup asking to open a desktop app — dismiss it, don't click "Open", Jarvis wants to stay in-browser; ` +
      `(2) a "Continue on this browser", "Use the web app instead", or "Join on the web" link/button; ` +
      `(3) a cookie-consent or permissions dialog's dismiss/allow button if it's covering the page; ` +
      `(4) a text field asking for a display name to join, IF it does not already have text typed into it; ` +
      `(5) the button to actually join or enter the meeting now (commonly "Join now", "Join meeting", or "Ask to join"). ` +
      `Pick whichever ONE of these is actually visible and highest in that priority order.`,
      { forceVision: true }
    );

    if (!next || !next.found) {
      // Nothing obviously clickable this round — could just be a
      // beat where the page is still loading between screens. Wait
      // and look again rather than giving up on the first blank read.
      await sleep(stepDelayMs);
      continue;
    }

    // Stuck-loop guard: if Jarvis keeps getting told to click the
    // same spot (within a small tolerance) round after round, the
    // click isn't actually progressing the page — clicking it again
    // won't help. Bail with a clear error instead of burning through
    // maxSteps clicking the same dead button.
    const clickKey = `${Math.round(next.x / 15)},${Math.round(next.y / 15)}`;
    if (clickKey === lastClickKey) {
      repeatCount++;
      if (repeatCount >= 2) {
        throw new Error(`Got stuck repeatedly clicking the same spot trying to join this meeting — that click isn't moving the page forward, so it needs to be finished manually this time.`);
      }
    } else {
      repeatCount = 0;
      lastClickKey = clickKey;
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

// ── VERIFY A CALL IS ACTUALLY CONNECTED ───────────────────────────
// callOnTeams() only clicks the call button — it can't tell whether
// the other person actually picked up. Speaking (or switching mics)
// into a call that's still ringing is pointless at best, and rude
// silence at worst. This polls the screen until it looks like a
// connected call (mute/camera/hang-up controls plus either their
// video or a running call timer) rather than a "Calling…"/ringing
// screen, up to timeoutMs. Returns false — not a throw — on timeout,
// so callers can decide what "never picked up" should mean for them.
async function waitForCallConnected(timeoutMs = 25000, pollMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = (await vision.lookAtScreen(
      `Look at this Microsoft Teams call screen. Has the other person actually picked up? Reply with exactly one word: ` +
      `CONNECTED if you can see live in-call controls (mute/camera/hang-up) together with either their video feed or a running call duration timer — meaning the call is actually live; ` +
      `or RINGING if it still shows "Calling…", "Ringing…", a dialing animation, or otherwise no sign anyone has answered yet.`
    )).trim().toUpperCase();
    if (status.includes("CONNECTED")) return true;
    await sleep(pollMs);
  }
  return false;
}

// ── IN-APP MICROPHONE DEVICE SWITCHING ────────────────────────────
// For the "cable" call-voice method: rather than relying on Windows'
// default-communications-device setting (which only works if Teams
// is set to "Same as System" and can silently stop working if that
// setting drifts), this drives Teams' OWN device picker directly —
// the panel opened by the little chevron next to the Mic button in
// the in-call toolbar (not Teams' separate Settings > Devices page).
// More clicks, but it's exactly what you'd do by hand, so it's not
// depending on anything outside Teams itself.
async function openMicPicker() {
  const opened = await vision.findAndClick(
    `the small dropdown chevron/arrow immediately next to the "Mic" button in the Teams in-call toolbar — NOT the Mic button itself (that toggles mute), and NOT the similar chevron next to the Camera button. It's the one that opens a Speaker/Microphone device list.`
  );
  if (!opened) throw new Error("Couldn't find the mic device dropdown in the Teams call toolbar — is a call actually active and connected?");
  await sleep(500);
  return true;
}

// Reads whichever microphone option is currently selected (its radio
// button filled in) so it can be restored later — read straight off
// the screen rather than assumed, so it's correct even if you'd
// changed it by hand since Jarvis last touched it.
async function readCurrentMicName() {
  const name = (await vision.lookAtScreen(
    `This is Teams' Speaker/Microphone device picker panel. Under the "Microphone" section specifically, which one option has its radio button filled in/selected right now? Reply with ONLY that option's exact visible label text and nothing else.`
  )).trim().replace(/^["']|["']$/g, "");
  return name;
}

async function selectMicByLabel(micLabel) {
  return vision.findAndClick(
    `the radio button next to the microphone option in Teams' Microphone device list whose label matches or contains "${micLabel}"`
  );
}

// Best-effort dismiss of the device picker panel once a selection's
// been made — clicks empty space near the toolbar rather than
// assuming Escape behaves consistently across Teams builds.
async function closeDevicePicker() {
  await vision.findAndClick(
    `an empty, non-interactive area near the Teams call toolbar, used just to close/dismiss the currently-open device picker panel — anywhere that isn't one of the panel's own options`
  ).catch(() => {});
  await sleep(300);
}

// Switches Teams' in-call microphone to micLabel (fuzzy-matched —
// doesn't need to be the exact full label). Returns the name of
// whichever mic was selected BEFORE the switch, so the caller can
// pass that straight to switchTeamsMicBack() afterward.
async function switchTeamsMicTo(micLabel) {
  await openMicPicker();
  const previous = await readCurrentMicName();
  const switched = await selectMicByLabel(micLabel);
  await closeDevicePicker();
  if (!switched) {
    throw new Error(`Couldn't find a microphone matching "${micLabel}" in Teams' device list — is it actually connected and showing up as a device?`);
  }
  return previous;
}

// Switches back to whatever mic was active before — same mechanics,
// opposite direction. Non-throwing on failure to find the old option
// (best-effort restore beats leaving the caller mid-error), but
// returns false so callers can log/notify if it didn't take.
async function switchTeamsMicBack(previousMicLabel) {
  if (!previousMicLabel) return false;
  await openMicPicker();
  const switched = await selectMicByLabel(previousMicLabel).catch(() => false);
  await closeDevicePicker();
  return !!switched;
}

// ── MAKE SURE A REAL MICROPHONE IS ACTUALLY SELECTED ───────────────
// call-voice.js's cable method switches Teams' in-call mic to the
// virtual "CABLE Output" device while Jarvis is speaking, then
// switches it back once done (see switchTeamsMicBack above) — but if
// that ever gets interrupted partway (a crash, a call that dropped
// mid-speech, the app being killed), Teams can be left with the
// virtual cable still selected as the mic for the NEXT call, which
// means the person on that next call can't hear anything from the
// real microphone at all.
//
// This is the safety net: right after a normal call connects, open
// the same device-picker chevron next to the in-call Mic button (NOT
// the Mic button itself, which only mutes) and check what's actually
// selected. If it's a virtual-cable device, switch to a real one —
// preferring TEAMS_DEFAULT_MIC_LABEL from .env if set, otherwise the
// first non-cable option Teams shows. If a real mic is already
// selected, this is a no-op past the one read.
async function ensureRealMicSelected() {
  await openMicPicker();
  const current = await readCurrentMicName();
  const looksVirtual = !current || /cable|virtual/i.test(current);

  if (!looksVirtual) {
    await closeDevicePicker();
    return current; // already on a real device, nothing to do
  }

  const preferred = (process.env.TEAMS_DEFAULT_MIC_LABEL || "").trim();
  let switched = preferred ? await selectMicByLabel(preferred) : false;

  if (!switched) {
    switched = await vision.findAndClick(
      `the radio button for a microphone option in Teams' Microphone device list that is a REAL physical microphone — ` +
      `NOT anything with "CABLE" or "Virtual" in its name. Prefer an option containing "Headset" or "Microphone Array" ` +
      `if one is visible; otherwise pick the first option in the list that isn't a CABLE/virtual device.`,
      { forceVision: true }
    );
  }
  await closeDevicePicker();
  return switched ? (preferred || "a physical microphone") : current;
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
  waitForCallConnected,
  openMicPicker,
  readCurrentMicName,
  selectMicByLabel,
  switchTeamsMicTo,
  switchTeamsMicBack,
  ensureRealMicSelected,
};
