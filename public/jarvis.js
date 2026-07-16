// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Client Brain v4.3
// Auth v2: unified Login + Create Account screen
// Fixed: face recognition threshold 0.55 → 0.72
// Added: intruder detection enable/disable voice command
// ═══════════════════════════════════════════════════════════════

// ── TIMEZONE HELPER ──
// The server's clock is whatever timezone IT runs in (often UTC on a
// host like Render), which is NOT necessarily your timezone. Every
// request that needs to know "what time is it for the user" should
// send this along so JARVIS reasons about YOUR local time.
function getUserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

// ── STATE ──
const state = window.state = {
  phase: "idle",
  muted: false,          // true after "mute"/"jarvis mute" — speak() becomes a silent no-op
  outputMode: "phone",   // "phone" = normal browser TTS, "home" = cast via Piper/Google Home
  user: null,
  userTitle: null,
  sessionId: crypto.randomUUID(),
  lastJarvisQuestion: null,   // tracks what JARVIS last asked so "yes/no" replies have context
  pendingBuildConfirm: false, // true while Build Mode is waiting on a "connect these parts?" answer
  pendingBriefingOffer: false, // true while waiting on a "want the daily briefing?" yes/no reply
  synth: window.speechSynthesis,
  isListening: false,
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
  // ── Face recognition ──
  faceDescriptors: null,
  faceEnrolled: false,
  faceEnrollPending: false,
  intruderDetectionEnabled: true,
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
  pendingAttachments: [], // files staged via the 📎 button, cleared on send
  simpleChatMode: false,  // true while the plain text "Simple Chat Mode" overlay is showing
  selectedCameraId: null,
  availableCameras: [],
  tesseractWorker: null,
  tesseractReady: false,
  activeTimers: [],
  memories: [],
};

// ═══════════════════════════════════════════════════════════════
// ── NOTIFICATION SYSTEM ──
// ═══════════════════════════════════════════════════════════════
const notif = {
  perms: "default",
  cfg: { intruder: true, away: true, return: true, system: false },
  _ctx: null,

  async init() {
    if (typeof Notification === "undefined") { this.perms = "unsupported"; updateNotifPermDisplay(); return; }
    this.perms = Notification.permission;
    try { this._ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {}
    if (this.perms === "default") {
      try { this.perms = await Notification.requestPermission(); } catch (e) {}
    }
    updateNotifPermDisplay();
  },

  async requestPerm() {
    if (typeof Notification === "undefined") { this.perms = "unsupported"; updateNotifPermDisplay(); return false; }
    try { this.perms = await Notification.requestPermission(); } catch (e) { this.perms = "unsupported"; }
    updateNotifPermDisplay();
    return this.perms === "granted";
  },

  push(title, body, tag, requireInteraction = false) {
    if (typeof Notification === "undefined" || this.perms !== "granted") return null;
    const n = new Notification(title, { body, tag, icon: "/favicon.ico", requireInteraction });
    n.onclick = () => { window.focus(); n.close(); };
    return n;
  },

  tone(type) {
    if (!this._ctx) return;
    const ac = this._ctx;
    if (ac.state === "suspended") ac.resume();
    const now = ac.currentTime;
    const g = ac.createGain(); g.connect(ac.destination);
    const o = ac.createOscillator(); o.connect(g);
    switch (type) {
      case "intruder":
        o.type = "square";
        o.frequency.setValueAtTime(880, now); o.frequency.setValueAtTime(440, now + 0.15);
        o.frequency.setValueAtTime(880, now + 0.30); o.frequency.setValueAtTime(440, now + 0.45);
        g.gain.setValueAtTime(0.35, now); g.gain.linearRampToValueAtTime(0, now + 0.65);
        o.start(now); o.stop(now + 0.65); break;
      case "away":
        o.type = "sine";
        o.frequency.setValueAtTime(523, now); o.frequency.linearRampToValueAtTime(392, now + 0.45);
        g.gain.setValueAtTime(0.15, now); g.gain.linearRampToValueAtTime(0, now + 0.55);
        o.start(now); o.stop(now + 0.55); break;
      case "return":
        o.type = "sine";
        o.frequency.setValueAtTime(392, now); o.frequency.linearRampToValueAtTime(523, now + 0.18);
        o.frequency.linearRampToValueAtTime(659, now + 0.38);
        g.gain.setValueAtTime(0.15, now); g.gain.linearRampToValueAtTime(0, now + 0.55);
        o.start(now); o.stop(now + 0.55); break;
      case "timer":
        o.type = "sine";
        o.frequency.setValueAtTime(659, now); o.frequency.setValueAtTime(784, now + 0.12);
        o.frequency.setValueAtTime(659, now + 0.24); o.frequency.setValueAtTime(784, now + 0.36);
        g.gain.setValueAtTime(0.2, now); g.gain.linearRampToValueAtTime(0, now + 0.55);
        o.start(now); o.stop(now + 0.55); break;
      case "system":
        o.type = "sine"; o.frequency.setValueAtTime(880, now);
        g.gain.setValueAtTime(0.07, now); g.gain.linearRampToValueAtTime(0, now + 0.12);
        o.start(now); o.stop(now + 0.15); break;
      default: o.start(now); o.stop(now + 0.01);
    }
  },

  intruder(T = "Sir") {
    if (!this.cfg.intruder) return;
    this.push("⚠ J.A.R.V.I.S — INTRUDER ALERT", `Unknown face detected, ${T}. Recording has started.`, "intruder", true);
    this.tone("intruder");
  },
  away(T = "Sir") {
    if (!this.cfg.away) return;
    this.push("J.A.R.V.I.S — Away mode active", `No face detected. Monitoring active, ${T}.`, "away");
    this.tone("away");
  },
  userReturn(T = "Sir") {
    if (!this.cfg.return) return;
    this.push("J.A.R.V.I.S — Welcome back", `${T} detected. Away mode deactivated.`, "user-return");
    this.tone("return");
  },
  system(msg) {
    if (!this.cfg.system) return;
    this.push("J.A.R.V.I.S", msg, "system-event");
    this.tone("system");
  },
};

function updateNotifPermDisplay() {
  const el = $("notif-perm-status"), btn = $("notif-perm-btn");
  if (!el) return;
  const p = notif.perms;
  if (p === "granted") { el.textContent = "● GRANTED"; el.className = "notif-perm-status granted"; if (btn) btn.style.display = "none"; }
  else if (p === "denied") { el.textContent = "● DENIED — enable in browser settings"; el.className = "notif-perm-status denied"; if (btn) btn.style.display = "none"; }
  else { el.textContent = "● PERMISSION NOT YET GRANTED"; el.className = "notif-perm-status pending"; if (btn) btn.style.display = ""; }
}

// ── MOOD ENGINE ──
function updateMood(delta) {
  state.moodScore = Math.max(-100, Math.min(100, state.moodScore + delta));
  const prev = state.mood;
  if      (state.moodScore >= 70)  state.mood = "excited";
  else if (state.moodScore >= 30)  state.mood = "pleased";
  else if (state.moodScore >= 10)  state.mood = "curious";
  else if (state.moodScore >= -20) state.mood = "neutral";
  else if (state.moodScore >= -50) state.mood = "concerned";
  else if (state.moodScore >= -80) state.mood = "bored";
  else                              state.mood = "tired";
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

// ── PROFILE — server-first, localStorage fallback ──
function loadProfile() {
  try { return JSON.parse(localStorage.getItem("jarvis_profile")) || null; }
  catch { return null; }
}
function saveProfileLocal(p) { localStorage.setItem("jarvis_profile", JSON.stringify(p)); }

async function saveProfileRemote(p) {
  try {
    await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
  } catch (e) { console.warn("[JARVIS] Could not save profile:", e); }
}

async function loadServerProfiles() {
  try {
    const res = await fetch("/api/profiles");
    const data = await res.json();
    return data.profiles || [];
  } catch { return []; }
}

const $ = id => document.getElementById(id);

// ── SHARED AUTH-SCREEN CAMERA HELPER ──
// Login and account-creation both need a live camera feed *before* the
// user is signed in (state.cameraStream doesn't exist yet at that point),
// so this opens its own short-lived stream and attaches it to whichever
// <video> element is passed in.
let _authStream = null;
async function getAuthCameraStream(videoEl) {
  if (!_authStream) {
    _authStream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 480 }, audio: false });
  }
  if (videoEl) { videoEl.srcObject = _authStream; await videoEl.play().catch(() => {}); }
  return _authStream;
}
function stopAuthCameraStream() {
  if (_authStream) { _authStream.getTracks().forEach(t => t.stop()); _authStream = null; }
}

// ═══════════════════════════════════════════════════════════════
// ── TESSERACT OCR ──
// ═══════════════════════════════════════════════════════════════
async function initTesseract() {
  try {
    if (!window.Tesseract) await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
    state.tesseractWorker = await Tesseract.createWorker("eng", 1, { logger: () => {} });
    state.tesseractReady = true;
    addMsg("system", "OCR engine loaded — screen reading available.");
  } catch (e) { addMsg("system", "OCR engine unavailable — screen reading limited."); }
}

async function ocrScreenFrame() {
  if (!state.screenStream) return null;
  const track = state.screenStream.getVideoTracks()[0]; if (!track) return null;
  let imageDataUrl;
  try {
    const capture = new ImageCapture(track);
    const bitmap  = await capture.grabFrame();
    const canvas  = document.createElement("canvas");
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    imageDataUrl = canvas.toDataURL("image/png");
  } catch {
    const video = document.createElement("video");
    video.srcObject = new MediaStream([track]);
    await new Promise(r => { video.onloadedmetadata = r; });
    video.play(); await delay(200);
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
// ── VOICE ENGINE — fixed browser voice (English - Australia - William)
// ═══════════════════════════════════════════════════════════════

// Always use this one voice. No fallback list, no server "Jarvis voice"
// lookup — this stops the assistant from switching voices mid-use.
const FIXED_VOICE_LANG = "en-AU";
const FIXED_VOICE_NAME = "William";

function pickVoice() {
  const voices = state.synth.getVoices(); if (!voices.length) return null;
  return voices.find(v => v.lang === FIXED_VOICE_LANG && v.name.includes(FIXED_VOICE_NAME))
      || voices.find(v => v.name.includes(FIXED_VOICE_NAME))
      || null;
}
window.speechSynthesis.onvoiceschanged = () => {};

// ── SERVER VOICE STATE ──────────────────────────────────────────
// Polls /api/tts/status so speak() knows when the cloned voice backend
// (Hugging Face Space, with an ElevenLabs fallback) is actually ready.
// Until then, everything speaks with the fixed browser voice above.
let _currentAudio = null;
let _ttsReady     = false;

async function checkTTSReady() {
  try {
    const res  = await fetch("/api/tts/status");
    const data = await res.json();
    _ttsReady  = data.ready;
    if (!_ttsReady) setTimeout(checkTTSReady, 3000);
    else console.log("[JARVIS] JARVIS voice model ready ✓");
  } catch {
    setTimeout(checkTTSReady, 5000);
  }
}
checkTTSReady();

// ── HOME TALK BADGE ───────────────────────────────────────────
function showHomeTalkBadge(device) {
  const badge = $("home-talk-badge");
  if (!badge) return;
  badge.textContent = `🏠 HOME TALK — ${(device || "speaker").toUpperCase()}`;
  badge.classList.remove("hidden");
}
function hideHomeTalkBadge() {
  const badge = $("home-talk-badge");
  if (badge) badge.classList.add("hidden");
}
async function syncHomeTalkBadge() {
  try {
    const res  = await fetch("/api/home-talk/status");
    const data = await res.json();
    state.outputMode = data.outputMode || "phone";
    if (data.outputMode === "home") showHomeTalkBadge(data.device);
    else hideHomeTalkBadge();
  } catch { /* badge just won't show until the next successful chat turn */ }
}
syncHomeTalkBadge();

// ── MAIN SPEAK FUNCTION ───────────────────────────────────────
// Phone/browser mode always uses the instant built-in browser voice —
// the cloned voice on free CPU hardware is too slow (10-40s+ per reply)
// to be usable for normal back-and-forth conversation. Only Home Talk
// (casting to a Google Home/Nest speaker) still uses the server voice,
// since that's the only place it was ever actually needed.
// ── VOLUME BOOST for the cloned TTS voice ──────────────────────
// A plain <audio> element is capped at its natural recording volume
// (1.0 is already "as loud as the file"), so if the cloned voice
// still sounds a little quiet at that cap, a Web Audio gain node lets
// us push it genuinely louder rather than just maxing out volume=1.
let _ttsAudioCtx = null;
const TTS_VOLUME_BOOST = 3.0; // >1 = louder than the source recording. Raise/lower to taste.
function playBoostedAudio(audioEl) {
  try {
    if (!_ttsAudioCtx) _ttsAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (_ttsAudioCtx.state === "suspended") _ttsAudioCtx.resume();
    const source = _ttsAudioCtx.createMediaElementSource(audioEl);
    const gain   = _ttsAudioCtx.createGain();
    gain.gain.value = TTS_VOLUME_BOOST;
    source.connect(gain).connect(_ttsAudioCtx.destination);
  } catch (e) {
    // Web Audio unavailable/blocked for some reason — the element still
    // plays at its normal (uncapped-by-us) volume either way.
    console.warn("[JARVIS] TTS volume boost unavailable, playing at normal volume:", e);
  }
}

// Generation token: every speak() call bumps this. Any older, still
// in-flight speak() request (its fetch hasn't resolved yet, etc.)
// checks this before actually producing sound. If a newer request has
// since come in, the stale one silently drops itself instead of
// playing over — this is what stops two voices ever overlapping and
// guarantees the *latest* thing said is always what's heard.
let _speakGen = 0;

async function speak(text, onEnd) {
  if (!text) { if (onEnd) onEnd(); return; }
  if (state.muted) { if (onEnd) onEnd(); return; }

  const myGen = ++_speakGen;
  const isCurrent = () => myGen === _speakGen;

  // Stop anything currently playing
  state.synth.cancel();
  if (_currentAudio) { _currentAudio.pause(); _currentAudio = null; }

  setOrb("speaking");

  // Home Talk always goes through the server (gTTS fallback lives there).
  // Phone/browser mode only goes through the server if a fast provider
  // (Camb.ai, or a voice-clone Space) has already reported ready via
  // /api/tts/status — otherwise skip straight to the instant browser
  // voice instead of waiting on a slow/unconfigured backend.
  if (state.outputMode !== "home" && !_ttsReady) {
    return _speakBrowser(text, onEnd, myGen);
  }

  // ── Cloned-voice TTS / Home Talk round-trip ─────────────────
  try {
    const res = await fetch("/api/tts", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ text }),
      // Chatterbox on free CPU hardware genuinely takes a while to
      // generate speech (not just a cold-start issue) — give it real
      // room to finish rather than bailing to the browser voice early.
      signal:  AbortSignal.timeout(60000),
    });

    // A newer speak() call arrived while we were waiting on the network —
    // this request is stale, so let it die quietly instead of talking
    // over whatever is now playing.
    if (!isCurrent()) { if (onEnd) onEnd(); return; }

    // 503 = Piper model not loaded. If we're in Home Talk mode the server
    // will handle TTS via gTTS — only fall back to browser on phone mode.
    if (res.status === 503) {
      const data = await res.json().catch(() => ({}));
      // If castTo is set the server already handled it via Home Talk
      if (data.castTo) return;
      if (!isCurrent()) { if (onEnd) onEnd(); return; }
      _ttsReady = false;
      return _speakBrowser(text, onEnd, myGen);
    }

    if (!res.ok) throw new Error(`TTS ${res.status}`);

    const contentType = res.headers.get("Content-Type") || "";

    // ── Home Talk is on: audio is already playing on the Google Home,
    //    not here, so there's nothing to play locally. ──
    if (contentType.includes("application/json")) {
      const data = await res.json();
      if (!isCurrent()) { if (onEnd) onEnd(); return; }
      if (data.ok) {
        setOrb("speaking");
        showHomeTalkBadge(data.castTo);
        const estimatedMs = Math.max(1500, text.length * 65);
        setTimeout(() => { if (isCurrent()) setOrb("idle"); if (onEnd) onEnd(); }, estimatedMs);
      } else {
        setOrb("idle");
        if (onEnd) onEnd();
      }
      return;
    }

    const blob = await res.blob();

    // Check again — decoding/downloading the blob takes time too.
    if (!isCurrent()) { if (onEnd) onEnd(); return; }

    const url   = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.volume = 1;
    _currentAudio = audio;
    playBoostedAudio(audio);

    let started = false; // set once real playback begins

    const cleanup = () => {
      URL.revokeObjectURL(url);
      if (_currentAudio === audio) _currentAudio = null;
      if (isCurrent()) setOrb("idle");
      if (onEnd) onEnd();
    };

    audio.onplaying = () => { started = true; };
    audio.onended = cleanup;
    // Some browsers fire a spurious "error" event mid-playback even
    // though audio is already sounding — only fall back to the browser
    // voice if playback never actually started, otherwise we'd get both
    // voices talking over each other.
    audio.onerror = () => {
      cleanup();
      if (!started && isCurrent()) _speakBrowser(text, onEnd, myGen);
    };

    if (!isCurrent()) { URL.revokeObjectURL(url); if (onEnd) onEnd(); return; }
    await audio.play();
    started = true; // play() resolved — treat as started even if the
                     // "playing" event hasn't fired yet

  } catch (e) {
    // Server unreachable or TTS not configured — fall back to browser voice.
    // (This only runs if we never even got to audio.play(), so there's no
    // risk of double voices here.)
    if (!isCurrent()) { if (onEnd) onEnd(); return; }
    console.warn("[JARVIS] Camb TTS failed, using browser voice:", e.message);
    _speakBrowser(text, onEnd, myGen);
  }
}

