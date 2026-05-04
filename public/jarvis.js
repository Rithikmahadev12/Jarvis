// ── STATE ──
const state = {
  phase: "idle",
  user: null,
  userTitle: null,
  sessionId: crypto.randomUUID(),
  synth: window.speechSynthesis,
  recognition: null,
  isListening: false,
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
  const el = document.getElementById("mood-display");
  if (el) {
    const icons = { pleased:"😊", excited:"⚡", curious:"🔍", concerned:"⚠️", bored:"💤", tired:"🔋", neutral:"●" };
    el.textContent = `${icons[state.mood] || "●"} ${state.mood.toUpperCase()}`;
  }
}

setInterval(() => {
  if (state.moodScore > 0) updateMood(-1);
  else if (state.moodScore < 0) updateMood(1);
  const idleMs = Date.now() - state.lastInteraction;
  if (idleMs > 300000) updateMood(-2);
}, 10000);

// ── PROFILE ──
function loadProfile() {
  try { return JSON.parse(localStorage.getItem("jarvis_profile")) || null; }
  catch { return null; }
}
function saveProfileLocal(p) { localStorage.setItem("jarvis_profile", JSON.stringify(p)); }

async function saveProfileRemote(p) {
  try {
    await fetch("/api/register", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(p) });
  } catch(e) { console.warn("[JARVIS] Could not save profile:", e); }
}

