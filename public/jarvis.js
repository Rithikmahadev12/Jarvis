// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Client Brain v6.0
// Bluetooth headset support (hold-volume wake)
// Ollama serve / start from voice/text
// Pure LLM intent — no preset command matching
// ═══════════════════════════════════════════════════════════════

const state = {
  phase: "idle",
  user: null,
  userTitle: null,
  sessionId: crypto.randomUUID(),
  isListening: false,
  isSpeaking: false,
  micActive: false,
  mediaRecorder: null,
  clipChunks: [],
  clipTimestamps: [],
  screenStream: null,
  cameraStream: null,
  cameraRecorder: null,
  cameraClipChunks: [],
  cameraClipTimestamps: [],
  voiceSamples: [],
  faceDescriptors: null,
  intruderActive: false,
  intruderChunks: [],
  intruderRecorder: null,
  intruderClips: [],
  intruderAuthorized: false,
  faceCheckInterval: null,
  lastSeenUser: Date.now(),
  awayMode: false,
  mood: "neutral",
  moodScore: 0,
  interactionCount: 0,
  lastInteraction: Date.now(),
  selectedCameraId: null,
  availableCameras: [],
  tesseractWorker: null,
  tesseractReady: false,
  activeTimers: [],
  currentAudio: null,
  audioCtx: null,
  ttsVoice: "Brian",
  selectedSinkId: null,
  audioDevices: [],
  useStreamElements: true,
  ollamaAvailable: false,
  interruptPending: false,
  // Bluetooth
  bluetoothDevice: null,
  bluetoothConnected: false,
  bluetoothMicId: null,   // deviceId of the bluetooth mic once connected
  mediaKeys: false,       // whether MediaSession API is active
};

// ═══════════════════════════════════════════════════════════════
// ── AUDIO DEVICE MANAGER ──
// ═══════════════════════════════════════════════════════════════
async function enumerateAudioOutputs() {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.audioDevices = devices.filter(d => d.kind === "audiooutput");
    buildAudioDeviceSelector();
  } catch (e) { console.warn("[JARVIS] Audio output enum failed:", e); }
}

function buildAudioDeviceSelector() {
  const existing = $("audio-device-wrap"); if (existing) existing.remove();
  if (state.audioDevices.length <= 1) return;
  const hud = $("hud-bottom"); if (!hud) return;
  const wrap = document.createElement("div");
  wrap.id = "audio-device-wrap";
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-left:auto;";
  const label = document.createElement("span");
  label.style.cssText = "font-family:var(--mono);font-size:0.52rem;letter-spacing:0.15em;color:var(--text-dim);";
  label.textContent = "🔊 OUT:";
  const sel = document.createElement("select");
  sel.id = "audio-device-select";
  sel.style.cssText = "background:rgba(0,200,255,0.06);border:1px solid var(--blue-dim);color:var(--blue);font-family:var(--mono);font-size:0.58rem;letter-spacing:0.08em;padding:3px 6px;border-radius:3px;outline:none;cursor:pointer;max-width:160px;";
  state.audioDevices.forEach((dev, i) => {
    const opt = document.createElement("option");
    opt.value = dev.deviceId;
    opt.textContent = dev.label || `Speaker ${i + 1}`;
    if (dev.deviceId === state.selectedSinkId) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => { state.selectedSinkId = sel.value; addMsg("system", "Audio output switched."); });
  wrap.appendChild(label); wrap.appendChild(sel);
  const hints = hud.querySelector(".hints");
  if (hints) hud.insertBefore(wrap, hints); else hud.appendChild(wrap);
}

async function attachSink(audioElement) {
  if (!state.selectedSinkId) return;
  try { if (typeof audioElement.setSinkId === "function") await audioElement.setSinkId(state.selectedSinkId); }
  catch (e) { console.warn("[JARVIS] setSinkId failed:", e); }
}

// ═══════════════════════════════════════════════════════════════
// ── BLUETOOTH HEADSET SUPPORT ──
// Connects to Bluetooth audio device via Web Bluetooth API.
// Volume button on headset triggers wake via MediaSession API.
// Falls back to showing available bluetooth mics from device list.
// ═══════════════════════════════════════════════════════════════

async function connectBluetooth() {
  // Method 1: Web Bluetooth API (Chrome/Edge only, needs user gesture)
  if (navigator.bluetooth) {
    try {
      addMsg("system", "Scanning for Bluetooth devices…");
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        // Request battery and generic access profiles common in headsets
        optionalServices: ["battery_service", "generic_access", "device_information"],
      });
      state.bluetoothDevice = device;
      state.bluetoothConnected = true;
      addMsg("system", `Bluetooth device found: ${device.name || "Unknown"}. Connecting…`);

      device.addEventListener("gattserverdisconnected", () => {
        state.bluetoothConnected = false;
        updateBluetoothStatus(false);
        addMsg("system", "Bluetooth headset disconnected.");
      });

      // Try to connect to GATT server
      try {
        const server = await device.gatt.connect();
        addMsg("system", `Connected to ${device.name}. Now select it as your mic input below.`);
      } catch (e) {
        // GATT may not be available on all headsets — that's fine
        addMsg("system", `Found ${device.name}. Select it as your mic input below.`);
      }

      updateBluetoothStatus(true, device.name);

      // Now enumerate audio inputs to find the bluetooth mic
      await refreshAudioInputs();

      return true;
    } catch (e) {
      if (e.name === "NotFoundError") {
        addMsg("system", "No Bluetooth device selected. You can also choose a Bluetooth mic from the input list below.");
      } else {
        addMsg("system", `Bluetooth: ${e.message}. Try selecting your headset from the mic input list.`);
      }
      // Fall through to show mic selector
      await refreshAudioInputs();
      return false;
    }
  } else {
    // Web Bluetooth not available — show mic selector only
    addMsg("system", "Web Bluetooth API not available in this browser. Use the mic selector to choose your headset.");
    await refreshAudioInputs();
    return false;
  }
}

async function refreshAudioInputs() {
  try {
    // Need permission first
    await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {});
    const devices = await navigator.mediaDevices.enumerateDevices();
    const inputs = devices.filter(d => d.kind === "audioinput");
    buildMicSelector(inputs);
  } catch (e) { console.warn("[Bluetooth] enumerate inputs failed:", e); }
}

function buildMicSelector(inputs) {
  const existing = $("mic-selector-wrap"); if (existing) existing.remove();
  if (!inputs || inputs.length <= 1) return;

  const hud = $("hud-bottom"); if (!hud) return;
  const wrap = document.createElement("div");
  wrap.id = "mic-selector-wrap";
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0;";

  const label = document.createElement("span");
  label.style.cssText = "font-family:var(--mono);font-size:0.52rem;letter-spacing:0.15em;color:var(--text-dim);";
  label.textContent = "🎙 MIC:";

  const sel = document.createElement("select");
  sel.id = "mic-input-select";
  sel.style.cssText = "background:rgba(0,200,255,0.06);border:1px solid var(--blue-dim);color:var(--blue);font-family:var(--mono);font-size:0.58rem;letter-spacing:0.08em;padding:3px 6px;border-radius:3px;outline:none;cursor:pointer;max-width:160px;";

  inputs.forEach((dev, i) => {
    const opt = document.createElement("option");
    opt.value = dev.deviceId;
    const label = dev.label || `Microphone ${i + 1}`;
    opt.textContent = label;
    // Auto-select bluetooth/headset
    if (/bluetooth|headset|headphone|wireless|airpod|jabra|bose|sony|sennheiser/i.test(label)) {
      opt.selected = true;
      state.bluetoothMicId = dev.deviceId;
    }
    sel.appendChild(opt);
  });

  sel.addEventListener("change", () => {
    state.bluetoothMicId = sel.value || null;
    const selectedLabel = sel.options[sel.selectedIndex]?.textContent || "selected device";
    addMsg("system", `Mic switched to: ${selectedLabel}. Restarting listener…`);
    mic.suspend();
    setTimeout(() => mic.resume(), 300);
  });

  wrap.appendChild(label); wrap.appendChild(sel);
  const micDbg = hud.querySelector(".mic-debug");
  if (micDbg) hud.insertBefore(wrap, micDbg); else hud.appendChild(wrap);
}

function updateBluetoothStatus(connected, deviceName) {
  let badge = $("bt-status-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "bt-status-badge";
    badge.style.cssText = "position:fixed;top:20px;left:50%;transform:translateX(-50%);z-index:90;font-family:var(--mono);font-size:0.62rem;letter-spacing:0.16em;padding:6px 16px;border-radius:3px;transition:all 0.3s;pointer-events:none;";
    document.body.appendChild(badge);
  }
  if (connected) {
    badge.textContent = `◉ BT: ${deviceName || "Headset"}`;
    badge.style.cssText += "background:rgba(0,255,136,0.1);border:1px solid var(--green);color:var(--green);";
    setTimeout(() => { if (badge) badge.style.opacity = "0"; }, 4000);
    setTimeout(() => { if (badge) badge.remove(); }, 4500);
  } else {
    badge.textContent = "◎ BT: Disconnected";
    badge.style.cssText += "background:rgba(255,51,51,0.1);border:1px solid var(--red);color:var(--red);";
    setTimeout(() => { if (badge) badge.remove(); }, 3000);
  }
}

