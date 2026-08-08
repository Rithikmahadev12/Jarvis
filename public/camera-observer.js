// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Camera Observer (client-side)
// Watches the camera feed, analyses what's happening,
// and makes JARVIS comment proactively with personality.
// Drop this file in public/ and add one script tag to index.html
// ═══════════════════════════════════════════════════════════════

window.CameraObserver = (function () {

  // ── STATE ──────────────────────────────────────────────────
  const obs = {
    active:               false,
    sessionStart:         Date.now(),
    lastProactiveComment: 0,        // timestamp of last unprompted comment
    lastUserMessage:      Date.now(),
    lastExpression:       null,
    expressionHoldCount:  0,        // how many frames same expression held
    previousScene:        null,
    checkInterval:        null,
    // Movie-accurate JARVIS is restrained, not chatty — a remark every
    // 15-20 min, not a running commentary. Randomized within that window
    // per session so it doesn't feel like a metronome.
    COMMENT_COOLDOWN_MS:  (15 + Math.random() * 5) * 60 * 1000,
    EXPRESSION_FRAMES:    3,                // frames expression must hold before reacting
  };

  // ── GRAB A REAL FRAME (for vision-grounded commentary) ─────
  // Only called right when we've already decided a comment is due —
  // not every tick — so this doesn't spend a vision-model call every
  // 90 seconds for no reason.
  function captureFrameBase64(videoEl) {
    try {
      if (!videoEl.videoWidth) return null;
      const c = document.createElement("canvas");
      c.width = videoEl.videoWidth;
      c.height = videoEl.videoHeight;
      c.getContext("2d").drawImage(videoEl, 0, 0);
      return c.toDataURL("image/jpeg", 0.85).split(",")[1];
    } catch (e) {
      return null;
    }
  }

  // ── UTILITIES ──────────────────────────────────────────────
  const minutesSince = ts => (Date.now() - ts) / 60000;

  // ── EXPRESSION → SCENE MAPPER ─────────────────────────────
  function expressionsToScene(expressions, sessionMinutes) {
    if (!expressions) return "idle";

    const sorted = Object.entries(expressions).sort((a, b) => b[1] - a[1]);
    const [topLabel, topConf] = sorted[0] || ["neutral", 0];

    const h = new Date().getHours();

    // Late night overrides everything
    if ((h >= 1 && h <= 4) && sessionMinutes > 10) return "lateNight";

    // Overworking check
    if (sessionMinutes > 95) return "overworking";

    // Expression-based
    if (topLabel === "happy"     && topConf > 0.55) return "happy";
    if (topLabel === "sad"       && topConf > 0.40) return "stressed";
    if (topLabel === "angry"     && topConf > 0.35) return "stressed";
    if (topLabel === "fearful"   && topConf > 0.35) return "stressed";
    if (topLabel === "disgusted" && topConf > 0.35) return "stressed";
    if (topLabel === "surprised" && topConf > 0.50) return "surprised";

    return "idle";
  }

  // ── DETECT FACE VIA FACE-API ──────────────────────────────
  async function detectFace(videoEl) {
    if (!window.faceapi || !videoEl || videoEl.readyState < 2) return null;
    try {
      const detection = await faceapi
        .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks()
        .withFaceExpressions();
      return detection || null;
    } catch {
      return null;
    }
  }

  // ── MAIN OBSERVATION TICK ─────────────────────────────────
  async function tick() {
    // Only run when JARVIS is in chatting mode and not currently speaking
    if (!window.state || window.state.phase !== "chatting") return;
    if (window.state.synth && window.state.synth.speaking) return;

    const videoEl = document.getElementById("camera-feed");
    if (!videoEl) return;

    const sessionMinutes      = minutesSince(obs.sessionStart);
    const lastSpokenMinutes   = minutesSince(obs.lastProactiveComment);
    const lastUserMsgMinutes  = minutesSince(obs.lastUserMessage);
    const T                   = window.state.userTitle || "Sir";

    // ── Face detection ──
    const detection = await detectFace(videoEl);

    let scene = "idle";

    if (!detection) {
      // No face — user may be away
      if (sessionMinutes > 3 && lastUserMsgMinutes > 10) {
        scene = "longSilence";
      }
    } else {
      scene = expressionsToScene(detection.expressions, sessionMinutes);
    }

    // ── Expression stability check ──
    // Only react if same scene held for EXPRESSION_FRAMES consecutive ticks
    if (scene === obs.lastExpression) {
      obs.expressionHoldCount++;
    } else {
      obs.lastExpression = scene;
      obs.expressionHoldCount = 0;
    }

    const sceneStable = obs.expressionHoldCount >= obs.EXPRESSION_FRAMES;

    // ── Decide whether to speak ──
    const cooldownPassed = lastSpokenMinutes > (obs.COMMENT_COOLDOWN_MS / 60000);
    const notTooSoon     = lastUserMsgMinutes > 2; // don't interrupt active conversations

    // Hard-coded trigger: always flag late night and overworking
    const isUrgent = (scene === "lateNight" && lastSpokenMinutes > 25)
                  || (scene === "overworking" && lastSpokenMinutes > 35);

    // Stressed — comment if held for several frames and user has been quiet
    const isStressed = (scene === "stressed" && sceneStable && lastUserMsgMinutes > 6 && lastSpokenMinutes > 12);

    // Occasional check-ins
    const isIdleCheckin = (
      sceneStable &&
      cooldownPassed &&
      notTooSoon &&
      lastSpokenMinutes > 15 &&
      Math.random() < 0.25  // 25% chance each tick when eligible
    );

    if (!isUrgent && !isStressed && !isIdleCheckin) return;

    // ── Fetch comment from server ──
    // Grab one real frame now (only now — not every tick) so JARVIS can
    // react to something actually happening in the room instead of just
    // the facial-expression label.
    const frame = captureFrameBase64(videoEl);

    try {
      const res = await fetch("/api/personality/comment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scene,
          userTitle:        T,
          sessionMinutes:   Math.floor(sessionMinutes),
          lastSpokenMinutes: Math.floor(lastSpokenMinutes),
          previousScene:    obs.previousScene,
          userTimezone:     (Intl.DateTimeFormat().resolvedOptions().timeZone) || null,
          image:            frame || undefined,
        }),
      });

      const data = await res.json();
      if (!data.reply) return;

      // ── Deliver the comment ──
      obs.lastProactiveComment = Date.now();
      obs.previousScene = scene;

      // Use JARVIS's existing addMsg and speak functions
      if (window.addMsg) window.addMsg("jarvis", data.reply);
      if (window.speak)  window.speak(data.reply);

    } catch (e) {
      console.warn("[OBSERVER] Comment fetch failed:", e.message);
    }
  }

  // ── TRACK USER MESSAGES ───────────────────────────────────
  // Call this from jarvis.js whenever the user sends a message
  function notifyUserMessage() {
    obs.lastUserMessage = Date.now();
  }

  // ── START / STOP ──────────────────────────────────────────
  function start() {
    if (obs.active) return;
    obs.active       = true;
    obs.sessionStart = Date.now();
    obs.lastProactiveComment = Date.now() - (5 * 60 * 1000); // allow first comment after 5 min

    // Check every 90 seconds
    obs.checkInterval = setInterval(tick, 90 * 1000);
    console.log("[OBSERVER] Camera observer active.");
  }

  function stop() {
    if (obs.checkInterval) clearInterval(obs.checkInterval);
    obs.active = false;
    console.log("[OBSERVER] Camera observer stopped.");
  }

  // ── EXPOSE PUBLIC API ─────────────────────────────────────
  return { start, stop, notifyUserMessage };

})();