// ── BROWSER FALLBACK ──────────────────────────────────────────
function _speakBrowser(text, onEnd, myGen) {
  // If a generation was supplied and a newer speak() has since started,
  // don't speak at all — this is what makes "latest wins" hold.
  if (typeof myGen === "number" && myGen !== _speakGen) { if (onEnd) onEnd(); return; }

  const utter  = new SpeechSynthesisUtterance(text);
  utter.rate   = 0.93;
  utter.pitch  = (state.userTitle === "Sir") ? 0.75 : 0.8;
  utter.volume = 1;
  const trySetVoice = () => { const v = pickVoice(); if (v) utter.voice = v; };
  trySetVoice();
  if (!utter.voice) setTimeout(trySetVoice, 150);
  const safetyMs = Math.max(3500, text.length * 75);
  let finished = false;
  const safetyTimer = setTimeout(() => { if (!finished) { finished = true; setOrb("idle"); if (onEnd) onEnd(); } }, safetyMs);
  const done = () => { if (finished) return; finished = true; clearTimeout(safetyTimer); setOrb("idle"); if (onEnd) onEnd(); };
  utter.onstart = () => {
    // Belt-and-braces: if something newer started speaking between
    // queueing this utterance and it actually starting, cut it off.
    if (typeof myGen === "number" && myGen !== _speakGen) { state.synth.cancel(); return; }
    setOrb("speaking");
  };
  utter.onend   = done;
  utter.onerror = done;
  state.synth.speak(utter);
}

// ── ORB STATE ─────────────────────────────────────────────────
function setOrb(s) {
  const orb = $("orb"); if (!orb) return;
  orb.className = "orb" + (s !== "idle" ? " " + s : "");
  const cfOrb = $("cf-orb");
  if (cfOrb) cfOrb.className = "orb" + (s !== "idle" ? " " + s : "");
  const labels = { idle: "STANDBY", listening: "LISTENING", thinking: "PROCESSING", speaking: "SPEAKING" };
  const st = $("status-text"); if (st) st.textContent = labels[s] || "STANDBY";
}
// ═══════════════════════════════════════════════════════════════
// ── CAMERA ──
// ═══════════════════════════════════════════════════════════════
async function enumerateCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.availableCameras = devices.filter(d => d.kind === "videoinput");
    buildCameraSelector();
  } catch (e) {}
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
  sel.style.cssText = "background:rgba(0,200,255,0.06);border:1px solid var(--blue-dim);color:var(--blue);font-family:var(--mono);font-size:0.58rem;letter-spacing:0.1em;padding:3px 6px;border-radius:3px;outline:none;cursor:pointer;width:120px;";
  state.availableCameras.forEach((cam, i) => {
    const opt = document.createElement("option");
    opt.value = cam.deviceId; opt.textContent = cam.label || `Camera ${i + 1}`;
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
  addMsg("system", "Switching camera…");
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width: 640, height: 480, frameRate: 15 }, audio: false
    });
    state.cameraStream = stream; state.selectedCameraId = deviceId;
    const vid = $("camera-feed"); if (vid) { vid.srcObject = stream; vid.play(); }
    startCameraBuffer(stream);
    state.faceDescriptors = null;
    state.faceEnrolled = false;
    await enrollUserFace();
    const reply = `Camera switched, ${state.userTitle}. Visual sensors updated.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); updateMood(2);
  } catch {
    const reply = `Camera switch failed, ${state.userTitle}. The device may be in use.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume());
  }
}

// ═══════════════════════════════════════════════════════════════
// ── MIC ENGINE ──
// ═══════════════════════════════════════════════════════════════
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = {
  rec: null, active: false, retryCount: 0, maxRetries: 999, retryDelay: 150,
  retryTimer: null, onResult: null, onInterim: null, continuous: true,
  suspended: false, _killing: false, permGranted: false,

  async requestPerm() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true, channelCount: 1, sampleRate: 16000 } });
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
    if (!SR) return;
    if (this.suspended) return;
    if (this.active) { this._killing = true; this._kill(); this._killing = false; }
    const r = new SR();
    r.lang = "en-US"; r.continuous = true; r.interimResults = true; r.maxAlternatives = 5;
    this.rec = r; this.active = true; state.isListening = true;
    setOrb(state.phase === "chatting" ? "listening" : "idle");

    r.onresult = (e) => {
      this.retryCount = 0;
      const result = e.results[e.results.length - 1];
      if (result.isFinal) {
        let bestText = result[0].transcript.trim(), bestConf = result[0].confidence || 0;
        for (let i = 1; i < result.length; i++) {
          if ((result[i].confidence || 0) > bestConf) { bestConf = result[i].confidence; bestText = result[i].transcript.trim(); }
        }
        if (!bestText) return;
        updateLiveHearing(""); updateMicDebug(`Mic: "${bestText}" (${(bestConf * 100).toFixed(0)}%)`);
        if (this.onResult) this.onResult(bestText);
      } else if (result[0]) {
        const interim = result[0].transcript.trim();
        updateLiveHearing(interim); updateMicDebug("Mic: " + interim + "…");
        if (this.onInterim) this.onInterim(interim);
      }
    };

    r.onerror = (e) => {
      this.active = false; state.isListening = false; updateLiveHearing("");
      switch (e.error) {
        case "not-allowed": case "service-not-allowed":
          this.permGranted = false; updateMicDebug("Mic: blocked — check permissions"); this.suspended = true; return;
        // "no-speech" fires constantly in continuous mode and is not a real error —
        // relaunch immediately with NO backoff so we never leave a dead gap that
        // swallows the start of what the person is saying.
        case "no-speech": updateMicDebug("Mic: listening…"); setTimeout(() => this._launch(), 0); return;
        case "audio-capture": this._scheduleRetry(800); return;
        case "network": this._scheduleRetry(1500); return;
        case "aborted": if (!this.suspended && !this._killing) setTimeout(() => this._launch(), 0); return;
        default: this._scheduleRetry(500);
      }
    };

    r.onend = () => {
      this.active = false; state.isListening = false;
      // Relaunch instantly on normal end (Chrome ends the session periodically
      // even mid-conversation) instead of routing through the backoff timer.
      if (!this.suspended) setTimeout(() => this._launch(), 0);
    };

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
  const micBtn = $("tb-btn-mic");
  if (micBtn) micBtn.classList.toggle("live", mic.active && !mic.suspended);
}, 2000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !mic.suspended && (state.phase === "idle" || state.phase === "chatting")) {
    if (!mic.active) mic._launch();
  }
});

function updateMicDebug(msg) { const el = $("mic-debug"); if (el) el.textContent = msg; }

// ── MUTE INDICATOR ──
// Small self-styled badge — no CSS file edits needed. Voice recognition
// (listening) keeps working while muted; only Jarvis's spoken replies
// (speak()) are silenced. Say "unmute" / "jarvis unmute" to bring the
// voice back.
function updateMuteUI(isMuted) {
  let badge = $("jarvis-mute-badge");
  const micBtn = $("tb-btn-mic");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "jarvis-mute-badge";
    badge.textContent = "🔇 MUTED";
    Object.assign(badge.style, {
      position: "fixed", bottom: "84px", left: "50%", transform: "translateX(-50%)",
      background: "rgba(200,40,40,0.85)", color: "#fff", padding: "4px 12px",
      borderRadius: "999px", fontSize: "12px", fontWeight: "600", letterSpacing: "0.04em",
      zIndex: 9999, pointerEvents: "none", display: "none", fontFamily: "inherit",
    });
    document.body.appendChild(badge);
  }
  badge.style.display = isMuted ? "block" : "none";
  if (micBtn) micBtn.classList.toggle("muted", !!isMuted);
}
function updateLiveHearing(text) {
  const el = $("live-hearing");
  if (el) {
    if (!text) { el.classList.add("empty"); el.querySelector(".live-hearing-text").textContent = "listening…"; }
    else { el.classList.remove("empty"); el.querySelector(".live-hearing-text").textContent = text; }
  }
  const cfText = $("cf-live-hearing");
  if (cfText) cfText.textContent = text || "listening…";
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
// ── AUTH v2 — Login + Create Account in one screen ─────────────
// ═══════════════════════════════════════════════════════════════

// ── INTERNAL AUTH VARS ──
let _authMode        = "login";   // "login" | "create"
let _selectedUser    = null;      // name key of tile-selected account
let _voiceSamples    = [];        // collected voice alias strings
let _voiceSamplesDone = 0;

// ── FEEDBACK HELPER ──
function showAuthFeedback(msg, type = "error") {
  const el = $("auth-feedback");
  if (!el) return;
  el.textContent = msg;
  el.className   = `auth-feedback ${type}`;
  el.classList.remove("hidden");
  if (type !== "error") setTimeout(() => el.classList.add("hidden"), 3500);
}
function hideAuthFeedback() {
  const el = $("auth-feedback");
  if (el) el.classList.add("hidden");
}

// ── MODE SWITCH ──
function switchAuthMode(mode) {
  _authMode = mode;
  hideAuthFeedback();

  const loginBtn    = $("mode-login-btn");
  const createBtn   = $("mode-create-btn");
  const loginPanel  = $("auth-login-panel");
  const createPanel = $("auth-create-panel");
  const savedWrap   = $("saved-accounts-wrap");
  const statusEl    = $("auth-status");

  if (mode === "login") {
    loginBtn?.classList.add("active");
    createBtn?.classList.remove("active");
    loginPanel?.classList.remove("hidden");
    createPanel?.classList.add("hidden");
    if (savedWrap)  savedWrap.style.display = "";
    if (statusEl)   statusEl.style.display  = "";
    attemptFaceLogin();
  } else {
    createBtn?.classList.add("active");
    loginBtn?.classList.remove("active");
    createPanel?.classList.remove("hidden");
    loginPanel?.classList.add("hidden");
    if (savedWrap)  savedWrap.style.display = "none";
    if (statusEl)   statusEl.style.display  = "none";
    // reset voice sample state
    _voiceSamples     = [];
    _voiceSamplesDone = 0;
    updateVoiceSampleUI();
    getAuthCameraStream($("create-face-video")).catch(() => {
      showAuthFeedback("Camera access is needed to set up Face ID.");
    });
  }
}

// ── RENDER SAVED ACCOUNT TILES ──
function renderSavedAccounts(profiles) {
  const wrap = $("saved-accounts-wrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!profiles || profiles.length === 0) return;

  const lastUsed = localStorage.getItem("jarvis_name_hint") || "";

  profiles.forEach(p => {
    const tile = document.createElement("button");
    tile.className = "account-tile";
    if (p.name.toLowerCase() === lastUsed) {
      tile.classList.add("selected");
      _selectedUser = p.name.toLowerCase();
    }

    tile.innerHTML = `
      <span class="tile-name">${p.name.toUpperCase()}</span>
      <span class="tile-title">${p.title || ""}</span>
    `;
    tile.addEventListener("click", () => {
      wrap.querySelectorAll(".account-tile").forEach(t => t.classList.remove("selected"));
      tile.classList.add("selected");
      _selectedUser = p.name.toLowerCase();
    });
    wrap.appendChild(tile);
  });
}

// ═══════════════════════════════════════════════════════════════
// ── LOCK SCREEN — auto identity check, before login/create shows ──
// Boots straight into an orb-style lock screen (no buttons yet).
// It checks whether ANY account exists on the server:
//   • no accounts        → hands off to the normal screen in
//                           "create account" mode
//   • accounts exist      → opens the camera immediately and scans
//                           for a face. A match signs the person
//                           straight in (skips the login screen
//                           entirely). No match after a short
//                           window falls back to the normal login
//                           screen so they can rescan or pick a
//                           saved profile manually.
// ═══════════════════════════════════════════════════════════════
let _lockClockTimer = null;
function startLockClock() {
  const el = $("lock-clock");
  if (!el) return;
  stopLockClock();
  const tick = () => {
    el.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  };
  tick();
  _lockClockTimer = setInterval(tick, 1000);
}
function stopLockClock() {
  if (_lockClockTimer) { clearInterval(_lockClockTimer); _lockClockTimer = null; }
}

// Rotating dot-sphere behind the video feed — same particle-globe
// factory the Daily Briefing screen's globe is built from, just a
// slightly different tint so the lock screen reads as its own state.
let _lockGlobe = null;
function startLockGlobe() {
  if (!window.createParticleGlobe) return;
  if (!_lockGlobe) _lockGlobe = window.createParticleGlobe("lock-globe-canvas", { count: 170, speed: 0.0026, color: "0,200,255" });
  _lockGlobe.start();
}
function stopLockGlobe() { _lockGlobe?.stop(); }

function setLockStatus(main, sub) {
  const s = $("lock-status"), sb = $("lock-substatus");
  if (s && main !== undefined) s.textContent = main;
  if (sb && sub !== undefined) sb.textContent = sub;
}

function exitLockScreen() {
  stopLockClock();
  stopLockGlobe();
  $("lock-screen")?.classList.remove("active");
  $("lock-face-video")?.classList.remove("scanning");
  $("lock-scan-sweep")?.classList.remove("active");
}

async function runLockScreen() {
  const lock = $("lock-screen");
  if (!lock) { showAuthScreen(); return; } // fallback if markup is missing

  $("auth-screen")?.classList.remove("active");
  $("main-screen")?.classList.remove("active");
  lock.classList.add("active");
  startLockClock();
  startLockGlobe();
  setLockStatus("CHECKING FOR ACCOUNT…", "");

  const profiles = await loadServerProfiles();
  await delay(700);

  if (!profiles.length) {
    setLockStatus("NO ACCOUNT FOUND", "Setting up a new profile…");
    await delay(900);
    exitLockScreen();
    showAuthScreen(); // defaults to "create" mode when there are no profiles
    return;
  }

  setLockStatus("SCANNING FACE…", "Look at the camera to sign in");
  const video = $("lock-face-video");
  const sweep = $("lock-scan-sweep");
  video?.classList.add("scanning");
  sweep?.classList.add("active");

  let ok;
  try {
    await getAuthCameraStream(video);
    ok = await ensureFaceApiLoaded();
  } catch (e) {
    setLockStatus("CAMERA UNAVAILABLE", "Opening manual sign-in…");
    await delay(900);
    exitLockScreen();
    showAuthScreen();
    return;
  }
  if (!ok) {
    setLockStatus("FACE ENGINE UNAVAILABLE", "Opening manual sign-in…");
    await delay(900);
    exitLockScreen();
    showAuthScreen();
    return;
  }

  const MAX_ATTEMPTS = 20; // ~14s scanning window before falling back
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (!video || video.readyState < 2) { await delay(500); continue; }

    try {
      const detection = await faceapi
        .detectSingleFace(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection && detection.descriptor) {
        const descriptor = Array.from(detection.descriptor);
        const res  = await fetch("/api/verify-face", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ descriptor }),
        });
        const data = await res.json();
        if (data.authorized) {
          setLockStatus("FACE RECOGNIZED ✓", `Welcome back, ${data.profile.name}`);
          sweep?.classList.remove("active");
          stopAuthCameraStream();
          stopLockClock();
          stopLockGlobe();
          localStorage.setItem("jarvis_name_hint", data.profile.name.toLowerCase());
          saveProfileLocal(data.profile);
          state.user      = data.profile.name;
          state.userTitle = data.profile.title;
          await delay(500);
          lock.classList.remove("active");
          speak(`Welcome back, ${data.profile.title}.`, launchMain);
          return;
        }
      }
    } catch (e) { /* keep scanning */ }

    setLockStatus(`SCANNING FACE… (${attempt + 1}/${MAX_ATTEMPTS})`);
    await delay(700);
  }

  setLockStatus("FACE NOT RECOGNIZED", "Opening manual sign-in…");
  sweep?.classList.remove("active");
  stopAuthCameraStream();
  await delay(1000);
  exitLockScreen();
  showAuthScreen();
}