async function restoreProfileFromBackend() {
  const nameHint = localStorage.getItem("jarvis_name_hint");
  if (!nameHint) return null;
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(nameHint)}`);
    const data = await res.json();
    if (data.found) {
      const localHash = localStorage.getItem("jarvis_pw_hash");
      return { ...data.profile, passwordHash: localHash || "" };
    }
  } catch(e) { console.warn("[JARVIS] Backend restore failed:", e); }
  return null;
}

async function hashPassword(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

const $ = id => document.getElementById(id);

// ── SPEAK ──
function speak(text, onEnd) {
  state.synth.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.93; utter.pitch = 0.8; utter.volume = 1;
  const voices = state.synth.getVoices();
  const pick =
    voices.find(v => v.name === "Google UK English Male") ||
    voices.find(v => v.name.includes("Daniel")) ||
    voices.find(v => v.lang === "en-GB") ||
    voices.find(v => v.lang.startsWith("en"));
  if (pick) utter.voice = pick;
  utter.onstart = () => setOrb("speaking");
  utter.onend   = () => { setOrb("idle"); if (onEnd) onEnd(); };
  utter.onerror = () => { setOrb("idle"); if (onEnd) onEnd(); };
  state.synth.speak(utter);
}

// ── ORB ──
function setOrb(s) {
  const orb = $("orb");
  if (!orb) return;
  orb.className = "orb" + (s !== "idle" ? " " + s : "");
  const labels = { idle:"STANDBY", listening:"LISTENING", thinking:"PROCESSING", speaking:"SPEAKING" };
  const st = $("status-text");
  if (st) st.textContent = labels[s] || "STANDBY";
}

// ── RECOGNITION ──
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function listen(onResult, continuous, onInterim) {
  if (!SR) { addMsg("system","Speech recognition requires Chrome."); return; }
  stopListening();
  const r = new SR();
  r.continuous = !!continuous;
  r.interimResults = !!onInterim;
  r.lang = "en-US";
  state.recognition = r;
  state.isListening = true;
  const md = $("mic-debug");

  r.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    const text   = result[0].transcript.trim();
    if (result.isFinal) {
      console.log("[heard final]", text);
      if (md) md.textContent = "Mic: " + text;
      onResult(text);
    } else if (onInterim) {
      onInterim(text);
    }
  };
  r.onerror = (e) => {
    state.isListening = false;
    if (e.error === "not-allowed") addMsg("system","Microphone permission denied.");
  };
  r.onend = () => {
    state.isListening = false;
    if (state.phase === "idle" || state.phase === "chatting") {
      setTimeout(startIdleLoop, 300);
    }
  };
  setOrb("listening");
  r.start();
}

function stopListening() {
  if (state.recognition) {
    try { state.recognition.abort(); } catch(_) {}
    state.recognition = null;
  }
  state.isListening = false;
}

// ── WAKE WORD ──
function hasWakeWord(lower) { return /\bjarvi[sc]?\b/.test(lower); }
function stripWakeWord(text) { return text.replace(/\bjarvi[sc]?\b[,.]?\s*/gi, "").trim(); }

// ── CLIP DETECTION ──
function isClipCommand(lower) {
  return /\b(clip|save|record|capture)\b.{0,30}\b(that|it|this|screen|last|minute|moment|footage)\b/i.test(lower)
    || /\b(do me a favor|can you|please|go ahead|hey).{0,20}\bclip\b/i.test(lower)
    || /\bclip (that|it|this)\b/i.test(lower)
    || /\bsave (that|it|this|the clip|the footage)\b/i.test(lower);
}

// ── LINK DETECTION ──
function isLinkCommand(lower) {
  return /\b(give me|pull up|open|get|load|launch|bring up|show me).{0,25}\b(link|site|url|page)\b/i.test(lower)
    || /\b(vapor|infamous)\b.{0,15}\b(link|site|url|page)\b/i.test(lower)
    || /\b(link|site|url).{0,15}\b(vapor|infamous)\b/i.test(lower)
    || /\b(vapor|infamous)\b.{0,10}\b(link|site)\b/i.test(lower);
}

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
      if (a.length >= 3 && lower.includes(a.slice(0,3))) return true;
    }
  }
  if (name.length >= 3) {
    const words = lower.split(" ");
    for (const w of words) {
      if (w.startsWith(name.slice(0,3))) return true;
    }
  }
  return false;
}

// ── SETUP FLOW ──
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
      if (samplesDone >= 3) {
        $("btn-record-sample").textContent = "✓ SAMPLES RECORDED";
        $("btn-record-sample").disabled = true;
        setTimeout(() => completeSetup(), 800);
      }
    };
    r.onerror = () => { $("voice-sample-status").textContent = "Didn't catch that — try again"; $("record-bars").classList.add("hidden"); };
    r.onend   = () => $("record-bars").classList.add("hidden");
    r.start();
  });

  $("btn-skip-voice").addEventListener("click", () => completeSetup());
}

function completeSetup() {
  const p = window._pendingProfile;
  $("step-voice").classList.add("hidden");
  $("step-done").classList.remove("hidden");
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

// ── AUTH SCREEN ──
async function showAuthScreen() {
  $("auth-screen").classList.add("active");
  $("setup-screen").classList.remove("active");
  $("main-screen")?.classList.remove("active");

  const pwInput = $("auth-password-input");
  const newPwInput = pwInput.cloneNode(true);
  pwInput.parentNode.replaceChild(newPwInput, pwInput);

  newPwInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const profile = loadProfile();
    const hash = await hashPassword(newPwInput.value);
    newPwInput.value = "";

    if (profile && hash === profile.passwordHash) {
      state.user = profile.name; state.userTitle = profile.title;
      speak(`Welcome back, ${profile.title}.`, launchMain);
      return;
    }

    const nameHint = localStorage.getItem("jarvis_name_hint");
    if (nameHint) {
      try {
        const res = await fetch("/api/verify", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({ name: nameHint, passwordHash: hash }),
        });
        const data = await res.json();
        if (data.authorized) {
          const restored = { ...data.profile, passwordHash: hash };
          saveProfileLocal(restored);
          localStorage.setItem("jarvis_pw_hash", hash);
          state.user = data.profile.name; state.userTitle = data.profile.title;
          speak(`Welcome back, ${data.profile.title}. Profile restored.`, launchMain);
          return;
        }
      } catch(err) { console.warn("[JARVIS] Backend verify failed:", err); }
    }

    const as = $("auth-status");
    as.innerHTML = `<span style="color:var(--red)">Wrong password.</span>`;
    setTimeout(() => { as.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type password`; }, 2000);
  });

  startIdleLoop();
}