// ── MEDIA SESSION API — volume button wake ──
// When user presses volume on bluetooth headset, we use MediaSession
// to intercept the media key and treat it as a JARVIS wake
function setupMediaSessionWake() {
  if (!("mediaSession" in navigator)) return;
  try {
    // Set a dummy audio to allow MediaSession to work
    navigator.mediaSession.metadata = new MediaMetadata({
      title: "J.A.R.V.I.S",
      artist: "Listening…",
      album: "Active Session",
    });

    // Intercept play/pause (volume button long-press on many BT headsets)
    navigator.mediaSession.setActionHandler("play", () => {
      if (state.phase === "chatting") {
        // Treat as JARVIS wake
        triggerBluetoothWake();
      }
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (state.isSpeaking) stopSpeaking();
      else if (state.phase === "chatting") triggerBluetoothWake();
    });

    // Some headsets send "previoustrack" on double-click volume
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      if (state.phase === "chatting") triggerBluetoothWake();
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      if (state.isSpeaking) stopSpeaking(); // next = interrupt
    });

    state.mediaKeys = true;
    console.log("[JARVIS] MediaSession wake active — BT buttons will trigger wake");
  } catch (e) {
    console.warn("[JARVIS] MediaSession not available:", e);
  }
}

function triggerBluetoothWake() {
  if (state.isSpeaking) { stopSpeaking(); return; }
  // Flash the orb to show we heard the button
  setOrb("listening");
  addMsg("system", "Bluetooth wake detected.");
  const acks = [`Yes, ${state.userTitle}?`, `At your service.`, `What do you need, ${state.userTitle}?`];
  const ack = acks[Math.floor(Math.random() * acks.length)];
  // Give a brief audible confirmation then listen
  speak(ack, () => {
    setOrb("idle");
    mic.resume();
  });
}

// ── KEYBOARD MEDIA KEY listener (headsets that send keyboard events) ──
document.addEventListener("keydown", (e) => {
  if (state.phase !== "chatting") return;
  // MediaTrackPrevious / MediaPlayPause / F keys on some headsets
  if (e.code === "MediaPlayPause" || e.code === "MediaTrackPrevious") {
    e.preventDefault();
    triggerBluetoothWake();
  }
  if (e.code === "MediaTrackNext") {
    e.preventDefault();
    if (state.isSpeaking) stopSpeaking();
  }
});

// ── BUILD BLUETOOTH PANEL in main screen ──
function buildBluetoothPanel() {
  const existing = $("bt-panel"); if (existing) return;
  const hud = $("hud-bottom"); if (!hud) return;

  const wrap = document.createElement("div");
  wrap.id = "bt-panel";
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0;";

  const label = document.createElement("span");
  label.style.cssText = "font-family:var(--mono);font-size:0.52rem;letter-spacing:0.15em;color:var(--text-dim);";
  label.textContent = "BT:";

  const btn = document.createElement("button");
  btn.id = "bt-connect-btn";
  btn.style.cssText = "background:transparent;border:1px solid var(--blue-dim);color:var(--blue);font-family:var(--mono);font-size:0.58rem;letter-spacing:0.1em;padding:3px 8px;border-radius:3px;cursor:pointer;transition:all 0.2s;";
  btn.textContent = state.bluetoothConnected ? "◉ CONNECTED" : "◎ CONNECT";
  btn.title = "Connect Bluetooth headset — then hold volume to wake JARVIS";

  btn.addEventListener("click", async () => {
    btn.textContent = "SCANNING…";
    btn.style.color = "var(--amber)";
    btn.style.borderColor = "var(--amber)";
    await connectBluetooth();
    btn.textContent = state.bluetoothConnected ? "◉ CONNECTED" : "◎ CONNECT";
    btn.style.color = state.bluetoothConnected ? "var(--green)" : "var(--blue)";
    btn.style.borderColor = state.bluetoothConnected ? "var(--green)" : "var(--blue-dim)";
  });

  wrap.appendChild(label); wrap.appendChild(btn);
  const hints = hud.querySelector(".hints");
  if (hints) hud.insertBefore(wrap, hints); else hud.appendChild(wrap);
}

// ═══════════════════════════════════════════════════════════════
// ── TTS ENGINE ──
// ═══════════════════════════════════════════════════════════════
async function speak(text, onEnd) {
  if (!text || !text.trim()) { if (onEnd) onEnd(); return; }
  state.isSpeaking = true;
  setOrb("speaking");
  stopSpeaking();
  if (state.useStreamElements) await speakStreamElements(text, onEnd);
  else speakWebSpeech(text, onEnd);
}

