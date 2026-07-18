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

  // ── ONCE-PER-DAY GATE ──
  // The boot intro (typed log + spoken self-introduction) should only
  // play the first time JARVIS is opened on a given day. Every login
  // after that, on the same day, skips straight to the main screen.
  const LAST_INTRO_KEY = "jarvis_last_intro_date";
  function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
  }
  function introAlreadyShownToday() {
    try { return localStorage.getItem(LAST_INTRO_KEY) === todayKey(); }
    catch (e) { return false; }
  }
  function markIntroShownToday() {
    try { localStorage.setItem(LAST_INTRO_KEY, todayKey()); } catch (e) {}
  }

  function formatCountdown(totalSeconds) {
    const s = Math.max(0, Math.round(totalSeconds));
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  }

  function runCountdown(durationMs) {
    const el = $("intro-countdown");
    if (!el) return;
    const startSeconds = 23 * 60 + 59; // stylised "23:59" starting point, matches boot reference
    const startTime = Date.now();
    el.textContent = formatCountdown(startSeconds);
    const timer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const pct = Math.min(1, elapsed / durationMs);
      // ease-out so it races down quickly then settles at 00:00 right as boot finishes
      const remaining = startSeconds * Math.pow(1 - pct, 2);
      el.textContent = formatCountdown(remaining);
      if (pct >= 1) { el.textContent = "00:00"; clearInterval(timer); }
    }, 80);
    return timer;
  }

  function typeBootLines(onComplete) {
    const log = $("intro-boot-log");
    const bar = $("intro-progress-bar");
    const caption = $("intro-caption");
    if (!log) { onComplete(); return; }
    log.innerHTML = "";
    let i = 0;

    runCountdown(BOOT_LINES.length * 380 + 350);

    function next() {
      if (i >= BOOT_LINES.length) {
        if (bar) bar.style.width = "100%";
        if (caption) caption.textContent = "All systems nominal.";
        setTimeout(onComplete, 350);
        return;
      }
      const line = document.createElement("div");
      line.className = "boot-line";
      line.textContent = BOOT_LINES[i];
      log.appendChild(line);
      log.scrollTop = log.scrollHeight;
      if (caption) caption.textContent = BOOT_LINES[i];
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

    // Already opened JARVIS today — skip the boot intro entirely and go
    // straight to the main HUD.
    if (introAlreadyShownToday()) { done(); return; }
    markIntroShownToday();

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
      // The Daily Briefing screen no longer runs automatically here —
      // JARVIS now asks whether you want it (after face enrollment, or
      // any time you say "daily briefing") instead of always showing it
      // on login. See offerDailyBriefing() in jarvis.js.
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
