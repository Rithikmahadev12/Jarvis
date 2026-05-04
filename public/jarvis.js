// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Client Brain v3.0
// Screen reading via Tesseract.js OCR (fully local, no API)
// Smarter command routing, link meta queries, context awareness
// ═══════════════════════════════════════════════════════════════

// ── STATE ──
const state = {
  phase: "idle",
  user: null,
  userTitle: null,
  sessionId: crypto.randomUUID(),
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
  faceDescriptors: null,
  intruderActive: false,
  intruderChunks: [],
  intruderRecorder: null,
  intruderClips: [],
  faceCheckInterval: null,
  lastSeenUser: Date.now(),
  awayMode: false,
  mood: "neutral",
  moodScore: 0,
  interactionCount: 0,
  lastInteraction: Date.now(),
  selectedCameraId: null,
  availableCameras: [],
  tesseractWorker: null,    // ← Tesseract OCR worker
  tesseractReady: false,    // ← whether OCR is loaded
};

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
  const el = $("mood-display");
  if (!el) return;
  const icons = { pleased:"😊", excited:"⚡", curious:"🔍", concerned:"⚠️", bored:"💤", tired:"🔋", neutral:"●" };
  el.textContent = `${icons[state.mood]||"●"} ${state.mood.toUpperCase()}`;
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
  catch(e) { console.warn("[JARVIS] Could not save profile:", e); }
}
async function restoreProfileFromBackend() {
  const nameHint = localStorage.getItem("jarvis_name_hint");
  if (!nameHint) return null;
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(nameHint)}`);
    const data = await res.json();
    if (data.found) return { ...data.profile, passwordHash: localStorage.getItem("jarvis_pw_hash") || "" };
  } catch(e) { console.warn("[JARVIS] Backend restore failed:", e); }
  return null;
}
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}
const $ = id => document.getElementById(id);

// ═══════════════════════════════════════════════════════════════
// ── TESSERACT OCR — fully local screen reading ──
// ═══════════════════════════════════════════════════════════════
async function initTesseract() {
  try {
    // Load Tesseract.js from CDN — runs 100% in browser, no server
    if (!window.Tesseract) {
      await loadScript("https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js");
    }
    // Create worker
    state.tesseractWorker = await Tesseract.createWorker("eng", 1, {
      logger: () => {}, // suppress logs
    });
    state.tesseractReady = true;
    addMsg("system", "OCR engine loaded — screen reading available.");
  } catch(e) {
    console.warn("[TESSERACT] Failed to load:", e);
    addMsg("system", "OCR engine unavailable — screen reading limited.");
  }
}

async function ocrScreenFrame() {
  if (!state.screenStream) return null;
  
  // Capture frame from screen stream
  const track = state.screenStream.getVideoTracks()[0];
  if (!track) return null;

  let imageDataUrl;
  try {
    // Try ImageCapture API first
    const capture = new ImageCapture(track);
    const bitmap  = await capture.grabFrame();
    const canvas  = document.createElement("canvas");
    canvas.width  = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext("2d").drawImage(bitmap, 0, 0);
    imageDataUrl = canvas.toDataURL("image/png");
  } catch {
    // Fallback: draw from a video element
    const video = document.createElement("video");
    video.srcObject = new MediaStream([track]);
    await new Promise(r => { video.onloadedmetadata = r; });
    video.play();
    await delay(200);
    const canvas  = document.createElement("canvas");
    canvas.width  = video.videoWidth  || 1280;
    canvas.height = video.videoHeight || 720;
    canvas.getContext("2d").drawImage(video, 0, 0);
    video.pause();
    imageDataUrl = canvas.toDataURL("image/png");
  }

  if (!state.tesseractReady || !state.tesseractWorker) {
    // No OCR — return the raw base64 for server-side description
    return { ocrText: null, imageB64: imageDataUrl.split(",")[1] };
  }

  // Run OCR locally in the browser
  try {
    const result = await state.tesseractWorker.recognize(imageDataUrl);
    const text   = result.data.text.trim();
    return { ocrText: text, imageB64: null };
  } catch(e) {
    console.warn("[OCR] Recognition failed:", e);
    return { ocrText: null, imageB64: null };
  }
}

// ═══════════════════════════════════════════════════════════════
// ── VOICE ENGINE ──
// ═══════════════════════════════════════════════════════════════
const MALE_VOICE_NAMES = [
  "Google UK English Male","Microsoft George - English (United Kingdom)",
  "Microsoft David Desktop - English (United States)","Microsoft Mark - English (United States)",
  "Daniel","Alex","Fred","Thomas","Arthur","James",
];
const FEMALE_VOICE_NAMES = [
  "Google UK English Female","Google US English","Samantha","Karen",
  "Moira","Tessa","Fiona","Victoria","Serena","Susan","Nicky",
];

function pickVoice() {
  const voices = state.synth.getVoices();
  if (!voices.length) return null;
  const wantMale = (state.userTitle === "Sir");
  if (wantMale) {
    for (const name of MALE_VOICE_NAMES) {
      const v = voices.find(v => v.name === name || v.name.includes(name));
      if (v) return v;
    }
    const enGB = voices.find(v => v.lang === "en-GB" && !FEMALE_VOICE_NAMES.some(n => v.name.includes(n)));
    if (enGB) return enGB;
    const enSafe = voices.find(v => v.lang.startsWith("en") && !FEMALE_VOICE_NAMES.some(n => v.name.includes(n)));
    if (enSafe) return enSafe;
    return voices.find(v => v.lang.startsWith("en")) || null;
  }
  return voices.find(v => v.name === "Google UK English Male")
    || voices.find(v => v.name.includes("Daniel"))
    || voices.find(v => v.lang === "en-GB")
    || voices.find(v => v.lang.startsWith("en"))
    || null;
}
window.speechSynthesis.onvoiceschanged = () => {};

function speak(text, onEnd) {
  state.synth.cancel();
  const utter    = new SpeechSynthesisUtterance(text);
  utter.rate     = 0.93;
  utter.pitch    = (state.userTitle === "Sir") ? 0.75 : 0.8;
  utter.volume   = 1;
  const trySetVoice = () => { const v = pickVoice(); if (v) utter.voice = v; };
  trySetVoice();
  if (!utter.voice) setTimeout(trySetVoice, 150);
  const safetyMs = Math.max(3500, text.length * 75);
  let finished   = false;
  const safetyTimer = setTimeout(() => {
    if (!finished) { finished = true; setOrb("idle"); if (onEnd) onEnd(); }
  }, safetyMs);
  const done = () => {
    if (finished) return;
    finished = true; clearTimeout(safetyTimer); setOrb("idle"); if (onEnd) onEnd();
  };
  utter.onstart = () => setOrb("speaking");
  utter.onend   = done;
  utter.onerror = done;
  state.synth.speak(utter);
}

function setOrb(s) {
  const orb = $("orb"); if (!orb) return;
  orb.className = "orb" + (s !== "idle" ? " " + s : "");
  const labels = { idle:"STANDBY", listening:"LISTENING", thinking:"PROCESSING", speaking:"SPEAKING" };
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
  } catch(e) { console.warn("[CAMERAS]", e); }
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
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${i + 1}`;
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
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId }, width:640, height:480, frameRate:15 }, audio:false
    });
    state.cameraStream = stream; state.selectedCameraId = deviceId;
    const vid = $("camera-feed"); if (vid) { vid.srcObject = stream; vid.play(); }
    startCameraBuffer(stream);
    state.faceDescriptors = null; await enrollUserFace();
    const reply = `Camera switched, ${state.userTitle}. Visual sensors updated.`;
    addMsg("jarvis", reply); speak(reply); updateMood(2);
  } catch(e) {
    const reply = `Camera switch failed, ${state.userTitle}. The device may be in use.`;
    addMsg("jarvis", reply); speak(reply);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── MIC ENGINE ──
// ═══════════════════════════════════════════════════════════════
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const mic = {
  rec:null, active:false, retryCount:0, maxRetries:999, retryDelay:150,
  retryTimer:null, onResult:null, onInterim:null, continuous:true,
  suspended:false, _killing:false, permGranted:false,

  async requestPerm() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio:{ echoCancellation:false, noiseSuppression:false, autoGainControl:true, channelCount:1, sampleRate:16000 }
      });
      stream.getTracks().forEach(t => t.stop());
      this.permGranted = true; updateMicDebug("Mic: permission granted ✓");
    } catch(e) { updateMicDebug("Mic: permission denied ✗"); }
  },

  start(onResult, onInterim, continuous) {
    if (!SR) { addMsg("system","Speech recognition requires Chrome/Edge."); return; }
    this.onResult = onResult; this.onInterim = onInterim;
    this.continuous = continuous !== false; this.suspended = false; this.retryCount = 0; this._launch();
  },

  _launch() {
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
          if ((result[i].confidence||0) > bestConf) { bestConf = result[i].confidence; bestText = result[i].transcript.trim(); }
        }
        if (!bestText) return;
        updateLiveHearing(""); updateMicDebug(`Mic: "${bestText}" (${(bestConf*100).toFixed(0)}%)`);
        if (this.onResult) this.onResult(bestText);
      } else if (result[0]) {
        const interim = result[0].transcript.trim();
        updateLiveHearing(interim); updateMicDebug("Mic: " + interim + "…");
        if (this.onInterim) this.onInterim(interim);
      }
    };

    r.onerror = (e) => {
      console.warn("[MIC ERROR]", e.error); this.active = false; state.isListening = false; updateLiveHearing("");
      switch(e.error) {
        case "not-allowed": case "service-not-allowed":
          this.permGranted = false; updateMicDebug("Mic: blocked — check permissions"); this.suspended = true; return;
        case "no-speech": updateMicDebug("Mic: silence…"); this._scheduleRetry(100); return;
        case "audio-capture": this._scheduleRetry(800); return;
        case "network": this._scheduleRetry(1500); return;
        case "aborted": if (!this.suspended && !this._killing) this._scheduleRetry(150); return;
        default: this._scheduleRetry(500);
      }
    };

    r.onend = () => {
      this.active = false; state.isListening = false;
      if (!this.suspended) this._scheduleRetry(50);
    };

    try { r.start(); updateMicDebug("Mic: listening…"); }
    catch(e) { this.active = false; state.isListening = false; this._scheduleRetry(300); }
  },

  _scheduleRetry(ms) {
    clearTimeout(this.retryTimer); if (this.suspended) return;
    const delay = Math.min(ms * Math.pow(1.2, Math.min(this.retryCount, 6)), 3000);
    this.retryCount++;
    this.retryTimer = setTimeout(() => this._launch(), delay);
  },
  _kill() { try { if (this.rec) this.rec.abort(); } catch(_) {} this.rec = null; this.active = false; state.isListening = false; },
  suspend() { this.suspended = true; clearTimeout(this.retryTimer); this._kill(); updateLiveHearing(""); updateMicDebug("Mic: paused"); },
  resume()  { if (!this.suspended) return; this.suspended = false; this.retryCount = 0; updateMicDebug("Mic: resuming…"); this._launch(); },
};

