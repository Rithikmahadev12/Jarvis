// J.A.R.V.I.S Extension — Popup Script
const JARVIS_URL_KEY = "jarvisUrl";
const DEFAULT_URL    = "http://localhost:3000";

const dot      = document.getElementById("status-dot");
const label    = document.getElementById("status-label");
const urlInput = document.getElementById("server-url");
const showBtn  = document.getElementById("btn-show");
const hideBtn  = document.getElementById("btn-hide");
const saveBtn  = document.getElementById("btn-save-url");

let serverUrl = DEFAULT_URL;

// Load saved URL
chrome.storage.local.get([JARVIS_URL_KEY], (data) => {
  serverUrl = data[JARVIS_URL_KEY] || DEFAULT_URL;
  urlInput.value = serverUrl;
  checkStatus();
});

// Save URL
saveBtn.addEventListener("click", () => {
  const url = urlInput.value.trim().replace(/\/$/, "");
  serverUrl = url;
  chrome.storage.local.set({ [JARVIS_URL_KEY]: url });
  checkStatus();
});

// Show/hide HUD via extension command queue
showBtn.addEventListener("click", async () => {
  await pushCommand("SHOW_HUD");
  window.close();
});

hideBtn.addEventListener("click", async () => {
  await pushCommand("HIDE_HUD");
  window.close();
});

async function pushCommand(action) {
  try {
    await fetch(`${serverUrl}/api/extension/command`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ action }),
    });
  } catch {}
}

async function checkStatus() {
  try {
    const res  = await fetch(`${serverUrl}/api/extension/status`, { cache: "no-store" });
    const data = await res.json();

    dot.className   = "status-dot online";
    label.textContent = "CONNECTED";

    document.getElementById("info-user").textContent   = data.user   ? `${data.user.toUpperCase()} / ${data.userTitle || ""}` : "NOT LOGGED IN";
    document.getElementById("info-phase").textContent  = (data.phase || "idle").toUpperCase();
    document.getElementById("info-mood").textContent   = (data.mood  || "neutral").toUpperCase();
    document.getElementById("info-server").textContent = serverUrl.replace("http://", "");
  } catch {
    dot.className     = "status-dot offline";
    label.textContent = "JARVIS OFFLINE";
    document.getElementById("info-user").textContent  = "—";
    document.getElementById("info-phase").textContent = "—";
    document.getElementById("info-mood").textContent  = "—";
  }
}
