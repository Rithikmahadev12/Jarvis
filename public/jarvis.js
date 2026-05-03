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
  // Voice samples: array of strings the user recorded
  voiceSamples: [],
  recordingSamples: false,
  sampleCount: 0,
};

// ── PROFILE (stored in localStorage) ──
// { name, passwordHash, title, voiceAliases: [] }
function loadProfile() {
  try { return JSON.parse(localStorage.getItem("jarvis_profile")) || null; }
  catch { return null; }
}
function saveProfile(p) {
  localStorage.setItem("jarvis_profile", JSON.stringify(p));
}
// Simple hash — not crypto-secure but fine for a personal app
async function hashPassword(pw) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pw));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
}

// ── DOM ──
const $ = id => document.getElementById(id);
const setupScreen   = $("setup-screen");
const authScreen    = $("auth-screen");
const mainScreen    = $("main-screen");
const authStatus    = $("auth-status");
const authPrompt    = $("auth-prompt");
const authListening = $("auth-listening");
const heardText     = $("heard-text");
const micDebug      = $("mic-debug");
const transcript    = $("transcript");
const statusText    = $("status-text");
const userDisplay   = $("user-display");
const orb           = $("orb");
const clipIndicator = $("clip-indicator");
const clipToast     = $("clip-toast");
const liveMic       = $("live-mic");

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
  orb.className = "orb" + (s !== "idle" ? " " + s : "");
  const labels = { idle:"STANDBY", listening:"LISTENING", thinking:"PROCESSING", speaking:"SPEAKING" };
  if (statusText) statusText.textContent = labels[s] || "STANDBY";
}