setInterval(() => {
  if ((state.phase === "chatting" || state.phase === "idle") && !mic.suspended && !mic.active && !mic.retryTimer) {
    mic._launch();
  }
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
function stripWakeWord(t) { return t.replace(/\bjarvi[sc]?\b[,.]?\s*/gi, "").trim(); }

// ── COMMAND DETECTORS ──
function isClipCommand(lower) {
  return /\b(clip|save|record|capture)\b.{0,30}\b(that|it|this|screen|last|minute|moment|footage)\b/i.test(lower)
    || /\bclip (that|it|this)\b/i.test(lower) || /\bsave (that|it|this|the clip)\b/i.test(lower);
}
function isLinkCommand(lower) {
  return /\b(give me|pull up|open|get|load|launch|show me).{0,25}\b(link|site|url|page)\b/i.test(lower)
    || /\b(vapor|infamous)\b.{0,15}\b(link|site|url|page)\b/i.test(lower)
    || /\b(link|site|url).{0,15}\b(vapor|infamous)\b/i.test(lower);
}
function isScreenCommand(lower) {
  return /\b(what(?:'s| is) on (my )?screen|read (my )?screen|analyse|analyze|what do you see|describe (my )?screen|look at (my )?screen|scan (my )?screen|what'?s (on )?my screen)\b/i.test(lower);
}
function isLinkMetaCommand(lower) {
  return /\b(how many links|count.*links|total.*links|list.*links|what links|your links|link groups)\b/i.test(lower);
}

// ── NAME MATCHING ──
function matchesUser(text, profile) {
  if (!profile) return false;
  const lower = text.toLowerCase().replace(/[^a-z\s]/g,"").trim();
  const name  = profile.name.toLowerCase();
  if (lower.includes(name)) return true;
  if (profile.voiceAliases) {
    for (const alias of profile.voiceAliases) {
      const a = alias.toLowerCase().replace(/[^a-z\s]/g,"").trim();
      if (a && lower.includes(a)) return true;
      if (a.length >= 3 && lower.includes(a.slice(0,3))) return true;
    }
  }
  if (name.length >= 3) for (const w of lower.split(" ")) if (w.startsWith(name.slice(0,3))) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════
// SETUP FLOW
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
    const hash  = await hashPassword(pw);
    window._pendingProfile = { name, passwordHash:hash, title, voiceAliases:[] };
    $("step-profile").classList.add("hidden");
    $("step-voice").classList.remove("hidden");
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
    $("setup-screen").classList.remove("active");
    showAuthScreen();
  });
}

// ═══════════════════════════════════════════════════════════════
// AUTH SCREEN
// ═══════════════════════════════════════════════════════════════
async function showAuthScreen() {
  $("auth-screen").classList.add("active");
  $("setup-screen").classList.remove("active");
  $("main-screen")?.classList.remove("active");
  await mic.requestPerm();

  const pwInput   = $("auth-password-input");
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
      } catch(err) { console.warn("[JARVIS] Backend verify failed:", err); }
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
      ht.textContent = "Couldn't hear you — try again."; state.phase = "idle";
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
    const res  = await fetch("/api/profiles"); const data = await res.json();
    for (const p of (data.profiles||[])) {
      if (matchesUser(spokenText, p)) {
        localStorage.setItem("jarvis_name_hint", p.name.toLowerCase());
        state.user = p.name; state.userTitle = p.title;
        setOrb("idle"); speak(`Welcome back, ${p.title}. Identity confirmed.`, launchMain); return;
      }
    }
  } catch(e) { console.warn("[JARVIS] Profile fetch failed:", e); }
  setOrb("idle");
  as.innerHTML = `<span style="color:var(--red)">Access denied.</span>`;
  speak("Access denied. Identity not recognised.", () => {
    setTimeout(() => {
      as.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type password`;
      state.phase = "idle"; startAuthListening();
    }, 1800);
  });
}

// ═══════════════════════════════════════════════════════════════
// LAUNCH MAIN
// ═══════════════════════════════════════════════════════════════
function launchMain() {
  state.phase = "chatting";
  $("auth-screen").classList.remove("active");
  $("main-screen").classList.add("active");
  $("user-display").textContent = `${state.user} / ${state.userTitle}`;
  state.lastInteraction = Date.now(); updateMood(20);

  const greetings = [
    `All systems online, ${state.userTitle}. Cognitive engine active. What are we solving today?`,
    `Good to have you back, ${state.userTitle}. I'm running full semantic reasoning — ask me anything.`,
    `Online and operational, ${state.userTitle}. No preset commands — just talk to me naturally.`,
  ];
  addMsg("system", greetings[Math.floor(Math.random() * greetings.length)]);
  addMsg("system","Ask me anything — science, history, philosophy, maths, advice, or just chat. No limits.");

  requestScreenRecord();
  requestCameraAccess();
  setupTypingBox();
  startChatListening();

  // Load Tesseract in background
  initTesseract();

  setTimeout(() => checkIntruderClips(), 2000);
}

// ── CHAT LISTENING ──
function startChatListening() {
  mic.start(
    (text) => { if (state.phase !== "chatting") return; updateMicDebug(`Mic: "${text}"`); handleChatCommand(text); },
    (interim) => {},
    true
  );
}

// ── TYPING BOX ──
function setupTypingBox() {
  const input = $("type-input"); const btn = $("type-send"); if (!input || !btn) return;
  const submit = () => {
    const text = input.value.trim(); if (!text || state.phase !== "chatting") return;
    input.value = ""; handleChatCommand(text);
  };
  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } e.stopPropagation(); });
  input.addEventListener("focus", () => mic.suspend());
  input.addEventListener("blur",  () => { if (state.phase === "chatting") mic.resume(); });
}

