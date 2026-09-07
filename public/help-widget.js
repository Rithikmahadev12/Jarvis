// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Screen Help Widget
//
// Triggered by saying/typing "Jarvis, help me on this" / "Jarvis, I
// need help on this" / "Jarvis, I need a website helper" (see the
// HELP_WIDGET_RE hook added in jarvis.js). No browser extension
// involved — this reads the screen server-side via screen-vision.js
// (screenshot-desktop + OCR, with a self-hosted Ollama vision model
// running in Jarvis's own E2B sandbox as a fallback for anything OCR
// can't read).
//
// Behavior:
//   - Opens a small floating panel: "Sir, tell me what you need
//     help with." with a text box.
//   - Type a question and hit Enter/Send -> answer streams into the
//     box as text (silent by default).
//   - Tap the mic button to switch to voice mode: your next question
//     can be spoken instead of typed, AND the answer is spoken back
//     out loud. Tap again to go back to text-only.
//   - Closing the panel (X) stops any listening/speaking in progress
//     and everything goes back to normal.
//
// window.HelpWidget.show() / .hide() / .toggle()
// ═══════════════════════════════════════════════════════════════

window.HelpWidget = (function () {
  let panel = null, logEl = null, inputEl = null, sendBtn = null, micBtn = null, statusEl = null;
  let voiceOn = false;
  let recognition = null;
  let listening = false;
  let currentAudio = null;
  let savedPhase = null;
  let busy = false;

  // ── STYLES (self-contained, no separate CSS file to wire up) ──
  function injectStyles() {
    if (document.getElementById("jhw-styles")) return;
    const style = document.createElement("style");
    style.id = "jhw-styles";
    style.textContent = `
      #jhw-panel {
        position: fixed; bottom: 24px; right: 24px; width: 340px;
        max-height: 420px; display: flex; flex-direction: column;
        background: rgba(10, 14, 20, 0.92); border: 1px solid rgba(80, 200, 255, 0.35);
        border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,0.55), 0 0 24px rgba(80,200,255,0.08);
        font-family: inherit; color: #d9f1ff; z-index: 999999;
        opacity: 0; transform: translateY(16px) scale(0.98); pointer-events: none;
        transition: opacity .18s ease, transform .18s ease;
        backdrop-filter: blur(10px);
      }
      #jhw-panel.jhw-in { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
      #jhw-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 10px 12px; border-bottom: 1px solid rgba(80,200,255,0.18);
        font-size: 12px; letter-spacing: 0.06em; text-transform: uppercase; color: #7fd8ff;
      }
      #jhw-close { background: none; border: none; color: #8fb8cc; font-size: 16px; cursor: pointer; line-height: 1; padding: 2px 4px; }
      #jhw-close:hover { color: #fff; }
      #jhw-log { flex: 1; overflow-y: auto; padding: 12px; font-size: 13.5px; line-height: 1.45; }
      #jhw-log .jhw-msg { margin-bottom: 10px; }
      #jhw-log .jhw-msg.jhw-user { color: #9fe6ff; }
      #jhw-log .jhw-msg.jhw-jarvis { color: #eaf6ff; }
      #jhw-log .jhw-msg.jhw-status { color: #6f8fa3; font-style: italic; }
      #jhw-inputrow { display: flex; align-items: center; gap: 6px; padding: 10px; border-top: 1px solid rgba(80,200,255,0.18); }
      #jhw-input {
        flex: 1; background: rgba(255,255,255,0.06); border: 1px solid rgba(80,200,255,0.25);
        border-radius: 8px; color: #eaf6ff; padding: 8px 10px; font-size: 13px; outline: none;
      }
      #jhw-input:focus { border-color: #4fd2ff; }
      #jhw-send, #jhw-mic {
        width: 34px; height: 34px; border-radius: 8px; border: 1px solid rgba(80,200,255,0.25);
        background: rgba(80,200,255,0.08); color: #bfe9ff; cursor: pointer; font-size: 15px;
        display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      }
      #jhw-send:hover, #jhw-mic:hover { background: rgba(80,200,255,0.2); }
      #jhw-mic.jhw-voice-on { background: #2fb8ff; color: #061018; border-color: #2fb8ff; }
      #jhw-mic.jhw-listening { animation: jhw-pulse 1s infinite; }
      @keyframes jhw-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(47,184,255,0.55);} 50% { box-shadow: 0 0 0 6px rgba(47,184,255,0);} }
    `;
    document.head.appendChild(style);
  }

  function ensureDom() {
    if (panel) return;
    injectStyles();
    panel = document.createElement("div");
    panel.id = "jhw-panel";
    panel.innerHTML = `
      <div id="jhw-head">
        <span>J.A.R.V.I.S — Screen Helper</span>
        <button id="jhw-close" title="Close">&#10005;</button>
      </div>
      <div id="jhw-log"></div>
      <div id="jhw-inputrow">
        <input id="jhw-input" type="text" placeholder="Tell me what you need help with..." autocomplete="off" />
        <button id="jhw-mic" title="Toggle voice">&#127908;</button>
        <button id="jhw-send" title="Send">&#10148;</button>
      </div>
    `;
    document.body.appendChild(panel);

    logEl = panel.querySelector("#jhw-log");
    inputEl = panel.querySelector("#jhw-input");
    sendBtn = panel.querySelector("#jhw-send");
    micBtn = panel.querySelector("#jhw-mic");

    panel.querySelector("#jhw-close").addEventListener("click", hide);
    sendBtn.addEventListener("click", handleSend);
    inputEl.addEventListener("keydown", (e) => { if (e.key === "Enter") handleSend(); });
    micBtn.addEventListener("click", toggleVoice);
  }

  function addLine(kind, text) {
    if (!logEl) return;
    const div = document.createElement("div");
    div.className = `jhw-msg jhw-${kind}`;
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    return div;
  }

  // ── SHOW / HIDE ─────────────────────────────────────────────
  function show() {
    ensureDom();
    panel.classList.add("jhw-in");
    if (!logEl.childElementCount) {
      addLine("jarvis", `${(window.state && window.state.userTitle) || "Sir"}, tell me what you need help with.`);
    }
    // Pause the main conversation pipeline while this panel owns the
    // mic/voice, so a spoken question here doesn't also get parsed as
    // a normal Jarvis command in the background.
    if (window.state && window.state.phase === "chatting") {
      savedPhase = "chatting";
      window.state.phase = "help-widget";
    }
    inputEl.focus();
  }

  function hide() {
    if (!panel) return;
    panel.classList.remove("jhw-in");
    stopListening();
    stopSpeakingWidget();
    if (savedPhase && window.state) {
      window.state.phase = savedPhase;
      savedPhase = null;
    }
    voiceOn = false;
    if (micBtn) micBtn.classList.remove("jhw-voice-on", "jhw-listening");
  }

  function toggle() { (panel && panel.classList.contains("jhw-in")) ? hide() : show(); }

  // ── VOICE MODE ──────────────────────────────────────────────
  function toggleVoice() {
    voiceOn = !voiceOn;
    micBtn.classList.toggle("jhw-voice-on", voiceOn);
    if (voiceOn) {
      addLine("status", "Voice on — I'll speak my answers, and you can talk instead of typing.");
      startListening();
    } else {
      addLine("status", "Voice off — text only from here.");
      stopListening();
      stopSpeakingWidget();
    }
  }

  function getRecognitionCtor() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  function startListening() {
    const Ctor = getRecognitionCtor();
    if (!Ctor) { addLine("status", "Voice input isn't supported in this browser — you can still type."); return; }
    if (recognition) { try { recognition.stop(); } catch {} }
    recognition = new Ctor();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = "en-US";

    recognition.onstart = () => { listening = true; micBtn.classList.add("jhw-listening"); };
    recognition.onend = () => {
      listening = false;
      micBtn.classList.remove("jhw-listening");
      // Auto-restart listening after speaking finishes, as long as
      // voice mode is still on and we're not mid-request.
      if (voiceOn && !busy && panel && panel.classList.contains("jhw-in")) {
        setTimeout(() => { if (voiceOn && !busy) startListening(); }, 400);
      }
    };
    recognition.onerror = (e) => { if (e.error !== "no-speech" && e.error !== "aborted") addLine("status", `(mic error: ${e.error})`); };
    recognition.onresult = (e) => {
      const transcript = e.results[0][0].transcript;
      if (transcript && transcript.trim()) {
        inputEl.value = transcript.trim();
        handleSend();
      }
    };
    try { recognition.start(); } catch {}
  }

  function stopListening() {
    if (recognition) { try { recognition.stop(); } catch {} recognition = null; }
    listening = false;
  }

  // ── SPEAKING (independent of the main app's global mute) ──────
  async function speakAnswer(text) {
    if (!voiceOn || !text) return;
    stopSpeakingWidget();
    try {
      const res = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, user: (window.state && window.state.user) }),
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        currentAudio = new Audio(url);
        currentAudio.play().catch(() => fallbackBrowserVoice(text));
        return;
      }
    } catch {}
    fallbackBrowserVoice(text);
  }

  function fallbackBrowserVoice(text) {
    if (!window.speechSynthesis) return;
    const utter = new SpeechSynthesisUtterance(text);
    window.speechSynthesis.speak(utter);
  }

  function stopSpeakingWidget() {
    if (currentAudio) { try { currentAudio.pause(); } catch {} currentAudio = null; }
    if (window.speechSynthesis) window.speechSynthesis.cancel();
  }

  // ── SEND ─────────────────────────────────────────────────────
  async function handleSend() {
    const question = inputEl.value.trim();
    if (!question || busy) return;
    inputEl.value = "";
    stopListening();
    addLine("user", question);
    const thinkingLine = addLine("status", "Looking at your screen...");
    busy = true;
    sendBtn.disabled = true;

    try {
      const res = await fetch("/api/help-widget/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, userTitle: (window.state && window.state.userTitle) || "Sir" }),
        signal: AbortSignal.timeout(45000),
      });
      const data = await res.json().catch(() => ({}));
      thinkingLine.remove();
      const reply = data.reply || "I couldn't get an answer that time.";
      addLine("jarvis", reply);
      if (voiceOn) speakAnswer(reply);
    } catch (e) {
      thinkingLine.remove();
      addLine("status", `Request failed: ${e.message}`);
    } finally {
      busy = false;
      sendBtn.disabled = false;
      if (voiceOn && panel.classList.contains("jhw-in")) {
        setTimeout(() => { if (voiceOn) startListening(); }, 300);
      } else {
        inputEl.focus();
      }
    }
  }

  return { show, hide, toggle };
})();