// ── SHOW AUTH SCREEN ──
async function showAuthScreen() {
  $("auth-screen")?.classList.add("active");
  $("setup-screen")?.classList.remove("active");
  $("main-screen")?.classList.remove("active");

  await mic.requestPerm();

  const profiles = await loadServerProfiles();
  renderSavedAccounts(profiles);

  // Default to login if profiles exist, create if none
  switchAuthMode(profiles.length > 0 ? "login" : "create");

  startAuthListening();
}
// Alias — old boot code calls showSetup when no profile exists
// but we now send everyone to showAuthScreen which auto-switches to create
function showSetup() { showAuthScreen(); }

// ── FACE LOGIN ──
// Runs automatically when the login screen appears (and again if the
// person taps "SCAN AGAIN"). Opens the camera, watches for a face, sends
// the descriptor to the server, and signs the person in the moment it
// finds a match — no password, no typing.
let _faceLoginRunId = 0;
async function attemptFaceLogin() {
  const runId = ++_faceLoginRunId; // lets a fresh call cancel a stale loop
  const label = $("auth-face-scan-label");
  hideAuthFeedback();
  if (label) label.textContent = "STARTING CAMERA…";

  let ok;
  try {
    await getAuthCameraStream($("auth-face-video"));
    ok = await ensureFaceApiLoaded();
  } catch (e) {
    showAuthFeedback("Camera access is needed for Face ID sign-in.");
    return;
  }
  if (!ok) { showAuthFeedback("Face recognition failed to load — check your connection."); return; }

  const vid = $("auth-face-video");
  if (label) label.textContent = "SCANNING FOR FACE…";

  const MAX_ATTEMPTS = 24; // ~ up to ~24s of scanning before giving up
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (runId !== _faceLoginRunId) return; // a newer scan superseded this one
    if (!vid || vid.readyState < 2) { await delay(500); continue; }

    try {
      const detection = await faceapi
        .detectSingleFace(vid, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection && detection.descriptor) {
        const descriptor = Array.from(detection.descriptor);
        const res  = await fetch("/api/verify-face", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ descriptor }),
        });
        const data = await res.json();
        if (data.authorized) {
          if (label) label.textContent = "FACE RECOGNIZED ✓";
          stopAuthCameraStream();
          localStorage.setItem("jarvis_name_hint", data.profile.name.toLowerCase());
          saveProfileLocal(data.profile);
          state.user      = data.profile.name;
          state.userTitle = data.profile.title;
          speak(`Welcome back, ${data.profile.title}.`, launchMain);
          return;
        }
      }
    } catch (e) { /* keep scanning */ }

    if (label) label.textContent = `SCANNING… (${attempt + 1}/${MAX_ATTEMPTS})`;
    await delay(700);
  }

  if (runId !== _faceLoginRunId) return;
  if (label) label.textContent = "NO MATCH FOUND";
  showAuthFeedback("Couldn't recognize your face. Try again, or create a new account.", "info");
}

// ── VOICE SAMPLE HELPERS ──
function updateVoiceSampleUI() {
  const countEl  = $("create-sample-count");
  const statusEl = $("create-sample-status");
  if (countEl)  countEl.textContent  = `${_voiceSamplesDone} / 3 samples`;
  if (statusEl) statusEl.textContent = _voiceSamplesDone >= 3
    ? "✓ Voice training complete"
    : "Ready to record";
}

function recordVoiceSample() {
  if (_voiceSamplesDone >= 3) return;
  const statusEl = $("create-sample-status");
  const bars     = $("create-record-bars");
  if (statusEl) statusEl.textContent = "Recording… say your name now";
  bars?.classList.remove("hidden");

  const r = new SR();
  r.continuous = false; r.interimResults = false; r.lang = "en-US";
  r.onresult = e => {
    const heard = e.results[0][0].transcript.trim();
    _voiceSamples.push(heard);
    _voiceSamplesDone++;
    bars?.classList.add("hidden");
    updateVoiceSampleUI();
  };
  r.onerror = () => {
    if (statusEl) statusEl.textContent = "Didn't catch that — try again";
    bars?.classList.add("hidden");
  };
  r.onend = () => bars?.classList.add("hidden");
  r.start();
}

function skipVoice() {
  _voiceSamples     = [];
  _voiceSamplesDone = 0;
  const block = $("voice-sample-block");
  if (block) block.style.opacity = "0.4";
}

// ── CREATE ACCOUNT SUBMIT ──
// Instead of a password, this scans the person's face and registers that
// descriptor as their sign-in credential.
async function submitCreateAccount() {
  const name  = ($("create-name")?.value  || "").trim();
  const title = $("create-title")?.value  || "Sir";

  if (!name) { showAuthFeedback("Enter your name."); return; }

  hideAuthFeedback();
  const label = $("auth-face-scan-label");
  showAuthFeedback("Look at the camera — capturing your face…", "info");

  let ok;
  try {
    await getAuthCameraStream($("create-face-video"));
    ok = await ensureFaceApiLoaded();
  } catch (e) {
    showAuthFeedback("Camera access is needed to set up Face ID.");
    return;
  }
  if (!ok) { showAuthFeedback("Face recognition failed to load — check your connection."); return; }

  const vid = $("create-face-video");
  let detection = null;
  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS && !detection; attempt++) {
    if (!vid || vid.readyState < 2) { await delay(500); continue; }
    try {
      detection = await faceapi
        .detectSingleFace(vid, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.35 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
    } catch (e) { /* retry */ }
    if (!detection) await delay(600);
  }

  if (!detection || !detection.descriptor) {
    showAuthFeedback("Couldn't get a clear look at your face — try better lighting and try again.");
    return;
  }

  const faceDescriptor = Array.from(detection.descriptor);
  const profile = { name, title, faceDescriptor, voiceAliases: _voiceSamples };

  try {
    const res  = await fetch("/api/register", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(profile),
    });
    const data = await res.json();
    if (!data.success) throw new Error("Server rejected registration");
  } catch (e) {
    showAuthFeedback("Server error — check that JARVIS is running.");
    return;
  }

  stopAuthCameraStream();
  saveProfileLocal({ name, title, voiceAliases: _voiceSamples });
  localStorage.setItem("jarvis_name_hint", name.toLowerCase());

  showAuthFeedback(`Face ID set up for ${name}. Logging you in…`, "success");
  state.user      = name;
  state.userTitle = title;

  setTimeout(() => {
    speak(`Welcome, ${title}. Face ID is active — I'll recognize you next time.`, launchMain);
  }, 900);
}

// ── VOICE AUTH (wake word "Jarvis log in") ──
function startAuthListening() {
  state.phase = "idle";
  mic.start((text) => {
    if (state.phase !== "idle") return;
    const lower = text.toLowerCase();
    const hasLogin = /\blog\s*in\b|\blogin\b|\bsign\s*in\b|\bopen\b|\bidentify\b|\baccess\b/.test(lower);
    if (hasWakeWord(lower) && hasLogin) startVoiceAuth();
  }, null, true);
}

function startVoiceAuth() {
  state.phase = "awaiting_name";
  mic.suspend();
  const as = $("auth-status"), ap = $("auth-prompt"),
        al = $("auth-listening"), ht = $("heard-text");
  if (as) as.style.display = "none";
  ap?.classList.remove("hidden");
  al?.classList.remove("hidden");
  if (ht) ht.textContent = "Listening…";

  speak("Identify yourself.", () => {
    const r = new SR();
    r.continuous = false; r.interimResults = true; r.lang = "en-US"; r.maxAlternatives = 5;
    r.onresult = e => {
      const result = e.results[0];
      const text   = result[0].transcript.trim();
      if (ht) ht.textContent = text;
      if (result.isFinal) {
        ap?.classList.add("hidden");
        al?.classList.add("hidden");
        if (as) as.style.display = "";
        checkVoiceAuth(text);
      }
    };
    r.onerror = () => {
      if (ht) ht.textContent = "Couldn't hear you — try again.";
      state.phase = "idle";
      setTimeout(() => {
        ap?.classList.add("hidden");
        al?.classList.add("hidden");
        if (as) as.style.display = "";
        startAuthListening();
      }, 1500);
    };
    setOrb("listening");
    r.start();
  });
}