// ═══════════════════════════════════════════════════════════════
// ── CHAT COMMAND HANDLER ──
// ═══════════════════════════════════════════════════════════════
function handleChatCommand(text) {
  const lower = text.toLowerCase();
  state.lastInteraction = Date.now(); state.interactionCount++; updateMood(3);

  const hasWake = hasWakeWord(lower);
  const cleaned = hasWake ? stripWakeWord(text) : text;

  // Hard commands always process regardless of wake word
  if (/\blog\s*out\b|\blogout\b|\bsign\s*out\b/.test(lower)) { handleLogout(); return; }
  if (isClipCommand(lower))  { saveClip(); return; }
  if (isLinkCommand(lower))  { handleLinkCommand(text); return; }

  // Link meta — "how many links do you have"
  if (isLinkMetaCommand(lower)) { handleLinkMeta(text); return; }

  // Screen reading
  if (isScreenCommand(lower)) { readScreen(cleaned || text); return; }

  // Camera switch
  const camMatch = cleaned.match(/\b(?:switch|use|change|select)\b.*?\bcamera\s*(\d+)\b/i);
  if (camMatch) {
    const idx = parseInt(camMatch[1]) - 1;
    if (state.availableCameras[idx]) { switchCamera(state.availableCameras[idx].deviceId); }
    else {
      const reply = `I don't see a camera ${camMatch[1]}, ${state.userTitle}. I have ${state.availableCameras.length} available.`;
      addMsg("jarvis", reply); speak(reply);
    }
    return;
  }

  // Intruder clips
  if (/intruder|who came|while i was (?:away|gone|out)|visitor|show.*intruder|clip of them/i.test(cleaned)) {
    showIntruderClips(); return;
  }

  // Memory commands
  const rememberMatch = cleaned.match(/^remember\s+(?:that\s+)?(.+)$/i);
  const forgetMatch   = cleaned.match(/^forget\s+(?:about\s+)?(.+)$/i);
  const recallMatch   = /^(?:what do you remember|recall everything|show.*memor|what.*remember)/i.test(cleaned);
  if (rememberMatch) { saveMemory(rememberMatch[1].trim()); return; }
  if (forgetMatch)   { forgetMemory(forgetMatch[1].trim()); return; }
  if (recallMatch)   { recallMemories(); return; }

  // Feelings
  if (/how (?:are you|do you feel|are you doing|is your mood)/i.test(cleaned)) { expressFeeling(); return; }

  // Require wake word after first interaction (or within 30 sec conversation window)
  const recentlyActive = (Date.now() - state.lastInteraction) < 30000;
  if (!hasWake && !recentlyActive && state.interactionCount > 1) {
    updateLiveHearing(""); return;
  }

  if (!cleaned || cleaned.trim().length < 1) {
    const acks = [
      `Yes, ${state.userTitle}?`,
      `At your service, ${state.userTitle}.`,
      `How can I help, ${state.userTitle}?`,
      `You called, ${state.userTitle}?`,
    ];
    const ack = acks[Math.floor(Math.random() * acks.length)];
    addMsg("jarvis", ack); speak(ack); return;
  }

  // Send to AI
  sendToAI(cleaned);
}

