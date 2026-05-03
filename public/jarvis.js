// ── STATE ──
const state = {
  phase: "idle",       // idle | awaiting_name | chatting
  user: null,
  userTitle: null,
  sessionId: crypto.randomUUID(),
  synth: window.speechSynthesis,
  recognition: null,
  isListening: false,
  // Screen recording / clip buffer
  mediaRecorder: null,
  clipChunks: [],      // rolling last-60s chunks
  clipTimestamps: [],  // timestamps per chunk
  screenStream: null,
};

// ── DOM ──
const $ = (id) => document.getElementById(id);
const authScreen    = $("auth-screen");
const mainScreen    = $("main-screen");
const authStatus    = $("auth-status");
const authPrompt    = $("auth-prompt");
const authListening = $("auth-listening");
const transcript    = $("transcript");
const statusText    = $("status-text");
const userDisplay   = $("user-display");
const orb           = $("orb");
const clipIndicator = $("clip-indicator");
const clipToast     = $("clip-toast");

// ── SPEECH SYNTHESIS ──
let voicesLoaded = false;
speechSynthesis.onvoiceschanged = () => { voicesLoaded = true; };

function speak(text, onEnd) {
  state.synth.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate  = 0.93;
  utter.pitch = 0.8;
  utter.volume = 1;

  const voices = state.synth.getVoices();
  const pick =
    voices.find(v => v.name === "Google UK English Male") ||
    voices.find(v => v.name.includes("Daniel")) ||
    voices.find(v => v.lang === "en-GB" && v.name.toLowerCase().includes("male")) ||
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
  const labels = { idle: "STANDBY", listening: "LISTENING", thinking: "PROCESSING", speaking: "SPEAKING" };
  statusText.textContent = labels[s] || "STANDBY";
}

// ── SPEECH RECOGNITION ──
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