async function checkVoiceAuth(spokenText) {
  const as = $("auth-status");
  if (as) as.textContent = `Heard: "${spokenText}" — verifying…`;
  setOrb("thinking");

  const profile = loadProfile();
  if (profile && matchesUser(spokenText, profile)) {
    state.user = profile.name; state.userTitle = profile.title;
    setOrb("idle");
    speak(`Welcome back, ${profile.title}.`, launchMain);
    return;
  }
  try {
    const res  = await fetch("/api/profiles");
    const data = await res.json();
    for (const p of (data.profiles || [])) {
      if (matchesUser(spokenText, p)) {
        localStorage.setItem("jarvis_name_hint", p.name.toLowerCase());
        state.user = p.name; state.userTitle = p.title;
        setOrb("idle");
        speak(`Welcome back, ${p.title}. Identity confirmed.`, launchMain);
        return;
      }
    }
  } catch {}

  setOrb("idle");
  if (as) as.innerHTML = `<span style="color:var(--red)">Access denied.</span>`;
  speak("Access denied. Identity not recognised.", () => {
    setTimeout(() => {
      if (as) as.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type below`;
      state.phase = "idle";
      startAuthListening();
    }, 1800);
  });
}

// ═══════════════════════════════════════════════════════════════
// ── LAUNCH MAIN ──
// ═══════════════════════════════════════════════════════════════
// ── SETTINGS SYNC — persists toggles (face detection, etc.) to the
// server so they survive page reloads/restarts, on Render too. ──
async function loadServerSettings() {
  try {
    const res = await fetch("/api/settings");
    const settings = await res.json();
    if (typeof settings.faceDetection === "boolean") {
      state.intruderDetectionEnabled = settings.faceDetection;
    }
  } catch (e) {
    console.warn("[SETTINGS] Couldn't load saved settings, using defaults:", e.message);
  }
}
function saveServerSetting(partial) {
  fetch("/api/settings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(partial),
  }).catch((e) => console.warn("[SETTINGS] Couldn't save setting:", e.message));
}

function launchMain() {
  state.phase = "chatting";
  loadServerSettings(); // restore saved toggles (face detection, etc.) — fire-and-forget, applies as soon as it resolves
  $("auth-screen").classList.remove("active");
  $("main-screen").classList.add("active");
  const ud = $("user-display"); if (ud) ud.textContent = `${state.user} / ${state.userTitle}`;
  state.lastInteraction = Date.now(); updateMood(20);

  notif.init().then(() => {
    addMsg("system", notif.perms === "granted"
      ? "Push notifications active."
      : "Push notifications not granted. Say \"notification settings\" to enable.");
  });

  const greetings = [
    `All systems online, ${state.userTitle}. Cognitive engine active. Just talk to me — no commands to memorise.`,
    `Good to have you back, ${state.userTitle}. Full semantic reasoning active — say anything naturally.`,
    `Online and operational, ${state.userTitle}. Ask me anything, tell me to clip something, open a link, set a timer — just say it how you'd say it.`,
  ];
  addMsg("system", greetings[Math.floor(Math.random() * greetings.length)]);

  // Each of these is independent — if one throws (e.g. an API missing on
  // this browser/device), it should not prevent the others from starting.
  const safeInit = (fn, label) => { try { fn(); } catch (e) { console.error(`launchMain: ${label} failed`, e); } };
  safeInit(requestScreenRecord, "requestScreenRecord");
  safeInit(requestCameraAccess, "requestCameraAccess");
  safeInit(setupTypingBox, "setupTypingBox");
  safeInit(startChatListening, "startChatListening");
  safeInit(initTesseract, "initTesseract");
  safeInit(() => CameraObserver.start(), "CameraObserver.start");
  setTimeout(() => checkIntruderClips(), 2000);

  setInterval(syncExtensionStatus, 3000);
  setInterval(pollReminders, 5000);
  setInterval(pollSchedule, 20000);

  setTimeout(() => checkMorningBriefing(), 2500);
}

// ═══════════════════════════════════════════════════════════════
// ── PROACTIVE MORNING BRIEFING ──
// ═══════════════════════════════════════════════════════════════
// Fires on its own every time the app opens — JARVIS never waits to be
// asked "what's the weather / any news / check my email / what's on
// today". Whatever sources are actually configured (weather, news,
// Google calendar + inbox) get checked server-side and combined into
// one message, shown and spoken once per day, unprompted.
async function checkMorningBriefing() {
  if (!state.user) return;
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const res  = await fetch(`/api/proactive/briefing/${encodeURIComponent(state.user)}?tz=${encodeURIComponent(tz)}`);
    const data = await res.json();
    if (!data.available || !data.entry) return;

    const shownKey = `jarvis_briefing_shown_${state.user.toLowerCase()}_${data.entry.date}`;
    if (localStorage.getItem(shownKey)) return; // already announced today
    localStorage.setItem(shownKey, "1");

    addMsg("jarvis", data.entry.headline);
    speak(data.entry.headline);
  } catch { /* silent — this is a bonus, not a critical path */ }
}

// ── WORK-SESSION BREAK NUDGE ──
// Checks in every 20s. Autonomous: if you've been at it over an hour,
// JARVIS has already picked a break suggestion by the time this
// responds — it reports what it did rather than asking permission.
// Links are rendered as clickable text (not force-opened) since a
// background timer has no user gesture to open a tab with anyway.
let _scheduleBusy = false;
async function pollSchedule() {
  if (_scheduleBusy) return;
  _scheduleBusy = true;
  try {
    const tz  = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    const res = await fetch(`/api/schedule/due?tz=${encodeURIComponent(tz)}&sessionId=${encodeURIComponent(state.sessionId)}`);
    const data = await res.json();
    const nudge = data?.nudge;
    if (nudge) {
      const linkHtml = (nudge.links || [])
        .map(l => `<a href="${l.url}" target="_blank" rel="noopener">${l.label}</a>`)
        .join(" &nbsp;·&nbsp; ");
      addMsg("jarvis", linkHtml ? `${nudge.text}<br>${linkHtml}` : nudge.text);
      mic.suspend();
      speak(nudge.text, () => mic.resume());
    }
  } catch {
    // server unreachable — try again next tick
  } finally {
    _scheduleBusy = false;
  }
}

// ── NATIVE REMINDERS / TIMERS POLL ──
// JARVIS's own scheduling engine fires server-side; we just check in
// every few seconds for anything that's come due and speak it once.
let _remindersBusy = false;
async function pollReminders() {
  if (_remindersBusy) return;
  _remindersBusy = true;
  try {
    const res  = await fetch("/api/reminders/due");
    const data = await res.json();
    const due  = data?.due || [];
    if (due.length) {
      // speak() cancels any in-flight utterance, so multiple due items
      // in the same tick get combined into one spoken line rather than
      // stomping on each other.
      due.forEach(item => addMsg("jarvis", item.text));
      const combined = due.map(item => item.text).join(" ");
      mic.suspend();
      speak(combined, () => mic.resume());
    }
  } catch {
    // server unreachable or not yet ready — try again next tick
  } finally {
    _remindersBusy = false;
  }
}

// ── EXTENSION STATUS SYNC ──
function syncExtensionStatus() {
  fetch("/api/extension/status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      phase:     state.phase,
      user:      state.user,
      userTitle: state.userTitle,
      mood:      state.mood,
      moodScore: state.moodScore,
    }),
  }).catch(() => {});
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
    const text = input.value.trim();
    if (!text && state.pendingAttachments.length === 0) return;
    if (state.phase !== "chatting") return;
    input.value = "";
    const attachments = state.pendingAttachments.slice();
    clearAttachments();
    handleChatCommand(text || "(see attached file)", attachments);
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } e.stopPropagation(); });
  input.addEventListener("focus", () => mic.suspend());
  input.addEventListener("blur",  () => { if (state.phase === "chatting") mic.resume(); });

  setupAttachments();

  // Same submit path, wired to the small talk row shown over the
  // fullscreen camera (mic stays live too — this is just for typing).
  const cfInput = $("cf-type-input"), cfBtn = $("cf-type-send");
  if (cfInput && cfBtn) {
    const cfSubmit = () => {
      const text = cfInput.value.trim();
      if (!text || state.phase !== "chatting") return;
      cfInput.value = "";
      handleChatCommand(text);
    };
    cfBtn.addEventListener("click", cfSubmit);
    cfInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); cfSubmit(); } e.stopPropagation(); });
    cfInput.addEventListener("focus", () => mic.suspend());
    cfInput.addEventListener("blur",  () => { if (state.phase === "chatting") mic.resume(); });
  }
}

// ═══════════════════════════════════════════════════════════════
// ── FILE ATTACHMENTS (chat mode file upload, ChatGPT-style) ──
// Click the 📎 button → pick files → they're read client-side and
// staged as chips above the input bar. On send, they ride along with
// the message to /api/chat, where the server folds their text content
// into what the AI sees. Text-ish files (code, txt, md, csv, json…)
// get their full content read; images get a data URL for on-screen
// preview but the current text-only model can't "see" pixels — the
// server tells JARVIS that plainly rather than pretending it can.
// ═══════════════════════════════════════════════════════════════
const ATTACH_MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB per file
const TEXT_EXT_RE = /\.(txt|md|csv|json|js|ts|jsx|tsx|py|log|html|css|xml|yml|yaml|c|cpp|h|java|sh)$/i;

function setupAttachments() {
  const fileInput = $("file-input"), attachBtn = $("attach-btn");
  if (!fileInput || !attachBtn) return;

  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async () => {
    const files = Array.from(fileInput.files || []);
    fileInput.value = ""; // allow re-selecting the same file later
    for (const file of files) await stageAttachment(file);
    renderAttachmentTray();
  });
}

async function stageAttachment(file) {
  if (file.size > ATTACH_MAX_FILE_BYTES) {
    addMsg("system", `"${file.name}" is too large to attach (max 8MB).`);
    return;
  }
  const isImage = file.type.startsWith("image/");
  const isText = isImage ? false : (file.type.startsWith("text/") || TEXT_EXT_RE.test(file.name) || file.type === "application/json");

  const entry = { name: file.name, mimeType: file.type || "application/octet-stream", size: file.size, isImage };

  try {
    if (isImage) {
      entry.dataUrl = await readFileAsDataURL(file);
    } else if (isText) {
      entry.textContent = await readFileAsText(file);
    }
    // Anything else (pdf, docx, etc.) is staged with just its name/type —
    // the server notes it can't extract that format's content yet.
  } catch (e) {
    console.error("[ATTACH] failed to read file:", e);
  }
  state.pendingAttachments.push(entry);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file);
  });
}
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

function renderAttachmentTray() {
  const tray = $("attachment-tray"), attachBtn = $("attach-btn");
  if (!tray) return;
  tray.innerHTML = "";
  state.pendingAttachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.innerHTML = `${a.isImage ? `<img class="ac-thumb" src="${a.dataUrl}"/>` : ""}<span class="ac-name">${a.name}</span><button class="ac-remove" title="Remove">✕</button>`;
    chip.querySelector(".ac-remove").addEventListener("click", () => {
      state.pendingAttachments.splice(i, 1);
      renderAttachmentTray();
    });
    tray.appendChild(chip);
  });
  if (attachBtn) attachBtn.classList.toggle("has-files", state.pendingAttachments.length > 0);
}

function clearAttachments() {
  state.pendingAttachments = [];
  renderAttachmentTray();
}

// ═══════════════════════════════════════════════════════════════
// ── CHAT COMMAND HANDLER ──
// ═══════════════════════════════════════════════════════════════
function handleChatCommand(text, attachments) {
  const lower = text.toLowerCase();
  const prevInteraction = state.lastInteraction;
  state.lastInteraction = Date.now();
  state.interactionCount++;
  updateMood(3);
  CameraObserver.notifyUserMessage();

  const hasWake = hasWakeWord(lower);
  const cleaned = hasWake ? stripWakeWord(text) : text;

  // Use the PREVIOUS lastInteraction timestamp, not the one we just set
  const recentlyActive = (Date.now() - prevInteraction) < 30000;
  if (!hasWake && !recentlyActive && state.interactionCount > 3) {
    updateLiveHearing(""); return;
  }

  if (!cleaned || cleaned.trim().length < 1) {
    const acks = [`Yes, ${state.userTitle}?`, `At your service, ${state.userTitle}.`, `How can I help, ${state.userTitle}?`];
    const ack = acks[Math.floor(Math.random() * acks.length)];
    addMsg("jarvis", ack); speak(ack); return;
  }

  // ── Context injection: if user says "yes/no/sure/ok" after JARVIS asked a question,
  //    automatically inject the question context so the AI understands the reply ──
  const isShortAffirmOrNeg = /^(yes|yeah|yep|sure|ok|okay|no|nope|nah|please|go ahead|do it|confirm|cancel|skip)\.?$/i.test(cleaned.trim());
  if (isShortAffirmOrNeg && state.pendingBuildConfirm) {
    const isYes = /^(yes|yeah|yep|sure|ok|okay|please|go ahead|do it|confirm)\.?$/i.test(cleaned.trim());
    const iframe = $("build-iframe");
    try { iframe?.contentWindow?.postMessage({ type: "BUILD_CONFIRM", yes: isYes }, "*"); } catch (e) {}
    state.pendingBuildConfirm = false;
    state.lastJarvisQuestion = null;
    const r = isYes ? `Connecting them now, ${state.userTitle}.` : `Understood — leaving them as they are.`;
    addMsg("jarvis", r); speak(r);
    return;
  }
  if (isShortAffirmOrNeg && state.lastJarvisQuestion) {
    const contextualText = `${cleaned} (in response to: "${state.lastJarvisQuestion}")`;
    state.lastJarvisQuestion = null;
    sendToAI(contextualText);
    return;
  }

  const cleanedLower = cleaned.toLowerCase();

  // NOTE: "daily briefing" / "brief me" etc. used to be intercepted HERE
  // and launched the full-screen briefing.js experience directly, which
  // is exactly the "big page every time" behavior that wasn't wanted.
  // It's no longer special-cased client-side — it just falls through to
  // sendToAI() below, and the server's routeDailyBriefing() handles the
  // whole conversation (goal question, steps, or the general "here's
  // what's going on" fallback) as plain chat replies.

  // ── Simple Chat Mode: "Jarvis turn on/switch to/enable chat mode"
  //    swaps in a plain text-chat overlay (light theme, "Ask anything"
  //    bar, no HUD/orb). "Jarvis turn off/exit chat mode" goes back to
  //    the full HUD. Any phrasing that includes the word "mode" is
  //    claimed here, ahead of the generic switchMatch below — a bare
  //    "switch to chat" (no "mode") still falls through to that and
  //    just flips the HUD's own chat tab. ──
  if (/\b(turn on|enable|activate|start|go into|open|switch(?:\s+(?:to|into))?)\s+(?:the\s+)?(?:simple\s+|text\s+)?chat\s*mode\b/.test(cleanedLower)) {
    enterSimpleChatMode();
    const r = `Chat mode on, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r);
    return;
  }
  if (/\b(turn off|disable|deactivate|stop|exit|leave|close)\s+(?:the\s+)?(?:simple\s+|text\s+)?chat\s*mode\b/.test(cleanedLower)) {
    exitSimpleChatMode();
    const r = `Chat mode off, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r);
    return;
  }

  // ── Mode switching: "Jarvis switch to map/chat/3d/build" ──
  const switchMatch = cleanedLower.match(/\bswitch(?:\s+(?:to|into))?\s+(map|chat|3d|hologram|holo|build|blueprint|cad)\s*(?:mode)?\b/);
  if (switchMatch) {
    const target = switchMatch[1];
    const modeMap = { map: "map", chat: "chat", "3d": "build", hologram: "build", holo: "build", build: "build", blueprint: "build", cad: "build" };
    const mode = modeMap[target] || "chat";
    switchMode(mode);
    const r = `Switching to ${mode} mode, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r);
    return;
  }

  // ── Build Mode voice control: "render it" runs every servo in the
  //    build, "make it bigger/smaller" scales the whole thing. Gated on
  //    Build Mode actually being open (or the phrase saying "build"
  //    outright) so ordinary chat like "that's bigger than I thought"
  //    never gets hijacked. ──
  const buildPanelOpen = $("build-panel")?.style.display === "block";
  if (buildPanelOpen || /\bbuild\b/.test(cleanedLower)) {
    if (/\b(render|animate|play|run)\s+(it|this|the\s+build|my\s+build|the\s+model|the\s+mechanism)\b/.test(cleanedLower)) {
      postToBuild({ type: "BUILD_RUN" });
      const r = `Rendering it now, ${state.userTitle}.`;
      addMsg("jarvis", r); speak(r);
      return;
    }
    if (/\b(stop|pause|halt)\s+(it|this|the\s+build|rendering|running)\b/.test(cleanedLower)) {
      postToBuild({ type: "BUILD_STOP" });
      const r = `Stopped, ${state.userTitle}.`;
      addMsg("jarvis", r); speak(r);
      return;
    }
    if (/\b(make it bigger|bigger|scale (?:it\s+)?up|spread it out|spread out|grow it|make it larger)\b/.test(cleanedLower)) {
      postToBuild({ type: "BUILD_SCALE_UP" });
      const r = `Scaling it up, ${state.userTitle}.`;
      addMsg("jarvis", r); speak(r);
      return;
    }
    if (/\b(make it smaller|smaller|scale (?:it\s+)?down|shrink it)\b/.test(cleanedLower)) {
      postToBuild({ type: "BUILD_SCALE_DOWN" });
      const r = `Scaling it down, ${state.userTitle}.`;
      addMsg("jarvis", r); speak(r);
      return;
    }

    // ── AI-designed builds: "build a helmet", "make a hydrogen tank
    //    with a repulsor that jets flame out the back", etc. Falls
    //    through to here only once the specific render/stop/scale
    //    commands above have already been ruled out. The description
    //    is handed to Build Mode's /api/build/generate pipeline, which
    //    designs and spawns the parts itself. ──
    const genericBuildMatch = cleaned.match(/\b(?:build|make|construct|create|design)\s+(?:me\s+)?(?:a|an|the)?\s*(.+)/i);
    if (genericBuildMatch && genericBuildMatch[1] && genericBuildMatch[1].trim().length > 1) {
      const buildPrompt = genericBuildMatch[1].trim().replace(/[.?!]+$/, "");
      postToBuild({ type: "BUILD_AI_REQUEST", prompt: buildPrompt });
      const r = `On it, ${state.userTitle} — designing ${buildPrompt} now.`;
      addMsg("jarvis", r); speak(r);
      return;
    }
  }

  // ── Map lookups: "show me a map of X" / "map of X" / "where is X" / "find X on the map" ──
  const mapMatch =
    cleanedLower.match(/\b(?:show me|show|open|pull up|display)\s+(?:a\s+|the\s+)?map\s+(?:of|for|showing)\s+(.+)/) ||
    cleanedLower.match(/\bmap\s+(?:of|for)\s+(.+)/) ||
    cleanedLower.match(/\bwhere\s+is\s+(.+?)(?:\s+located)?\??$/) ||
    cleanedLower.match(/\bfind\s+(.+?)\s+on\s+(?:the\s+)?map\b/);
  if (mapMatch && mapMatch[1] && mapMatch[1].trim().length > 1) {
    const place = mapMatch[1].trim().replace(/[?.!]+$/, "");
    switchMode("map", place);
    const r = `Pulling up a map of ${place}, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r);
    return;
  }
  if (/\b(open|show|switch to)\s+(the\s+)?map\b/.test(cleanedLower) && !mapMatch) {
    switchMode("map");
    const r = `Here's the map, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r);
    return;
  }

  // ── Notification / intruder settings ──
  if (/\b(notification|alert|intruder|settings|setting|configure|config|toggle|manage)\b/.test(cleanedLower) &&
      /\b(settings|setting|panel|menu|page|where|open|show|go to|find|access)\b/.test(cleanedLower)) {
    const r = `Opening notification and security settings, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r); showNotifSettings(); updateMood(2); return;
  }

  // ── Google / Gmail / Calendar settings ──
  if (/\b(google|gmail|calendar|email)\b/.test(cleanedLower) &&
      /\b(settings|setting|connect|configure|setup|set up|api|credentials|key|integrate|link|add|change)\b/.test(cleanedLower)) {
    const r = `Opening Google integration settings, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r); showGoogleSettings(); updateMood(2); return;
  }

  // ── Intruder detection toggle ──
  if (/\b(disable|turn off|deactivate|stop)\b/.test(cleanedLower) &&
      /\b(intruder|face detection|face recognition|facial recognition|facial|unknown face)\b/.test(cleanedLower)) {
    state.intruderDetectionEnabled = false;
    saveServerSetting({ faceDetection: false });
    if (state.intruderActive) {
      stopIntruderRecord();
      state.intruderActive = false;
      hideFaceAuthOverlay();
      const panel = $("camera-panel"); if (panel) panel.classList.remove("alert");
    }
    const r = `Intruder detection disabled, ${state.userTitle}. I'll stop monitoring for unknown faces. Say "enable intruder detection" to turn it back on.`;
    addMsg("jarvis", r); speak(r); updateMood(2); return;
  }

  if (/\b(enable|turn on|activate|start|re-enable)\b/.test(cleanedLower) &&
      /\b(intruder|face detection|face recognition|facial recognition|facial|unknown face)\b/.test(cleanedLower)) {
    state.intruderDetectionEnabled = true;
    saveServerSetting({ faceDetection: true });
    const r = `Intruder detection re-enabled, ${state.userTitle}. I'll alert you if an unknown face appears on camera.`;
    addMsg("jarvis", r); speak(r); updateMood(2); return;
  }

  // ── Re-enroll iris / retina command ──
  if (/\b(re-?enroll|enroll|enroll again|re-?scan|scan again)\b/.test(cleanedLower) &&
      /\b(iris|retina|eye|eyes)\b/.test(cleanedLower)) {
    const r = `Enrolling your iris now, ${state.userTitle}. Look at the camera.`;
    addMsg("jarvis", r); speak(r);
    if (window.RetinaScan) RetinaScan.enroll((state.user || "owner").toLowerCase());
    return;
  }

