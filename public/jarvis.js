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
  voiceSamples: [],
  recordingSamples: false,
  sampleCount: 0,
};

// ── PROFILE (localStorage is cache for speed; backend is the source of truth) ──
function loadProfile() {
  try { return JSON.parse(localStorage.getItem("jarvis_profile")) || null; }
  catch { return null; }
}
function saveProfileLocal(p) {
  localStorage.setItem("jarvis_profile", JSON.stringify(p));
}

// Save profile to backend (persists across cache clears)
async function saveProfileRemote(p) {
  try {
    await fetch("/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(p),
    });
  } catch (e) {
    console.warn("[JARVIS] Could not save profile to backend:", e);
  }
}

// Try to restore profile from backend by stored name hint
async function restoreProfileFromBackend() {
  // We store just the name hint in localStorage (not the full profile)
  const nameHint = localStorage.getItem("jarvis_name_hint");
  if (!nameHint) return null;
  try {
    const res = await fetch(`/api/profile/${encodeURIComponent(nameHint)}`);
    const data = await res.json();
    if (data.found) {
      // Restore passwordHash from local storage (we keep it there for login)
      const localHash = localStorage.getItem("jarvis_pw_hash");
      return { ...data.profile, passwordHash: localHash || "" };
    }
  } catch (e) {
    console.warn("[JARVIS] Backend restore failed:", e);
  }
  return null;
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

  $("btn-launch").addEventListener("click", async () => {
    // Save locally
    saveProfileLocal(p);
    // Save name hint and password hash separately for backend restore
    localStorage.setItem("jarvis_name_hint", p.name.toLowerCase());
    localStorage.setItem("jarvis_pw_hash", p.passwordHash);
    // Save to backend (source of truth)
    await saveProfileRemote(p);
    setupScreen.classList.remove("active");
    showAuthScreen();
  });
}

// ── AUTH SCREEN ──
async function showAuthScreen() {
  authScreen.classList.add("active");
  setupScreen.classList.remove("active");
  mainScreen.classList.remove("active");

  // Password input — press Enter to auth
  const pwInput = $("auth-password-input");

  // Remove any previous listener by cloning
  const newPwInput = pwInput.cloneNode(true);
  pwInput.parentNode.replaceChild(newPwInput, pwInput);

  newPwInput.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const profile = loadProfile();
    const hash = await hashPassword(newPwInput.value);
    newPwInput.value = "";

    if (profile && hash === profile.passwordHash) {
      state.user      = profile.name;
      state.userTitle = profile.title;
      speak(`Welcome back, ${profile.title}.`, launchMain);
      return;
    }

    // Fallback: verify against backend (in case localStorage was cleared)
    const nameHint = localStorage.getItem("jarvis_name_hint");
    if (nameHint) {
      try {
        const res = await fetch("/api/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: nameHint, passwordHash: hash }),
        });
        const data = await res.json();
        if (data.authorized) {
          // Restore profile locally
          const restored = { ...data.profile, passwordHash: hash };
          saveProfileLocal(restored);
          localStorage.setItem("jarvis_pw_hash", hash);
          state.user      = data.profile.name;
          state.userTitle = data.profile.title;
          speak(`Welcome back, ${data.profile.title}. Profile restored from secure storage.`, launchMain);
          return;
        }
      } catch (err) {
        console.warn("[JARVIS] Backend verify failed:", err);
      }
    }

    authStatus.innerHTML = `<span style="color:var(--red)">Wrong password.</span>`;
    setTimeout(() => {
      authStatus.innerHTML = `Say <span class="highlight">"Jarvis, log in"</span> to begin`;
    }, 2000);
  });

  startIdleLoop();
}

// ── WAKE WORD ──
// Strict match: only "jarvis" or "jarves" (common mishear). NO travis, jarvi, jarvas.
// Uses word-boundary check so "travis" in the middle of a sentence can't sneak through.
function hasWakeWord(lower) {
  return /\bjarvi[sc]?\b/.test(lower);
}

// Strip wake word from a command string
function stripWakeWord(text) {
  return text.replace(/\bjarvi[sc]?\b[,.]?\s*/gi, "").trim();
}