async function speakStreamElements(text, onEnd) {
  const clean = text.replace(/[*_`#]/g, "").trim();
  try {
    const url = `/api/tts?voice=${encodeURIComponent(state.ttsVoice)}&text=${encodeURIComponent(clean)}`;
    const audio = new Audio();
    state.currentAudio = audio;
    await attachSink(audio);
    audio.src = url;
    const safetyMs = Math.max(4000, clean.length * 80);
    let finished = false;
    const safetyTimer = setTimeout(() => { if (!finished) { finished = true; _onSpeakEnd(onEnd); } }, safetyMs);
    const done = () => { if (finished) return; finished = true; clearTimeout(safetyTimer); _onSpeakEnd(onEnd); };
    audio.onended = done;
    audio.onerror = () => { clearTimeout(safetyTimer); speakWebSpeech(text, onEnd); };
    await audio.play().catch(() => speakWebSpeech(text, onEnd));
  } catch (err) { speakWebSpeech(text, onEnd); }
}

const MALE_VOICE_NAMES = ["Google UK English Male","Microsoft George - English (United Kingdom)","Daniel","Arthur","James","Thomas"];
function pickVoice() {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  for (const name of MALE_VOICE_NAMES) { const v = voices.find(v => v.name === name || v.name.includes(name)); if (v) return v; }
  return voices.find(v => v.lang === "en-GB") || voices.find(v => v.lang.startsWith("en")) || null;
}

function speakWebSpeech(text, onEnd) {
  const synth = window.speechSynthesis; synth.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.93; utter.pitch = 0.72; utter.volume = 1;
  const tryVoice = () => { const v = pickVoice(); if (v) utter.voice = v; };
  tryVoice(); if (!utter.voice) setTimeout(tryVoice, 150);
  const safetyMs = Math.max(3500, text.length * 75);
  let finished = false;
  const safetyTimer = setTimeout(() => { if (!finished) { finished = true; _onSpeakEnd(onEnd); } }, safetyMs);
  const done = () => { if (finished) return; finished = true; clearTimeout(safetyTimer); _onSpeakEnd(onEnd); };
  utter.onend = done; utter.onerror = done; synth.speak(utter);
}

function _onSpeakEnd(onEnd) {
  state.isSpeaking = false; state.currentAudio = null; setOrb("idle");
  if (onEnd) onEnd();
}

function stopSpeaking() {
  if (state.currentAudio) { try { state.currentAudio.pause(); state.currentAudio.src = ""; } catch (_) {} state.currentAudio = null; }
  try { window.speechSynthesis.cancel(); } catch (_) {}
  state.isSpeaking = false;
}

// ═══════════════════════════════════════════════════════════════
// ── NOTIFICATION SYSTEM ──
// ═══════════════════════════════════════════════════════════════
const notif = {
  perms: "default",
  cfg: { intruder: true, away: true, return: true, system: false },
  _ctx: null,
  async init() {
    this.perms = Notification.permission;
    try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    if (this.perms === "default") this.perms = await Notification.requestPermission();
    updateNotifPermDisplay();
  },
  async requestPerm() { this.perms = await Notification.requestPermission(); updateNotifPermDisplay(); return this.perms === "granted"; },
  push(title, body, tag, requireInteraction = false) {
    if (this.perms !== "granted") return null;
    const n = new Notification(title, { body, tag, icon: "/favicon.ico", requireInteraction });
    n.onclick = () => { window.focus(); n.close(); }; return n;
  },
  tone(type) {
    if (!this._ctx) return;
    const ac = this._ctx; if (ac.state === "suspended") ac.resume();
    const now = ac.currentTime, g = ac.createGain(), o = ac.createOscillator();
    g.connect(ac.destination); o.connect(g);
    switch (type) {
      case "intruder": o.type="square"; o.frequency.setValueAtTime(880,now); o.frequency.setValueAtTime(440,now+0.15); o.frequency.setValueAtTime(880,now+0.30); o.frequency.setValueAtTime(440,now+0.45); g.gain.setValueAtTime(0.35,now); g.gain.linearRampToValueAtTime(0,now+0.65); o.start(now); o.stop(now+0.65); break;
      case "away": o.type="sine"; o.frequency.setValueAtTime(523,now); o.frequency.linearRampToValueAtTime(392,now+0.45); g.gain.setValueAtTime(0.15,now); g.gain.linearRampToValueAtTime(0,now+0.55); o.start(now); o.stop(now+0.55); break;
      case "return": o.type="sine"; o.frequency.setValueAtTime(392,now); o.frequency.linearRampToValueAtTime(523,now+0.18); o.frequency.linearRampToValueAtTime(659,now+0.38); g.gain.setValueAtTime(0.15,now); g.gain.linearRampToValueAtTime(0,now+0.55); o.start(now); o.stop(now+0.55); break;
      case "timer": o.type="sine"; o.frequency.setValueAtTime(659,now); o.frequency.setValueAtTime(784,now+0.12); o.frequency.setValueAtTime(659,now+0.24); o.frequency.setValueAtTime(784,now+0.36); g.gain.setValueAtTime(0.2,now); g.gain.linearRampToValueAtTime(0,now+0.55); o.start(now); o.stop(now+0.55); break;
      case "system": o.type="sine"; o.frequency.setValueAtTime(880,now); g.gain.setValueAtTime(0.07,now); g.gain.linearRampToValueAtTime(0,now+0.12); o.start(now); o.stop(now+0.15); break;
      default: o.start(now); o.stop(now+0.01);
    }
  },
  intruder(T="Sir") { if (!this.cfg.intruder) return; this.push("⚠ JARVIS — INTRUDER ALERT",`Unknown face detected, ${T}.`,"intruder",true); this.tone("intruder"); },
  away(T="Sir")     { if (!this.cfg.away) return; this.push("JARVIS — Away mode",`No face detected. Monitoring active, ${T}.`,"away"); this.tone("away"); },
  userReturn(T="Sir") { if (!this.cfg.return) return; this.push("JARVIS — Welcome back",`${T} detected. Away mode off.`,"user-return"); this.tone("return"); },
  system(msg) { if (!this.cfg.system) return; this.push("JARVIS", msg, "system-event"); this.tone("system"); },
};

function updateNotifPermDisplay() {
  const el = $("notif-perm-status"), btn = $("notif-perm-btn"); if (!el) return;
  const p = notif.perms;
  if (p === "granted") { el.textContent = "● GRANTED"; el.className = "notif-perm-status granted"; if (btn) btn.style.display = "none"; }
  else if (p === "denied") { el.textContent = "● DENIED"; el.className = "notif-perm-status denied"; if (btn) btn.style.display = "none"; }
  else { el.textContent = "● NOT GRANTED"; el.className = "notif-perm-status pending"; if (btn) btn.style.display = ""; }
}

// ── MOOD ──
function updateMood(delta) {
  state.moodScore = Math.max(-100, Math.min(100, state.moodScore + delta));
  const prev = state.mood;
  if (state.moodScore >= 70) state.mood = "excited";
  else if (state.moodScore >= 30) state.mood = "pleased";
  else if (state.moodScore >= 10) state.mood = "curious";
  else if (state.moodScore >= -20) state.mood = "neutral";
  else if (state.moodScore >= -50) state.mood = "concerned";
  else if (state.moodScore >= -80) state.mood = "bored";
  else state.mood = "tired";
  if (prev !== state.mood) updateMoodDisplay();
}
function updateMoodDisplay() {
  const el = $("mood-display"); if (!el) return;
  const icons = { pleased:"😊", excited:"⚡", curious:"🔍", concerned:"⚠️", bored:"💤", tired:"🔋", neutral:"●" };
  el.textContent = `${icons[state.mood] || "●"} ${state.mood.toUpperCase()}`;
}
setInterval(() => {
  if (state.moodScore > 0) updateMood(-1); else if (state.moodScore < 0) updateMood(1);
  if (Date.now() - state.lastInteraction > 300000) updateMood(-2);
}, 10000);

// ── PROFILE ──
function loadProfile() { try { return JSON.parse(localStorage.getItem("jarvis_profile")) || null; } catch { return null; } }
function saveProfileLocal(p) { localStorage.setItem("jarvis_profile", JSON.stringify(p)); }
async function saveProfileRemote(p) {
  try { await fetch("/api/register", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(p) }); }
  catch (e) { console.warn("[JARVIS] Could not save profile:", e); }
}
async function restoreProfileFromBackend() {
  const nameHint = localStorage.getItem("jarvis_name_hint"); if (!nameHint) return null;
  try {
    const res  = await fetch(`/api/profile/${encodeURIComponent(nameHint)}`);
    const data = await res.json();
    if (data.found) return { ...data.profile, passwordHash: localStorage.getItem("jarvis_pw_hash") || "" };
  } catch (e) { console.warn("[JARVIS] Backend restore failed:", e); }
  return null;
}
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}
const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════
// ── TESSERACT OCR ──
// ═══════════════════════════════════════════════════════════════
async function initTesseract() {
  try {
    if (!window.Tesseract) await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
    state.tesseractWorker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
    state.tesseractReady = true;
    addMsg("system", "OCR engine loaded — screen reading available.");
  } catch (e) { addMsg("system", "OCR engine unavailable."); }
}

async function ocrScreenFrame() {
  if (!state.screenStream) return null;
  const track = state.screenStream.getVideoTracks()[0]; if (!track) return null;
  let imageDataUrl;
  try {
    const capture = new ImageCapture(track), bitmap = await capture.grabFrame();
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    imageDataUrl = canvas.toDataURL("image/png");
  } catch {
    const video = document.createElement("video");
    video.srcObject = new MediaStream([track]);
    await new Promise(r => { video.onloadedmetadata = r; }); video.play(); await delay(200);
    const canvas = document.createElement("canvas");
    canvas.width = video.videoWidth || 1280; canvas.height = video.videoHeight || 720;
    canvas.getContext("2d").drawImage(video, 0, 0); video.pause();
    imageDataUrl = canvas.toDataURL("image/png");
  }
  if (!state.tesseractReady || !state.tesseractWorker) return { ocrText: null, imageB64: imageDataUrl.split(",")[1] };
  try {
    const result = await state.tesseractWorker.recognize(imageDataUrl);
    return { ocrText: result.data.text.trim(), imageB64: null };
  } catch { return { ocrText: null, imageB64: null }; }
}

// ═══════════════════════════════════════════════════════════════
// ── MIC ENGINE ──
// Now supports selected input device (bluetooth mic)
// ═══════════════════════════════════════════════════════════════
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = {
  rec: null, active: false, retryCount: 0, maxRetries: 999, retryDelay: 150,
  retryTimer: null, onResult: null, onInterim: null, continuous: true,
  suspended: false, _killing: false, permGranted: false,

  async requestPerm() {
    try {
      const constraints = { audio: state.bluetoothMicId
        ? { deviceId: { exact: state.bluetoothMicId }, echoCancellation: false, noiseSuppression: false, autoGainControl: true }
        : { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1, sampleRate: 16000 }
      };
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      stream.getTracks().forEach(t => t.stop());
      this.permGranted = true; updateMicDebug("Mic: permission granted ✓");
    } catch { updateMicDebug("Mic: permission denied ✗"); }
  },

  start(onResult, onInterim, continuous) {
    if (!SR) { addMsg("system", "Speech recognition requires Chrome/Edge."); return; }
    this.onResult = onResult; this.onInterim = onInterim;
    this.continuous = continuous !== false; this.suspended = false; this.retryCount = 0; this._launch();
  },

  _launch() {
    if (this.suspended) return;
    if (this.active) { this._killing = true; this._kill(); this._killing = false; }
    const r = new SR();
    r.lang = "en-US"; r.continuous = true; r.interimResults = true; r.maxAlternatives = 5;
    this.rec = r; this.active = true; state.isListening = true;

    r.onresult = (e) => {
      this.retryCount = 0;
      const result = e.results[e.results.length - 1];
      if (result.isFinal) {
        let bestText = result[0].transcript.trim(), bestConf = result[0].confidence || 0;
        for (let i = 1; i < result.length; i++) {
          if ((result[i].confidence || 0) > bestConf) { bestConf = result[i].confidence; bestText = result[i].transcript.trim(); }
        }
        if (!bestText) return;
        updateLiveHearing(""); updateMicDebug(`Mic: "${bestText}" (${(bestConf*100).toFixed(0)}%)`);
        // Interrupt detection
        if (state.isSpeaking && hasWakeWord(bestText.toLowerCase())) {
          stopSpeaking(); addMsg("system", "Interrupted.");
          const stripped = stripWakeWord(bestText);
          if (stripped.trim().length > 1) { if (this.onResult) this.onResult(stripped); }
          else {
            const ack = [`Yes, ${state.userTitle}?`, `At your service.`, `How can I help?`][Math.floor(Math.random()*3)];
            addMsg("jarvis", ack); speak(ack, () => mic.resume());
          }
          return;
        }
        if (this.onResult) this.onResult(bestText);
      } else if (result[0]) {
        const interim = result[0].transcript.trim();
        updateLiveHearing(interim); updateMicDebug("Mic: " + interim + "…");
        if (state.isSpeaking && hasWakeWord(interim.toLowerCase())) state.interruptPending = true;
        if (this.onInterim) this.onInterim(interim);
      }
    };

    r.onerror = (e) => {
      this.active = false; state.isListening = false; updateLiveHearing("");
      switch (e.error) {
        case "not-allowed": case "service-not-allowed": this.permGranted = false; updateMicDebug("Mic: blocked"); this.suspended = true; return;
        case "no-speech": updateMicDebug("Mic: silence…"); this._scheduleRetry(100); return;
        case "audio-capture": this._scheduleRetry(800); return;
        case "network": this._scheduleRetry(1500); return;
        case "aborted": if (!this.suspended && !this._killing) this._scheduleRetry(150); return;
        default: this._scheduleRetry(500);
      }
    };
    r.onend = () => { this.active = false; state.isListening = false; if (!this.suspended) this._scheduleRetry(50); };
    try { r.start(); updateMicDebug("Mic: listening…"); }
    catch { this.active = false; state.isListening = false; this._scheduleRetry(300); }
  },

  _scheduleRetry(ms) {
    clearTimeout(this.retryTimer); if (this.suspended) return;
    const d = Math.min(ms * Math.pow(1.2, Math.min(this.retryCount, 6)), 3000);
    this.retryCount++;
    this.retryTimer = setTimeout(() => this._launch(), d);
  },
  _kill() { try { if (this.rec) this.rec.abort(); } catch (_) {} this.rec = null; this.active = false; state.isListening = false; },
  suspend() { this.suspended = true; clearTimeout(this.retryTimer); this._kill(); updateLiveHearing(""); updateMicDebug("Mic: paused"); },
  resume()  { if (!this.suspended) return; this.suspended = false; this.retryCount = 0; updateMicDebug("Mic: resuming…"); this._launch(); },
};

setInterval(() => {
  if ((state.phase === "chatting" || state.phase === "idle") && !mic.suspended && !mic.active && !mic.retryTimer) mic._launch();
}, 2000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !mic.suspended && (state.phase === "idle" || state.phase === "chatting")) {
    if (!mic.active) mic._launch();
  }
});

function updateMicDebug(msg) { const el = $("mic-debug"); if (el) el.textContent = msg; }
function updateLiveHearing(text) {
  const el = $("live-hearing"); if (!el) return;
  if (!text) { el.classList.add("empty"); el.querySelector(".live-hearing-text").textContent = "listening…"; }
  else { el.classList.remove("empty"); el.querySelector(".live-hearing-text").textContent = text; }
}

// ── WAKE WORD ──
function hasWakeWord(lower) { return /\bjarvi[sc]?\b/.test(lower); }
function stripWakeWord(t)   { return t.replace(/\bjarvi[sc]?\b[,.]?\s*/gi, "").trim(); }

// ── NAME MATCHING ──
function matchesUser(text, profile) {
  if (!profile) return false;
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const name  = profile.name.toLowerCase();
  if (lower.includes(name)) return true;
  if (profile.voiceAliases) {
    for (const alias of profile.voiceAliases) {
      const a = alias.toLowerCase().replace(/[^a-z\s]/g, "").trim();
      if (a && lower.includes(a)) return true;
      if (a.length >= 3 && lower.includes(a.slice(0, 3))) return true;
    }
  }
  if (name.length >= 3) for (const w of lower.split(" ")) if (w.startsWith(name.slice(0, 3))) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════
// ── SETUP FLOW ──
// ═══════════════════════════════════════════════════════════════
function showSetup() {
  $("setup-screen").classList.add("active");
  $("auth-screen").classList.remove("active");
  $("main-screen")?.classList.remove("active");

  $("btn-next-profile").addEventListener("click", async () => {
    const name  = $("setup-name").value.trim();
    const pw    = $("setup-password").value.trim();
    const title = $("setup-title").value;
    if (!name || !pw) { alert("Please enter your name and a password."); return; }
    const hash = await hashPassword(pw);
    window._pendingProfile = { name, passwordHash: hash, title, voiceAliases: [] };
    $("step-profile").classList.add("hidden"); $("step-voice").classList.remove("hidden");
  });

  let samplesDone = 0;
  $("btn-record-sample").addEventListener("click", () => {
    if (samplesDone >= 3) return;
    $("voice-sample-status").textContent = "Recording… say your name now";
    $("record-bars").classList.remove("hidden");
    const r = new SR();
    r.continuous = false; r.interimResults = false; r.lang = "en-US";
    r.onresult = (e) => {
      const heard = e.results[0][0].transcript.trim();
      window._pendingProfile.voiceAliases.push(heard);
      samplesDone++;
      $("sample-count").textContent = `${samplesDone} / 3 samples recorded`;
      $("voice-sample-status").textContent = `Got it: "${heard}"`;
      $("record-bars").classList.add("hidden");
      if (samplesDone >= 3) { $("btn-record-sample").textContent = "✓ SAMPLES RECORDED"; $("btn-record-sample").disabled = true; setTimeout(() => completeSetup(), 800); }
    };
    r.onerror = () => { $("voice-sample-status").textContent = "Didn't catch that — try again"; $("record-bars").classList.add("hidden"); };
    r.onend   = () => $("record-bars").classList.add("hidden");
    r.start();
  });
  $("btn-skip-voice").addEventListener("click", () => completeSetup());
}

function completeSetup() {
  const p = window._pendingProfile;
  $("step-voice").classList.add("hidden"); $("step-done").classList.remove("hidden");
  const aliases = p.voiceAliases.length ? `Voice aliases: ${p.voiceAliases.join(", ")}` : "No voice aliases.";
  $("setup-summary").textContent = `Profile created for ${p.name} (${p.title}). ${aliases}`;
  $("btn-launch").addEventListener("click", async () => {
    saveProfileLocal(p);
    localStorage.setItem("jarvis_name_hint", p.name.toLowerCase());
    localStorage.setItem("jarvis_pw_hash", p.passwordHash);
    await saveProfileRemote(p);
    $("setup-screen").classList.remove("active"); showAuthScreen();
  });
}

// ═══════════════════════════════════════════════════════════════
// ── AUTH SCREEN ──
// ═══════════════════════════════════════════════════════════════
async function showAuthScreen() {
  $("auth-screen").classList.add("active");
  $("setup-screen").classList.remove("active");
  $("main-screen")?.classList.remove("active");
  await mic.requestPerm();

  const pwInput = $("auth-password-input");
  const newPwInput = pwInput.cloneNode(true);
  pwInput.parentNode.replaceChild(newPwInput, pwInput);

  newPwInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const profile = loadProfile();
    const hash    = await hashPassword(newPwInput.value);
    newPwInput.value = "";
    if (profile && hash === profile.passwordHash) {
      state.user = profile.name; state.userTitle = profile.title;
      speak(`Welcome back, ${profile.title}.`, launchMain); return;
    }
    const nameHint = localStorage.getItem("jarvis_name_hint");
    if (nameHint) {
      try {
        const res  = await fetch("/api/verify", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ name:nameHint, passwordHash:hash }) });
        const data = await res.json();
        if (data.authorized) {
          const restored = { ...data.profile, passwordHash: hash };
          saveProfileLocal(restored); localStorage.setItem("jarvis_pw_hash", hash);
          state.user = data.profile.name; state.userTitle = data.profile.title;
          speak(`Welcome back, ${data.profile.title}. Profile restored.`, launchMain); return;
        }
      } catch {}
    }
    const as = $("auth-status");
    as.innerHTML = `<span style="color:var(--red)">Wrong password.</span>`;
    setTimeout(() => { as.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type password`; }, 2000);
  });
  startAuthListening();
}