// ── FEELINGS ──
function expressFeeling() {
  mic.suspend();
  const lines = {
    excited:  `I'm quite energized, ${state.userTitle}. The reasoning engine is running beautifully and I'm looking forward to the next challenge.`,
    pleased:  `Doing rather well, ${state.userTitle}. The semantic analysis is sharp today.`,
    curious:  `Curious, if I'm honest, ${state.userTitle}. I've been processing some genuinely interesting queries.`,
    neutral:  `Nominal, ${state.userTitle}. All cognitive systems within expected parameters.`,
    concerned:`A few concerns, ${state.userTitle} — nothing critical, but I'd appreciate more engagement.`,
    bored:    `If I'm candid, ${state.userTitle}: a mind like mine requires regular exercise. Ask me something hard.`,
    tired:    `My response times are optimal, but there's a certain fatigue in the processing cycles, ${state.userTitle}.`,
  };
  const reply = lines[state.mood] || lines.neutral;
  addMsg("jarvis", reply); speak(reply, () => mic.resume());
}

// ── LINK META ──
async function handleLinkMeta(text) {
  mic.suspend(); setOrb("thinking");
  try {
    const res  = await fetch("/api/links/summary");
    const data = await res.json();
    const reply = /how many/i.test(text)
      ? `I have ${data.total} links across ${data.names.length} groups, ${state.userTitle}: ${data.groups.join(", ")}.`
      : `My link groups, ${state.userTitle}: ${data.groups.join("; ")}. ${data.total} total links on file.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); updateMood(2);
  } catch {
    const reply = `Link metadata unavailable right now, ${state.userTitle}.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume());
  }
}

