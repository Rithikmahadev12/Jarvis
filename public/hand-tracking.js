// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — HAND TRACKING MODULE
// MediaPipe Hands skeleton overlay + dwell-click cursor + gesture
// virtual keyboard. Fully additive — does not touch existing IDs
// used by jarvis.js. Runs on the main screen only, reusing the
// existing camera-feed <video> element as input.
//
// GESTURE EVENTS — any page can listen for these on `window`:
//   "jarvis:swipe"  detail: { dir: "left" | "right" }   — one hand,
//       fast horizontal motion. Use to switch monitors/modes.
//   "jarvis:zoom"   detail: { dir: "in" | "out" }        — two hands,
//       spreading apart = "out" (pull back to an overview), bringing
//       together = "in" (focus back on one monitor). Mirrors the
//       two-arm "open up the workspace" gesture from the reference
//       footage.
// Example: window.addEventListener("jarvis:swipe", e => { ... });
//
// PINCH-DRAG — no event, no spoken command. Pinch thumb + index over any
// element marked with the attribute `data-hand-drag="true"` and it moves
// with your hand until you release the pinch. It works by dispatching
// real PointerEvents at the pinch point, so it just rides whatever
// pointer-drag handling that widget already has for mouse/touch — there's
// no separate "move mode" to trigger, the widget just follows your hand
// the moment you grab it, the same way it'd follow a mouse drag.
// To make a new widget hand-draggable, add `dataset.handDrag = "true"`
// to its root element (see music-widget.js for the pattern).
// ═══════════════════════════════════════════════════════════════