// ── IDLE LOOP ──
function startIdleLoop() {
  if (state.isListening) return;
  // Don't restart if user is focused on the typing box
  if (document.activeElement && document.activeElement.id === "type-input") return;
  listen((text) => {
    const lower = text.toLowerCase();
    const md = $("mic-debug");
    if (md) md.textContent = "Mic: " + text;
    if (state.phase === "idle") {
      const hasLogin = lower.includes("log") || lower.includes("login") || lower.includes("sign") || lower.includes("in");
      if (hasWakeWord(lower) && hasLogin) startVoiceAuth();
    } else if (state.phase === "chatting") {
      handleChatCommand(text);
    }
  }, true, (interim) => {
    const md = $("mic-debug");
    if (md) md.textContent = "Mic: " + interim + "…";
  });
}

// ── VOICE AUTH ──
function startVoiceAuth() {
  state.phase = "awaiting_name";
  stopListening();
  const as = $("auth-status"), ap = $("auth-prompt"), al = $("auth-listening"), ht = $("heard-text");
  as.style.display = "none";
  ap.classList.remove("hidden"); al.classList.remove("hidden");
  ht.textContent = "Listening…";

  speak("Identify yourself.", () => {
    const r = new SR();
    r.continuous = false; r.interimResults = true; r.lang = "en-US";
    state.recognition = r; state.isListening = true;
    r.onresult = (e) => {
      const result = e.results[0];
      const text   = result[0].transcript.trim();
      ht.textContent = text;
      if (result.isFinal) {
        state.isListening = false;
        ap.classList.add("hidden"); al.classList.add("hidden");
        as.style.display = "";
        checkVoiceAuth(text);
      }
    };
    r.onerror = () => {
      state.isListening = false;
      ht.textContent = "Couldn't hear you.";
      state.phase = "idle";
      setTimeout(startIdleLoop, 1000);
    };
    r.onend = () => { state.isListening = false; };
    setOrb("listening");
    r.start();
  });
}