// ── Re-enroll face command ──
  if (/\b(re-?enroll|enroll again|re-?scan|scan again|re-?register)\b/.test(cleanedLower) &&
      /\b(face|facial|me)\b/.test(cleanedLower)) {
    state.faceEnrolled = false;
    state.faceDescriptors = null;
    clearSavedFaceDescriptor();
    const r = `Re-enrolling your face now, ${state.userTitle}. Please look at the camera.`;
    addMsg("jarvis", r); speak(r);
    enrollUserFace(); return;
  }

  sendToAI(cleaned, attachments);
}

// ═══════════════════════════════════════════════════════════════
// ── AI CHAT ──
async function sendToAI(message, attachments) {
  mic.suspend();
  addMsg("user", message, attachments);
  setOrb("thinking");

  try {
    const stRes = await fetch("/api/personality/smalltalk", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, userTitle: state.userTitle, userTimezone: getUserTimezone() }),
    });
    const stData = await stRes.json();
    if (stData.reply) {
      addMsg("jarvis", stData.reply);
      speak(stData.reply, () => mic.resume());
      updateMood(5);
      syncExtensionStatus();
      return;
    }
  } catch { /* fall through */ }

  const memories = await loadMemoriesForPrompt();
  const moodCtx  = `mood: ${state.mood} (score: ${state.moodScore})`;
  try {
    const res  = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        sessionId:   state.sessionId,
        userName:    state.user,
        userTitle:   state.userTitle,
        memories,
        moodContext: moodCtx,
        cameraActive: !!state.cameraStream,   // tell the AI camera is already online
        screenActive: !!state.screenStream,   // and whether screen share is active
        userTimezone: getUserTimezone(),      // so JARVIS knows YOUR local time, not the server's
        // Only name/type/text ride to the server — data URLs stay client-side
        // for preview only, since the current model can't read image pixels.
        attachments: (attachments || []).map(a => ({
          name: a.name, mimeType: a.mimeType, isImage: !!a.isImage, textContent: a.textContent || null,
        })),
      }),
    });
    const data  = await res.json();
    // NOTE: an empty reply here almost always means the tutor/brain call
    // failed server-side (see server logs for "[BRAIN] Tutor call failed").
    // Silently answering "Yes, Sir?" made it look like JARVIS agreed with
    // everything it was asked, when it actually just didn't understand.
    // Say so honestly instead so the failure is visible, not disguised.
    const reply = data.reply || `I didn't quite get that, ${state.userTitle}. Could you rephrase, or try again in a moment?`;

    addMsg("jarvis", reply);
    updateMood(5);
    syncExtensionStatus();

    if (data.action === "HOME_TALK_ON")  { state.outputMode = "home";  showHomeTalkBadge(data.meta?.device); }
    if (data.action === "HOME_TALK_OFF") { state.outputMode = "phone"; hideHomeTalkBadge(); }

    // BUGFIX: this used to require BOTH data.action AND data.meta to be
    // truthy before running handleAction(). Actions like SHOW_CAMERA,
    // HIDE_CAMERA, and MUTE_ON/MUTE_OFF never carry a `meta` payload —
    // they don't need one — so this condition silently skipped
    // handleAction() for them and just spoke the reply text without
    // ever actually opening the camera / muting / etc. Only `action`
    // is required now; handleAction's own `default` case already
    // speaks-and-resumes for anything it doesn't specifically handle,
    // so this is safe for every existing action too.
    if (data.action) {
      await handleAction(data.action, data.meta, reply);
    } else {
      speak(reply, () => mic.resume());
    }

  } catch (err) {
    console.error("[JARVIS] AI error:", err);
    const fb = `Something went sideways, ${state.userTitle}. Give it another go.`;
    addMsg("jarvis", fb); speak(fb, () => mic.resume()); updateMood(-5);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── MODE TASKBAR ──
// Single entry point used by the bottom taskbar buttons AND by voice/text
// commands ("Jarvis, switch to map"). Keeps the active tab highlighted
// and makes sure only one full-screen panel is open at a time.
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// ── SIMPLE CHAT MODE ──
// A plain text-chat overlay (light theme, centered "Ask anything"
// bar, no HUD/orb/panels) — toggled by "Jarvis, turn on/off chat
// mode". Purely a CSS-driven view swap: the exact same #transcript,
// #type-input and addMsg()/handleChatCommand() plumbing keeps running
// underneath, so nothing about how messages are sent/rendered changes.
// ═══════════════════════════════════════════════════════════════
function enterSimpleChatMode() {
  if (state.simpleChatMode) return;
  state.simpleChatMode = true;
  closeBuild(); closeMapMode(); closeNews();
  document.body.classList.add("simple-chat-active");
  updateSimpleChatEmptyState();
  const input = $("type-input");
  if (input) setTimeout(() => input.focus(), 50);
}
function exitSimpleChatMode() {
  if (!state.simpleChatMode) return;
  state.simpleChatMode = false;
  document.body.classList.remove("simple-chat-active", "simple-chat-empty");
}
function updateSimpleChatEmptyState() {
  const transcript = $("transcript");
  const isEmpty = !transcript || transcript.children.length === 0;
  document.body.classList.toggle("simple-chat-empty", state.simpleChatMode && isEmpty);
}

function switchMode(mode, query) {
  // Close whatever full-screen panel is currently open (idempotent if none is)
  closeBuild();
  closeMapMode();
  closeNews();

  document.querySelectorAll(".taskbar-btn").forEach(b => b.classList.remove("active"));
  const btn = $("tb-btn-" + (mode === "build" ? "build" : mode === "map" ? "map" : mode === "news" ? "news" : "chat"));
  if (btn) btn.classList.add("active");

  // Send the JARVIS orb sliding down into the bottom-left corner whenever
  // we leave chat for another full-screen mode, and bring it back to
  // center when we return to chat.
  const homeHero = document.querySelector(".hud-home");
  if (homeHero) homeHero.classList.toggle("corner-mode", mode !== "chat");

  if (mode === "map") openMapMode(query);
  else if (mode === "build") openBuild(query || "");
  else if (mode === "news") openNews(query || null);
  // "chat" needs nothing further — closing the panels above already returns to it
}

function openMapMode(query) {
  const panel = $("map-panel");
  const iframe = $("map-iframe");
  if (!panel || !iframe) return;
  panel.style.display = "block";
  const sendMsg = () => {
    try { if (query) iframe.contentWindow.postMessage({ type: "MAP_SEARCH", query }, "*"); }
    catch (e) {}
  };
  if (iframe.contentDocument?.readyState === "complete") setTimeout(sendMsg, 300);
  else iframe.onload = () => setTimeout(sendMsg, 300);
}
function closeMapMode() {
  const panel = $("map-panel");
  if (panel) panel.style.display = "none";
  if (state.phase === "chatting") mic.resume();
  _setTaskbarChatActive();
}

function toggleListening() {
  const micBtn = $("tb-btn-mic");
  if (mic.suspended) {
    mic.resume();
    if (micBtn) micBtn.classList.add("live");
  } else {
    mic.suspend();
    if (micBtn) micBtn.classList.remove("live");
  }
}


function _setTaskbarChatActive() {
  document.querySelectorAll(".taskbar-btn").forEach(b => b.classList.remove("active"));
  const chatBtn = $("tb-btn-chat");
  if (chatBtn) chatBtn.classList.add("active");
  const homeHero = document.querySelector(".hud-home");
  if (homeHero) homeHero.classList.remove("corner-mode");
}

// ═══════════════════════════════════════════════════════════════
// ── BUILD MODE FUNCTIONS ──
// CAD-style engine: pull real 3D parts, grab/spin them by hand,
// Jarvis screws touching parts together on confirmation.
// ═══════════════════════════════════════════════════════════════
function openBuild(query) {
  const panel  = $("build-panel");
  const iframe = $("build-iframe");
  if (!panel || !iframe) return;
  panel.style.display = "block";

  // Build Mode runs its OWN hand-tracking instance inside the iframe (its
  // own camera feed, its own overlay canvas — see build-mode.html). The
  // parent HUD's hand-tracking overlay covers the entire viewport and
  // would otherwise keep drawing its own skeleton/cursor on top of Build
  // Mode's, producing two independently-tracked, out-of-sync skeletons
  // fighting each other on screen. Pause the parent's while Build Mode
  // owns the screen; closeBuild() resumes it.
  try { window.HandTracking?.stop(); } catch (e) {}

  // Load the iframe lazily — only the first time Build mode is actually
  // opened, so it doesn't boot in the background while the user is
  // still on the login/boot screen.
  const needsLoad = !iframe.src && iframe.dataset.src;
  if (needsLoad) iframe.src = iframe.dataset.src;

  const sendMsg = () => {
    try {
      if (query) iframe.contentWindow.postMessage({ type: "BUILD_SEARCH", query }, "*");
    } catch (e) {}
  };

  if (!needsLoad && iframe.contentDocument?.readyState === "complete") {
    setTimeout(sendMsg, 300);
  } else {
    iframe.onload = () => setTimeout(sendMsg, 300);
  }
}
function closeBuild() {
  const panel = $("build-panel");
  if (panel) panel.style.display = "none";
  if (state.phase === "chatting") mic.resume();
  _setTaskbarChatActive();
  // Resume the parent HUD's hand tracking now that Build Mode's own
  // instance (and its overlay) is no longer the only one that should be
  // drawing — only if the main screen is actually still active (don't
  // resurrect it during logout).
  try {
    if (document.getElementById("main-screen")?.classList.contains("active") && !window.HandTracking?.active) {
      window.HandTracking?.start();
    }
  } catch (e) {}
}

// ═══════════════════════════════════════════════════════════════
// ── NEWS WIDGET FUNCTIONS ──
// Broadcast-style dashboard, real headlines, JARVIS narrates with
// its usual dry sarcasm. No typing — voice/taskbar only.
// ═══════════════════════════════════════════════════════════════
function openNews(newsMeta) {
  const panel  = $("news-panel");
  const iframe = $("news-iframe");
  if (!panel || !iframe) return;
  panel.style.display = "block";

  const needsLoad = !iframe.src && iframe.dataset.src;
  if (needsLoad) iframe.src = iframe.dataset.src;

  const sendData = () => {
    try { iframe.contentWindow.postMessage({ type: "NEWS_DATA", meta: newsMeta || null }, "*"); } catch (e) {}
  };

  if (!needsLoad && iframe.contentDocument?.readyState === "complete") {
    setTimeout(sendData, 250);
  } else {
    iframe.onload = () => setTimeout(sendData, 250);
  }
}
function closeNews() {
  const panel = $("news-panel");
  if (panel) panel.style.display = "none";
  if (state.phase === "chatting") mic.resume();
  _setTaskbarChatActive();
}

// Used by voice commands ("render it", "make it bigger") to talk to
// Build Mode — opens it if it isn't already open, then posts once the
// iframe has actually finished loading (handles the very-first-open case
// where the iframe src hasn't loaded yet).
function postToBuild(msg) {
  switchMode("build");
  const iframe = $("build-iframe");
  if (!iframe) return;
  const send = () => { try { iframe.contentWindow.postMessage(msg, "*"); } catch (e) {} };
  if (iframe.contentDocument?.readyState === "complete") setTimeout(send, 250);
  else iframe.onload = () => setTimeout(send, 250);
}

// Listen for the iframe's exit button telling us to close
window.addEventListener("message", (e) => {
  if (e.data?.type === "CLOSE_BUILD") closeBuild();
  if (e.data?.type === "BUILD_ASK_CONNECT" && e.data.question) {
    state.pendingBuildConfirm = true;
    state.lastJarvisQuestion = e.data.question;
    addMsg("jarvis", e.data.question);
    speak(e.data.question);
  }
});

// ═══════════════════════════════════════════════════════════════
// ── ACTION HANDLER ──
// ═══════════════════════════════════════════════════════════════
async function handleAction(action, meta, replyText) {
  const T = state.userTitle || "Sir";

  switch (action) {
    case "SHOW_BOARD": {
      speak(replyText, () => mic.resume());
      if (window.BoardWidget && meta) {
        window.BoardWidget.show({ id: meta.id, title: meta.title, content: meta.content });
      }
      break;
    }
    case "BOARD_NOT_FOUND":
    case "ASK_BOARD_TOPIC":
    case "LIST_BOARDS":
    case "BOARD_DELETED": {
      speak(replyText, () => mic.resume());
      break;
    }
    case "SHOW_HOLOGRAM": {
      const query = meta?.query || "";
      speak(replyText, () => {
        switchMode("build", query);
        mic.resume();
      });
      break;
    }
    case "SHOW_NEWS_WIDGET": {
      const newsPayload = { newsData: meta?.newsData || null, briefing: replyText, label: meta?.label || "" };
      speak(replyText, () => {
        switchMode("news", newsPayload);
        mic.resume();
      });
      break;
    }
    case "SHOW_NEWS_PAGE": {
      const newsPayload = { newsData: meta?.newsData || null, briefing: replyText, label: meta?.label || "" };
      speak(replyText, () => {
        // Hand the fresh data to the news page via sessionStorage so it
        // shows the exact same headlines/briefing JARVIS just spoke —
        // this is a real same-tab navigation, not an iframe, so there's
        // no postMessage channel to use instead.
        try {
          sessionStorage.setItem("jarvis_news_payload", JSON.stringify({ ts: Date.now(), ...newsPayload }));
        } catch (e) {}
        window.location.href = "/news";
      });
      break;
    }
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
            html += `<span class="link-more">… and ${group.count - 3} more. Say "${group.name}" to open a random one.</span>`;
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
      } else {
        speak(replyText, () => mic.resume());
      }
      break;
    }
    case "SHOW_CALENDAR": {
      speak(replyText, () => mic.resume());
      showCalendarUI(meta || {});
      break;
    }
    case "OPEN_LINKS": {
      const links = Array.isArray(meta?.links) ? meta.links : [];
      if (links.length) {
        const wrap = document.createElement("div"); wrap.className = "msg jarvis";
        let html = `<div class="msg-label">J.A.R.V.I.S — LINKS</div><div class="msg-text">`;
        for (const l of links) {
          html += `<a href="${l.url}" target="_blank" rel="noopener" class="jarvis-link link-item">${l.label || l.url}</a>`;
        }
        html += `</div>`;
        wrap.innerHTML = html;
        $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
        speak(replyText, () => {
          // Best-effort auto-open. Browsers may block a batch of popups
          // that aren't tied to a direct click — that's why the links
          // above are also rendered as clickable fallbacks. Install the
          // JARVIS Chrome extension for reliable auto-opening even when
          // this tab isn't focused (it uses chrome.tabs.create instead).
          links.forEach((l, i) => setTimeout(() => window.open(l.url, "_blank", "noopener"), i * 400));
          mic.resume();
        });
      } else {
        speak(replyText, () => mic.resume());
      }
      break;
    }
    case "PLAY_MUSIC":
    case "PLAY_MUSIC_SEARCH": {
      const url = meta?.playUrl;
      if (url && window.MusicWidget) {
        // Music is always the floating now-playing widget — never a tab.
        speak(replyText, () => {
          window.MusicWidget.play({ url, title: meta?.title, artist: meta?.artist, album: meta?.album, artwork: meta?.artwork });
          mic.resume();
        });
      } else if (url) {
        // Fallback only if the widget script somehow failed to load.
        speak(replyText, () => { window.open(url, "_blank", "noopener"); mic.resume(); });
      } else {
        speak(replyText, () => mic.resume());
      }
      break;
    }
    case "OPEN_BREAK_TABS": {
      const urls = Array.isArray(meta?.urls) ? meta.urls : [];
      speak(replyText, () => {
        // Staggered like OPEN_LINKS below — a burst of window.open calls
        // tied to one gesture is what usually survives the popup blocker.
        urls.forEach((u, i) => setTimeout(() => window.open(u, "_blank", "noopener"), i * 400));
        mic.resume();
      });
      break;
    }
    case "OPEN_RESEARCH": {
      const url = meta?.url;
      speak(replyText, () => {
        if (url) window.open(url, "_blank", "noopener");
        mic.resume();
      });
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
          const noBufferMsg = `No buffer available yet, ${T}. The rolling buffer needs a moment to fill — try again in a few seconds.`;
          addMsg("jarvis", noBufferMsg); speak(noBufferMsg, () => mic.resume()); return;
        }
        const toast = $("clip-toast");
        if (toast) { toast.classList.remove("hidden"); setTimeout(() => toast.classList.add("hidden"), 3500); }
        updateMood(3); mic.resume();
      });
      break;
    }
    case "SHOW_CLIPS": {
      speak(replyText, () => { showIntruderClips(); mic.resume(); });
      break;
    }
    case "READ_SCREEN": {
      speak(replyText, () => {});
      await readScreen(meta.question || "What's on my screen?");
      break;
    }
    case "SWITCH_CAMERA": {
      if (meta.switchCamera && meta.cameraIndex >= 0) {
        speak(replyText, () => {});
        if (state.availableCameras[meta.cameraIndex]) {
          await switchCamera(state.availableCameras[meta.cameraIndex].deviceId);
        } else {
          const noCamera = `I don't see camera ${meta.cameraIndex + 1}, ${T}. I have ${state.availableCameras.length} available.`;
          addMsg("jarvis", noCamera); speak(noCamera, () => mic.resume());
        }
      } else {
        speak(replyText, () => mic.resume());
      }
      break;
    }
    case "TIMER": {
      if (meta.action === "TIMER_SET" && meta.duration) {
        speak(replyText, () => mic.resume());
        showTimerBadge(meta.duration, meta.task);
        const timerId = setTimeout(() => {
          const task = meta.task ? ` — remember to ${meta.task}` : "";
          const alertMsg = `${T}, your timer is up${task}. That was ${formatDurationClient(meta.duration)}.`;
          addMsg("jarvis", alertMsg);
          speak(alertMsg);
          notif.tone("timer");
          notif.push("⏱ J.A.R.V.I.S — Timer", alertMsg, "timer", true);
          hideTimerBadge(timerId);
          const orb = $("orb");
          if (orb) { orb.classList.add("speaking"); setTimeout(() => orb.classList.remove("speaking"), 3000); }
        }, meta.duration);
        state.activeTimers.push({ id: timerId, duration: meta.duration, task: meta.task, startedAt: Date.now() });
      } else {
        speak(replyText, () => mic.resume());
      }
      break;
    }
    case "NOTIF_SETTINGS": { speak(replyText, () => {}); showNotifSettings(); break; }
    case "LOGOUT": { speak(replyText, () => {}); setTimeout(() => handleLogout(), 800); break; }
    case "CALL": {
  const targetName = meta?.targetName || null;
  speak(replyText, () => {
    if (targetName) {
      window.open(`/comms?call=${encodeURIComponent(targetName)}`, '_blank');
    } else {
      window.open('/comms', '_blank');
    }
    mic.resume();
  });
  break;
}
   case "OPEN_HOME": {
  speak(replyText, () => {
    window.open('/home', '_blank');
    mic.resume();
  });
  break;
}
    case "MUTE_ON": {
      // Speak the confirmation once (state.muted flips only after it
      // finishes), then everything after stays silent until unmuted.
      state.muted = false;
      speak(replyText, () => { state.muted = true; updateMuteUI(true); mic.resume(); });
      break;
    }
    case "MUTE_OFF": {
      state.muted = false;
      updateMuteUI(false);
      speak(replyText, () => mic.resume());
      break;
    }
    case "SHOW_CAMERA": {
      speak(replyText, async () => {
        if (!state.cameraStream) await requestCameraAccess();
        openCameraFullscreen();
        mic.resume();
      });
      break;
    }
    case "HIDE_CAMERA": {
      speak(replyText, () => { closeCameraFullscreen(); mic.resume(); });
      break;
    }
    case "SHOW_HUD": {
      speak(replyText, () => mic.resume());
      if (window.PiPWidgets) window.PiPWidgets.handleVoiceCommand("SHOW_HUD", { query: meta?.query || replyText });
      break;
    }
    case "HIDE_HUD": {
      speak(replyText, () => mic.resume());
      if (window.PiPWidgets) window.PiPWidgets.handleVoiceCommand("HIDE_HUD", { query: meta?.query || replyText });
      break;
    }
    default: { speak(replyText, () => mic.resume()); break; }
  }
}