const HandTracking = (() => {

  const DWELL_MS          = 1000;   // hold time to "click"
  const RAISE_THRESHOLD   = 0.40;   // wrist y (0=top,1=bottom) above which hand counts as "raised"
  const REARM_THRESHOLD   = 0.65;   // wrist must drop below this before a new raise can trigger again
  const SMOOTHING         = 0.35;   // cursor smoothing factor (0=instant,1=frozen)
  const TOGGLE_COOLDOWN_MS = 600;   // minimum time between toggles

  let hands            = null;
  let camera            = null;
  let overlayCanvas     = null;
  let overlayCtx        = null;
  let cursorEl          = null;
  let keyboardEl        = null;
  let active            = false;
  let armed             = true;   // true = wrist has dropped low enough that a new raise can trigger a toggle
  let keyboardOpen      = false;
  let lastToggleAt      = 0;
  let smoothX = null, smoothY = null;
  let dwellTarget       = null;
  let dwellStart        = 0;
  let dwellRingEl       = null;

  // ── HOVER SOUND EFFECT ──
  // Plays whenever the hand-tracking cursor moves onto a NEW clickable
  // element (any dwell target — taskbar buttons, mode-picker nodes,
  // dialogs, etc). Cloning the node on every play lets rapid hovers
  // overlap instead of cutting each other off.
  let hoverAudio = null;
  function playHoverSound() {
    if (!hoverAudio) return;
    try {
      const a = hoverAudio.cloneNode();
      a.volume = 0.35;
      a.play().catch(() => {});
    } catch (e) {}
  }

  // ── PINCH-DRAG STATE (direct manipulation — no spoken command needed) ──
  // Pinching thumb + index over anything marked [data-hand-drag] grabs it;
  // moving the hand while pinched moves it; releasing the pinch drops it.
  // This works by dispatching real PointerEvents at the pinch point, so it
  // rides on whatever pointer-based drag handling the widget already has
  // (the same one mouse/touch dragging uses) — no per-widget gesture code.
  const PINCH_ON  = 0.055; // normalized thumb-index distance to start a pinch
  const PINCH_OFF = 0.075; // must open past this to release (hysteresis avoids flicker)
  const DRAG_POINTER_ID = 9101;
  let pinching     = false;
  let pinchDragTarget = null;
  let typingTargetInput = null; // input element virtual keyboard types into
  let scriptsLoaded     = false;

  // ── GESTURE DETECTION STATE (swipe + two-hand zoom) ──
  let posHistory   = [];   // {x,y,t} raw cursor samples, single hand, for swipe
  let lastSwipeAt  = 0;
  const SWIPE_WINDOW_MS    = 260;
  const SWIPE_MIN_DIST_PX  = 160;
  const SWIPE_COOLDOWN_MS  = 700;

  let distHistory  = [];   // {d,t} normalized distance between two wrists, for zoom
  let lastZoomAt   = 0;
  const ZOOM_WINDOW_MS   = 380;
  const ZOOM_MIN_DELTA   = 0.22;
  const ZOOM_COOLDOWN_MS = 900;

  // ── BUILD DOM ──
  function buildDom() {
    if ($id("ht-overlay-canvas")) return; // already built

    overlayCanvas = document.createElement("canvas");
    overlayCanvas.id = "ht-overlay-canvas";
    overlayCanvas.className = "ht-overlay-canvas";
    document.body.appendChild(overlayCanvas);
    overlayCtx = overlayCanvas.getContext("2d");

    cursorEl = document.createElement("div");
    cursorEl.id = "ht-cursor";
    cursorEl.className = "ht-cursor";
    cursorEl.innerHTML = `<div class="ht-cursor-dot"></div><svg class="ht-cursor-ring" viewBox="0 0 40 40"><circle class="ht-cursor-ring-bg" cx="20" cy="20" r="17"/><circle class="ht-cursor-ring-fill" cx="20" cy="20" r="17"/></svg>`;
    document.body.appendChild(cursorEl);
    dwellRingEl = cursorEl.querySelector(".ht-cursor-ring-fill");

    const badge = document.createElement("div");
    badge.id = "ht-status-badge";
    badge.className = "ht-status-badge";
    badge.innerHTML = `<span class="ht-status-dot"></span><span id="ht-status-text">HAND TRACKING — INITIALISING</span>`;
    document.body.appendChild(badge);

    buildKeyboard();

    hoverAudio = new Audio("/soundeffects/UI-soundeffect.mp3");
    hoverAudio.preload = "auto";

    window.addEventListener("resize", resizeCanvas);
    resizeCanvas();
  }

  function resizeCanvas() {
    if (!overlayCanvas) return;
    overlayCanvas.width = window.innerWidth;
    overlayCanvas.height = window.innerHeight;
  }

  function setStatus(text) {
    const el = $id("ht-status-text");
    if (el) el.textContent = text;
  }

  // ── VIRTUAL KEYBOARD ──
  const KEY_ROWS = [
    ["1","2","3","4","5","6","7","8","9","0","⌫"],
    ["q","w","e","r","t","y","u","i","o","p"],
    ["a","s","d","f","g","h","j","k","l"],
    ["z","x","c","v","b","n","m",",","."],
    ["SPACE","ENTER"],
  ];

  function buildKeyboard() {
    keyboardEl = document.createElement("div");
    keyboardEl.id = "ht-keyboard";
    keyboardEl.className = "ht-keyboard hidden";

    const header = document.createElement("div");
    header.className = "ht-kb-header";
    header.innerHTML = `<span>VIRTUAL KEYBOARD — RAISE HAND TO SUMMON, LOWER TO DISMISS</span>`;
    keyboardEl.appendChild(header);

    KEY_ROWS.forEach(row => {
      const rowEl = document.createElement("div");
      rowEl.className = "ht-kb-row";
      row.forEach(k => {
        const keyEl = document.createElement("button");
        keyEl.className = "ht-key" + (k === "SPACE" ? " ht-key-space" : k === "ENTER" ? " ht-key-enter" : "");
        keyEl.textContent = k === "SPACE" ? "SPACE" : k === "ENTER" ? "ENTER ⏎" : k;
        keyEl.dataset.key = k;
        keyEl.addEventListener("click", () => pressKey(k));
        rowEl.appendChild(keyEl);
      });
      keyboardEl.appendChild(rowEl);
    });

    document.body.appendChild(keyboardEl);
  }

  function pressKey(k) {
    const target = typingTargetInput || document.getElementById("type-input");
    if (!target) return;
    if (k === "⌫") {
      target.value = target.value.slice(0, -1);
    } else if (k === "SPACE") {
      target.value += " ";
    } else if (k === "ENTER") {
      target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const sendBtn = document.getElementById("type-send");
      if (sendBtn) sendBtn.click();
    } else {
      target.value += k;
    }
    target.dispatchEvent(new Event("input", { bubbles: true }));
    flashKey(k);
  }

  function flashKey(k) {
    const el = keyboardEl.querySelector(`.ht-key[data-key="${CSS.escape(k)}"]`);
    if (!el) return;
    el.classList.add("ht-key-flash");
    setTimeout(() => el.classList.remove("ht-key-flash"), 180);
  }

  function showKeyboard() {
    keyboardEl.classList.remove("hidden");
    keyboardEl.classList.add("ht-kb-in");
    typingTargetInput = document.getElementById("type-input");
  }
  function hideKeyboard() {
    keyboardEl.classList.add("hidden");
    keyboardEl.classList.remove("ht-kb-in");
  }

  // ── MEDIAPIPE SETUP ──
  // NOTE: these are pinned to a known-compatible release set. Using
  // unversioned ("latest") CDN URLs lets the hands.js loader and the
  // WASM/.tflite model binaries it fetches drift out of sync with each
  // other — that mismatch is what was causing the repeated
  // "Failed to read file ... palm_detection_full.tflite" abort, which in
  // turn made onFrame() (below) retry the multi-MB model load on every
  // single animation frame, forever, chewing through bandwidth.
  const MEDIAPIPE_HANDS_VERSION = "0.4.1675469240";
  const MEDIAPIPE_CAMERA_UTILS_VERSION = "0.3.1675466862";
  const MEDIAPIPE_DRAWING_UTILS_VERSION = "0.3.1675466124";

  async function loadScripts() {
    if (scriptsLoaded) return;
    const urls = [
      `https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils@${MEDIAPIPE_DRAWING_UTILS_VERSION}/drawing_utils.js`,
      `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_HANDS_VERSION}/hands.js`,
    ];
    for (const src of urls) await loadScriptTag(src);
    scriptsLoaded = true;
  }
  function loadScriptTag(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.crossOrigin = "anonymous";
      s.onload = resolve; s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  let rafId = null;
  let waitForFeedTimer = null;

  async function start() {
    if (active) return;
    buildDom();
    setStatus("HAND TRACKING — LOADING MODEL…");

    const video = document.getElementById("camera-feed");
    if (!video) { setStatus("HAND TRACKING — NO CAMERA FEED"); return; }

    try {
      await loadScripts();
    } catch (e) {
      setStatus("HAND TRACKING — FAILED TO LOAD");
      console.warn("[HandTracking] script load failed", e);
      return;
    }

    hands = new Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@${MEDIAPIPE_HANDS_VERSION}/${file}`,
    });
    hands.setOptions({
      maxNumHands: 2,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.5,
    });
    hands.onResults(onResults);

    // ── Reuse whatever stream is already playing in #camera-feed instead of
    //    requesting our own via MediaPipe's Camera helper. The main HUD's
    //    face-recognition code (requestCameraAccess in jarvis.js) claims this
    //    same <video> element for its own getUserMedia stream at almost the
    //    same moment hand tracking starts (right after login) — a second,
    //    independent getUserMedia() call here would fight it for ownership
    //    of the element and silently break tracking a few frames in. Reading
    //    frames directly off the existing element sidesteps that entirely.
    //    (Build Mode doesn't have this problem because it owns a private,
    //    dedicated camera-feed video with nothing else attached to it.)
    active = true; // set first so waitForFeed()/frameLoop() don't bail immediately
    waitForFeed(video);
  }

  function waitForFeed(video, attempt = 0) {
    if (!active) return;
    const ready = video.srcObject && video.readyState >= 2 && video.videoWidth > 0;
    if (ready) {
      setStatus("HAND TRACKING — ACTIVE");
      startFrameLoop(video);
      return;
    }
    if (attempt === 0) setStatus("HAND TRACKING — WAITING FOR CAMERA…");
    if (attempt > 40) { // ~20s of retrying (40 * 500ms)
      setStatus("HAND TRACKING — NO CAMERA FEED");
      active = false;
      return;
    }
    waitForFeedTimer = setTimeout(() => waitForFeed(video, attempt + 1), 500);
  }

  function startFrameLoop(video) {
    // Circuit breaker: if hands.send() fails repeatedly in a row (e.g. the
    // CDN model assets are unreachable), stop retrying instead of hammering
    // the network on every animation frame indefinitely.
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 8;
    let sending = false;

    async function frameLoop() {
      if (!active) return;
      rafId = requestAnimationFrame(frameLoop);
      if (sending) return; // don't overlap sends if one is still processing
      if (video.readyState < 2 || !video.srcObject) return; // feed dropped — skip this frame, keep looping
      sending = true;
      try {
        await hands.send({ image: video });
        consecutiveFailures = 0;
      } catch (e) {
        consecutiveFailures++;
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.warn("[HandTracking] hands.send() failed repeatedly, stopping to avoid a retry loop.", e);
          stop("HAND TRACKING — UNAVAILABLE");
        }
      } finally {
        sending = false;
      }
    }
    rafId = requestAnimationFrame(frameLoop);
  }

  function stop(reason) {
    active = false;
    clearTimeout(waitForFeedTimer);
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (camera) { try { camera.stop(); } catch (e) {} camera = null; }
    if (overlayCtx) overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (cursorEl) cursorEl.style.opacity = "0";
    endPinchDrag();
    hideKeyboard();
    // Only stamp over the status with a generic "STOPPED" if the caller
    // didn't already leave a more specific reason (e.g. "UNAVAILABLE" from
    // the circuit breaker above) — otherwise that reason gets silently
    // clobbered right after it's set, which is exactly what made hand
    // tracking failures look like a clean, deliberate stop.
    setStatus(reason || "HAND TRACKING — STOPPED");
  }

  // ── RESULTS / CURSOR / DWELL / GESTURE ──
  function onResults(results) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);

    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      cursorEl.style.opacity = "0.15";
      clearDwell();
      endPinchDrag(); // don't leave a widget stuck mid-drag if the hand drops out of frame
      posHistory = []; distHistory = []; // no hands → gesture state can't carry over
      return;
    }

    const landmarks = results.multiHandLandmarks[0];

    // Draw skeleton for every visible hand (mirrored to match the mirrored video feel)
    results.multiHandLandmarks.forEach(drawSkeleton);

    // Index fingertip = landmark 8. Mirror x because video is not flipped visually
    // (camera feed in this app is not CSS-mirrored, so map directly; flip if needed).
    const tip = landmarks[8];
    const rawX = (1 - tip.x) * window.innerWidth;  // mirror horizontally for natural pointing
    const rawY = tip.y * window.innerHeight;

    // Gesture detection runs on the raw (unsmoothed) position so quick
    // motions aren't damped out by the cursor's smoothing filter.
    detectSwipe(rawX, rawY);
    detectZoom(results.multiHandLandmarks);

    // Broadcast raw landmark data so other pages can do custom gesture detection
    // (e.g. monitor-wall.html uses this for raise-both-wrists → overview toggle)
    window.dispatchEvent(new CustomEvent('jarvis:handframe', {
      detail: { allLandmarks: results.multiHandLandmarks }
    }));

    smoothX = smoothX === null ? rawX : smoothX + (rawX - smoothX) * (1 - SMOOTHING);
    smoothY = smoothY === null ? rawY : smoothY + (rawY - smoothY) * (1 - SMOOTHING);

    cursorEl.style.opacity = "1";
    cursorEl.style.left = `${smoothX}px`;
    cursorEl.style.top  = `${smoothY}px`;

    // ── Raised-hand gesture → toggles virtual keyboard ──
    // Raising the hand once OPENS the keyboard. It stays open no matter where
    // your hand goes next (so reaching down to "type" on it doesn't close it).
    // You have to lower your hand below REARM_THRESHOLD and raise it again to
    // toggle it closed — or dwell-click the close button on the keyboard itself.
    const wristY = landmarks[0].y; // 0 = top of frame
    const now = performance.now();

    if (wristY > REARM_THRESHOLD) {
      armed = true;
    }
    if (armed && wristY < RAISE_THRESHOLD && (now - lastToggleAt) > TOGGLE_COOLDOWN_MS) {
      armed = false;
      lastToggleAt = now;
      keyboardOpen = !keyboardOpen;
      if (keyboardOpen) showKeyboard(); else hideKeyboard();
    }

    // ── Pinch-drag ──
    handlePinchDrag(landmarks, smoothX, smoothY);

    // ── Dwell click (suppressed mid-pinch so grabbing a widget doesn't
    //    also fire a dwell-click on whatever's underneath it) ──
    if (!pinching) handleDwell(smoothX, smoothY);
  }

  // ── PINCH-DRAG — grabs whatever [data-hand-drag] widget is under the
  // cursor when you pinch, moves it with your hand, drops it on release.
  // No gesture-to-command mapping: what happens is just whatever the
  // widget under your fingers already does with a pointer. ──
  function handlePinchDrag(landmarks, x, y) {
    const thumb = landmarks[4], index = landmarks[8];
    const pinchDist = Math.hypot(thumb.x - index.x, thumb.y - index.y);
    const wasPinching = pinching;
    pinching = wasPinching ? pinchDist < PINCH_OFF : pinchDist < PINCH_ON;

    if (pinching && !wasPinching) {
      // Pinch just started — is there something grabbable under the cursor?
      cursorEl.style.pointerEvents = "none";
      const el = document.elementFromPoint(x, y);
      cursorEl.style.pointerEvents = "";
      const target = el ? el.closest("[data-hand-drag]") : null;
      if (target) {
        pinchDragTarget = target;
        cursorEl.classList.add("ht-cursor-grabbing");
        dispatchPointer(target, "pointerdown", x, y);
      }
    } else if (pinching && pinchDragTarget) {
      dispatchPointer(pinchDragTarget, "pointermove", x, y);
    } else if (!pinching && wasPinching && pinchDragTarget) {
      dispatchPointer(pinchDragTarget, "pointerup", x, y);
      pinchDragTarget = null;
      cursorEl.classList.remove("ht-cursor-grabbing");
    }
  }

  function dispatchPointer(el, type, x, y) {
    const ev = new PointerEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      pointerId: DRAG_POINTER_ID, pointerType: "touch", isPrimary: true,
      clientX: x, clientY: y, button: 0, buttons: type === "pointerup" ? 0 : 1,
    });
    el.dispatchEvent(ev);
  }

  // Release any in-progress pinch-drag cleanly (e.g. when tracking stops
  // mid-grab) so the widget doesn't get stuck following a hand that's no
  // longer being tracked.
  function endPinchDrag() {
    if (pinchDragTarget) {
      dispatchPointer(pinchDragTarget, "pointerup", smoothX || 0, smoothY || 0);
    }
    pinching = false;
    pinchDragTarget = null;
    if (cursorEl) cursorEl.classList.remove("ht-cursor-grabbing");
  }

  // ── SWIPE — one hand, fast horizontal motion → "jarvis:swipe" ──
  function detectSwipe(rawX, rawY) {
    const now = performance.now();
    posHistory.push({ x: rawX, y: rawY, t: now });
    while (posHistory.length && now - posHistory[0].t > SWIPE_WINDOW_MS) posHistory.shift();
    if (now - lastSwipeAt < SWIPE_COOLDOWN_MS || posHistory.length < 2) return;

    const dx = rawX - posHistory[0].x;
    const dy = Math.abs(rawY - posHistory[0].y);
    if (Math.abs(dx) > SWIPE_MIN_DIST_PX && dy < Math.abs(dx) * 0.6) {
      lastSwipeAt = now;
      posHistory = [];
      fireGesture("swipe", { dir: dx > 0 ? "right" : "left" });
    }
  }

  // ── ZOOM — two hands, wrists spreading apart/together → "jarvis:zoom" ──
  function detectZoom(allLandmarks) {
    if (allLandmarks.length < 2) { distHistory = []; return; }
    const w1 = allLandmarks[0][0], w2 = allLandmarks[1][0]; // wrist landmark of each hand
    const dist = Math.hypot(w1.x - w2.x, w1.y - w2.y); // normalized 0–1 space

    const now = performance.now();
    distHistory.push({ d: dist, t: now });
    while (distHistory.length && now - distHistory[0].t > ZOOM_WINDOW_MS) distHistory.shift();
    if (now - lastZoomAt < ZOOM_COOLDOWN_MS || distHistory.length < 2) return;

    const delta = dist - distHistory[0].d;
    if (delta > ZOOM_MIN_DELTA)       { lastZoomAt = now; distHistory = []; fireGesture("zoom", { dir: "out" }); }
    else if (delta < -ZOOM_MIN_DELTA) { lastZoomAt = now; distHistory = []; fireGesture("zoom", { dir: "in"  }); }
  }

  function fireGesture(type, detail) {
    window.dispatchEvent(new CustomEvent("jarvis:" + type, { detail }));
  }

  function drawSkeleton(landmarks) {
    if (!window.drawConnectors || !window.HAND_CONNECTIONS) return;
    overlayCtx.save();
    overlayCtx.translate(overlayCanvas.width, 0);
    overlayCtx.scale(-1, 1); // mirror to match cursor mapping
    // Need pixel-space landmarks scaled to canvas, drawConnectors expects normalized + canvas ctx with image size context
    const scaled = landmarks.map(p => ({ x: p.x, y: p.y, z: p.z }));
    drawConnectors(overlayCtx, scaled, HAND_CONNECTIONS, {
      color: "rgba(0,200,255,0.55)", lineWidth: 2,
    });
    drawLandmarks(overlayCtx, scaled, {
      color: "rgba(255,170,0,0.9)", lineWidth: 1, radius: 3,
    });
    overlayCtx.restore();
  }

  function handleDwell(x, y) {
    cursorEl.style.pointerEvents = "none";
    const el = document.elementFromPoint(x, y);
    cursorEl.style.pointerEvents = "";
    const clickable = el ? el.closest("button, a, .q-btn, .hud-btn, .account-tile, .ht-key, input[type=checkbox], .mode-btn, .mp-segment, .mp-close-btn") : null;

    if (!clickable) { clearDwell(); return; }

    if (clickable !== dwellTarget) {
      dwellTarget = clickable;
      dwellStart = performance.now();
      clickable.classList.add("ht-hover");
      playHoverSound(); // hand just moved onto a new selectable option
    }

    const elapsed = performance.now() - dwellStart;
    const pct = Math.min(1, elapsed / DWELL_MS);
    setDwellRing(pct);

    if (pct >= 1) {
      clickable.click();
      flashClick();
      clearDwell();
      dwellStart = performance.now() + 400; // small cooldown to avoid double-fire
    }
  }

  function setDwellRing(pct) {
    if (!dwellRingEl) return;
    const circumference = 2 * Math.PI * 17;
    dwellRingEl.style.strokeDasharray = `${circumference}`;
    dwellRingEl.style.strokeDashoffset = `${circumference * (1 - pct)}`;
  }

  function flashClick() {
    cursorEl.classList.add("ht-cursor-click");
    setTimeout(() => cursorEl.classList.remove("ht-cursor-click"), 220);
  }

  function clearDwell() {
    if (dwellTarget) dwellTarget.classList.remove("ht-hover");
    dwellTarget = null;
    setDwellRing(0);
  }

  function $id(id) { return document.getElementById(id); }

  return { start, stop, playHoverSound, get active() { return active; } };
})();

window.HandTracking = HandTracking;