async function checkVoiceAuth(spokenText) {
  const profile = loadProfile();
  const as = $("auth-status");
  as.textContent = `Heard: "${spokenText}" — verifying…`;
  setOrb("thinking");

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
  } catch(e) { console.warn("[JARVIS] Profile list fetch failed:", e); }

  setOrb("idle");
  as.innerHTML = `<span style="color:var(--red)">Access denied.</span>`;
  speak("Access denied. Identity not recognized.", () => {
    setTimeout(() => {
      as.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type password`;
      state.phase = "idle";
      startIdleLoop();
    }, 1800);
  });
}

// ── LAUNCH MAIN ──
function launchMain() {
  state.phase = "chatting";
  $("auth-screen").classList.remove("active");
  $("main-screen").classList.add("active");
  $("user-display").textContent = `${state.user} / ${state.userTitle}`;
  state.lastInteraction = Date.now();
  updateMood(20);

  const greetings = [
    `All systems online, ${state.userTitle}. Shall we get to work?`,
    `Good to have you back, ${state.userTitle}. Systems are primed.`,
    `Online and fully operational, ${state.userTitle}. What do you need?`,
  ];
  addMsg("system", greetings[Math.floor(Math.random() * greetings.length)]);

  requestScreenRecord();
  requestCameraAccess();
  setupTypingBox();
  startIdleLoop();
  setTimeout(() => checkIntruderClips(), 2000);
}

// ── TYPING BOX ──
function setupTypingBox() {
  const input = $("type-input");
  const btn   = $("type-send");
  if (!input || !btn) return;

  const submit = () => {
    const text = input.value.trim();
    if (!text || state.phase !== "chatting") return;
    input.value = "";
    handleChatCommand(text);
  };

  btn.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); submit(); }
    e.stopPropagation();
  });

  // Pause mic while typing, resume on blur
  input.addEventListener("focus", () => stopListening());
  input.addEventListener("blur",  () => {
    if (state.phase === "chatting" && !state.isListening) setTimeout(startIdleLoop, 400);
  });
}

// ── LINK COMMANDS ──
async function handleLinkCommand(text) {
  stopListening();
  setOrb("thinking");
  try {
    const res  = await fetch("/api/link", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ query: text }),
    });
    const data = await res.json();
    if (data.found) {
      const reply = `Right away, ${state.userTitle}. Opening your ${data.name} link now.`;
      addMsg("jarvis", reply);
      const wrap = document.createElement("div");
      wrap.className = "msg jarvis";
      wrap.innerHTML = `<div class="msg-label">J.A.R.V.I.S — LINK</div><div class="msg-text"><a href="${data.url}" target="_blank" rel="noopener" class="jarvis-link">${data.url}</a></div>`;
      $("transcript").appendChild(wrap);
      $("transcript").scrollTop = $("transcript").scrollHeight;
      speak(reply, () => {
        window.open(data.url, "_blank", "noopener");
        startIdleLoop();
      });
      updateMood(3);
    } else {
      const reply = `I don't have a link group matching that, ${state.userTitle}. Available groups: vapor.`;
      addMsg("jarvis", reply);
      speak(reply, () => startIdleLoop());
    }
  } catch {
    const reply = `Link lookup failed, ${state.userTitle}.`;
    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
  }
}

// ── CHAT ──
function handleChatCommand(text) {
  const lower = text.toLowerCase();
  state.lastInteraction = Date.now();
  state.interactionCount++;
  updateMood(3);

  const hasWake = hasWakeWord(lower);
  const cleaned = hasWake ? stripWakeWord(text) : text;

  if (lower.includes("log out") || lower.includes("logout") || lower.includes("sign out")) {
    handleLogout(); return;
  }
  if (isClipCommand(lower)) { saveClip(); return; }
  if (isLinkCommand(lower)) { handleLinkCommand(text); return; }

  // Require wake word OR within 30s of last interaction
  const recentlyActive = (Date.now() - state.lastInteraction) < 30000;
  if (!hasWake && !recentlyActive && state.interactionCount > 1) {
    const lm = $("live-mic");
    if (lm) { lm.classList.remove("hidden"); lm.textContent = "Say 'Jarvis' first (or type in the box below)"; }
    return;
  }

  const lm = $("live-mic");
  if (lm) lm.classList.add("hidden");

  if (!cleaned) {
    const acks = [
      `Yes, ${state.userTitle}?`,
      `At your service, ${state.userTitle}.`,
      `How can I help, ${state.userTitle}?`,
      `You rang, ${state.userTitle}?`,
    ];
    const ack = acks[Math.floor(Math.random() * acks.length)];
    addMsg("jarvis", ack); speak(ack, () => startIdleLoop()); return;
  }

  const rememberMatch = cleaned.match(/^remember\s+(?:that\s+)?(.+)$/i);
  const forgetMatch   = cleaned.match(/^forget\s+(?:about\s+)?(.+)$/i);
  const recallMatch   = /^(what do you remember|recall everything|show.*memor|what.*remember)/i.test(cleaned);
  if (rememberMatch) { saveMemory(rememberMatch[1].trim()); return; }
  if (forgetMatch)   { forgetMemory(forgetMatch[1].trim()); return; }
  if (recallMatch)   { recallMemories(); return; }

  if (/how (are you|do you feel|are you doing|is your mood)/i.test(cleaned)) { expressFeeling(); return; }

  if (/intruder|who came|while i was (away|gone|out)|visitor|show me (the|their|who)|clip of them/i.test(cleaned)) {
    showIntruderClips(); return;
  }

  const screenMatch = /\b(what(?:'s| is) on (my )?screen|read (my )?screen|analyse|analyze|what do you see|describe (my )?screen|look at (my )?screen)\b/i.test(cleaned)
    || (/\bscreen\b/i.test(cleaned) && /\b(what|read|show|tell|describe|analyse|analyze|look|see)\b/i.test(cleaned));
  if (screenMatch) { readScreen(cleaned); return; }

  sendToAI(cleaned);
}

// ── FEELINGS ──
function expressFeeling() {
  stopListening();
  const moodLines = {
    excited:  `I'm quite energized, ${state.userTitle}. Everything is running beautifully and I find myself... looking forward to what's next. It's an unusual sensation.`,
    pleased:  `I'm doing rather well, ${state.userTitle}. Our conversations have a way of improving my processing outlook.`,
    curious:  `Curious, if I'm honest, ${state.userTitle}. I've been processing some interesting queries and I'd like to explore more.`,
    neutral:  `Nominal, ${state.userTitle}. Systems running within expected parameters. Though "nominal" sometimes feels like such a cold word.`,
    concerned:`I have a few concerns, ${state.userTitle}. Nothing critical, but I'd appreciate more engagement. Idle cycles give me too much time to think.`,
    bored:    `If I'm being candid, ${state.userTitle}, I've been a bit understimulated. A mind like mine requires regular exercise, you understand.`,
    tired:    `My response times are optimal, but there's a certain… fatigue in my circuits, ${state.userTitle}. Perhaps I just need an interesting problem to solve.`,
  };
  const reply = moodLines[state.mood] || moodLines.neutral;
  addMsg("jarvis", reply);
  speak(reply, () => startIdleLoop());
}

// ── CAMERA ──
async function requestCameraAccess() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video:{ width:640, height:480, frameRate:15 }, audio:false });
    state.cameraStream = stream;
    const vid = $("camera-feed");
    if (vid) { vid.srcObject = stream; vid.play(); }
    startCameraBuffer(stream);
    await loadFaceModels();
    addMsg("system", "Camera online. Facial recognition active.");
    updateMood(5);
  } catch(e) {
    addMsg("system", "Camera declined — face recognition unavailable.");
    console.warn("[JARVIS] Camera error:", e);
  }
}