// ── CALENDAR / AGENDA UI ──
// Self-contained: injects its own CSS once so it doesn't depend on
// style.css being updated too. Shows today's routine (if any) with
// the current block highlighted, plus upcoming reminders/events.
let _calendarCSSInjected = false;
function ensureCalendarCSS() {
  if (_calendarCSSInjected) return;
  _calendarCSSInjected = true;
  const style = document.createElement("style");
  style.textContent = `
    #jarvis-calendar-overlay {
      position: fixed; inset: 0; background: rgba(0,8,16,0.72);
      display: flex; align-items: center; justify-content: center;
      z-index: 99999; font-family: 'Share Tech Mono', monospace;
    }
    #jarvis-calendar-panel {
      width: min(460px, 92vw); max-height: 80vh; overflow-y: auto;
      background: rgba(6,18,28,0.97); border: 1px solid rgba(0,200,255,0.35);
      border-radius: 10px; box-shadow: 0 0 40px rgba(0,200,255,0.25);
      padding: 20px 22px 24px;
    }
    #jarvis-calendar-panel h2 {
      color: #00c8ff; font-size: 0.95rem; letter-spacing: 0.08em;
      margin: 0 0 14px; display: flex; justify-content: space-between; align-items: center;
    }
    #jarvis-calendar-panel .jc-close {
      cursor: pointer; color: #7fdcff; background: none; border: 1px solid rgba(0,200,255,0.4);
      border-radius: 4px; padding: 2px 9px; font-size: 0.8rem;
    }
    #jarvis-calendar-panel .jc-section-title {
      color: #7fdcff; font-size: 0.72rem; letter-spacing: 0.06em; margin: 14px 0 6px; text-transform: uppercase;
    }
    #jarvis-calendar-panel .jc-block {
      display: flex; justify-content: space-between; gap: 10px;
      padding: 6px 8px; border-radius: 5px; font-size: 0.78rem; color: #cfeeff;
      border-bottom: 1px solid rgba(0,200,255,0.08);
    }
    #jarvis-calendar-panel .jc-block.current { background: rgba(0,200,255,0.14); color: #fff; }
    #jarvis-calendar-panel .jc-time { color: #6fb8d6; white-space: nowrap; }
    #jarvis-calendar-panel .jc-empty { color: #6fb8d6; font-size: 0.78rem; padding: 6px 8px; }
  `;
  document.head.appendChild(style);
}

function showCalendarUI(meta) {
  ensureCalendarCSS();
  const old = document.getElementById("jarvis-calendar-overlay");
  if (old) old.remove();

  const overlay = document.createElement("div");
  overlay.id = "jarvis-calendar-overlay";
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });

  const blocks    = Array.isArray(meta.blocks) ? meta.blocks : [];
  const reminders = Array.isArray(meta.reminders) ? meta.reminders : [];
  const currentId = meta.current?.id;

  let html = `<div id="jarvis-calendar-panel">
    <h2>J.A.R.V.I.S — AGENDA <button class="jc-close" id="jc-close-btn">CLOSE</button></h2>`;

  html += `<div class="jc-section-title">Today's Routine</div>`;
  if (blocks.length) {
    for (const b of blocks) {
      const isCurrent = b.id === currentId;
      html += `<div class="jc-block${isCurrent ? " current" : ""}"><span>${b.label}</span><span class="jc-time">${b.start}–${b.end}</span></div>`;
    }
  } else {
    html += `<div class="jc-empty">No routine set up yet — say "give me a healthy schedule".</div>`;
  }

  html += `<div class="jc-section-title">Reminders &amp; Events</div>`;
  if (reminders.length) {
    for (const r of reminders) {
      const when = new Date(r.dueAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" });
      html += `<div class="jc-block"><span>${r.label}</span><span class="jc-time">${when}</span></div>`;
    }
  } else {
    html += `<div class="jc-empty">Nothing on the books.</div>`;
  }

  html += `</div>`;
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
  document.getElementById("jc-close-btn").addEventListener("click", () => overlay.remove());
}

// ── TIMER BADGE ──
function showTimerBadge(durationMs, task) {
  let badge = $("timer-badge-el");
  if (!badge) {
    badge = document.createElement("div"); badge.id = "timer-badge-el"; badge.className = "timer-badge";
    document.body.appendChild(badge);
  }
  const endTime = Date.now() + durationMs;
  badge.innerHTML = `<span class="timer-badge-dot"></span><span id="timer-badge-text">⏱ ${task ? task.toUpperCase() : "TIMER"} — ${formatDurationClient(durationMs)}</span>`;
  badge.classList.remove("hidden");
  const tick = setInterval(() => {
    const remaining = endTime - Date.now();
    if (remaining <= 0) { clearInterval(tick); return; }
    const el = $("timer-badge-text");
    if (el) el.textContent = `⏱ ${task ? task.toUpperCase() : "TIMER"} — ${formatDurationClient(remaining)}`;
  }, 1000);
  badge._tick = tick;
}
function hideTimerBadge(timerId) {
  const badge = $("timer-badge-el"); if (!badge) return;
  if (badge._tick) clearInterval(badge._tick);
  badge.classList.add("hidden");
}

function formatDurationClient(ms) {
  const h = Math.floor(ms / 3600000), m = Math.floor((ms % 3600000) / 60000), s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !h) parts.push(`${s}s`);
  return parts.join(" ") || "0s";
}