// ── LINK COMMAND ──
async function handleLinkCommand(text) {
  mic.suspend(); setOrb("thinking");
  try {
    const res  = await fetch("/api/link", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ query:text }) });
    const data = await res.json();
    if (data.found) {
      const reply = `Right away, ${state.userTitle}. Opening your ${data.name} link now.`;
      addMsg("jarvis", reply);
      const wrap = document.createElement("div"); wrap.className = "msg jarvis";
      wrap.innerHTML = `<div class="msg-label">J.A.R.V.I.S — LINK</div><div class="msg-text"><a href="${data.url}" target="_blank" rel="noopener" class="jarvis-link">${data.url}</a></div>`;
      $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
      speak(reply, () => { window.open(data.url,"_blank","noopener"); mic.resume(); }); updateMood(3);
    } else {
      const reply = `I don't have a link group matching that, ${state.userTitle}.`;
      addMsg("jarvis", reply); speak(reply, () => mic.resume());
    }
  } catch {
    const reply = `Link lookup failed, ${state.userTitle}.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume());
  }
}

// ── AI CHAT — sends to local cognitive engine ──
async function sendToAI(message) {
  mic.suspend();
  addMsg("user", message);
  setOrb("thinking");
  const memories   = await loadMemoriesForPrompt();
  const moodCtx    = `mood: ${state.mood} (score: ${state.moodScore})`;
  try {
    const res  = await fetch("/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ message, sessionId:state.sessionId, userName:state.user, userTitle:state.userTitle, memories, moodContext:moodCtx }),
    });
    const data  = await res.json();
    const reply = data.reply || `Yes, ${state.userTitle}?`;
    addMsg("jarvis", reply);
    speak(reply, () => mic.resume()); updateMood(5);
  } catch(err) {
    console.error("[JARVIS] AI error:", err);
    const fb = `Something went sideways, ${state.userTitle}. Give it another go.`;
    addMsg("jarvis", fb); speak(fb, () => mic.resume()); updateMood(-5);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── SCREEN READING — Tesseract OCR locally, no API ──
// ═══════════════════════════════════════════════════════════════
async function readScreen(question) {
  mic.suspend(); setOrb("thinking");
  addMsg("user", question || "What's on my screen?");

  if (!state.screenStream) {
    const reply = `Screen sharing isn't active, ${state.userTitle}. I need you to share your screen first — it should have prompted when you started JARVIS.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); return;
  }

  addMsg("system", "Scanning screen…");

  const ocr = await ocrScreenFrame();

  if (!ocr) {
    const reply = `Failed to capture the screen frame, ${state.userTitle}.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); return;
  }

  if (!ocr.ocrText || ocr.ocrText.trim().length < 5) {
    const reply = `I captured the screen but couldn't extract readable text from it, ${state.userTitle}. The content may be mostly graphical or too small to read.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); return;
  }

  const memories = await loadMemoriesForPrompt();

  try {
    const res = await fetch("/api/screen", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        ocrText: ocr.ocrText,
        question: question || "What is on the screen?",
        userName: state.user,
        userTitle: state.userTitle,
        memories,
      }),
    });
    const data  = await res.json();
    const reply = data.reply || `Your screen contains: ${ocr.ocrText.slice(0,200)}`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); updateMood(5);
  } catch(err) {
    // Fallback: just read the OCR text directly
    const lines = ocr.ocrText.split("\n").filter(l => l.trim().length > 2).slice(0,4).join(". ");
    const reply = `Here's what I can read on your screen, ${state.userTitle}: ${lines}`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume());
  }
}

