// J.A.R.V.I.S Extension — Background Service Worker
// Wakes up on alarm, polls JARVIS server, relays commands to active tab

const JARVIS_URL = "http://localhost:3000";

chrome.runtime.onInstalled.addListener(() => {
  console.log("[JARVIS] Extension installed.");
});

// Allow content scripts to request server URL
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_SERVER_URL") {
    chrome.storage.local.get(["jarvisUrl"], (data) => {
      sendResponse({ url: data.jarvisUrl || JARVIS_URL });
    });
    return true;
  }

  if (msg.type === "SET_SERVER_URL") {
    chrome.storage.local.set({ jarvisUrl: msg.url });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === "GET_STATUS") {
    fetch(`${JARVIS_URL}/api/extension/status`)
      .then(r => r.json())
      .then(data => sendResponse({ connected: true, ...data }))
      .catch(() => sendResponse({ connected: false }));
    return true;
  }

  // JARVIS's own schedule/inspo engine asks us to pop tabs open —
  // this runs in the background service worker, so it isn't subject
  // to the page-level popup blocker a content script would hit.
  if (msg.type === "OPEN_URLS") {
    const urls = Array.isArray(msg.urls) ? msg.urls : [];
    urls.forEach((url, i) => {
      chrome.tabs.create({ url, active: i === 0 });
    });
    sendResponse({ ok: true, opened: urls.length });
    return true;
  }
});