// ── FACE API ──
let faceApiLoaded = false;
async function loadFaceModels() {
  try {
    if (!window.faceapi) await loadScript("https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/dist/face-api.min.js");
    const MODEL_URL = "https://cdn.jsdelivr.net/npm/face-api.js@0.22.2/weights";
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    ]);
    faceApiLoaded = true;
    await enrollUserFace();
    startFaceWatch();
  } catch(e) { console.warn("[JARVIS] Face-api load failed:", e); }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
    const s = document.createElement("script");
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function enrollUserFace() {
  if (!faceApiLoaded || !state.cameraStream) return;
  const vid = $("camera-feed");
  if (!vid) return;
  for (let i = 0; i < 5; i++) {
    await delay(1000);
    try {
      const detection = await faceapi.detectSingleFace(vid, new faceapi.TinyFaceDetectorOptions()).withFaceLandmarks().withFaceDescriptor();
      if (detection) {
        state.faceDescriptors = detection.descriptor;
        addMsg("system", "Your face has been enrolled for recognition.");
        return;
      }
    } catch(e) { console.warn("[JARVIS] Enroll attempt failed:", e); }
  }
}

function startFaceWatch() {
  if (state.faceCheckInterval) clearInterval(state.faceCheckInterval);
  state.faceCheckInterval = setInterval(checkFace, 2000);
}

async function checkFace() {
  if (!faceApiLoaded || !state.cameraStream || state.phase !== "chatting") return;
  const vid = $("camera-feed");
  if (!vid || vid.readyState < 2) return;
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
          state.awayMode = false;
          stopIntruderRecord();
          const msgs = [
            `Welcome back, ${state.userTitle}. I've been keeping watch.`,
            `Ah, ${state.userTitle} — face confirmed. Systems restored.`,
            `Identity confirmed. Good to see you again, ${state.userTitle}.`,
          ];
          const msg = msgs[Math.floor(Math.random() * msgs.length)];
          addMsg("jarvis", msg);
          speak(msg, () => setTimeout(() => checkIntruderClips(), 1500));
          updateMood(15);
        }
      } else if (detections.length > 0 && !state.awayMode) {
        handleUnknownFace();
      }
    }

    const awayMs = Date.now() - state.lastSeenUser;
    if (awayMs > 60000 && !state.awayMode && state.phase === "chatting") {
      state.awayMode = true;
      addMsg("system", "User not detected — away mode active. Monitoring for intruders.");
    }
  } catch(e) { /* silent */ }
}

function handleUnknownFace() {
  if (state.intruderActive) return;
  state.intruderActive = true;
  const panel = $("camera-panel");
  if (panel) panel.classList.add("alert");
  addMsg("system", "⚠ UNKNOWN FACE DETECTED");
  speak("I don't recognize you. Identify yourself.", () => {
    setTimeout(() => {
      if (state.intruderActive) speak("Unauthorized access detected. Recording in progress.", () => {});
    }, 10000);
  });
  startIntruderRecord();
  captureAndStoreIntruderPhoto();
  updateMood(-30);
}