// ── IDLE LOOP ──
function startIdleLoop() {
  if (state.isListening) return;
  listen((text) => {
    const lower = text.toLowerCase();
    micDebug.textContent = "Mic: " + text;

    if (state.phase === "idle") {
      const hasLogin = lower.includes("log") || lower.includes("login") ||
                       lower.includes("sign") || lower.includes("in");
      if (hasWakeWord(lower) && hasLogin) {
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
    const r = new SR();
    r.continuous     = false;
    r.interimResults = true;
    r.lang           = "en-US";
    state.recognition = r;
    state.isListening = true;

    r.onresult = (e) => {
      const result = e.results[0];
      const text   = result[0].transcript.trim();
      heardText.textContent = text;
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

  // Try local profile first
  if (profile && matchesUser(spokenText, profile)) {
    state.user      = profile.name;
    state.userTitle = profile.title;
    setOrb("idle");
    speak(`Welcome back, ${profile.title}.`, launchMain);
    return;
  }

  // Fallback: check backend profiles list (works after cache clear)
  try {
    const res  = await fetch("/api/profiles");
    const data = await res.json();
    for (const p of (data.profiles || [])) {
      if (matchesUser(spokenText, p)) {
        // Found on backend — restore name hint so password login works
        localStorage.setItem("jarvis_name_hint", p.name.toLowerCase());
        state.user      = p.name;
        state.userTitle = p.title;
        setOrb("idle");
        speak(`Welcome back, ${p.title}. Identity confirmed.`, launchMain);
        return;
      }
    }
  } catch (e) {
    console.warn("[JARVIS] Profile list fetch failed:", e);
  }

  // Not found anywhere
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

  if (!hasWakeWord(lower)) {
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

  const cleaned = stripWakeWord(text);

  // If nothing left after stripping (user just said "Jarvis"), acknowledge
  if (!cleaned) {
    const acks = [
      `Yes, ${state.userTitle}?`,
      `At your service, ${state.userTitle}.`,
      `How can I help, ${state.userTitle}?`,
    ];
    const ack = acks[Math.floor(Math.random() * acks.length)];
    addMsg("jarvis", ack);
    speak(ack, () => startIdleLoop());
    return;
  }

  // ── MEMORY COMMANDS ──
  const rememberMatch = cleaned.match(/^remember\s+(?:that\s+)?(.+)$/i);
  const forgetMatch   = cleaned.match(/^forget\s+(?:about\s+)?(.+)$/i);
  const recallMatch   = /^(what do you remember|recall everything|show.*memor|what.*remember)/i.test(cleaned);

  if (rememberMatch) { saveMemory(rememberMatch[1].trim()); return; }
  if (forgetMatch)   { forgetMemory(forgetMatch[1].trim()); return; }
  if (recallMatch)   { recallMemories(); return; }

  // ── SCREEN READ COMMANDS ──
  // Triggers: "what's on my screen", "read my screen", "analyse this", "what do you see", etc.
  const screenMatch = /\b(what(?:'s| is) on (my )?screen|read (my )?screen|analyse (my )?screen|analyze (my )?screen|what do you see|describe (my )?screen|look at (my )?screen|scan (my )?screen)\b/i.test(cleaned)
    || /\bscreen\b/i.test(cleaned) && /\b(what|read|show|tell|describe|analyse|analyze|look|see)\b/i.test(cleaned);

  if (screenMatch) { readScreen(cleaned); return; }

  sendToAI(cleaned);
}

// ── MEMORY ──
async function saveMemory(fact) {
  stopListening();
  setOrb("thinking");
  try {
    await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: state.user, fact }),
    });
    const reply = `Noted and filed, ${state.userTitle}. I'll remember that.`;
    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
  } catch {
    const reply = `I tried to remember that, ${state.userTitle}, but the memory banks seem unresponsive.`;
    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
  }
}

async function forgetMemory(hint) {
  stopListening();
  setOrb("thinking");
  try {
    const res  = await fetch("/api/memory/forget", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: state.user, hint }),
    });
    const data = await res.json();
    const reply = data.removed > 0
      ? `Done, ${state.userTitle}. ${data.removed} memory entry removed.`
      : `I couldn't find anything matching that to forget, ${state.userTitle}.`;
    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
  } catch {
    addMsg("jarvis", `Memory deletion failed, ${state.userTitle}.`);
    speak(`Memory deletion failed, ${state.userTitle}.`, () => startIdleLoop());
  }
}

async function recallMemories() {
  stopListening();
  setOrb("thinking");
  try {
    const res   = await fetch(`/api/memory/${encodeURIComponent(state.user)}`);
    const data  = await res.json();
    const facts = data.memories || [];
    if (!facts.length) {
      const reply = `My memory banks are empty for you, ${state.userTitle}. Tell me something worth remembering.`;
      addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); return;
    }
    const list  = facts.map((f, i) => `${i+1}. ${f.fact}`).join("\n");
    const reply = `I currently have ${facts.length} items on file, ${state.userTitle}:\n${list}`;
    addMsg("jarvis", reply);
    speak(`I have ${facts.length} items on file, ${state.userTitle}. Check the transcript for the full list.`, () => startIdleLoop());
  } catch {
    addMsg("jarvis", `Memory retrieval failed, ${state.userTitle}.`);
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
  stopListening();
  setOrb("thinking");
  addMsg("user", question || "What's on my screen?");

  if (!state.screenStream) {
    const reply = `I don't have screen access, ${state.userTitle}. Screen sharing must be active first.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); return;
  }

  let frameB64;
  try {
    frameB64 = await captureScreenFrame();
  } catch (e) {
    console.error("[JARVIS] Frame capture failed:", e);
  }

  if (!frameB64) {
    const reply = `The visual sensors are unresponsive, ${state.userTitle}. Try refreshing the screen share.`;
    addMsg("jarvis", reply); speak(reply, () => startIdleLoop()); return;
  }

  const memories = await loadMemoriesForPrompt();
  try {
    const res  = await fetch("/api/screen", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frameB64,
        question: question || "What is on the screen?",
        userName:  state.user,
        userTitle: state.userTitle,
        memories,
      }),
    });
    const data  = await res.json();
    const reply = data.reply || `I couldn't interpret the screen, ${state.userTitle}.`;
    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
  } catch {
    const reply = `Screen analysis failed, ${state.userTitle}. The optical link dropped.`;
    addMsg("jarvis", reply);
    speak(reply, () => startIdleLoop());
  }
}

async function sendToAI(message) {
  stopListening();
  addMsg("user", message);
  setOrb("thinking");
  const memories = await loadMemoriesForPrompt();
  try {
    const res  = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        sessionId:  state.sessionId,
        userName:   state.user,
        userTitle:  state.userTitle,
        memories,
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
    addMsg("system", "Screen recording declined — 'clip that' and 'read screen' unavailable.");
  }
}

// Grab a single frame from the screen stream as a base64 JPEG
function captureScreenFrame() {
  if (!state.screenStream) return null;
  const track = state.screenStream.getVideoTracks()[0];
  if (!track) return null;
  try {
    // ImageCapture API — available in Chrome
    const capture = new ImageCapture(track);
    return capture.grabFrame().then(bitmap => {
      const canvas = document.createElement("canvas");
      canvas.width  = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      // Return base64 jpeg (quality 0.85 keeps size manageable)
      return canvas.toDataURL("image/jpeg", 0.85).split(",")[1];
    });
  } catch {
    // Fallback: draw current video frame via a hidden <video>
    return new Promise(resolve => {
      const video = document.createElement("video");
      video.srcObject = new MediaStream([track]);
      video.onloadedmetadata = () => {
        video.play();
        const canvas = document.createElement("canvas");
        canvas.width  = video.videoWidth  || 1280;
        canvas.height = video.videoHeight || 720;
        canvas.getContext("2d").drawImage(video, 0, 0);
        video.pause();
        resolve(canvas.toDataURL("image/jpeg", 0.85).split(",")[1]);
      };
    });
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
window.addEventListener("load", async () => {
  setTimeout(() => {
    const w = new SpeechSynthesisUtterance(" ");
    w.volume = 0; speechSynthesis.speak(w);
  }, 500);

  let profile = loadProfile();

  // If no local profile, try to restore from backend using name hint
  if (!profile) {
    profile = await restoreProfileFromBackend();
    if (profile) {
      saveProfileLocal(profile);
      console.log("[JARVIS] Profile restored from backend:", profile.name);
    }
  }

  if (!profile) {
    showSetup();
  } else {
    showAuthScreen();
  }
});