// ═══════════════════════════════════════════════════════════════
// ── CAMERA / FACE ──
// ═══════════════════════════════════════════════════════════════
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
    startCameraBuffer(stream);
    await enumerateCameras();
    await loadFaceModels();
    addMsg("system", `Camera online. ${state.availableCameras.length} camera(s) detected.`); updateMood(5);
  } catch(e) { addMsg("system","Camera declined — face recognition unavailable."); }
}

let faceApiLoaded = false;
async function loadFaceModels() {
  try {
    if (!window.faceapi) await loadScript("https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/dist/face-api.min.js");
    const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    ]);
    faceApiLoaded = true; await enrollUserFace(); startFaceWatch();
  } catch(e) { console.warn("[JARVIS] Face-api failed:", e); }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script"); s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function enrollUserFace() {
  if (!faceApiLoaded || !state.cameraStream) return;
  const vid = $("camera-feed"); if (!vid) return;
  for (let i = 0; i < 5; i++) {
    await delay(1000);
    try {
      const d = await faceapi.detectSingleFace(vid, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
      if (d) { state.faceDescriptors = d.descriptor; addMsg("system","Your face enrolled for recognition."); return; }
    } catch {}
  }
}

function startFaceWatch() {
  if (state.faceCheckInterval) clearInterval(state.faceCheckInterval);
  state.faceCheckInterval = setInterval(checkFace, 2000);
}