function startAuthListening() {
  state.phase = "idle";
  mic.start((text) => {
    const lower = text.toLowerCase();
    if (state.phase === "idle") {
      const hasLogin = /\blog\s*in\b|\blogin\b|\bsign\s*in\b|\bopen\b|\bidentify\b|\baccess\b/.test(lower);
      if (hasWakeWord(lower) && hasLogin) startVoiceAuth();
    }
  }, null, true);
}

function startVoiceAuth() {
  state.phase = "awaiting_name"; mic.suspend();
  const as = $("auth-status"), ap = $("auth-prompt"), al = $("auth-listening"), ht = $("heard-text");
  as.style.display = "none"; ap.classList.remove("hidden"); al.classList.remove("hidden"); ht.textContent = "Listening…";
  speak("Identify yourself.", () => {
    const r = new SR();
    r.continuous = false; r.interimResults = true; r.lang = "en-US"; r.maxAlternatives = 5;
    r.onresult = (e) => {
      const result = e.results[0]; const text = result[0].transcript.trim(); ht.textContent = text;
      if (result.isFinal) { ap.classList.add("hidden"); al.classList.add("hidden"); as.style.display = ""; checkVoiceAuth(text); }
    };
    r.onerror = () => {
      ht.textContent = "Couldn't hear you."; state.phase = "idle";
      setTimeout(() => { ap.classList.add("hidden"); al.classList.add("hidden"); as.style.display = ""; startAuthListening(); }, 1500);
    };
    setOrb("listening"); r.start();
  });
}