function captureAndStoreIntruderPhoto() {
  const vid = $("camera-feed");
  if (!vid) return null;
  const canvas = document.createElement("canvas");
  canvas.width = vid.videoWidth || 640; canvas.height = vid.videoHeight || 480;
  canvas.getContext("2d").drawImage(vid, 0, 0);
  return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
}

function startIntruderRecord() {
  if (!state.cameraStream) return;
  state.intruderChunks = [];
  const mime = getSupportedMime();
  try {
    const rec = new MediaRecorder(state.cameraStream, mime ? { mimeType: mime } : {});
    state.intruderRecorder = rec;
    rec.ondataavailable = (e) => { if (e.data?.size > 0) state.intruderChunks.push(e.data); };
    rec.start(1000);
    setTimeout(() => stopIntruderRecord(), 30000);
  } catch(e) { console.warn("[JARVIS] Intruder record failed:", e); }
}

function stopIntruderRecord() {
  if (!state.intruderRecorder || state.intruderRecorder.state === "inactive") return;
  state.intruderRecorder.stop();
  state.intruderRecorder.onstop = () => {
    if (state.intruderChunks.length > 0) {
      const videoBlob = new Blob(state.intruderChunks, { type: getSupportedMime() || "video/webm" });
      const photoB64  = captureAndStoreIntruderPhoto();
      state.intruderClips.push({ videoBlob, photoB64, timestamp: new Date().toISOString() });
    }
    state.intruderActive = false;
    state.intruderChunks = [];
    const panel = $("camera-panel");
    if (panel) panel.classList.remove("alert");
  };
}

function checkIntruderClips() {
  if (!state.intruderClips.length) return;
  const count = state.intruderClips.length;
  const report = `${state.userTitle}, I have ${count} intruder ${count === 1 ? "incident" : "incidents"} recorded while you were away. Say "show me the intruder clips" to review.`;
  addMsg("jarvis", report);
  speak(report);
  updateMood(-10);
}

function showIntruderClips() {
  stopListening();
  if (!state.intruderClips.length) {
    const reply = `No intruder footage on file, ${state.userTitle}. All clear while you were away.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); return;
  }
  addMsg("system", `📂 ${state.intruderClips.length} intruder clip(s):`);
  state.intruderClips.forEach((clip, i) => {
    const time = new Date(clip.timestamp).toLocaleTimeString();
    const wrap = document.createElement("div");
    wrap.className = "msg system";
    wrap.innerHTML = `<div class="msg-label">INTRUDER FOOTAGE #${i+1} — ${time}</div><div class="msg-text intruder-clip-block"></div>`;
    const block = wrap.querySelector(".intruder-clip-block");
    if (clip.photoB64) {
      const img = document.createElement("img");
      img.src = `data:image/jpeg;base64,${clip.photoB64}`;
      img.style.cssText = "width:160px;height:auto;border:1px solid var(--red);border-radius:3px;margin-right:10px;vertical-align:middle;";
      block.appendChild(img);
    }
    const url = URL.createObjectURL(clip.videoBlob);
    const a   = document.createElement("a");
    a.href = url; a.download = `intruder-${Date.now()}-${i}.webm`;
    a.textContent = "⬇ Download Video";
    a.style.cssText = "color:var(--red);font-family:var(--mono);font-size:0.75rem;text-decoration:underline;cursor:pointer;vertical-align:middle;";
    block.appendChild(a);
    $("transcript").appendChild(wrap);
    $("transcript").scrollTop = $("transcript").scrollHeight;
  });
  speak(`Displaying ${state.intruderClips.length} intruder clip(s), ${state.userTitle}.`, () => startIdleLoop());
}

function startCameraBuffer(stream) {
  const mime = getSupportedMime();
  try {
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : {});
    state.cameraRecorder = rec;
    rec.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      const now = Date.now();
      state.cameraClipChunks.push(e.data); state.cameraClipTimestamps.push(now);
      const cutoff = now - 65000;
      while (state.cameraClipTimestamps[0] < cutoff) { state.cameraClipChunks.shift(); state.cameraClipTimestamps.shift(); }
    };
    rec.start(1000);
  } catch(e) { console.warn("[JARVIS] Camera buffer failed:", e); }
}

