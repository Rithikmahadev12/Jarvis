// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — BALL GAME
// Fully proactive: no command needed. Watches the camera feed for
// a person arriving in frame ("walking by"), and when that happens
// it spawns a holographic energy ball on its own plus a target
// reticle. Grab the ball (mouse, touch, or a hand-tracking pinch —
// it rides the same [data-hand-drag] pointer-event pipeline used
// elsewhere in the app) and throw it at the reticle to score.
// Walk away and the game clears itself; walk back and it starts
// again — the person never has to ask for it.
// ═══════════════════════════════════════════════════════════════

window.BallGame = (function () {

  // ── CONFIG ──────────────────────────────────────────────────
  const PRESENCE_CHECK_MS   = 1100;   // how often we look for a face
  const ARRIVE_FRAMES       = 2;      // consecutive "present" ticks before we count it as an arrival
  const LEAVE_FRAMES        = 3;      // consecutive "absent" ticks before we count it as gone
  const RESPAWN_DELAY_MS    = 1400;   // pause after a goal/miss before the next ball appears
  const MIN_THROW_SPEED     = 260;    // px/s — below this a "release" just drops the ball
  const GRAVITY             = 900;    // px/s^2
  const DRAG                = 0.994;  // per-frame horizontal velocity decay
  const VELOCITY_WINDOW_MS  = 120;    // how far back we look to compute throw velocity

  let state = {
    active:         false,
    presenceTick:   null,
    faceReady:      false,
    presentCount:   0,
    absentCount:    0,
    personHere:     false,
    ballEl:         null,
    goalEl:         null,
    scoreEl:        null,
    score:          0,
    dragging:       false,
    flying:         false,
    respawnTimer:   null,
    rafId:          null,
    ptrHistory:     [],   // {x,y,t}
    ballPos:        { x: 0, y: 0 },
    ballVel:        { x: 0, y: 0 },
    offset:         { x: 0, y: 0 },
    goalRect:       null,
  };

  function $id(id) { return document.getElementById(id); }

  // ── FACE-API BOOTSTRAP (presence only — reuses the same CDN
  // build the retina-scan module uses, but only loads the light
  // detector net since we don't need landmarks here) ────────────
  async function ensureFaceApi() {
    if (window.faceapi && window.faceapi.nets.tinyFaceDetector.isLoaded) return true;
    if (!window.faceapi) {
      await new Promise((res, rej) => {
        const s = document.createElement("script");
        s.src = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/dist/face-api.min.js";
        s.onload = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    if (!window.faceapi.nets.tinyFaceDetector.isLoaded) {
      const MODEL_URL = "https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights";
      await window.faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
    }
    return true;
  }

  async function checkPresence() {
    const videoEl = $id("camera-feed");
    if (!videoEl || videoEl.readyState < 2 || !window.faceapi) return;
    try {
      const detection = await window.faceapi.detectSingleFace(
        videoEl, new window.faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.45 })
      );
      handlePresence(!!detection);
    } catch { /* camera not ready yet — ignore this tick */ }
  }

  function handlePresence(seen) {
    if (seen) {
      state.presentCount++;
      state.absentCount = 0;
    } else {
      state.absentCount++;
      state.presentCount = 0;
    }

    if (!state.personHere && state.presentCount >= ARRIVE_FRAMES) {
      state.personHere = true;
      onArrive();
    } else if (state.personHere && state.absentCount >= LEAVE_FRAMES) {
      state.personHere = false;
      onLeave();
    }
  }

  // ── ARRIVE / LEAVE ─────────────────────────────────────────
  function onArrive() {
    ensureDom();
    showGoal();
    spawnBall();
  }

  function onLeave() {
    clearTimeout(state.respawnTimer);
    despawnBall(false);
    hideGoal();
    state.score = 0;
    updateScore();
  }

  // ── DOM ──────────────────────────────────────────────────────
  function ensureDom() {
    if ($id("bg-score")) return;

    const score = document.createElement("div");
    score.id = "bg-score";
    score.className = "bg-score hidden";
    score.innerHTML = `<span class="bg-score-label">GOALS</span><span id="bg-score-num">0</span>`;
    document.body.appendChild(score);
    state.scoreEl = score;

    const goal = document.createElement("div");
    goal.id = "bg-goal";
    goal.className = "bg-goal hidden";
    goal.innerHTML = `
      <svg viewBox="0 0 120 120" class="bg-goal-svg">
        <circle cx="60" cy="60" r="52" class="bg-goal-ring bg-goal-ring-outer"/>
        <circle cx="60" cy="60" r="36" class="bg-goal-ring bg-goal-ring-mid"/>
        <circle cx="60" cy="60" r="6"  class="bg-goal-core"/>
        <line x1="60" y1="2" x2="60" y2="20" class="bg-goal-tick"/>
        <line x1="60" y1="100" x2="60" y2="118" class="bg-goal-tick"/>
        <line x1="2" y1="60" x2="20" y2="60" class="bg-goal-tick"/>
        <line x1="100" y1="60" x2="118" y2="60" class="bg-goal-tick"/>
      </svg>
      <div class="bg-goal-label">TARGET</div>
    `;
    document.body.appendChild(goal);
    state.goalEl = goal;
  }

  function placeGoal() {
    const margin = 130;
    const w = window.innerWidth, h = window.innerHeight;
    // Park it up in a top corner, alternating sides, out of the way of the
    // taskbar/nav chrome at the very edges.
    const onRight = Math.random() < 0.5;
    const x = onRight ? w - margin - 40 : margin - 40;
    const y = 110 + Math.random() * Math.min(160, h * 0.25);
    state.goalEl.style.left = x + "px";
    state.goalEl.style.top = y + "px";
    state.goalRect = { x, y, r: 46 };
  }

  function showGoal() {
    ensureDom();
    placeGoal();
    state.goalEl.classList.remove("hidden");
    state.scoreEl.classList.remove("hidden");
    requestAnimationFrame(() => state.goalEl.classList.add("bg-goal-in"));
  }

  function hideGoal() {
    if (!state.goalEl) return;
    state.goalEl.classList.remove("bg-goal-in");
    state.goalEl.classList.add("hidden");
    if (state.scoreEl) state.scoreEl.classList.add("hidden");
  }

  function updateScore() {
    const n = $id("bg-score-num");
    if (n) n.textContent = state.score;
  }

  // ── BALL SPAWN / DRAG / THROW ─────────────────────────────────
  function spawnBall() {
    if (state.ballEl || !state.personHere) return;

    const ball = document.createElement("div");
    ball.id = "bg-ball";
    ball.className = "bg-ball bg-ball-spawn";
    ball.dataset.handDrag = "true"; // rides HandTracking's pinch-drag pointer pipeline
    ball.innerHTML = `<div class="bg-ball-core"></div><div class="bg-ball-ring"></div>`;
    document.body.appendChild(ball);
    state.ballEl = ball;

    const w = window.innerWidth, h = window.innerHeight;
    const x = w * 0.5 + (Math.random() - 0.5) * w * 0.2;
    const y = h * 0.62 + (Math.random() - 0.5) * h * 0.08;
    setBallPos(x, y);

    initBallDrag(ball);
    playChime("spawn");
  }

  function setBallPos(x, y) {
    state.ballPos.x = x;
    state.ballPos.y = y;
    if (state.ballEl) {
      state.ballEl.style.left = x + "px";
      state.ballEl.style.top = y + "px";
    }
  }

  function initBallDrag(ball) {
    ball.addEventListener("pointerdown", (e) => {
      if (state.flying) return;
      state.dragging = true;
      state.ptrHistory = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      const rect = ball.getBoundingClientRect();
      state.offset.x = e.clientX - (rect.left + rect.width / 2);
      state.offset.y = e.clientY - (rect.top + rect.height / 2);
      ball.classList.add("bg-ball-grabbed");
      ball.classList.remove("bg-ball-spawn");
      try { ball.setPointerCapture(e.pointerId); } catch {}
    });

    ball.addEventListener("pointermove", (e) => {
      if (!state.dragging) return;
      const x = e.clientX - state.offset.x;
      const y = e.clientY - state.offset.y;
      setBallPos(x, y);
      state.ptrHistory.push({ x: e.clientX, y: e.clientY, t: performance.now() });
      const cutoff = performance.now() - VELOCITY_WINDOW_MS;
      while (state.ptrHistory.length > 2 && state.ptrHistory[0].t < cutoff) state.ptrHistory.shift();
    });

    function release(e) {
      if (!state.dragging) return;
      state.dragging = false;
      ball.classList.remove("bg-ball-grabbed");
      try { ball.releasePointerCapture(e.pointerId); } catch {}

      const hist = state.ptrHistory;
      let vx = 0, vy = 0;
      if (hist.length >= 2) {
        const a = hist[0], b = hist[hist.length - 1];
        const dt = Math.max(16, b.t - a.t) / 1000;
        vx = (b.x - a.x) / dt;
        vy = (b.y - a.y) / dt;
      }
      const speed = Math.hypot(vx, vy);
      if (speed >= MIN_THROW_SPEED) {
        throwBall(vx, vy);
      }
      // else: just leave it where it was dropped, still grabbable
    }
    ball.addEventListener("pointerup", release);
    ball.addEventListener("pointercancel", release);
  }

  function throwBall(vx, vy) {
    state.flying = true;
    state.ballVel.x = vx;
    state.ballVel.y = vy;
    state.ballEl.classList.add("bg-ball-flying");
    let lastT = performance.now();

    function frame(now) {
      const dt = Math.min(0.032, (now - lastT) / 1000);
      lastT = now;

      state.ballVel.y += GRAVITY * dt;
      state.ballVel.x *= DRAG;
      setBallPos(state.ballPos.x + state.ballVel.x * dt, state.ballPos.y + state.ballVel.y * dt);

      if (hitGoal()) { onGoal(); return; }

      const w = window.innerWidth, h = window.innerHeight;
      if (state.ballPos.x < -80 || state.ballPos.x > w + 80 || state.ballPos.y > h + 80) {
        onMiss();
        return;
      }
      state.rafId = requestAnimationFrame(frame);
    }
    state.rafId = requestAnimationFrame(frame);
  }

  function hitGoal() {
    if (!state.goalRect) return false;
    const d = Math.hypot(state.ballPos.x - state.goalRect.x, state.ballPos.y - state.goalRect.y);
    return d < state.goalRect.r;
  }

  function onGoal() {
    state.flying = false;
    state.score++;
    updateScore();
    flashGoal();
    playChime("score");
    despawnBall(true);
    queueRespawn();
  }

  function onMiss() {
    state.flying = false;
    despawnBall(false);
    queueRespawn();
  }

  function queueRespawn() {
    if (!state.personHere) return;
    clearTimeout(state.respawnTimer);
    state.respawnTimer = setTimeout(() => { if (state.personHere) spawnBall(); }, RESPAWN_DELAY_MS);
  }

  function flashGoal() {
    if (!state.goalEl) return;
    state.goalEl.classList.add("bg-goal-score");
    setTimeout(() => state.goalEl && state.goalEl.classList.remove("bg-goal-score"), 500);

    const burst = document.createElement("div");
    burst.className = "bg-burst";
    burst.style.left = state.goalRect.x + "px";
    burst.style.top = state.goalRect.y + "px";
    document.body.appendChild(burst);
    setTimeout(() => burst.remove(), 700);
  }

  function despawnBall(scored) {
    if (state.rafId) cancelAnimationFrame(state.rafId);
    state.rafId = null;
    state.dragging = false;
    state.flying = false;
    if (state.ballEl) {
      const el = state.ballEl;
      el.classList.add(scored ? "bg-ball-scored-out" : "bg-ball-fade-out");
      setTimeout(() => el.remove(), 260);
      state.ballEl = null;
    }
  }

  // ── LIGHTWEIGHT AUDIO FEEDBACK (no extra asset files) ──────────
  let actx = null;
  function playChime(kind) {
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.connect(g); g.connect(actx.destination);
      const t = actx.currentTime;
      if (kind === "score") {
        o.type = "sine";
        o.frequency.setValueAtTime(520, t);
        o.frequency.exponentialRampToValueAtTime(1040, t + 0.18);
        g.gain.setValueAtTime(0.08, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        o.start(t); o.stop(t + 0.36);
      } else {
        o.type = "sine";
        o.frequency.setValueAtTime(300, t);
        o.frequency.exponentialRampToValueAtTime(480, t + 0.12);
        g.gain.setValueAtTime(0.05, t);
        g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
        o.start(t); o.stop(t + 0.2);
      }
    } catch { /* audio not available — silently skip */ }
  }

  // ── START / STOP ────────────────────────────────────────────
  async function start() {
    if (state.active) return;
    state.active = true;
    try { await ensureFaceApi(); } catch { /* will retry on next tick via checkPresence guard */ }
    state.presenceTick = setInterval(checkPresence, PRESENCE_CHECK_MS);
  }

  function stop() {
    state.active = false;
    if (state.presenceTick) clearInterval(state.presenceTick);
    clearTimeout(state.respawnTimer);
    despawnBall(false);
    hideGoal();
    state.personHere = false;
    state.presentCount = 0;
    state.absentCount = 0;
  }

  return { start, stop };
})();
