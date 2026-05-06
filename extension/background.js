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
});