async function checkVoiceAuth(spokenText) {
  const profile = loadProfile(); const as = $("auth-status");
  as.textContent = `Heard: "${spokenText}" — verifying…`; setOrb("thinking");
  if (profile && matchesUser(spokenText, profile)) {
    state.user = profile.name; state.userTitle = profile.title;
    setOrb("idle"); speak(`Welcome back, ${profile.title}.`, launchMain); return;
  }
  try {
    const res = await fetch("/api/profiles"); const data = await res.json();
    for (const p of (data.profiles || [])) {
      if (matchesUser(spokenText, p)) {
        localStorage.setItem("jarvis_name_hint", p.name.toLowerCase());
        state.user = p.name; state.userTitle = p.title;
        setOrb("idle"); speak(`Welcome back, ${p.title}. Identity confirmed.`, launchMain); return;
      }
    }
  } catch {}
  setOrb("idle");
  as.innerHTML = `<span style="color:var(--red)">Access denied.</span>`;
  speak("Access denied. Identity not recognised.", () => {
    setTimeout(() => { as.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type password`; state.phase = "idle"; startAuthListening(); }, 1800);
  });
}

// ═══════════════════════════════════════════════════════════════
// ── LAUNCH MAIN ──
// ═══════════════════════════════════════════════════════════════
async function launchMain() {
  state.phase = "chatting";
  $("auth-screen").classList.remove("active");
  $("main-screen").classList.add("active");
  $("user-display").textContent = `${state.user} / ${state.userTitle}`;
  state.lastInteraction = Date.now(); updateMood(20);

  // Check Ollama
  try {
    const res = await fetch("/api/ollama/status");
    const data = await res.json();
    state.ollamaAvailable = data.available && data.hasModel;
    const llmEl = $("llm-status");
    if (llmEl) {
      if (state.ollamaAvailable) {
        llmEl.textContent = `LLM: ${data.model} ● ONLINE`;
        llmEl.style.color = "var(--green)";
      } else if (data.available) {
        llmEl.textContent = `LLM: MODEL NOT PULLED — say "pull ${data.model}"`;
        llmEl.style.color = "var(--amber)";
      } else {
        llmEl.textContent = `LLM: OFFLINE — say "start ollama"`;
        llmEl.style.color = "var(--amber)";
      }
    }
  } catch {
    const llmEl = $("llm-status");
    if (llmEl) { llmEl.textContent = "LLM: OFFLINE — say \"start ollama\""; llmEl.style.color = "var(--amber)"; }
  }

  notif.init().then(() => {
    addMsg("system", notif.perms === "granted" ? "Push notifications active." : "Push notifications not granted.");
  });

  await enumerateAudioOutputs();

  // Build bluetooth panel
  buildBluetoothPanel();

  // Setup MediaSession for bluetooth button wake
  setupMediaSessionWake();

  // Try to auto-detect bluetooth headsets in mic list
  await refreshAudioInputs();

  const greetings = [
    `All systems online, ${state.userTitle}. Just talk to me — no commands to memorise. Say "start ollama" if my intelligence is offline.`,
    `Good to have you back, ${state.userTitle}. Full semantic reasoning active. Connect a Bluetooth headset and hold volume to wake me.`,
    `Online and operational, ${state.userTitle}. Ask me anything naturally. Hold volume on your headset to get my attention.`,
  ];
  addMsg("system", greetings[Math.floor(Math.random() * greetings.length)]);

  requestScreenRecord();
  requestCameraAccess();
  setupTypingBox();
  setupTTSToggle();
  startChatListening();
  initTesseract();
  setTimeout(() => checkIntruderClips(), 2000);
}

// ── TTS TOGGLE ──
function setupTTSToggle() {
  const hud = $("hud-bottom"); if (!hud) return;
  const existing = $("tts-toggle-wrap"); if (existing) return;
  const wrap = document.createElement("div"); wrap.id = "tts-toggle-wrap";
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;flex-shrink:0;";
  const label = document.createElement("span");
  label.style.cssText = "font-family:var(--mono);font-size:0.52rem;letter-spacing:0.15em;color:var(--text-dim);";
  label.textContent = "VOICE:";
  const btn = document.createElement("button"); btn.id = "tts-toggle-btn";
  btn.style.cssText = "background:transparent;border:1px solid var(--blue-dim);color:var(--blue);font-family:var(--mono);font-size:0.58rem;letter-spacing:0.1em;padding:3px 8px;border-radius:3px;cursor:pointer;";
  btn.textContent = "BRIAN";
  btn.addEventListener("click", () => {
    state.useStreamElements = !state.useStreamElements;
    btn.textContent = state.useStreamElements ? "BRIAN" : "WEB";
    btn.style.borderColor = state.useStreamElements ? "var(--blue-dim)" : "var(--amber)";
    btn.style.color = state.useStreamElements ? "var(--blue)" : "var(--amber)";
    addMsg("system", `Voice: ${state.useStreamElements ? "StreamElements Brian" : "Web Speech"}`);
  });
  wrap.appendChild(label); wrap.appendChild(btn);
  const micDbg = hud.querySelector(".mic-debug");
  if (micDbg) hud.insertBefore(wrap, micDbg); else hud.appendChild(wrap);
}

// ── CHAT LISTENING ──
function startChatListening() {
  mic.start(
    (text) => { if (state.phase !== "chatting") return; updateMicDebug(`Mic: "${text}"`); handleChatCommand(text); },
    () => {},
    true
  );
}

// ── TYPING BOX ──
function setupTypingBox() {
  const input = $("type-input"), btn = $("type-send"); if (!input || !btn) return;
  const submit = () => {
    const text = input.value.trim(); if (!text || state.phase !== "chatting") return;
    input.value = ""; handleChatCommand(text, true);
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } e.stopPropagation(); });
  input.addEventListener("focus", () => mic.suspend());
  input.addEventListener("blur",  () => { if (state.phase === "chatting") mic.resume(); });
}

// ═══════════════════════════════════════════════════════════════
// ── CHAT COMMAND HANDLER ──
// ═══════════════════════════════════════════════════════════════
function handleChatCommand(text, isTyped = false) {
  const lower = text.toLowerCase();
  state.lastInteraction = Date.now();
  state.interactionCount++;
  updateMood(3);

  const hasWake = isTyped || hasWakeWord(lower);
  const cleaned = hasWake ? (isTyped ? text : stripWakeWord(text)) : text;

  if (!isTyped) {
    const recentlyActive = (Date.now() - state.lastInteraction) < 30000;
    if (!hasWake && !recentlyActive && state.interactionCount > 3) { updateLiveHearing(""); return; }
  }

  if (!cleaned || cleaned.trim().length < 1) {
    const ack = [`Yes, ${state.userTitle}?`, `At your service, ${state.userTitle}.`, `How can I help, ${state.userTitle}?`][Math.floor(Math.random()*3)];
    addMsg("jarvis", ack); speak(ack, () => mic.resume()); return;
  }

  sendToAI(cleaned);
}

// ═══════════════════════════════════════════════════════════════
// ── AI CHAT — pure Ollama, no intent scoring ──
// ═══════════════════════════════════════════════════════════════
async function sendToAI(message) {
  mic.suspend();
  addMsg("user", message);
  setOrb("thinking");
  const memories = await loadMemoriesForPrompt();
  const moodCtx  = `mood: ${state.mood} (score: ${state.moodScore})`;
  try {
    const res  = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, sessionId: state.sessionId, userName: state.user, userTitle: state.userTitle, memories, moodContext: moodCtx }),
    });
    const data  = await res.json();
    const reply = data.reply || `Yes, ${state.userTitle}?`;
    addMsg("jarvis", reply);
    updateMood(5);

    // Refresh LLM status in case it just came online/offline
    refreshLLMStatus();

    if (data.action && data.action !== "NONE") {
      await handleAction(data.action, data.meta || {}, reply);
    } else {
      speak(reply, () => mic.resume());
    }
  } catch (err) {
    console.error("[JARVIS] AI error:", err);
    const fb = `Something went sideways, ${state.userTitle}. Give it another go.`;
    addMsg("jarvis", fb); speak(fb, () => mic.resume()); updateMood(-5);
  }
}

async function refreshLLMStatus() {
  try {
    const res = await fetch("/api/ollama/status");
    const data = await res.json();
    const llmEl = $("llm-status"); if (!llmEl) return;
    if (data.available && data.hasModel) {
      llmEl.textContent = `LLM: ${data.model} ● ONLINE`;
      llmEl.style.color = "var(--green)";
      state.ollamaAvailable = true;
    } else if (data.available) {
      llmEl.textContent = `LLM: MODEL NOT PULLED — say "pull ${data.model}"`;
      llmEl.style.color = "var(--amber)";
      state.ollamaAvailable = false;
    } else {
      llmEl.textContent = `LLM: OFFLINE — say "start ollama"`;
      llmEl.style.color = "var(--amber)";
      state.ollamaAvailable = false;
    }
  } catch {}
}

// ═══════════════════════════════════════════════════════════════
// ── ACTION HANDLER ──
// ═══════════════════════════════════════════════════════════════
async function handleAction(action, meta, replyText) {
  const T = state.userTitle || "Sir";

  switch (action) {
    case "SHOW_LINKS": {
      speak(replyText, () => mic.resume());
      if (meta.linkGroups && meta.linkGroups.length > 0) {
        const wrap = document.createElement("div"); wrap.className = "msg system";
        let html = `<div class="msg-label">J.A.R.V.I.S — LINK BANK (${meta.total} total)</div><div class="msg-text link-bank-display">`;
        for (const group of meta.linkGroups) {
          html += `<div class="link-group"><div class="link-group-name">${group.name.toUpperCase()} <span class="link-count">(${group.count})</span></div>`;
          if (group.count <= 5) {
            for (const url of group.urls) html += `<a href="${url}" target="_blank" rel="noopener" class="jarvis-link link-item">${url}</a>`;
          } else {
            for (const url of group.urls.slice(0, 3)) html += `<a href="${url}" target="_blank" rel="noopener" class="jarvis-link link-item">${url}</a>`;
            html += `<span class="link-more">… and ${group.count - 3} more. Say "${group.name}" to open one.</span>`;
          }
          html += `</div>`;
        }
        html += `</div>`;
        wrap.innerHTML = html;
        $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
      }
      break;
    }
    case "OPEN_LINK": {
      if (meta.found) {
        const wrap = document.createElement("div"); wrap.className = "msg jarvis";
        wrap.innerHTML = `<div class="msg-label">J.A.R.V.I.S — LINK</div><div class="msg-text"><a href="${meta.url}" target="_blank" rel="noopener" class="jarvis-link">${meta.url}</a></div>`;
        $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
        speak(replyText, () => { window.open(meta.url, "_blank", "noopener"); mic.resume(); });
      } else { speak(replyText, () => mic.resume()); }
      break;
    }
    case "CLIP_SAVE": {
      speak(replyText, () => {
        const clipType = meta.clipType || "both";
        let saved = 0;
        if ((clipType === "both" || clipType === "screen") && state.clipChunks.length) {
          const blob = new Blob(state.clipChunks, { type: getSupportedMime() || "video/webm" });
          downloadClipBlob(blob, `jarvis-screen-${Date.now()}.webm`); saved++;
        }
        if ((clipType === "both" || clipType === "camera") && state.cameraClipChunks.length) {
          const blob = new Blob(state.cameraClipChunks, { type: getSupportedMime() || "video/webm" });
          downloadClipBlob(blob, `jarvis-camera-${Date.now()}.webm`); saved++;
        }
        if (!saved) {
          const msg = `No buffer available yet, ${T}. Give it a few seconds.`;
          addMsg("jarvis", msg); speak(msg, () => mic.resume()); return;
        }
        const toast = $("clip-toast");
        if (toast) { toast.classList.remove("hidden"); setTimeout(() => toast.classList.add("hidden"), 3500); }
        updateMood(3); mic.resume();
      });
      break;
    }
    case "SHOW_CLIPS":   { speak(replyText, () => { showIntruderClips(); mic.resume(); }); break; }
    case "READ_SCREEN":  { speak(replyText, () => {}); await readScreen(meta.question || "What's on my screen?"); break; }
    case "SWITCH_CAMERA": {
      if (typeof meta.cameraIndex === "number" && meta.cameraIndex >= 0) {
        speak(replyText, () => {});
        if (state.availableCameras[meta.cameraIndex]) await switchCamera(state.availableCameras[meta.cameraIndex].deviceId);
        else { const m = `I don't see camera ${meta.cameraIndex + 1}, ${T}.`; addMsg("jarvis", m); speak(m, () => mic.resume()); }
      } else { speak(replyText, () => mic.resume()); }
      break;
    }
    case "TIMER": {
      if (meta.action === "TIMER_SET" && meta.duration) {
        speak(replyText, () => mic.resume());
        showTimerBadge(meta.duration, meta.task);
        const timerId = setTimeout(() => {
          const task = meta.task ? ` — remember to ${meta.task}` : "";
          const alertMsg = `${T}, your timer is up${task}.`;
          addMsg("jarvis", alertMsg); speak(alertMsg);
          notif.tone("timer"); notif.push("⏱ J.A.R.V.I.S — Timer", alertMsg, "timer", true);
          hideTimerBadge();
        }, meta.duration);
        state.activeTimers.push({ id: timerId, duration: meta.duration, task: meta.task, startedAt: Date.now() });
      } else { speak(replyText, () => mic.resume()); }
      break;
    }
    case "NOTIF_SETTINGS": { speak(replyText, () => {}); showNotifSettings(); break; }
    case "LOGOUT":          { speak(replyText, () => {}); setTimeout(() => handleLogout(), 800); break; }
    default:                { speak(replyText, () => mic.resume()); break; }
  }
}

// ── TIMER BADGE ──
function showTimerBadge(durationMs, task) {
  let badge = $("timer-badge-el");
  if (!badge) { badge = document.createElement("div"); badge.id = "timer-badge-el"; badge.className = "timer-badge"; document.body.appendChild(badge); }
  const endTime = Date.now() + durationMs;
  badge.innerHTML = `<span class="timer-badge-dot"></span><span id="timer-badge-text">⏱ ${task ? task.toUpperCase() : "TIMER"} — ${formatDurationClient(durationMs)}</span>`;
  badge.classList.remove("hidden");
  const tick = setInterval(() => {
    const remaining = endTime - Date.now();
    if (remaining <= 0) { clearInterval(tick); return; }
    const el = $("timer-badge-text"); if (el) el.textContent = `⏱ ${task ? task.toUpperCase() : "TIMER"} — ${formatDurationClient(remaining)}`;
  }, 1000);
  badge._tick = tick;
}
function hideTimerBadge() { const badge = $("timer-badge-el"); if (!badge) return; if (badge._tick) clearInterval(badge._tick); badge.classList.add("hidden"); }
function formatDurationClient(ms) {
  const h = Math.floor(ms/3600000), m = Math.floor((ms%3600000)/60000), s = Math.floor((ms%60000)/1000);
  const parts = []; if (h) parts.push(`${h}h`); if (m) parts.push(`${m}m`); if (s && !h) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}

// ── ORB ──
function setOrb(s) {
  const orb = $("orb"); if (!orb) return;
  orb.className = "orb" + (s !== "idle" ? " " + s : "");
  const labels = { idle:"STANDBY", listening:"LISTENING", thinking:"PROCESSING", speaking:"SPEAKING" };
  const st = $("status-text"); if (st) st.textContent = labels[s] || "STANDBY";
}

// ── NOTIFICATION SETTINGS ──
function showNotifSettings() {
  mic.suspend();
  let overlay = $("notif-settings-overlay");
  if (!overlay) {
    overlay = document.createElement("div"); overlay.id = "notif-settings-overlay"; overlay.className = "notif-settings-overlay";
    overlay.innerHTML = `
      <div class="notif-settings-box">
        <div class="notif-settings-header"><span class="notif-settings-title">NOTIFICATION SETTINGS</span><button class="notif-close-btn" id="notif-close-btn">✕</button></div>
        <div class="notif-section"><div class="notif-section-label">PUSH PERMISSION</div><div class="notif-perm-bar"><span class="notif-perm-status pending" id="notif-perm-status">● CHECKING…</span><button class="hud-btn" id="notif-perm-btn" style="width:auto;padding:6px 14px;font-size:0.65rem;">REQUEST</button></div></div>
        <div class="notif-section"><div class="notif-section-label">ALERT CHANNELS</div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot red"></span><div><div class="notif-row-title">Intruder detection</div><div class="notif-row-sub">Push + alarm tone</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-intruder" ${notif.cfg.intruder?"checked":""}><span class="notif-slider"></span></label></div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot amber"></span><div><div class="notif-row-title">Away mode</div><div class="notif-row-sub">Push + chime</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-away" ${notif.cfg.away?"checked":""}><span class="notif-slider"></span></label></div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot blue"></span><div><div class="notif-row-title">User return</div><div class="notif-row-sub">Push + welcome tone</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-return" ${notif.cfg.return?"checked":""}><span class="notif-slider"></span></label></div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot green"></span><div><div class="notif-row-title">System events</div><div class="notif-row-sub">Subtle ping</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-system" ${notif.cfg.system?"checked":""}><span class="notif-slider"></span></label></div>
        </div>
        <div class="notif-section"><div class="notif-section-label">TEST ALERTS</div>
          <div class="notif-test-grid">
            <button class="notif-test-btn" id="ntest-intruder">Intruder alarm</button>
            <button class="notif-test-btn" id="ntest-away">Away mode</button>
            <button class="notif-test-btn" id="ntest-return">User return</button>
            <button class="notif-test-btn" id="ntest-system">System ping</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    $("notif-close-btn").addEventListener("click", hideNotifSettings);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) hideNotifSettings(); });
    $("notif-perm-btn")?.addEventListener("click", () => notif.requestPerm());
    const toggleMap = { "nt-intruder":"intruder","nt-away":"away","nt-return":"return","nt-system":"system" };
    for (const [id, key] of Object.entries(toggleMap)) $(id)?.addEventListener("change", (e) => { notif.cfg[key] = e.target.checked; });
    $("ntest-intruder").addEventListener("click", () => { notif.tone("intruder"); notif.push("⚠ TEST","Intruder test.","test-i"); });
    $("ntest-away").addEventListener("click",     () => { notif.tone("away");     notif.push("TEST","Away test.","test-a"); });
    $("ntest-return").addEventListener("click",   () => { notif.tone("return");   notif.push("TEST","Return test.","test-r"); });
    $("ntest-system").addEventListener("click",   () => { notif.tone("system");   notif.push("TEST","System ping.","test-s"); });
  }
  overlay.classList.remove("hidden"); updateNotifPermDisplay(); addMsg("system", "Notification settings open.");
}
function hideNotifSettings() { const o = $("notif-settings-overlay"); if (o) o.classList.add("hidden"); if (state.phase === "chatting") mic.resume(); }

// ── FACE AUTH ──
function showFaceAuthOverlay() {
  const overlay = $("face-auth-overlay"), pwInput = $("face-auth-password"), errMsg = $("face-auth-error"), submit = $("face-auth-submit"), dismiss = $("face-auth-dismiss");
  overlay.classList.remove("hidden"); pwInput.value = ""; errMsg.classList.add("hidden"); pwInput.focus();
  const nK = submit.cloneNode(true), nDi = dismiss.cloneNode(true);
  submit.parentNode.replaceChild(nK, submit); dismiss.parentNode.replaceChild(nDi, dismiss);
  const attemptAuth = async () => {
    const pw = $("face-auth-password").value; if (!pw) return;
    const hash = await hashPassword(pw), profile = loadProfile(); let authorized = false;
    if (profile && hash === profile.passwordHash) authorized = true;
    else {
      const nameHint = localStorage.getItem("jarvis_name_hint");
      if (nameHint) { try { const res = await fetch("/api/verify",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({name:nameHint,passwordHash:hash})}); const data = await res.json(); if (data.authorized) authorized = true; } catch {} }
    }
    if (authorized) {
      state.intruderAuthorized = true; hideFaceAuthOverlay();
      $("camera-panel")?.classList.remove("alert");
      const r = `Access authorized, ${state.userTitle}.`; addMsg("jarvis",r); speak(r); updateMood(10);
    } else {
      const errEl = $("face-auth-error"); errEl.classList.remove("hidden"); $("face-auth-password").value = ""; $("face-auth-password").focus();
      setTimeout(() => errEl.classList.add("hidden"), 2500);
    }
  };
  $("face-auth-submit").addEventListener("click", attemptAuth);
  $("face-auth-password").addEventListener("keydown", (e) => { if (e.key === "Enter") attemptAuth(); });
  $("face-auth-dismiss").addEventListener("click", () => { hideFaceAuthOverlay(); addMsg("system","Overlay dismissed. Recording continues."); });
}
function hideFaceAuthOverlay() { $("face-auth-overlay").classList.add("hidden"); }

// ── CLIP REVIEW ──
function showClipReviewPrompt(clip) {
  const overlay = $("clip-review-overlay"), subText = $("clip-review-sub"),
        keepBtn = $("clip-review-keep"), dlBtn = $("clip-review-download"), discardBtn = $("clip-review-discard");
  subText.textContent = state.intruderAuthorized ? "You authorized this visit. Keep the clip?" : "Unauthorized face detected. Keep this incident clip?";
  overlay.classList.remove("hidden");
  const nK = keepBtn.cloneNode(true), nD = dlBtn.cloneNode(true), nDi = discardBtn.cloneNode(true);
  keepBtn.parentNode.replaceChild(nK,keepBtn); dlBtn.parentNode.replaceChild(nD,dlBtn); discardBtn.parentNode.replaceChild(nDi,discardBtn);
  const close = () => overlay.classList.add("hidden");
  $("clip-review-keep").addEventListener("click",     () => { state.intruderClips.push(clip); close(); const r = `Clip saved, ${state.userTitle}.`; addMsg("jarvis",r); speak(r); });
  $("clip-review-download").addEventListener("click", () => { state.intruderClips.push(clip); downloadClipBlob(clip.videoBlob,`jarvis-incident-${Date.now()}.webm`); close(); const r = `Clip downloaded, ${state.userTitle}.`; addMsg("jarvis",r); speak(r); });
  $("clip-review-discard").addEventListener("click",  () => { close(); const r = `Clip discarded, ${state.userTitle}.`; addMsg("jarvis",r); speak(r); });
}
function downloadClipBlob(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

// ── SCREEN READING ──
async function readScreen(question) {
  mic.suspend(); setOrb("thinking");
  addMsg("user", question || "What's on my screen?");
  if (!state.screenStream) { const r = `Screen sharing isn't active, ${state.userTitle}.`; addMsg("jarvis",r); speak(r, () => mic.resume()); return; }
  addMsg("system","Scanning screen…");
  const ocr = await ocrScreenFrame();
  if (!ocr || !ocr.ocrText || ocr.ocrText.trim().length < 5) {
    const r = `Couldn't extract readable text from the screen, ${state.userTitle}.`; addMsg("jarvis",r); speak(r, () => mic.resume()); return;
  }
  const memories = await loadMemoriesForPrompt();
  try {
    const res = await fetch("/api/screen", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ ocrText:ocr.ocrText, question:question||"What is on the screen?", userName:state.user, userTitle:state.userTitle, memories }) });
    const data  = await res.json();
    const reply = data.reply || `Your screen contains: ${ocr.ocrText.slice(0,200)}`;
    addMsg("jarvis",reply); speak(reply, () => mic.resume()); updateMood(5);
  } catch {
    const lines = ocr.ocrText.split("\n").filter(l => l.trim().length > 2).slice(0,4).join(". ");
    const r = `Here's what I can read, ${state.userTitle}: ${lines}`; addMsg("jarvis",r); speak(r, () => mic.resume());
  }
}