// ═══════════════════════════════════════════════════════════════
// ── NOTIFICATION SETTINGS OVERLAY ──
// ═══════════════════════════════════════════════════════════════
function showNotifSettings() {
  mic.suspend();
  let overlay = $("notif-settings-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "notif-settings-overlay";
    overlay.className = "notif-settings-overlay";
    overlay.innerHTML = `
      <div class="notif-settings-box">
        <div class="notif-settings-header">
          <span class="notif-settings-title">NOTIFICATION &amp; SECURITY SETTINGS</span>
          <button class="notif-close-btn" id="notif-close-btn">✕</button>
        </div>
        <div class="notif-section">
          <div class="notif-section-label">⚠ INTRUDER DETECTION</div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot red"></span><div><div class="notif-row-title">Master switch — unknown face detection</div><div class="notif-row-sub">Disables all face monitoring &amp; alerts</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-intruder-master" ${state.intruderDetectionEnabled ? "checked" : ""}><span class="notif-slider"></span></label></div>
        </div>
        <div class="notif-section">
          <div class="notif-section-label">PUSH PERMISSION</div>
          <div class="notif-perm-bar">
            <span class="notif-perm-status pending" id="notif-perm-status">● CHECKING…</span>
            <button class="hud-btn" id="notif-perm-btn" style="width:auto;padding:6px 14px;font-size:0.65rem;">REQUEST</button>
          </div>
        </div>
        <div class="notif-section">
          <div class="notif-section-label">ALERT CHANNELS</div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot red"></span><div><div class="notif-row-title">Intruder alert push notification</div><div class="notif-row-sub">Push + alarm tone</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-intruder" ${notif.cfg.intruder ? "checked" : ""}><span class="notif-slider"></span></label></div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot amber"></span><div><div class="notif-row-title">Away mode</div><div class="notif-row-sub">Push + descending chime</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-away" ${notif.cfg.away ? "checked" : ""}><span class="notif-slider"></span></label></div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot blue"></span><div><div class="notif-row-title">User return</div><div class="notif-row-sub">Push + ascending welcome tone</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-return" ${notif.cfg.return ? "checked" : ""}><span class="notif-slider"></span></label></div>
          <div class="notif-row"><div class="notif-row-info"><span class="notif-row-dot green"></span><div><div class="notif-row-title">System events</div><div class="notif-row-sub">Subtle ping</div></div></div><label class="notif-toggle"><input type="checkbox" id="nt-system" ${notif.cfg.system ? "checked" : ""}><span class="notif-slider"></span></label></div>
        </div>
        <div class="notif-section">
          <div class="notif-section-label">TEST ALERTS</div>
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
    $("nt-intruder-master")?.addEventListener("change", (e) => {
      state.intruderDetectionEnabled = e.target.checked;
      saveServerSetting({ faceDetection: e.target.checked });
      const r = e.target.checked
        ? `Intruder detection re-enabled, ${state.userTitle}. Monitoring for unknown faces.`
        : `Intruder detection disabled, ${state.userTitle}. I will stop monitoring.`;
      addMsg("jarvis", r); speak(r);
      if (!e.target.checked && state.intruderActive) {
        stopIntruderRecord(); state.intruderActive = false; hideFaceAuthOverlay();
        const panel = $("camera-panel"); if (panel) panel.classList.remove("alert");
      }
    });
    const toggleMap = { "nt-intruder":"intruder","nt-away":"away","nt-return":"return","nt-system":"system" };
    for (const [id, key] of Object.entries(toggleMap)) $(id)?.addEventListener("change", (e) => { notif.cfg[key] = e.target.checked; });
    const testT = state.userTitle || "Sir";
    $("ntest-intruder").addEventListener("click", () => { notif.tone("intruder"); notif.push("⚠ J.A.R.V.I.S — TEST", `Test: intruder alert, ${testT}.`, "test-intruder"); });
    $("ntest-away").addEventListener("click",     () => { notif.tone("away");     notif.push("J.A.R.V.I.S — TEST", `Test: away mode, ${testT}.`, "test-away"); });
    $("ntest-return").addEventListener("click",   () => { notif.tone("return");   notif.push("J.A.R.V.I.S — TEST", `Test: welcome back, ${testT}.`, "test-return"); });
    $("ntest-system").addEventListener("click",   () => { notif.tone("system");   notif.push("J.A.R.V.I.S — TEST", "Test: system ping.", "test-system"); });
  }
  overlay.classList.remove("hidden");
  updateNotifPermDisplay();
  addMsg("system", "Notification settings open.");
}

function hideNotifSettings() {
  const overlay = $("notif-settings-overlay"); if (overlay) overlay.classList.add("hidden");
  if (state.phase === "chatting") mic.resume();
}

// ═══════════════════════════════════════════════════════════════
// ── GOOGLE SIGN-IN ──
// ═══════════════════════════════════════════════════════════════
// One click: "Sign in with Google". No client ID/secret for the user to
// find or paste in — the app already has a single shared Google OAuth
// app configured server-side (see google.js / GOOGLE_CLIENT_ID+SECRET).
function showGoogleSettings() {
  mic.suspend();
  let overlay = $("google-settings-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "google-settings-overlay";
    overlay.className = "notif-settings-overlay";
    overlay.innerHTML = `
      <div class="notif-settings-box" style="max-width:420px">
        <div class="notif-settings-header">
          <span class="notif-settings-title">🔗 GOOGLE INTEGRATION</span>
          <button class="notif-close-btn" id="google-settings-close">✕</button>
        </div>
        <div class="notif-section">
          <p style="font-family:var(--mono);font-size:0.62rem;color:var(--text-dim);margin:0 0 16px;line-height:1.6">
            Connect your Google account to let JARVIS read your unread inbox and
            upcoming calendar events. Sign-in happens through Google directly —
            JARVIS never sees or stores your password.
          </p>
          <div id="google-settings-status" style="font-family:var(--mono);font-size:0.62rem;color:var(--text-dim);min-height:18px;margin-bottom:12px"></div>
          <div style="display:flex;gap:10px">
            <button class="hud-btn" id="google-signin-btn" style="flex:1;padding:10px">SIGN IN WITH GOOGLE</button>
            <button class="hud-btn" id="google-disconnect-btn" style="flex:1;padding:10px;border-color:var(--red);color:var(--red)">DISCONNECT</button>
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    $("google-settings-close").addEventListener("click", hideGoogleSettings);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) hideGoogleSettings(); });

    $("google-signin-btn").addEventListener("click", () => {
      const statusEl = $("google-settings-status");
      statusEl.style.color = "var(--text-dim)"; statusEl.textContent = "Opening Google sign-in…";
      window.open(`/api/google/auth?user=${encodeURIComponent(state.user)}`, "_blank");
      const msg = `Opening Google sign-in, ${state.userTitle}. Approve access in the new tab to activate Gmail and Calendar.`;
      addMsg("jarvis", msg); speak(msg);
    });

    $("google-disconnect-btn").addEventListener("click", async () => {
      const statusEl = $("google-settings-status");
      statusEl.style.color = "var(--text-dim)"; statusEl.textContent = "Disconnecting…";
      try {
        await fetch("/api/google/disconnect", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userName: state.user }),
        });
        statusEl.style.color = "#ff4444"; statusEl.textContent = "Disconnected. Gmail and Calendar deactivated.";
        const msg = `Google disconnected, ${state.userTitle}. Gmail and Calendar are no longer active.`;
        addMsg("jarvis", msg); speak(msg);
      } catch { statusEl.style.color = "var(--red)"; statusEl.textContent = "Error — try again."; }
    });
  }

  // Reflect current connection status
  fetch(`/api/profile/${encodeURIComponent(state.user)}`).then(r => r.json()).then(d => {
    const statusEl = $("google-settings-status");
    if (d.profile?.googleConnected) {
      statusEl.style.color = "#00ff88";
      statusEl.textContent = "✓ Connected. Gmail and Calendar are active.";
    } else {
      statusEl.style.color = "var(--text-dim)";
      statusEl.textContent = "Not connected yet.";
    }
  }).catch(() => {});

  overlay.classList.remove("hidden");
  addMsg("system", "Google settings open.");
}

function hideGoogleSettings() {
  const overlay = $("google-settings-overlay"); if (overlay) overlay.classList.add("hidden");
  if (state.phase === "chatting") mic.resume();
}


function showFaceAuthOverlay() {
  const overlay = $("face-auth-overlay"), errMsg = $("face-auth-error"),
        submit  = $("face-auth-submit"),  dismiss = $("face-auth-dismiss");
  overlay.classList.remove("hidden");
  errMsg.classList.add("hidden");

  const newSubmit  = submit.cloneNode(true), newDismiss = dismiss.cloneNode(true);
  submit.parentNode.replaceChild(newSubmit, submit);
  dismiss.parentNode.replaceChild(newDismiss, dismiss);

  // Re-scan the camera feed and compare against the already-enrolled owner
  // descriptor. This is the same face-recognition check used for sign-in —
  // just run again in case the earlier "unknown face" reading was a fluke
  // (bad angle, lighting, etc).
  const attemptAuth = async () => {
    if (!state.faceEnrolled || !state.faceDescriptors || !faceApiLoaded || !state.cameraStream) {
      showFaceAuthError("Face recognition unavailable right now.");
      return;
    }
    const vid = $("camera-feed");
    if (!vid || vid.readyState < 2) { showFaceAuthError("Camera not ready — try again."); return; }

    let authorized = false;
    try {
      const detection = await faceapi
        .detectSingleFace(vid, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (detection) {
        const dist = faceapi.euclideanDistance(detection.descriptor, state.faceDescriptors);
        if (dist < 0.72) authorized = true;
      }
    } catch {}

    if (authorized) {
      state.intruderAuthorized = true; hideFaceAuthOverlay();
      const panel = $("camera-panel"); if (panel) panel.classList.remove("alert");
      const reply = `Access authorized, ${state.userTitle}. Recording is still completing.`;
      addMsg("jarvis", reply); speak(reply); updateMood(10);
    } else {
      showFaceAuthError("Face not recognized — access denied");
    }
  };
  function showFaceAuthError(msg) {
    const errEl = $("face-auth-error");
    errEl.textContent = msg;
    errEl.classList.remove("hidden");
    setTimeout(() => errEl.classList.add("hidden"), 2500);
  }

  $("face-auth-submit").addEventListener("click", attemptAuth);
  $("face-auth-dismiss").addEventListener("click", () => { hideFaceAuthOverlay(); addMsg("system", "Overlay dismissed. Incident recording continues."); });
}
function hideFaceAuthOverlay() { $("face-auth-overlay").classList.add("hidden"); }

// ═══════════════════════════════════════════════════════════════
// ── CLIP REVIEW PROMPT ──
// ═══════════════════════════════════════════════════════════════
function showClipReviewPrompt(clip) {
  const overlay = $("clip-review-overlay"), subText = $("clip-review-sub"),
        keepBtn = $("clip-review-keep"),    dlBtn   = $("clip-review-download"),
        discardBtn = $("clip-review-discard");

  subText.textContent = state.intruderAuthorized
    ? "You authorized this visit — the recording completed. Keep the clip?"
    : "Unauthorized face detected. The recording is complete. Keep this incident clip?";
  overlay.classList.remove("hidden");

  const nK = keepBtn.cloneNode(true), nD = dlBtn.cloneNode(true), nDi = discardBtn.cloneNode(true);
  keepBtn.parentNode.replaceChild(nK, keepBtn);
  dlBtn.parentNode.replaceChild(nD, dlBtn);
  discardBtn.parentNode.replaceChild(nDi, discardBtn);
  const close = () => overlay.classList.add("hidden");

  $("clip-review-keep").addEventListener("click", () => {
    state.intruderClips.push(clip); close();
    const r = `Clip saved to intruder log, ${state.userTitle}. Say "show me the intruder clips" to review.`;
    addMsg("jarvis", r); speak(r);
  });
  $("clip-review-download").addEventListener("click", () => {
    state.intruderClips.push(clip);
    downloadClipBlob(clip.videoBlob, `jarvis-incident-${Date.now()}.webm`); close();
    const r = `Incident clip downloaded and saved, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r);
  });
  $("clip-review-discard").addEventListener("click", () => {
    close();
    const r = state.intruderAuthorized ? `Clip discarded, ${state.userTitle}. Authorized visit not logged.` : `Clip discarded, ${state.userTitle}.`;
    addMsg("jarvis", r); speak(r);
  });
}

function downloadClipBlob(blob, filename) {
  const url = URL.createObjectURL(blob), a = document.createElement("a");
  a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
}

// ═══════════════════════════════════════════════════════════════
// ── SCREEN READING ──
// ═══════════════════════════════════════════════════════════════
async function readScreen(question) {
  mic.suspend(); setOrb("thinking");
  addMsg("user", question || "What's on my screen?");
  if (!state.screenStream) {
    const reply = `Screen sharing isn't active, ${state.userTitle}. I need you to share your screen first.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); return;
  }
  addMsg("system", "Scanning screen…");
  const ocr = await ocrScreenFrame();
  if (!ocr) { const r = `Failed to capture the screen, ${state.userTitle}.`; addMsg("jarvis", r); speak(r, () => mic.resume()); return; }
  if (!ocr.ocrText || ocr.ocrText.trim().length < 5) { const r = `I captured the screen but couldn't extract readable text, ${state.userTitle}.`; addMsg("jarvis", r); speak(r, () => mic.resume()); return; }
  const memories = await loadMemoriesForPrompt();
  try {
    const res = await fetch("/api/screen", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ocrText: ocr.ocrText, question: question || "What is on the screen?", userName: state.user, userTitle: state.userTitle, memories }),
    });
    const data  = await res.json();
    const reply = data.reply || `Your screen contains: ${ocr.ocrText.slice(0, 200)}`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); updateMood(5);
  } catch {
    const lines = ocr.ocrText.split("\n").filter(l => l.trim().length > 2).slice(0, 4).join(". ");
    const reply = `Here's what I can read on your screen, ${state.userTitle}: ${lines}`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume());
  }
}

// ── FULLSCREEN CAMERA — opened by the show_camera tool ──
function openCameraFullscreen() {
  const wrap = $("camera-fullscreen"); if (!wrap) return;
  // Without a live stream this would just show a black "active" overlay
  // while Jarvis claims the feed is up — tell the truth instead.
  if (!state.cameraStream) {
    addMsg("system", "Camera isn't available — check that camera permission was granted (browser address-bar icon) and try again.");
    return;
  }
  const feed = $("camera-fullscreen-feed");
  if (feed) feed.srcObject = state.cameraStream;
  wrap.classList.add("active");
  const badge = $("camera-fullscreen-badge");
  if (badge && !badge._cfBound) {
    badge._cfBound = true;
    badge.addEventListener("click", closeCameraFullscreen);
  }
}
function closeCameraFullscreen() {
  const wrap = $("camera-fullscreen"); if (!wrap) return;
  wrap.classList.remove("active");
}

// ═══════════════════════════════════════════════════════════════
// ── CAMERA / FACE ──
// ═══════════════════════════════════════════════════════════════
async function requestCameraAccess() {
  try {
    await enumerateCameras();
    const videoConstraints = state.selectedCameraId
      ? { deviceId: { exact: state.selectedCameraId }, width: 640, height: 480, frameRate: 15 }
      : { width: 640, height: 480, frameRate: 15 };
    const stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    state.cameraStream = stream;
    const track = stream.getVideoTracks()[0];
    if (track) { const s = track.getSettings(); state.selectedCameraId = s.deviceId || state.selectedCameraId; }
    const vid = $("camera-feed"); if (vid) { vid.srcObject = stream; vid.play(); }
    const cameraStatus = $("camera-status");
    if (cameraStatus) { cameraStatus.textContent = "● ONLINE"; cameraStatus.classList.add("online"); }
    startCameraBuffer(stream);
    await enumerateCameras();
    addMsg("system", `Camera online. ${state.availableCameras.length} camera(s) detected.`);
    updateMood(5);
    await loadFaceModels();
  } catch { addMsg("system", "Camera declined — face recognition unavailable."); }
}

let faceApiLoaded = false;
async function ensureFaceApiLoaded() {
  if (faceApiLoaded) return true;
  try {
    if (!window.faceapi) await loadScript("https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/dist/face-api.min.js");
    const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    ]);
    faceApiLoaded = true;
    return true;
  } catch (e) {
    console.warn("[JARVIS] Face-api failed to load:", e);
    return false;
  }
}
async function loadFaceModels() {
  const ok = await ensureFaceApiLoaded();
  if (!ok) { addMsg("system", "Face recognition unavailable — intruder detection disabled."); return; }

  // ── Reuse a previously-enrolled face instead of scanning again ──
  // Enrollment used to run fresh every single login (state.faceDescriptors
  // only ever lived in memory, so it was wiped on every page load) —
  // that's why it felt like re-enrolling "the same face" every time you
  // logged in, and why the daily-briefing offer that was chained after it
  // kept popping up too. Now the descriptor is saved once and just loaded
  // back silently on future logins.
  const saved = loadSavedFaceDescriptor();
  if (saved) {
    state.faceDescriptors = saved;
    state.faceEnrolled = true;
    startFaceWatch();
    return;
  }

  addMsg("system", "Face recognition engine loaded. Enrolling your face — please look at the camera.");
  speak(`Face recognition active, ${state.userTitle}. Please look at the camera while I scan your face.`);
  await enrollUserFace();
}

