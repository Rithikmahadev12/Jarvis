// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Home UI helpers v1.0
// The type-to-chat box is hidden by default on the minimal home
// screen. It only appears when the user asks for it by voice
// (or by typing, once the mic has picked up the wake phrase), e.g.
//   "Jarvis, pull up typing feature"
//   "Jarvis, show typing"
//   "Jarvis, hide typing"
// This wraps window.handleChatCommand (defined in jarvis.js) the
// same way intro.js wraps launchMain — no edits to jarvis.js needed.
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function getBar() {
    const input = $("type-input");
    return input ? input.closest(".input-bar") : null;
  }

  function showTypingFeature() {
    const bar = getBar();
    if (!bar) return;
    bar.classList.add("show-typing");
    setTimeout(() => { const input = $("type-input"); if (input) input.focus(); }, 60);
  }

  function hideTypingFeature() {
    const bar = getBar();
    if (!bar) return;
    bar.classList.remove("show-typing");
    const input = $("type-input");
    if (input) input.blur();
  }

  window.showTypingFeature = showTypingFeature;
  window.hideTypingFeature = hideTypingFeature;

  // ── Chat hero pill buttons ──
  // #type-send now doubles as the pill's mic icon (jarvis.js's own
  // click listener still fires and sends the message when there's
  // text). We check on mousedown — BEFORE jarvis.js's click listener
  // clears the input — so we know whether the click was "send" or
  // "start listening" without racing it.
  window.addEventListener("load", () => {
    const micBtn = $("type-send");
    const input = $("type-input");
    const plusBtn = $("chat-plus-btn");

    if (micBtn && input) {
      micBtn.addEventListener("mousedown", () => {
        micBtn.dataset.hadText = input.value.trim() ? "1" : "0";
      });
      micBtn.addEventListener("click", () => {
        if (micBtn.dataset.hadText === "0" && typeof window.toggleListening === "function") {
          window.toggleListening();
        }
      });
    }

    if (plusBtn && input) {
      plusBtn.addEventListener("click", () => input.focus());
    }

    // Mirror the taskbar mic's "live" state onto the pill's mic icon.
    if (typeof window.toggleListening === "function") {
      const originalToggle = window.toggleListening;
      window.toggleListening = function () {
        originalToggle();
        const tbMic = $("tb-btn-mic");
        if (micBtn && tbMic) micBtn.classList.toggle("live", tbMic.classList.contains("live"));
      };
    }
  });

  const SHOW_TYPING = /\b(pull up|bring up|show|open|enable|activate)\s+(the\s+)?typ(e|ing)(\s+feature|\s+box|\s+bar|\s+mode)?\b/i;
  const HIDE_TYPING  = /\b(hide|close|dismiss|put away)\s+(the\s+)?typ(e|ing)(\s+feature|\s+box|\s+bar|\s+mode)?\b/i;

  window.addEventListener("load", () => {
    if (typeof window.handleChatCommand !== "function") return;
    const original = window.handleChatCommand;

    window.handleChatCommand = function (text) {
      const lower = (text || "").toLowerCase();

      if (SHOW_TYPING.test(lower)) {
        showTypingFeature();
        if (typeof window.speak === "function") window.speak("Here you go.");
        return;
      }
      if (HIDE_TYPING.test(lower)) {
        hideTypingFeature();
        if (typeof window.speak === "function") window.speak("Putting that away.");
        return;
      }
      return original(text);
    };
  });
})();