// ── CAMERA ──
async function enumerateCameras() {
  try { const devices = await navigator.mediaDevices.enumerateDevices(); state.availableCameras = devices.filter(d => d.kind === "videoinput"); buildCameraSelector(); }
  catch (e) {}
}
function buildCameraSelector() {
  const existing = $("camera-selector-wrap"); if (existing) existing.remove();
  if (state.availableCameras.length <= 1) return;
  const panel = $("camera-panel"); if (!panel) return;
  const wrap = document.createElement("div"); wrap.id = "camera-selector-wrap";
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;margin-top:4px;";
  const label = document.createElement("span");
  label.style.cssText = "font-family:var(--mono);font-size:0.52rem;letter-spacing:0.15em;color:var(--text-dim);";
  label.textContent = "CAM:";
  const sel = document.createElement("select"); sel.id = "camera-select";
  sel.style.cssText = "background:rgba(0,200,255,0.06);border:1px solid var(--blue-dim);color:var(--blue);font-family:var(--mono);font-size:0.58rem;letter-spacing:0.08em;padding:3px 6px;border-radius:3px;outline:none;cursor:pointer;width:120px;";
  state.availableCameras.forEach((cam, i) => {
    const opt = document.createElement("option"); opt.value = cam.deviceId; opt.textContent = cam.label || `Camera ${i+1}`;
    if (cam.deviceId === state.selectedCameraId) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", () => { state.selectedCameraId = sel.value; switchCamera(sel.value); });
  wrap.appendChild(label); wrap.appendChild(sel); panel.appendChild(wrap);
}
async function switchCamera(deviceId) {
  if (state.cameraStream) { state.cameraStream.getTracks().forEach(t => t.stop()); state.cameraStream = null; }
  if (state.cameraRecorder && state.cameraRecorder.state !== "inactive") { state.cameraRecorder.stop(); state.cameraRecorder = null; }
  state.cameraClipChunks = []; state.cameraClipTimestamps = [];
  addMsg("system","Switching camera…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video:{ deviceId:{ exact:deviceId }, width:640, height:480, frameRate:15 }, audio:false });
    state.cameraStream = stream; state.selectedCameraId = deviceId;
    const vid = $("camera-feed"); if (vid) { vid.srcObject = stream; vid.play(); }
    startCameraBuffer(stream); state.faceDescriptors = null; await enrollUserFace();
    const r = `Camera switched, ${state.userTitle}.`; addMsg("jarvis",r); speak(r); updateMood(2);
  } catch { const r = `Camera switch failed, ${state.userTitle}.`; addMsg("jarvis",r); speak(r); }
}
async function requestCameraAccess() {
  try {
    await enumerateCameras();
    const videoConstraints = state.selectedCameraId
      ? { deviceId:{ exact:state.selectedCameraId }, width:640, height:480, frameRate:15 }
      : { width:640, height:480, frameRate:15 };
    const stream = await navigator.mediaDevices.getUserMedia({ video:videoConstraints, audio:false });
    state.cameraStream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) { const s = track.getSettings(); state.selectedCameraId = s.deviceId || state.selectedCameraId; }
    const vid = $("camera-feed"); if (vid) { vid.srcObject = stream; vid.play(); }
    const cameraStatus = $("camera-status");
    if (cameraStatus) { cameraStatus.textContent = "● ONLINE"; cameraStatus.classList.add("online"); }
    startCameraBuffer(stream); await enumerateCameras(); await loadFaceModels();
    addMsg("system",`Camera online. ${state.availableCameras.length} camera(s) detected.`); updateMood(5);
  } catch { addMsg("system","Camera declined — face recognition unavailable."); }
}

let faceApiLoaded = false;
async function loadFaceModels() {
  try {
    if (!window.faceapi) await loadScript("https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/dist/face-api.min.js");
    const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
    await Promise.all([faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL), faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL), faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL)]);
    faceApiLoaded = true; await enrollUserFace(); startFaceWatch();
  } catch (e) { console.warn("[JARVIS] Face-api failed:", e); }
}
function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = reject; document.head.appendChild(s);
  });
}
async function enrollUserFace() {
  if (!faceApiLoaded || !state.cameraStream) return;
  const vid = $("camera-feed"); if (!vid) return;
  for (let i = 0; i < 5; i++) {
    await delay(1000);
    try { const d = await faceapi.detectSingleFace(vid, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor(); if (d) { state.faceDescriptors = d.descriptor; addMsg("system","Your face enrolled."); return; } }
    catch {}
  }
}
function startFaceWatch() { if (state.faceCheckInterval) clearInterval(state.faceCheckInterval); state.faceCheckInterval = setInterval(checkFace, 2000); }
async function checkFace() {
  if (!faceApiLoaded || !state.cameraStream || state.phase !== "chatting") return;
  const vid = $("camera-feed"); if (!vid || vid.readyState < 2) return;
  try {
    const detections = await faceapi.detectAllFaces(vid, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
    if (detections.length > 0) state.lastSeenUser = Date.now();
    if (state.faceDescriptors && detections.length > 0) {
      let userPresent = false;
      for (const d of detections) { if (faceapi.euclideanDistance(d.descriptor, state.faceDescriptors) < 0.55) { userPresent = true; break; } }
      if (userPresent) {
        if (state.awayMode) { state.awayMode = false; stopIntruderRecord(); notif.userReturn(state.userTitle); const msg = `Welcome back, ${state.userTitle}.`; addMsg("jarvis",msg); speak(msg, () => setTimeout(() => checkIntruderClips(), 1500)); updateMood(15); }
      } else if (detections.length > 0 && !state.intruderActive) { handleUnknownFace(); }
    }
    if (Date.now() - state.lastSeenUser > 60000 && !state.awayMode && state.phase === "chatting") { state.awayMode = true; notif.away(state.userTitle); addMsg("system","User not detected — away mode active."); }
  } catch {}
}
function handleUnknownFace() {
  if (state.intruderActive) return;
  state.intruderActive = true; state.intruderAuthorized = false;
  $("camera-panel")?.classList.add("alert"); notif.intruder(state.userTitle);
  addMsg("system","⚠ UNKNOWN FACE DETECTED — recording started");
  speak("I don't recognise you. Identify yourself.", () => { setTimeout(() => { if (state.intruderActive && !state.intruderAuthorized) speak("Unauthorised access detected. Recording in progress."); }, 10000); });
  showFaceAuthOverlay(); startIntruderRecord(); updateMood(-30);
}
function startIntruderRecord() {
  if (!state.cameraStream) return;
  state.intruderChunks = [];
  const mime = getSupportedMime(), photo = captureAndStoreIntruderPhoto();
  try {
    const rec = new MediaRecorder(state.cameraStream, mime ? { mimeType:mime } : {});
    state.intruderRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data?.size > 0) state.intruderChunks.push(e.data); };
    rec.onstop = () => {
      if (state.intruderChunks.length > 0) {
        const videoBlob = new Blob(state.intruderChunks, { type:getSupportedMime()||"video/webm" });
        const clip = { videoBlob, photoB64:photo, timestamp:new Date().toISOString(), authorized:state.intruderAuthorized };
        hideFaceAuthOverlay(); $("camera-panel")?.classList.remove("alert"); state.intruderActive = false; state.intruderChunks = [];
        showClipReviewPrompt(clip);
      } else { state.intruderActive = false; state.intruderChunks = []; }
    };
    rec.start(1000);
    setTimeout(() => { if (state.intruderRecorder && state.intruderRecorder.state !== "inactive") state.intruderRecorder.stop(); }, 30000);
  } catch { state.intruderActive = false; }
}
function stopIntruderRecord() { if (!state.intruderRecorder || state.intruderRecorder.state === "inactive") return; state.intruderRecorder.stop(); }
function captureAndStoreIntruderPhoto() {
  const vid = $("camera-feed"); if (!vid) return null;
  const c = document.createElement("canvas"); c.width = vid.videoWidth||640; c.height = vid.videoHeight||480;
  c.getContext("2d").drawImage(vid,0,0); return c.toDataURL("image/jpeg",0.85).split(",")[1];
}
function checkIntruderClips() {
  if (!state.intruderClips.length) return;
  const count = state.intruderClips.length;
  const r = `${state.userTitle}, I have ${count} intruder incident${count===1?"":"s"} on file. Say "show clips" to review.`;
  notif.system(`${count} intruder clip(s) on file.`); addMsg("jarvis",r); speak(r); updateMood(-10);
}
function showIntruderClips() {
  mic.suspend();
  if (!state.intruderClips.length) { const r = `No intruder footage on file, ${state.userTitle}.`; addMsg("jarvis",r); speak(r, () => mic.resume()); return; }
  addMsg("system",`📂 ${state.intruderClips.length} intruder clip(s):`);
  state.intruderClips.forEach((clip, i) => {
    const time = new Date(clip.timestamp).toLocaleTimeString();
    const tag  = clip.authorized ? " (AUTHORIZED)" : "";
    const wrap = document.createElement("div"); wrap.className = "msg system";
    wrap.innerHTML = `<div class="msg-label">INTRUDER #${i+1} — ${time}${tag}</div><div class="msg-text intruder-clip-block"></div>`;
    const block = wrap.querySelector(".intruder-clip-block");
    if (clip.photoB64) { const img = document.createElement("img"); img.src = `data:image/jpeg;base64,${clip.photoB64}`; img.style.cssText = "width:160px;border:1px solid var(--red);border-radius:3px;margin-right:10px;vertical-align:middle;"; block.appendChild(img); }
    const url = URL.createObjectURL(clip.videoBlob);
    const a = document.createElement("a"); a.href = url; a.download = `intruder-${Date.now()}-${i}.webm`; a.textContent = "⬇ Download Video";
    a.style.cssText = "color:var(--red);font-family:var(--mono);font-size:0.75rem;text-decoration:underline;cursor:pointer;vertical-align:middle;";
    block.appendChild(a); $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
  });
  speak(`Displaying ${state.intruderClips.length} intruder clip(s), ${state.userTitle}.`, () => mic.resume());
}
function startCameraBuffer(stream) {
  const mime = getSupportedMime();
  try {
    const rec = new MediaRecorder(stream, mime ? { mimeType:mime } : {}); state.cameraRecorder = rec;
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      const now = Date.now(); state.cameraClipChunks.push(e.data); state.cameraClipTimestamps.push(now);
      const cutoff = now - 65000;
      while (state.cameraClipTimestamps[0] < cutoff) { state.cameraClipChunks.shift(); state.cameraClipTimestamps.shift(); }
    };
    rec.start(1000);
  } catch {}
}