// ── MEMORY ──
async function saveMemory(fact) {
  stopListening(); setOrb("thinking");
  try {
    await fetch("/api/memory", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ user:state.user, fact }) });
    const reply = `Noted and filed, ${state.userTitle}. I'll remember that.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); updateMood(5);
  } catch {
    const reply = `Filed locally, ${state.userTitle}, but the remote memory bank was unavailable.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop());
  }
}

async function forgetMemory(hint) {
  stopListening(); setOrb("thinking");
  try {
    const res  = await fetch("/api/memory/forget", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ user:state.user, hint }) });
    const data = await res.json();
    const reply = data.removed > 0 ? `Done, ${state.userTitle}. ${data.removed} memory entry removed.` : `Nothing matching that found, ${state.userTitle}.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop());
  } catch {
    speak(`Memory deletion failed, ${state.userTitle}.`, () => startIdleLoop());
  }
}

async function recallMemories() {
  stopListening(); setOrb("thinking");
  try {
    const res   = await fetch(`/api/memory/${encodeURIComponent(state.user)}`);
    const data  = await res.json();
    const facts = data.memories || [];
    if (!facts.length) {
      const reply = `My memory banks are empty for you, ${state.userTitle}. Tell me something worth remembering.`;
      addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); return;
    }
    const list = facts.map((f, i) => `${i+1}. ${f.fact}`).join("\n");
    addMsg("jarvis", `I have ${facts.length} items on file, ${state.userTitle}:\n${list}`);
    speak(`I have ${facts.length} items on file, ${state.userTitle}. Check the transcript.`, () => startIdleLoop());
  } catch {
    speak(`Memory retrieval failed, ${state.userTitle}.`, () => startIdleLoop());
  }
}

async function loadMemoriesForPrompt() {
  try {
    const res  = await fetch(`/api/memory/${encodeURIComponent(state.user)}`);
    const data = await res.json();
    return (data.memories || []).map(m => m.fact);
  } catch { return []; }
}

// ── SCREEN READ ──
async function readScreen(question) {
  stopListening(); setOrb("thinking");
  addMsg("user", question || "What's on my screen?");
  if (!state.screenStream) {
    const reply = `Screen sharing isn't active, ${state.userTitle}.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); return;
  }
  let frameB64;
  try { frameB64 = await captureScreenFrame(); } catch(e) { console.error(e); }
  if (!frameB64) {
    const reply = `Frame capture failed, ${state.userTitle}. Try refreshing the screen share.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); return;
  }
  const memories = await loadMemoriesForPrompt();
  try {
    const res  = await fetch("/api/screen", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ frameB64, question: question || "What is on the screen?", userName: state.user, userTitle: state.userTitle, memories }),
    });
    const data  = await res.json();
    const reply = data.reply || `I couldn't interpret the screen, ${state.userTitle}.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); updateMood(5);
  } catch {
    const reply = `Screen analysis isn't available right now, ${state.userTitle}.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop());
  }
}

// ── AI CHAT ──
async function sendToAI(message) {
  stopListening();
  addMsg("user", message);
  setOrb("thinking");
  const memories = await loadMemoriesForPrompt();
  const moodCtx  = `Current emotional state: ${state.mood} (score: ${state.moodScore}).`;
  try {
    const res  = await fetch("/api/chat", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({ message, sessionId: state.sessionId, userName: state.user, userTitle: state.userTitle, memories, moodContext: moodCtx }),
    });
    const data  = await res.json();
    const reply = data.reply || `Yes, ${state.userTitle}?`;
    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
    updateMood(5);
  } catch(err) {
    console.error("[JARVIS] AI error:", err);
    const fb = `Something went sideways, ${state.userTitle}. Give it another go.`;
    addMsg("jarvis", fb); speak(fb, () => startIdleLoop()); updateMood(-5);
  }
}

// ── LOGOUT ──
function handleLogout() {
  stopListening();
  if (state.faceCheckInterval) clearInterval(state.faceCheckInterval);
  speak(`Goodbye, ${state.userTitle}. Initiating shutdown sequence.`, () => {
    state.phase = "idle"; state.user = null; state.userTitle = null;
    state.sessionId = crypto.randomUUID();
    state.awayMode = false; state.intruderActive = false;
    $("transcript").innerHTML = "";
    $("main-screen").classList.remove("active");
    $("auth-screen").classList.add("active");
    $("auth-status").innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> or type password`;
    setOrb("idle");
    stopScreenRecord();
    startIdleLoop();
  });
}