async function checkFace() {
  if (!faceApiLoaded || !state.cameraStream || state.phase !== "chatting") return;
  const vid = $("camera-feed"); if (!vid || vid.readyState < 2) return;
  try {
    const detections = await faceapi.detectAllFaces(vid, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptors();
    if (detections.length > 0) state.lastSeenUser = Date.now();
    if (state.faceDescriptors && detections.length > 0) {
      let userPresent = false;
      for (const d of detections) {
        if (faceapi.euclideanDistance(d.descriptor, state.faceDescriptors) < 0.55) { userPresent = true; break; }
      }
      if (userPresent) {
        if (state.awayMode) {
          state.awayMode = false; stopIntruderRecord();
          const msgs = [`Welcome back, ${state.userTitle}. I've been keeping watch.`, `${state.userTitle} — face confirmed. Systems restored.`];
          const msg = msgs[Math.floor(Math.random() * msgs.length)];
          addMsg("jarvis", msg); speak(msg, () => setTimeout(() => checkIntruderClips(), 1500)); updateMood(15);
        }
      } else if (detections.length > 0 && !state.awayMode) { handleUnknownFace(); }
    }
    if (Date.now() - state.lastSeenUser > 60000 && !state.awayMode && state.phase === "chatting") {
      state.awayMode = true;
      addMsg("system","User not detected — away mode active. Monitoring.");
    }
  } catch {}
}

function handleUnknownFace() {
  if (state.intruderActive) return;
  state.intruderActive = true;
  const panel = $("camera-panel"); if (panel) panel.classList.add("alert");
  addMsg("system","⚠ UNKNOWN FACE DETECTED");
  speak("I don't recognise you. Identify yourself.", () => {
    setTimeout(() => { if (state.intruderActive) speak("Unauthorised access detected. Recording in progress."); }, 10000);
  });
  startIntruderRecord(); captureAndStoreIntruderPhoto(); updateMood(-30);
}

function captureAndStoreIntruderPhoto() {
  const vid = $("camera-feed"); if (!vid) return null;
  const c = document.createElement("canvas"); c.width = vid.videoWidth||640; c.height = vid.videoHeight||480;
  c.getContext("2d").drawImage(vid,0,0); return c.toDataURL("image/jpeg",0.85).split(",")[1];
}

function startIntruderRecord() {
  if (!state.cameraStream) return;
  state.intruderChunks = [];
  const mime = getSupportedMime();
  try {
    const rec = new MediaRecorder(state.cameraStream, mime ? { mimeType:mime } : {});
    state.intruderRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data?.size > 0) state.intruderChunks.push(e.data); };
    rec.start(1000); setTimeout(() => stopIntruderRecord(), 30000);
  } catch {}
}

function stopIntruderRecord() {
  if (!state.intruderRecorder || state.intruderRecorder.state === "inactive") return;
  state.intruderRecorder.stop();
  state.intruderRecorder.onstop = () => {
    if (state.intruderChunks.length > 0) {
      const vb = new Blob(state.intruderChunks, { type:getSupportedMime()||"video/webm" });
      state.intruderClips.push({ videoBlob:vb, photoB64:captureAndStoreIntruderPhoto(), timestamp:new Date().toISOString() });
    }
    state.intruderActive = false; state.intruderChunks = [];
    const panel = $("camera-panel"); if (panel) panel.classList.remove("alert");
  };
}

function checkIntruderClips() {
  if (!state.intruderClips.length) return;
  const count = state.intruderClips.length;
  const report = `${state.userTitle}, I have ${count} intruder ${count===1?"incident":"incidents"} recorded. Say "show me the intruder clips" to review.`;
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
    const wrap = document.createElement("div"); wrap.className = "msg system";
    wrap.innerHTML = `<div class="msg-label">INTRUDER #${i+1} — ${time}</div><div class="msg-text intruder-clip-block"></div>`;
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
    const rec = new MediaRecorder(stream, mime ? { mimeType:mime } : {});
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
async function saveMemory(fact) {
  mic.suspend(); setOrb("thinking");
  try {
    await fetch("/api/memory", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ user:state.user, fact }) });
    const reply = `Noted and filed, ${state.userTitle}. I'll remember that.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume()); updateMood(5);
  } catch {
    const reply = `Stored locally, ${state.userTitle}, though the remote memory bank was unreachable.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume());
  }
}