// ── MEMORY ──
async function loadMemoriesForPrompt() {
  try { const res = await fetch(`/api/memory/${encodeURIComponent(state.user)}`); const data = await res.json(); return (data.memories || []).map(m => m.fact); }
  catch { return []; }
}

// ── SCREEN RECORD ──
async function requestScreenRecord() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:{ frameRate:30 }, audio:true });
    state.screenStream = stream; startRollingBuffer(stream);
    $("clip-indicator")?.classList.remove("hidden");
    addMsg("system","Screen sharing active — I can read your screen.");
  } catch { addMsg("system","Screen sharing declined — screen reading unavailable."); }
}
function startRollingBuffer(stream) {
  const mime = getSupportedMime();
  const rec  = new MediaRecorder(stream, mime ? { mimeType:mime } : {});
  state.mediaRecorder = rec;
  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    const now = Date.now(); state.clipChunks.push(e.data); state.clipTimestamps.push(now);
    const cutoff = now - 65000;
    while (state.clipTimestamps[0] < cutoff) { state.clipChunks.shift(); state.clipTimestamps.shift(); }
  };
  rec.start(1000);
}
function getSupportedMime() {
  return ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"].find(t => MediaRecorder.isTypeSupported(t)) || "";
}
function stopScreenRecord() {
  if (state.mediaRecorder?.state !== "inactive") state.mediaRecorder?.stop();
  state.screenStream?.getTracks().forEach(t => t.stop());
  state.mediaRecorder = null; state.screenStream = null; state.clipChunks = []; state.clipTimestamps = [];
  $("clip-indicator")?.classList.add("hidden");
}