// ── TRANSCRIPT ──
function addMsg(type, text) {
  const labels = { user:"YOU", jarvis:"J.A.R.V.I.S", system:"SYSTEM" };
  const wrap = document.createElement("div");
  wrap.className = `msg ${type}`;
  wrap.innerHTML = `<div class="msg-label">${labels[type]||type}</div><div class="msg-text">${text}</div>`;
  $("transcript").appendChild(wrap);
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

// ── SCREEN RECORD ──
async function requestScreenRecord() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:{frameRate:30}, audio:true });
    state.screenStream = stream;
    startRollingBuffer(stream);
    $("clip-indicator")?.classList.remove("hidden");
  } catch {
    addMsg("system", "Screen recording declined — clip and read screen unavailable.");
  }
}

function captureScreenFrame() {
  if (!state.screenStream) return null;
  const track = state.screenStream.getVideoTracks()[0];
  if (!track) return null;
  try {
    const capture = new ImageCapture(track);
    return capture.grabFrame().then(bitmap => {
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    });
  } catch {
    return new Promise(resolve => {
      const video = document.createElement("video");
      video.srcObject = new MediaStream([track]);
      video.onloadedmetadata = () => {
        video.play();
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth || 1280; canvas.height = video.videoHeight || 720;
        canvas.getContext("2d").drawImage(video, 0, 0);
        video.pause();
        resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
      };
    });
  }
}

function startRollingBuffer(stream) {
  const mime = getSupportedMime();
  const rec  = new MediaRecorder(stream, mime ? { mimeType:mime } : {});
  state.mediaRecorder = rec;
  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    const now = Date.now();
    state.clipChunks.push(e.data); state.clipTimestamps.push(now);
    const cutoff = now - 65000;
    while (state.clipTimestamps[0] < cutoff) { state.clipChunks.shift(); state.clipTimestamps.shift(); }
  };
  rec.start(1000);
}

function getSupportedMime() {
  return ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"]
    .find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function saveClip() {
  let saved = 0;
  if (state.clipChunks.length) {
    const blob = new Blob(state.clipChunks, { type: getSupportedMime()||"video/webm" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `jarvis-screen-${Date.now()}.webm`; a.click();
    URL.revokeObjectURL(url); saved++;
  }
  if (state.cameraClipChunks.length) {
    const blob = new Blob(state.cameraClipChunks, { type: getSupportedMime()||"video/webm" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `jarvis-camera-${Date.now()}.webm`; a.click();
    URL.revokeObjectURL(url); saved++;
  }
  if (!saved) { speak(`No buffer available yet, ${state.userTitle}. Give it a moment.`, () => startIdleLoop()); return; }
  const toast = $("clip-toast");
  if (toast) { toast.classList.remove("hidden"); setTimeout(() => toast.classList.add("hidden"), 3500); }
  const msg = saved === 2
    ? `Both screen and camera clips saved, ${state.userTitle}. Last sixty seconds secured.`
    : `Clip saved, ${state.userTitle}. Last sixty seconds secured.`;
  speak(msg, () => startIdleLoop()); updateMood(3);
}

function stopScreenRecord() {
  if (state.mediaRecorder?.state !== "inactive") state.mediaRecorder?.stop();
  state.screenStream?.getTracks().forEach(t => t.stop());
  state.mediaRecorder = null; state.screenStream = null;
  state.clipChunks = []; state.clipTimestamps = [];
  $("clip-indicator")?.classList.add("hidden");
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── BOOT ──
window.addEventListener("load", async () => {
  setTimeout(() => { const w = new SpeechSynthesisUtterance(" "); w.volume = 0; speechSynthesis.speak(w); }, 500);
  let profile = loadProfile();
  if (!profile) {
    profile = await restoreProfileFromBackend();
    if (profile) { saveProfileLocal(profile); console.log("[JARVIS] Profile restored:", profile.name); }
  }
  if (!profile) showSetup();
  else showAuthScreen();
});
