// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Intro / Boot Sequence v1.0
// Loads AFTER jarvis.js. Wraps the existing window.launchMain
// so the boot animation + spoken self-introduction plays once,
// right after login succeeds, before the main HUD reveals.
// Does not modify any existing logic — pure hook + new screen.
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const BOOT_LINES = [
    "Initializing cognitive engine…",
    "Calibrating neural pathways…",
    "Loading semantic reasoning core…",
    "Establishing secure session…",
    "Linking visual and audio sensors…",
    "Memory bank synchronized…",
    "All systems nominal.",
  ];

  function $(id) { return document.getElementById(id); }

  function typeBootLines(onComplete) {
    const log = $("intro-boot-log");
    const bar = $("intro-progress-bar");
    if (!log) { onComplete(); return; }
    log.innerHTML = "";
    let i = 0;

    function next() {
      if (i >= BOOT_LINES.length) {
        if (bar) bar.style.width = "100%";
        setTimeout(onComplete, 350);
        return;
      }
      const line = document.createElement("div");
      line.className = "boot-line";
      line.textContent = BOOT_LINES[i];
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
      if (bar) bar.style.width = `${Math.round(((i + 1) / BOOT_LINES.length) * 100)}%`;
      i++;
      setTimeout(next, 380);
    }
    next();
  }

  function runIntro(done) {
    const intro = $("intro-screen");
    const auth  = $("auth-screen");
    const main  = $("main-screen");
    if (!intro) { done(); return; }

    if (auth) auth.classList.remove("active");
    if (main) main.classList.remove("active");
    intro.classList.add("active");

    const greetingEl = $("intro-greeting");
    const T = (window.state && window.state.userTitle) || "Sir";
    const userName = (window.state && window.state.user) || "";

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      intro.classList.remove("active");
      if (greetingEl) greetingEl.classList.remove("show");
      done();
    }

    // Skip button — always available in case TTS hangs
    const skipBtn = $("intro-skip-btn");
    if (skipBtn) skipBtn.onclick = finish;

    typeBootLines(() => {
      // ── Hand off to the Daily Briefing screen ──────────────────
      // Asks "what is going to be your task today?" the first time
      // each day, then speaks/plays a numbered briefing. Falls back
      // to the old plain greeting if daily-briefing.js isn't loaded.
      if (window.JarvisBriefing && typeof window.JarvisBriefing.run === "function") {
        try {
          window.JarvisBriefing.run({ user: userName, userTitle: T }, finish);
          return;
        } catch (e) {
          // fall through to legacy greeting below
        }
      }

      const greeting = `Online and fully operational${userName ? `, ${userName}` : ""}. I am J.A.R.V.I.S — Just A Rather Very Intelligent System. All systems are nominal and I'm ready when you are, ${T}.`;
      if (greetingEl) {
        greetingEl.textContent = greeting;
        greetingEl.classList.add("show");
      }

      // Safety timeout in case speech synthesis/Piper never resolves
      const safety = setTimeout(finish, 7000);

      if (typeof window.speak === "function") {
        try {
          window.speak(greeting, () => { clearTimeout(safety); setTimeout(finish, 300); });
        } catch (e) {
          clearTimeout(safety);
          setTimeout(finish, 1800);
        }
      } else {
        clearTimeout(safety);
        setTimeout(finish, 2200);
      }
    });
  }

  // ── HOOK INTO EXISTING launchMain ─────────────────────────
  // jarvis.js declares `function launchMain() {...}` at top level,
  // which attaches to window. We wrap it post-load so the original
  // behaviour (activating main-screen, starting mic, etc.) still
  // runs — just after the intro plays first.
  window.addEventListener("load", () => {
    if (typeof window.launchMain !== "function") return;
    const originalLaunchMain = window.launchMain;
    window.launchMain = function () {
      runIntro(() => originalLaunchMain());
    };
  });
})();