// ── RECOGNITION ──
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function listen(onResult, continuous, onInterim) {
  if (!SR) { addMsg("system","Speech recognition requires Chrome."); return; }
  stopListening();
  const r = new SR();
  r.continuous     = !!continuous;
  r.interimResults = !!onInterim;
  r.lang           = "en-US";
  state.recognition = r;
  state.isListening = true;

  r.onresult = (e) => {
    const result = e.results[e.results.length - 1];
    const text   = result[0].transcript.trim();
    if (result.isFinal) {
      console.log("[heard final]", text);
      micDebug.textContent = "Mic: " + text;
      onResult(text);
    } else if (onInterim) {
      onInterim(text);
    }
  };
  r.onerror = (e) => {
    state.isListening = false;
    if (e.error === "not-allowed") {
      addMsg("system","Microphone permission denied. Please allow mic access and refresh.");
    }
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

// ── NAME MATCHING ──
// Returns true if the spoken text matches the user's name or any saved alias
function matchesUser(text, profile) {
  if (!profile) return false;
  const lower = text.toLowerCase().replace(/[^a-z\s]/g, "").trim();
  const name  = profile.name.toLowerCase();

  // Direct match
  if (lower.includes(name)) return true;

  // Check saved voice aliases (what they recorded)
  if (profile.voiceAliases) {
    for (const alias of profile.voiceAliases) {
      const a = alias.toLowerCase().replace(/[^a-z\s]/g, "").trim();
      if (a && lower.includes(a)) return true;
      // Fuzzy: if first 3 chars match
      if (a.length >= 3 && lower.includes(a.slice(0,3))) return true;
    }
  }

  // Phonetic: check if it starts similarly (first 3 chars of name)
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
  setupScreen.classList.add("active");
  authScreen.classList.remove("active");
  mainScreen.classList.remove("active");

  $("btn-next-profile").addEventListener("click", async () => {
    const name = $("setup-name").value.trim();
    const pw   = $("setup-password").value.trim();
    const title = $("setup-title").value;
    if (!name || !pw) {
      alert("Please enter your name and a password.");
      return;
    }
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
    r.continuous = false;
    r.interimResults = false;
    r.lang = "en-US";
    r.onresult = (e) => {
      const heard = e.results[0][0].transcript.trim();
      console.log("[voice sample]", heard);
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
    r.onerror = () => {
      $("voice-sample-status").textContent = "Didn't catch that — try again";
      $("record-bars").classList.add("hidden");
    };
    r.onend = () => $("record-bars").classList.add("hidden");
    r.start();
  });

  $("btn-skip-voice").addEventListener("click", () => completeSetup());
}

function completeSetup() {
  const p = window._pendingProfile;
  $("step-voice").classList.add("hidden");
  $("step-done").classList.remove("hidden");
  const aliases = p.voiceAliases.length
    ? `Voice aliases saved: ${p.voiceAliases.join(", ")}`
    : "No voice aliases — will match exact name.";
  $("setup-summary").textContent =
    `Profile created for ${p.name} (${p.title}). ${aliases}`;

  $("btn-launch").addEventListener("click", () => {
    saveProfile(p);
    setupScreen.classList.remove("active");
    showAuthScreen();
  });
}

// ── AUTH SCREEN ──
function showAuthScreen() {
  authScreen.classList.add("active");
  setupScreen.classList.remove("active");
  mainScreen.classList.remove("active");

  // Password input — press Enter to auth
  const pwInput = $("auth-password-input");
  pwInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      const profile = loadProfile();
      const hash = await hashPassword(pwInput.value);
      pwInput.value = "";
      if (profile && hash === profile.passwordHash) {
        state.user      = profile.name;
        state.userTitle = profile.title;
        speak(`Welcome back, ${profile.title}.`, launchMain);
      } else {
        authStatus.innerHTML = `<span style="color:var(--red)">Wrong password.</span>`;
        setTimeout(() => {
          authStatus.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> to begin`;
        }, 2000);
      }
    }
  });

  startIdleLoop();
}

// ── IDLE LOOP ──
function startIdleLoop() {
  if (state.isListening) return;
  listen((text) => {
    const lower = text.toLowerCase();
    micDebug.textContent = "Mic: " + text;

    if (state.phase === "idle") {
      // Trigger login — be generous with "jarvis" detection
      const hasJarvis = lower.includes("jarvis") || lower.includes("travis") ||
                        lower.includes("jarvas") || lower.includes("jarvi");
      const hasLogin  = lower.includes("log") || lower.includes("login") ||
                        lower.includes("sign") || lower.includes("in");
      if (hasJarvis && hasLogin) {
        startVoiceAuth();
      }
    } else if (state.phase === "chatting") {
      handleChatCommand(text);
    }
  }, true, (interim) => {
    micDebug.textContent = "Mic: " + interim + "…";
  });
}

// ── VOICE AUTH ──
function startVoiceAuth() {
  state.phase = "awaiting_name";
  stopListening();

  authStatus.style.display = "none";
  authPrompt.classList.remove("hidden");
  authListening.classList.remove("hidden");
  heardText.textContent = "Listening…";

  speak("Identify yourself.", () => {
    // Listen for name with interim updates so user sees what's being heard
    const r = new SR();
    r.continuous     = false;
    r.interimResults = true;
    r.lang           = "en-US";
    state.recognition = r;
    state.isListening = true;

    r.onresult = (e) => {
      const result = e.results[0];
      const text   = result[0].transcript.trim();
      heardText.textContent = text; // live feedback
      if (result.isFinal) {
        state.isListening = false;
        authPrompt.classList.add("hidden");
        authListening.classList.add("hidden");
        authStatus.style.display = "";
        checkVoiceAuth(text);
      }
    };
    r.onerror = () => {
      state.isListening = false;
      heardText.textContent = "Couldn't hear you.";
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
  authStatus.textContent = `Heard: "${spokenText}" — verifying…`;
  setOrb("thinking");

  setTimeout(() => {
    if (!profile) {
      authStatus.innerHTML = `<span style="color:var(--red)">No profile found. Please set up first.</span>`;
      setOrb("idle");
      state.phase = "idle";
      setTimeout(startIdleLoop, 2000);
      return;
    }

    if (matchesUser(spokenText, profile)) {
      state.user      = profile.name;
      state.userTitle = profile.title;
      setOrb("idle");
      speak(`Welcome back, ${profile.title}.`, launchMain);
    } else {
      setOrb("idle");
      authStatus.innerHTML = `<span style="color:var(--red)">Access denied. I heard "${spokenText}" — not recognized.</span>`;
      speak("Access denied. Identity not recognized.", () => {
        setTimeout(() => {
          authStatus.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> to begin`;
          state.phase = "idle";
          startIdleLoop();
        }, 1800);
      });
    }
  }, 600);
}

// ── MAIN ──
function launchMain() {
  state.phase = "chatting";
  authScreen.classList.remove("active");
  mainScreen.classList.add("active");
  userDisplay.textContent = `${state.user} / ${state.userTitle}`;
  addMsg("system", `All systems online. Welcome back, ${state.userTitle}.`);
  requestScreenRecord();
  startIdleLoop();
}