// ── LOGOUT ──
function handleLogout() {
  mic.suspend(); stopSpeaking();
  if (state.faceCheckInterval) clearInterval(state.faceCheckInterval);
  for (const t of state.activeTimers) clearTimeout(t.id);
  state.activeTimers = []; $("timer-badge-el")?.classList.add("hidden");
  speak(`Goodbye, ${state.userTitle}. Initiating shutdown.`, () => {
    state.phase = "idle"; state.user = null; state.userTitle = null;
    state.sessionId = crypto.randomUUID(); state.awayMode = false; state.intruderActive = false;
    $("transcript").innerHTML = ""; $("main-screen").classList.remove("active"); $("auth-screen").classList.add("active");
    $("auth-status").innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type password`;
    setOrb("idle"); stopScreenRecord(); startAuthListening();
  });
}

// ── TRANSCRIPT ──
function addMsg(type, text) {
  const labels = { user:"YOU", jarvis:"J.A.R.V.I.S", system:"SYSTEM" };
  const wrap   = document.createElement("div"); wrap.className = `msg ${type}`;
  wrap.innerHTML = `<div class="msg-label">${labels[type] || type}</div><div class="msg-text">${text}</div>`;
  $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
// ── BOOT ──
// ═══════════════════════════════════════════════════════════════
window.addEventListener("load", async () => {
  setTimeout(() => {
    const w = new SpeechSynthesisUtterance(" "); w.volume = 0;
    speechSynthesis.speak(w); speechSynthesis.getVoices();
  }, 500);
  let profile = loadProfile();
  if (!profile) { profile = await restoreProfileFromBackend(); if (profile) saveProfileLocal(profile); }
  if (!profile) showSetup(); else showAuthScreen();
});