// ── Persisted face descriptor (localStorage) ─────────────────────
// Stored as a plain array (Float32Array isn't JSON-serializable as-is).
const FACE_DESCRIPTOR_KEY = "jarvis_face_descriptor";
function loadSavedFaceDescriptor() {
  try {
    const raw = localStorage.getItem(FACE_DESCRIPTOR_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || !arr.length) return null;
    return new Float32Array(arr);
  } catch { return null; }
}
function saveFaceDescriptor(descriptor) {
  try { localStorage.setItem(FACE_DESCRIPTOR_KEY, JSON.stringify(Array.from(descriptor))); }
  catch (e) { console.warn("[JARVIS] Couldn't persist face descriptor:", e.message); }
}
function clearSavedFaceDescriptor() {
  try { localStorage.removeItem(FACE_DESCRIPTOR_KEY); } catch {}
}

async function enrollUserFace() {
  if (!faceApiLoaded || !state.cameraStream) return;
  if (state.faceEnrollPending) return;
  state.faceEnrollPending = true;
  state.faceEnrolled = false;
  state.faceDescriptors = null;

  const vid = $("camera-feed"); if (!vid) { state.faceEnrollPending = false; return; }

  showEnrollBadge("SCANNING YOUR FACE…");

  const MAX_ATTEMPTS = 20;
  const WAIT_PER_ATTEMPT_MS = 1500;
  let attempts = 0;
  let success = false;

  while (attempts < MAX_ATTEMPTS && !success) {
    await delay(WAIT_PER_ATTEMPT_MS);
    attempts++;

    if (vid.readyState < 2) { updateEnrollBadge(`WAITING FOR CAMERA… (${attempts}/${MAX_ATTEMPTS})`); continue; }

    try {
      const detection = await faceapi
        .detectSingleFace(vid, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.35 }))
        .withFaceLandmarks()
        .withFaceDescriptor();

      if (detection && detection.descriptor) {
        state.faceDescriptors = detection.descriptor;
        state.faceEnrolled = true;
        saveFaceDescriptor(detection.descriptor);
        success = true;
        hideEnrollBadge();
        addMsg("system", `✓ Your face has been enrolled, ${state.userTitle}. Intruder detection is now active.`);
        speak(`Face enrolled, ${state.userTitle}. I'll alert you if anyone else appears on camera.`);
        startFaceWatch();
        break;
      } else {
        updateEnrollBadge(`SCANNING… look at camera (${attempts}/${MAX_ATTEMPTS})`);
      }
    } catch (e) {
      updateEnrollBadge(`SCAN ERROR — retrying (${attempts}/${MAX_ATTEMPTS})`);
      console.warn("[JARVIS] Enroll attempt error:", e.message);
    }
  }

  state.faceEnrollPending = false;

  if (!success) {
    hideEnrollBadge();
    addMsg("system", "Face enrollment failed — couldn't detect a face. Intruder detection disabled. Say 're-enroll face' to try again.");
  }
}

// ── Daily briefing now lives entirely server-side as a plain chat
// back-and-forth (see routeDailyBriefing in server.js) — it's never
// launched proactively here, and never opens the old full-screen
// experience. "daily briefing" / "brief me" etc. just fall through to
// sendToAI() like any other message below.

function runDailyBriefing() {
  if (window.JarvisBriefing && typeof window.JarvisBriefing.run === "function") {
    try { window.JarvisBriefing.run({ user: state.user, userTitle: state.userTitle }, () => {}); return; }
    catch (e) { console.warn("[JARVIS] Daily briefing failed to launch:", e); }
  }
  const r = "The daily briefing screen isn't available right now.";
  addMsg("jarvis", r); speak(r);
}

function showEnrollBadge(text) {
  let badge = $("face-enroll-badge");
  if (!badge) {
    badge = document.createElement("div");
    badge.id = "face-enroll-badge";
    badge.style.cssText = `
      position:fixed; top:20px; left:50%; transform:translateX(-50%);
      background:rgba(0,200,255,0.1); border:1px solid rgba(0,200,255,0.5);
      color:var(--blue,#00c8ff); font-family:'Share Tech Mono',monospace;
      font-size:0.7rem; letter-spacing:0.18em; padding:8px 20px;
      border-radius:3px; z-index:90; display:flex; align-items:center; gap:10px;
      box-shadow:0 0 20px rgba(0,200,255,0.15);
    `;
    const dot = document.createElement("span");
    dot.style.cssText = "width:7px;height:7px;border-radius:50%;background:var(--blue,#00c8ff);animation:blink 1s step-end infinite;flex-shrink:0;";
    const txt = document.createElement("span"); txt.id = "face-enroll-badge-text"; txt.textContent = text;
    badge.appendChild(dot); badge.appendChild(txt);
    document.body.appendChild(badge);
  }
  badge.style.display = "flex";
  const t = $("face-enroll-badge-text"); if (t) t.textContent = text;
}
function updateEnrollBadge(text) {
  const t = $("face-enroll-badge-text"); if (t) t.textContent = text;
}
function hideEnrollBadge() {
  const badge = $("face-enroll-badge"); if (badge) badge.style.display = "none";
}

function startFaceWatch() {
  if (state.faceCheckInterval) clearInterval(state.faceCheckInterval);
  state.faceCheckInterval = setInterval(checkFace, 2500);
}

async function checkFace() {
  if (!state.intruderDetectionEnabled) return;
  if (!faceApiLoaded || !state.cameraStream || state.phase !== "chatting") return;
  if (!state.faceEnrolled || !state.faceDescriptors) return;
  if (state.faceEnrollPending) return;

  const vid = $("camera-feed"); if (!vid || vid.readyState < 2) return;
  try {
    const detections = await faceapi.detectAllFaces(vid, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
    if (detections.length > 0) state.lastSeenUser = Date.now();

    if (detections.length > 0) {
      let userPresent = false;
      for (const d of detections) {
        const dist = faceapi.euclideanDistance(d.descriptor, state.faceDescriptors);
        if (dist < 0.72) { userPresent = true; break; }
      }
      if (userPresent) {
        if (state.awayMode) {
          state.awayMode = false; stopIntruderRecord(); notif.userReturn(state.userTitle);
          const msgs = [`Welcome back, ${state.userTitle}. I've been keeping watch.`, `${state.userTitle} — face confirmed. Systems restored.`];
          const msg = msgs[Math.floor(Math.random() * msgs.length)];
          addMsg("jarvis", msg); speak(msg, () => setTimeout(() => checkIntruderClips(), 1500)); updateMood(15);
        }
      } else if (!state.intruderActive) {
        handleUnknownFace();
      }
    }

    if (Date.now() - state.lastSeenUser > 60000 && !state.awayMode && state.phase === "chatting") {
      state.awayMode = true; notif.away(state.userTitle);
      addMsg("system", "User not detected — away mode active. Monitoring.");
    }
  } catch (e) {
    console.warn("[JARVIS] checkFace error:", e.message);
  }
}

function handleUnknownFace() {
  if (state.intruderActive) return;
  state.intruderActive = true; state.intruderAuthorized = false;
  const panel = $("camera-panel"); if (panel) panel.classList.add("alert");
  notif.intruder(state.userTitle);
  addMsg("system", "⚠ UNKNOWN FACE DETECTED — recording started");
  speak("I don't recognise you. Identify yourself.", () => {
    setTimeout(() => { if (state.intruderActive && !state.intruderAuthorized) speak("Unauthorised access detected. Recording in progress."); }, 10000);
  });
  showFaceAuthOverlay(); startIntruderRecord(); captureAndStoreIntruderPhoto(); updateMood(-30);
}

function captureAndStoreIntruderPhoto() {
  const vid = $("camera-feed"); if (!vid) return null;
  const c = document.createElement("canvas"); c.width = vid.videoWidth || 640; c.height = vid.videoHeight || 480;
  c.getContext("2d").drawImage(vid, 0, 0); return c.toDataURL("image/jpeg", 0.85).split(",")[1];
}

function startIntruderRecord() {
  if (!state.cameraStream) return;
  state.intruderChunks = [];
  const mime = getSupportedMime(), photo = captureAndStoreIntruderPhoto();
  try {
    const rec = new MediaRecorder(state.cameraStream, mime ? { mimeType: mime } : {});
    state.intruderRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data?.size > 0) state.intruderChunks.push(e.data); };
    rec.onstop = () => {
      if (state.intruderChunks.length > 0) {
        const videoBlob = new Blob(state.intruderChunks, { type: getSupportedMime() || "video/webm" });
        const clip = { videoBlob, photoB64: photo, timestamp: new Date().toISOString(), authorized: state.intruderAuthorized };
        hideFaceAuthOverlay();
        const panel = $("camera-panel"); if (panel) panel.classList.remove("alert");
        state.intruderActive = false; state.intruderChunks = [];
        showClipReviewPrompt(clip);
      } else {
        state.intruderActive = false; state.intruderChunks = [];
      }
    };
    rec.start(1000);
    setTimeout(() => { if (state.intruderRecorder && state.intruderRecorder.state !== "inactive") state.intruderRecorder.stop(); }, 30000);
  } catch { state.intruderActive = false; }
}

function stopIntruderRecord() {
  if (!state.intruderRecorder || state.intruderRecorder.state === "inactive") return;
  state.intruderRecorder.stop();
}

function checkIntruderClips() {
  if (!state.intruderClips.length) return;
  const count = state.intruderClips.length;
  const report = `${state.userTitle}, I have ${count} intruder ${count === 1 ? "incident" : "incidents"} on file. Say "show me the intruder clips" to review.`;
  notif.system(`${count} intruder clip(s) on file.`);
  addMsg("jarvis", report); speak(report); updateMood(-10);
}

function showIntruderClips() {
  mic.suspend();
  if (!state.intruderClips.length) {
    const reply = `No intruder footage on file, ${state.userTitle}. All clear.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); return;
  }
  addMsg("system", `📂 ${state.intruderClips.length} intruder clip(s):`);
  state.intruderClips.forEach((clip, i) => {
    const time = new Date(clip.timestamp).toLocaleTimeString();
    const tag  = clip.authorized ? " (AUTHORIZED)" : "";
    const wrap = document.createElement("div"); wrap.className = "msg system";
    wrap.innerHTML = `<div class="msg-label">INTRUDER #${i + 1} — ${time}${tag}</div><div class="msg-text intruder-clip-block"></div>`;
    const block = wrap.querySelector(".intruder-clip-block");
    if (clip.photoB64) {
      const img = document.createElement("img"); img.src = `data:image/jpeg;base64,${clip.photoB64}`;
      img.style.cssText = "width:160px;border:1px solid var(--red);border-radius:3px;margin-right:10px;vertical-align:middle;";
      block.appendChild(img);
    }
    const url = URL.createObjectURL(clip.videoBlob);
    const a = document.createElement("a"); a.href = url; a.download = `intruder-${Date.now()}-${i}.webm`;
    a.textContent = "⬇ Download Video";
    a.style.cssText = "color:var(--red);font-family:var(--mono);font-size:0.75rem;text-decoration:underline;cursor:pointer;vertical-align:middle;";
    block.appendChild(a); $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
  });
  speak(`Displaying ${state.intruderClips.length} intruder clip(s), ${state.userTitle}.`, () => mic.resume());
}

function startCameraBuffer(stream) {
  const mime = getSupportedMime();
  try {
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    state.cameraRecorder = rec;
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
  try {
    const res  = await fetch(`/api/memory/${encodeURIComponent(state.user)}`);
    const data = await res.json();
    return (data.memories || []).map(m => m.fact);
  } catch { return []; }
}

// ── SCREEN RECORD ──
async function requestScreenRecord() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    state.screenStream = stream; startRollingBuffer(stream);
    $("clip-indicator")?.classList.remove("hidden");
    addMsg("system", "Screen sharing active — I can now read your screen.");
  } catch { addMsg("system", "Screen sharing declined — screen reading unavailable."); }
}

function startRollingBuffer(stream) {
  const mime = getSupportedMime();
  const rec  = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
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
  return ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"]
    .find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function stopScreenRecord() {
  if (state.mediaRecorder?.state !== "inactive") state.mediaRecorder?.stop();
  state.screenStream?.getTracks().forEach(t => t.stop());
  state.mediaRecorder = null; state.screenStream = null; state.clipChunks = []; state.clipTimestamps = [];
  $("clip-indicator")?.classList.add("hidden");
}

// ── LOGOUT ──
function handleLogout() {
  mic.suspend();
  if (state.faceCheckInterval) clearInterval(state.faceCheckInterval);
  for (const t of state.activeTimers) clearTimeout(t.id);
  state.activeTimers = [];
  const badge = $("timer-badge-el"); if (badge) badge.classList.add("hidden");
  hideEnrollBadge();

  speak(`Goodbye, ${state.userTitle}. Initiating shutdown.`, async () => {
    state.phase = "idle"; state.user = null; state.userTitle = null;
    state.sessionId = crypto.randomUUID(); state.awayMode = false; state.intruderActive = false;
    state.faceEnrolled = false; state.faceDescriptors = null; state.faceEnrollPending = false;
    state.intruderDetectionEnabled = true;
    _selectedUser = null; _voiceSamples = []; _voiceSamplesDone = 0;
    $("transcript").innerHTML = "";
    $("main-screen").classList.remove("active");
    setOrb("idle"); stopScreenRecord();

    runLockScreen();
  });
}

// ── TRANSCRIPT ──
function addMsg(type, text, attachments) {
  const labels = { user:"YOU", jarvis:"J.A.R.V.I.S", system:"SYSTEM" };
  const wrap   = document.createElement("div"); wrap.className = `msg ${type}`;
  wrap.innerHTML = `<div class="msg-label">${labels[type] || type}</div><div class="msg-text">${text}</div>`;
  if (attachments && attachments.length) {
    const row = document.createElement("div"); row.className = "msg-attachments";
    attachments.forEach(a => {
      if (a.isImage && a.dataUrl) {
        const img = document.createElement("img"); img.src = a.dataUrl; img.alt = a.name;
        row.appendChild(img);
      } else {
        const chip = document.createElement("span"); chip.className = "ac-name-only"; chip.textContent = a.name;
        row.appendChild(chip);
      }
    });
    wrap.appendChild(row);
  }
  $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
  if (state.simpleChatMode) updateSimpleChatEmptyState();
  // Track JARVIS questions so short replies like "yes" can be understood in context
  if (type === "jarvis" && text.includes("?")) {
    // Store the last sentence that contains a question mark
    const sentences = text.split(/(?<=[.!?])\s+/);
    const question = sentences.filter(s => s.includes("?")).pop();
    if (question) state.lastJarvisQuestion = question.replace(/<[^>]+>/g, "").trim();
  }
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

// ═══════════════════════════════════════════════════════════════
// ── BOOT ──
// ═══════════════════════════════════════════════════════════════
window.addEventListener("load", async () => {
  setTimeout(() => {
    const w = new SpeechSynthesisUtterance(" ");
    w.volume = 0; speechSynthesis.speak(w); speechSynthesis.getVoices();
  }, 500);

  runLockScreen();
});