// ── CHAT ──
function handleChatCommand(text) {
  const lower = text.toLowerCase();
  const hasJarvis = lower.includes("jarvis") || lower.includes("travis") ||
                    lower.includes("jarvas") || lower.includes("jarvi");
  if (!hasJarvis) {
    liveMic.classList.remove("hidden");
    liveMic.textContent = "Heard: " + text + " (say 'Jarvis' first)";
    return;
  }

  liveMic.classList.add("hidden");

  if (lower.includes("log out") || lower.includes("logout") || lower.includes("sign out")) {
    handleLogout(); return;
  }
  if (lower.includes("clip that") || lower.includes("clip it") || lower.includes("save that")) {
    saveClip(); return;
  }

  const cleaned = text.replace(/\b(jarvis|travis|jarvas|jarvi)\b[,.]?\s*/gi, "").trim();
  if (!cleaned) return;
  sendToAI(cleaned);
}

async function sendToAI(message) {
  stopListening();
  addMsg("user", message);
  setOrb("thinking");
  try {
    const res  = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        sessionId: state.sessionId,
        userName:  state.user,
        userTitle: state.userTitle,
      }),
    });
    const data  = await res.json();
    const reply = data.reply || data.error || `I encountered an issue, ${state.userTitle}.`;
    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
  } catch {
    const fb = `Connection failure, ${state.userTitle}.`;
    addMsg("jarvis", fb);
    speak(fb, () => startIdleLoop());
  }
}

// ── LOGOUT ──
function handleLogout() {
  stopListening();
  speak(`Goodbye, ${state.userTitle}. Initiating shutdown sequence.`, () => {
    state.phase = "idle"; state.user = null; state.userTitle = null;
    state.sessionId = crypto.randomUUID();
    transcript.innerHTML = "";
    mainScreen.classList.remove("active");
    authScreen.classList.add("active");
    authStatus.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> to begin`;
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
  transcript.appendChild(wrap);
  transcript.scrollTop = transcript.scrollHeight;
}

// ── SCREEN RECORD ──
async function requestScreenRecord() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video:{frameRate:30}, audio:true });
    state.screenStream = stream;
    startRollingBuffer(stream);
    clipIndicator.classList.remove("hidden");
  } catch {
    addMsg("system", "Screen recording declined — 'clip that' unavailable.");
  }
}
function startRollingBuffer(stream) {
  const mime = getSupportedMime();
  const rec  = new MediaRecorder(stream, mime ? {mimeType:mime} : {});
  state.mediaRecorder = rec;
  rec.ondataavailable = (e) => {
    if (!e.data || e.data.size === 0) return;
    const now = Date.now();
    state.clipChunks.push(e.data);
    state.clipTimestamps.push(now);
    const cutoff = now - 65000;
    while (state.clipTimestamps[0] < cutoff) {
      state.clipChunks.shift(); state.clipTimestamps.shift();
    }
  };
  rec.start(1000);
}
function getSupportedMime() {
  return ["video/webm;codecs=vp9,opus","video/webm;codecs=vp8,opus","video/webm","video/mp4"]
    .find(t => MediaRecorder.isTypeSupported(t)) || "";
}
function saveClip() {
  if (!state.clipChunks.length) {
    speak(`No buffer available, ${state.userTitle}.`, () => startIdleLoop()); return;
  }
  const blob = new Blob(state.clipChunks, { type: getSupportedMime()||"video/webm" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = `jarvis-clip-${Date.now()}.webm`; a.click();
  URL.revokeObjectURL(url);
  clipToast.classList.remove("hidden");
  setTimeout(() => clipToast.classList.add("hidden"), 3500);
  speak(`Clip saved, ${state.userTitle}. Last sixty seconds secured.`, () => startIdleLoop());
}
function stopScreenRecord() {
  if (state.mediaRecorder?.state !== "inactive") state.mediaRecorder?.stop();
  state.screenStream?.getTracks().forEach(t => t.stop());
  state.mediaRecorder = null; state.screenStream = null;
  state.clipChunks = []; state.clipTimestamps = [];
  clipIndicator.classList.add("hidden");
}

// ── BOOT ──
window.addEventListener("load", () => {
  setTimeout(() => {
    const w = new SpeechSynthesisUtterance(" ");
    w.volume = 0; speechSynthesis.speak(w);
  }, 500);

  const profile = loadProfile();
  if (!profile) {
    // First time — show setup
    showSetup();
  } else {
    showAuthScreen();
  }
});