function listen(onResult, continuous) {
  if (!SR) { addMsg("system", "Speech recognition requires Chrome."); return; }
  stopListening();

  const r = new SR();
  r.continuous      = !!continuous;
  r.interimResults  = false;
  r.lang            = "en-US";
  state.recognition = r;
  state.isListening = true;

  r.onresult = (e) => {
    const text = e.results[e.results.length - 1][0].transcript.trim();
    console.log("[heard]", text);
    onResult(text);
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed") {
      addMsg("system", "Microphone permission denied. Please allow mic access and refresh.");
    }
  };
  r.onend = () => {
    state.isListening = false;
    // Re-start idle continuous listener automatically
    if (state.phase === "idle" || state.phase === "chatting") {
      setTimeout(startIdleLoop, 400);
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

// ── IDLE LOOP (always listening for "Jarvis") ──
function startIdleLoop() {
  if (state.isListening) return;
  listen((text) => {
    const lower = text.toLowerCase();

    if (state.phase === "idle") {
      if (lower.includes("jarvis") && (lower.includes("log in") || lower.includes("login") || lower.includes("sign in"))) {
        startAuthFlow();
      }
      // Else ignore — not logged in
    } else if (state.phase === "chatting") {
      handleChatCommand(text);
    }
  }, true);
}

// ── AUTH FLOW ──
function startAuthFlow() {
  state.phase = "awaiting_name";
  stopListening();

  authStatus.style.display = "none";
  authPrompt.classList.remove("hidden");
  authListening.classList.remove("hidden");

  speak("Identify yourself.", () => {
    listen((name) => {
      authPrompt.classList.add("hidden");
      authListening.classList.add("hidden");
      authStatus.style.display = "";
      checkAuth(name);
    }, false);
  });
}

async function checkAuth(name) {
  authStatus.textContent = "Verifying…";
  setOrb("thinking");

  try {
    const res  = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();

    if (data.authorized) {
      state.user      = data.name;
      state.userTitle = data.title;
      setOrb("idle");
      speak(`Welcome back, ${data.title}.`, () => {
        launchMain();
      });
    } else {
      setOrb("idle");
      authStatus.innerHTML = `<span style="color:var(--red)">Access denied. Identity not recognized.</span>`;
      speak("Access denied. Identity not recognized.", () => {
        setTimeout(() => {
          state.phase = "idle";
          authStatus.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> to begin`;
          authStatus.style.display = "";
          startIdleLoop();
        }, 1800);
      });
    }
  } catch (err) {
    setOrb("idle");
    authStatus.textContent = "Server connection failed. Is the server running?";
    state.phase = "idle";
  }
}

// ── MAIN INTERFACE ──
function launchMain() {
  state.phase = "chatting";
  authScreen.classList.remove("active");
  mainScreen.classList.add("active");
  userDisplay.textContent = `${state.user} / ${state.userTitle}`;
  addMsg("system", `All systems online. Welcome back, ${state.userTitle}.`);
  requestScreenRecord();
  startIdleLoop();
}

// ── CHAT COMMANDS ──
function handleChatCommand(text) {
  const lower = text.toLowerCase();

  // Must start with "Jarvis"
  if (!lower.includes("jarvis")) return;

  // Log out
  if (lower.includes("log out") || lower.includes("logout") || lower.includes("sign out")) {
    handleLogout();
    return;
  }

  // Clip that
  if (lower.includes("clip that") || lower.includes("clip it") || lower.includes("save that")) {
    saveClip();
    return;
  }

  // Everything else → send to Gemini
  // Strip "jarvis" from the message for cleaner input
  const cleaned = text.replace(/jarvis[,.]?\s*/i, "").trim();
  if (!cleaned) return;

  sendToAI(cleaned);
}

// ── AI CHAT ──
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
    const data = await res.json();
    const reply = data.reply || data.error || "I encountered an issue, " + state.userTitle + ".";

    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
  } catch (err) {
    const fallback = "Connection to my language systems failed, " + state.userTitle + ". Please check the server.";
    addMsg("jarvis", fallback);
    speak(fallback, () => startIdleLoop());
  }
}

// ── LOG OUT ──
function handleLogout() {
  stopListening();
  speak(`Goodbye, ${state.userTitle}. Initiating shutdown sequence.`, () => {
    state.phase     = "idle";
    state.user      = null;
    state.userTitle = null;
    state.sessionId = crypto.randomUUID();
    transcript.innerHTML = "";

    mainScreen.classList.remove("active");
    authScreen.classList.add("active");
    authStatus.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> to begin`;
    authStatus.style.display = "";
    setOrb("idle");

    stopScreenRecord();
    startIdleLoop();
  });
}

// ── TRANSCRIPT ──
function addMsg(type, text) {
  const labels = { user: "YOU", jarvis: "J.A.R.V.I.S", system: "SYSTEM" };
  const wrap  = document.createElement("div");
  wrap.className = `msg ${type}`;
  wrap.innerHTML = `<div class="msg-label">${labels[type] || type}</div><div class="msg-text">${text}</div>`;
  transcript.appendChild(wrap);
  transcript.scrollTop = transcript.scrollHeight;
}

// ── SCREEN RECORDING (rolling 60s buffer) ──
async function requestScreenRecord() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: true,
    });
    state.screenStream = stream;
    startRollingBuffer(stream);
    clipIndicator.classList.remove("hidden");
  } catch (err) {
    addMsg("system", "Screen recording permission denied — 'clip that' will be unavailable.");
  }
}

function startRollingBuffer(stream) {
  const rec = new MediaRecorder(stream, { mimeType: getSupportedMime() });
  state.mediaRecorder = rec;

  rec.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) {
      const now = Date.now();
      state.clipChunks.push(e.data);
      state.clipTimestamps.push(now);
      // Drop chunks older than 65 seconds
      const cutoff = now - 65000;
      while (state.clipTimestamps.length && state.clipTimestamps[0] < cutoff) {
        state.clipChunks.shift();
        state.clipTimestamps.shift();
      }
    }
  };

  rec.start(1000); // collect a chunk every second
}

function getSupportedMime() {
  const types = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  return types.find(t => MediaRecorder.isTypeSupported(t)) || "";
}

function saveClip() {
  if (!state.clipChunks.length) {
    speak("No recording buffer available, " + state.userTitle + ". Screen capture may not be active.", () => startIdleLoop());
    return;
  }

  const blob = new Blob(state.clipChunks, { type: getSupportedMime() || "video/webm" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `jarvis-clip-${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(url);

  showToast();
  speak("Clip saved, " + state.userTitle + ". Last sixty seconds secured.", () => startIdleLoop());
}

function showToast() {
  clipToast.classList.remove("hidden");
  setTimeout(() => clipToast.classList.add("hidden"), 3500);
}

function stopScreenRecord() {
  if (state.mediaRecorder && state.mediaRecorder.state !== "inactive") {
    state.mediaRecorder.stop();
  }
  if (state.screenStream) {
    state.screenStream.getTracks().forEach(t => t.stop());
  }
  state.mediaRecorder  = null;
  state.screenStream   = null;
  state.clipChunks     = [];
  state.clipTimestamps = [];
  clipIndicator.classList.add("hidden");
}

// ── BOOT ──
window.addEventListener("load", () => {
  // Warm up voices
  setTimeout(() => {
    const warm = new SpeechSynthesisUtterance(" ");
    warm.volume = 0;
    speechSynthesis.speak(warm);
  }, 500);

  startIdleLoop();
});