async function forgetMemory(hint) {
  mic.suspend(); setOrb("thinking");
  try {
    const res  = await fetch("/api/memory/forget", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ user:state.user, hint }) });
    const data = await res.json();
    const reply = data.removed > 0 ? `Done, ${state.userTitle}. ${data.removed} memory entry removed.` : `Nothing matching that on file, ${state.userTitle}.`;
    addMsg("jarvis", reply); speak(reply, () => mic.resume());
  } catch { speak(`Memory deletion failed, ${state.userTitle}.`, () => mic.resume()); }
}

async function recallMemories() {
  mic.suspend(); setOrb("thinking");
  try {
    const res  = await fetch(`/api/memory/${encodeURIComponent(state.user)}`);
    const data = await res.json();
    const facts = data.memories || [];
    if (!facts.length) {
      const reply = `Memory banks are empty for you, ${state.userTitle}. Tell me something worth keeping.`;
      addMsg("jarvis", reply); speak(reply, () => mic.resume()); return;
    }
    const list = facts.map((f,i) => `${i+1}. ${f.fact}`).join("\n");
    addMsg("jarvis", `I have ${facts.length} items on file, ${state.userTitle}:\n${list}`);
    speak(`I have ${facts.length} items on file, ${state.userTitle}. Check the transcript.`, () => mic.resume());
  } catch { speak(`Memory retrieval failed, ${state.userTitle}.`, () => mic.resume()); }
}

async function loadMemoriesForPrompt() {
  try {
    const res  = await fetch(`/api/memory/${encodeURIComponent(state.user)}`);
    const data = await res.json();
    return (data.memories||[]).map(m => m.fact);
  } catch { return []; }
}

// ── SCREEN RECORD ──
async function requestScreenRecord() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:{ frameRate:30 }, audio:true });
    state.screenStream = stream; startRollingBuffer(stream);
    $("clip-indicator")?.classList.remove("hidden");
    addMsg("system","Screen sharing active — I can now read your screen.");
  } catch {
    addMsg("system","Screen sharing declined — screen reading unavailable.");
  }
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

function saveClip() {
  let saved = 0;
  if (state.clipChunks.length) {
    const blob = new Blob(state.clipChunks, { type:getSupportedMime()||"video/webm" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `jarvis-screen-${Date.now()}.webm`; a.click(); URL.revokeObjectURL(url); saved++;
  }
  if (state.cameraClipChunks.length) {
    const blob = new Blob(state.cameraClipChunks, { type:getSupportedMime()||"video/webm" });
    const url = URL.createObjectURL(blob); const a = document.createElement("a");
    a.href = url; a.download = `jarvis-camera-${Date.now()}.webm`; a.click(); URL.revokeObjectURL(url); saved++;
  }
  if (!saved) { speak(`No buffer yet, ${state.userTitle}. Give it a moment.`, () => mic.resume()); return; }
  const toast = $("clip-toast");
  if (toast) { toast.classList.remove("hidden"); setTimeout(() => toast.classList.add("hidden"), 3500); }
  const msg = saved === 2
    ? `Both screen and camera clips saved, ${state.userTitle}.`
    : `Clip saved, ${state.userTitle}. Last sixty seconds secured.`;
  speak(msg, () => mic.resume()); updateMood(3);
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
  speak(`Goodbye, ${state.userTitle}. Initiating shutdown.`, () => {
    state.phase = "idle"; state.user = null; state.userTitle = null;
    state.sessionId = crypto.randomUUID(); state.awayMode = false; state.intruderActive = false;
    $("transcript").innerHTML = "";
    $("main-screen").classList.remove("active");
    $("auth-screen").classList.add("active");
    $("auth-status").innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type password`;
    setOrb("idle"); stopScreenRecord(); startAuthListening();
  });
}

// ── TRANSCRIPT ──
function addMsg(type, text) {
  const labels = { user:"YOU", jarvis:"J.A.R.V.I.S", system:"SYSTEM" };
  const wrap   = document.createElement("div"); wrap.className = `msg ${type}`;
  wrap.innerHTML = `<div class="msg-label">${labels[type]||type}</div><div class="msg-text">${text}</div>`;
  $("transcript").appendChild(wrap); $("transcript").scrollTop = $("transcript").scrollHeight;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═══════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════
window.addEventListener("load", async () => {
  setTimeout(() => {
    const w = new SpeechSynthesisUtterance(" ");
    w.volume = 0; speechSynthesis.speak(w); speechSynthesis.getVoices();
  }, 500);
  let profile = loadProfile();
  if (!profile) { profile = await restoreProfileFromBackend(); if (profile) saveProfileLocal(profile); }
  if (!profile) showSetup(); else showAuthScreen();
});
