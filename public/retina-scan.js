// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Retina Scan Authentication Module v3.0
// Save as: public/retina-scan.js
//
// v3 additions on top of v2:
//   • On login/verify NO-MATCH → fires InternetFaceLookup.search()
//     instead of immediately returning { success: false }
//   • InternetFaceLookup shows the HUD confirmation panel, handles
//     user YES/NO, auto-enrolls, and calls back with the result
//   • All v2 behavior (enroll, local match) is unchanged
// ═══════════════════════════════════════════════════════════════

window.RetinaScan = (function () {

  // ── STATE ──────────────────────────────────────────────────
  const rs = {
    overlay:            null,
    canvas:             null,
    ctx:                null,
    video:              null,
    stream:             null,
    animFrame:          null,
    scanFrame:          0,
    scanLine:           0,
    scanDir:            1,
    progress:           0,
    status:             'idle',
    onComplete:         null,
    mode:               'enroll',
    ENROLL_KEY:         'jarvis_face_descriptor_v2',
    MATCH_THRESHOLD:    0.5,
    SCAN_FRAMES:        12,
    descriptorHistory:  [],
    // v3: keep a reference to the video element at the time of no-match
    // so InternetFaceLookup can grab a frame from it
    _lastVideoEl:       null,
    _lastDescriptor:    null,
  };

  // ── DOM BUILDER ────────────────────────────────────────────
  function buildOverlay() {
    if (document.getElementById('retina-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id        = 'retina-overlay';
    overlay.className = 'retina-overlay hidden';
    overlay.innerHTML = `
      <video id="retina-video" autoplay muted playsinline></video>

      <div class="retina-box">
        <div style="font-family:var(--hud,Orbitron,monospace);font-size:0.52rem;letter-spacing:0.4em;color:rgba(0,200,255,0.5);text-align:center" id="retina-mode-label">RETINAL SCAN</div>

        <div class="eye-scanner-wrap" style="position:relative;width:280px;height:280px;display:flex;align-items:center;justify-content:center;">
          <video id="retina-live-video"
            autoplay muted playsinline
            style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;transform:scaleX(-1);filter:brightness(1.1) contrast(1.15) saturate(0.6) hue-rotate(160deg);opacity:0.85;"></video>

          <canvas id="retina-canvas" width="280" height="280"
            style="position:absolute;inset:0;width:100%;height:100%;border-radius:50%;z-index:2;pointer-events:none;"></canvas>

          <div style="position:absolute;top:10px;left:10px;width:30px;height:30px;border-top:2px solid #00c8ff;border-left:2px solid #00c8ff;z-index:3;"></div>
          <div style="position:absolute;top:10px;right:10px;width:30px;height:30px;border-top:2px solid #00c8ff;border-right:2px solid #00c8ff;z-index:3;"></div>
          <div style="position:absolute;bottom:10px;left:10px;width:30px;height:30px;border-bottom:2px solid #00c8ff;border-left:2px solid #00c8ff;z-index:3;"></div>
          <div style="position:absolute;bottom:10px;right:10px;width:30px;height:30px;border-bottom:2px solid #00c8ff;border-right:2px solid #00c8ff;z-index:3;"></div>

          <div style="position:absolute;inset:-8px;border-radius:50%;border:1px solid rgba(0,200,255,0.3);z-index:3;animation:retinaRingPulse 2s ease-in-out infinite;pointer-events:none;"></div>
          <div style="position:absolute;inset:-18px;border-radius:50%;border:1px solid rgba(0,200,255,0.15);z-index:3;animation:retinaRingPulse 2s ease-in-out infinite 0.5s;pointer-events:none;"></div>

          <div style="position:absolute;left:-110px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;z-index:3;">
            <div style="font-family:monospace;font-size:0.44rem;letter-spacing:0.15em;color:rgba(0,200,255,0.5);">IRIS POINTS<br><span style="color:#00c8ff;font-size:0.6rem;" id="rd-points">—</span></div>
            <div style="font-family:monospace;font-size:0.44rem;letter-spacing:0.15em;color:rgba(0,200,255,0.5);">EYE DETECT<br><span style="color:#00c8ff;font-size:0.6rem;" id="rd-eye">SCANNING</span></div>
          </div>
          <div style="position:absolute;right:-110px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:6px;z-index:3;text-align:right;">
            <div style="font-family:monospace;font-size:0.44rem;letter-spacing:0.15em;color:rgba(0,200,255,0.5);">MATCH DIST<br><span style="color:#00c8ff;font-size:0.6rem;" id="rd-dist">—</span></div>
            <div style="font-family:monospace;font-size:0.44rem;letter-spacing:0.15em;color:rgba(0,200,255,0.5);">CONFIDENCE<br><span style="color:#00c8ff;font-size:0.6rem;" id="rd-conf">—</span></div>
          </div>
        </div>

        <div class="retina-status idle" id="retina-status">INITIALISING IRIS SCANNER</div>

        <div class="retina-progress-wrap">
          <div class="retina-progress-bar" id="retina-progress-bar"></div>
        </div>

        <div class="retina-btns">
          <button class="hud-btn secondary" id="retina-cancel-btn" onclick="RetinaScan.cancel()">CANCEL</button>
        </div>
      </div>`;

    if (!document.getElementById('retina-keyframes')) {
      const style = document.createElement('style');
      style.id = 'retina-keyframes';
      style.textContent = `
        @keyframes retinaRingPulse {
          0%,100% { opacity:0.4; transform:scale(1); }
          50%      { opacity:1;   transform:scale(1.04); }
        }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(overlay);
    rs.overlay  = overlay;
    rs.canvas   = document.getElementById('retina-canvas');
    rs.ctx      = rs.canvas.getContext('2d');
    rs.video    = document.getElementById('retina-video');
  }

  // ── FACE DESCRIPTOR ────────────────────────────────────────
  async function extractFaceDescriptor(videoEl) {
    if (!videoEl || videoEl.readyState < 2) return null;
    try {
      const detection = await faceapi
        .detectSingleFace(videoEl, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
        .withFaceLandmarks()
        .withFaceDescriptor();
      if (!detection || !detection.descriptor) return null;
      return detection.descriptor;
    } catch (_) { return null; }
  }

  function descriptorDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    if (window.faceapi && typeof faceapi.euclideanDistance === 'function') {
      return faceapi.euclideanDistance(a, b);
    }
    let sum = 0;
    for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; sum += d * d; }
    return Math.sqrt(sum);
  }

  function averageDescriptors(descs) {
    if (!descs.length) return null;
    const len = descs[0].length;
    const avg = new Float32Array(len);
    for (const d of descs) for (let i = 0; i < len; i++) avg[i] += d[i];
    for (let i = 0; i < len; i++) avg[i] /= descs.length;
    return avg;
  }

  function saveDescriptor(descriptor, userName) {
    const key = `${rs.ENROLL_KEY}_${(userName || 'owner').toLowerCase()}`;
    localStorage.setItem(key, JSON.stringify(Array.from(descriptor)));
  }

  function loadDescriptor(userName) {
    const key  = `${rs.ENROLL_KEY}_${(userName || 'owner').toLowerCase()}`;
    const data = localStorage.getItem(key);
    if (!data) return null;
    try { return new Float32Array(JSON.parse(data)); } catch { return null; }
  }

  function hasEnrolledIris(userName) { return !!loadDescriptor(userName); }

  // ── CANVAS DRAW ────────────────────────────────────────────
  function drawScanCanvas(detectedEye, progress, dist) {
    const ctx = rs.ctx;
    const W = rs.canvas.width, H = rs.canvas.height;
    const cx = W / 2, cy = H / 2;
    const f  = rs.scanFrame;

    ctx.clearRect(0, 0, W, H);

    const statusColor = rs.status === 'success' ? '#00ff88'
                      : rs.status === 'error'   ? '#ff3333'
                      : '#00c8ff';

    const irisR  = 100;
    const pupilR = 34;
    const colours = ['rgba(0,200,255,0.18)', 'rgba(0,150,200,0.22)', 'rgba(0,100,180,0.14)'];
    [irisR, irisR * 0.75, irisR * 0.5].forEach((r, i) => {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = colours[i]; ctx.lineWidth = 1; ctx.stroke();
    });

    const numSpokes = 24;
    for (let i = 0; i < numSpokes; i++) {
      const angle = (i / numSpokes) * Math.PI * 2 + f * 0.008;
      const alpha = detectedEye ? 0.3 + 0.15 * Math.sin(f * 0.05 + i) : 0.1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * pupilR, cy + Math.sin(angle) * pupilR);
      ctx.lineTo(cx + Math.cos(angle) * irisR,  cy + Math.sin(angle) * irisR);
      ctx.strokeStyle = `rgba(0,180,255,${alpha})`; ctx.lineWidth = 0.8; ctx.stroke();
    }

    if (detectedEye) {
      for (let ring = 0; ring < 8; ring++) {
        for (let seg = 0; seg < 8; seg++) {
          const r1 = pupilR + (ring / 8) * (irisR - pupilR);
          const r2 = pupilR + ((ring + 1) / 8) * (irisR - pupilR);
          const a1 = (seg / 8) * Math.PI * 2;
          const a2 = ((seg + 1) / 8) * Math.PI * 2;
          const scanned = (ring * 8 + seg) < (progress * 64);
          if (!scanned) continue;
          ctx.beginPath();
          ctx.arc(cx, cy, r2, a1, a2);
          ctx.arc(cx, cy, r1, a2, a1, true);
          ctx.closePath();
          ctx.fillStyle = `rgba(0,200,255,${0.06 + 0.04 * Math.random()})`;
          ctx.fill();
          ctx.strokeStyle = 'rgba(0,200,255,0.25)'; ctx.lineWidth = 0.4; ctx.stroke();
        }
      }
    }

    rs.scanLine += rs.scanDir * 0.02;
    if (rs.scanLine > 1) rs.scanDir = -1;
    if (rs.scanLine < 0) rs.scanDir =  1;
    const scanY = cy - irisR + rs.scanLine * irisR * 2;
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, irisR, 0, Math.PI * 2); ctx.clip();
    ctx.beginPath();
    ctx.moveTo(cx - irisR, scanY); ctx.lineTo(cx + irisR, scanY);
    ctx.strokeStyle = `rgba(0,200,255,${0.55 + 0.3 * Math.sin(f * 0.1)})`;
    ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();

    const nDots = 8;
    for (let i = 0; i < nDots; i++) {
      const angle = (i / nDots) * Math.PI * 2 + f * 0.04;
      const dotR  = irisR + 12;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(angle) * dotR, cy + Math.sin(angle) * dotR, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,200,255,${0.5 + 0.5 * Math.sin(f * 0.1 + i)})`; ctx.fill();
    }

    ctx.beginPath(); ctx.arc(cx, cy, irisR + 2, 0, Math.PI * 2);
    ctx.strokeStyle = `${statusColor}66`; ctx.lineWidth = 2; ctx.stroke();

    const statusLabels = {
      scanning:  'SCANNING…',
      matched:   'IDENTITY CONFIRMED',
      failed:    'NO LOCAL MATCH — SEARCHING INTERNET…',
      enrolling: 'ENROLLING IRIS…',
      enrolled:  'IRIS ENROLLED',
      verifying: 'VERIFYING…',
      success:   rs.mode === 'enroll' ? 'ENROLLED' : 'AUTHORIZED',
      error:     rs.mode === 'verify' ? 'INTRUDER CONFIRMED' : 'ACCESS DENIED',
    };
    ctx.fillStyle = statusColor; ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(statusLabels[rs.status] || rs.status.toUpperCase(), cx, H - 8);
  }

  function updateDataFields(eyeDetected, dist, confidence) {
    const pts  = document.getElementById('rd-points');
    const dEl  = document.getElementById('rd-dist');
    const eyeE = document.getElementById('rd-eye');
    const confE= document.getElementById('rd-conf');
    if (pts)   pts.textContent   = eyeDetected ? '64 SAMPLES' : '—';
    if (dEl)   dEl.textContent   = dist !== null ? dist.toFixed(3) : '—';
    if (eyeE)  eyeE.textContent  = eyeDetected ? 'LOCKED' : 'SCANNING';
    if (confE) confE.textContent = confidence ? `${Math.round(confidence * 100)}%` : '—';
  }

  function setStatus(text, type) {
    const el = document.getElementById('retina-status');
    if (!el) return;
    el.textContent = text;
    el.className   = `retina-status ${type || ''}`;
  }

  function setProgress(pct) {
    const bar = document.getElementById('retina-progress-bar');
    if (bar) bar.style.width = Math.round(Math.min(100, Math.max(0, pct * 100))) + '%';
  }

  // ── CAMERA ─────────────────────────────────────────────────
  async function startCamera() {
    try {
      rs.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' }, audio: false,
      });
      rs.video.srcObject = rs.stream;
      await rs.video.play();
      const liveVid = document.getElementById('retina-live-video');
      if (liveVid) { liveVid.srcObject = rs.stream; liveVid.play(); }
      return true;
    } catch (e) {
      console.warn('[RETINA] Camera error:', e.message);
      return false;
    }
  }

  function stopCamera() {
    if (rs.stream) { rs.stream.getTracks().forEach(t => t.stop()); rs.stream = null; }
    if (rs.animFrame) { cancelAnimationFrame(rs.animFrame); rs.animFrame = null; }
  }

  async function ensureFaceApi() {
    if (window.faceapi
        && window.faceapi.nets.faceLandmark68Net.isLoaded
        && window.faceapi.nets.faceRecognitionNet.isLoaded) return true;
    if (!window.faceapi) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src     = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/dist/face-api.min.js';
        s.onload  = res; s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
      faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    return true;
  }

  // ── SCAN LOOP ──────────────────────────────────────────────
  async function runScanLoop(mode, userName, storedDescriptor) {
    rs.scanFrame           = 0;
    rs.descriptorHistory   = [];
    rs.status              = mode === 'enroll' ? 'enrolling' : 'scanning';
    rs.progress            = 0;

    const maxFrames = rs.SCAN_FRAMES;

    const loop = async () => {
      if (!rs.overlay || rs.overlay.classList.contains('hidden')) return;

      rs.scanFrame++;
      let eyeDetected = false, dist = null, confidence = null;

      if (rs.scanFrame % 3 === 0 && rs.video.readyState >= 2) {
        try {
          const detection = await faceapi
            .detectSingleFace(rs.video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
            .withFaceLandmarks()
            .withFaceDescriptor();

          if (detection && detection.descriptor) {
            eyeDetected = true;
            confidence  = detection.detection.score;
            const desc  = detection.descriptor;
            rs.descriptorHistory.push(desc);
            // Keep a running reference so IFL can grab it on no-match
            rs._lastDescriptor = desc;
            if (storedDescriptor) dist = descriptorDistance(desc, storedDescriptor);
          }
        } catch (_) {}
      }

      rs.progress = Math.min(1, rs.descriptorHistory.length / maxFrames);
      setProgress(rs.progress);
      updateDataFields(eyeDetected, dist, confidence);

      if (rs.descriptorHistory.length < 10)             setStatus('ALIGN EYE WITH SCANNER', '');
      else if (rs.descriptorHistory.length < maxFrames * 0.5) setStatus('IRIS DETECTED — HOLD STEADY', '');
      else setStatus(mode === 'enroll' ? 'MAPPING IRIS PATTERN…' : 'COMPARING BIOMETRICS…', '');

      drawScanCanvas(eyeDetected, rs.progress, dist);

      if (rs.descriptorHistory.length >= maxFrames) {
        onScanComplete(mode, userName, storedDescriptor);
        return;
      }

      if (rs.scanFrame > maxFrames * 6 && rs.descriptorHistory.length === 0) {
        rs.status = 'error';
        drawScanCanvas(false, 0, null);
        setStatus('NO EYE DETECTED — CHECK CAMERA', 'error');
        setTimeout(() => { if (rs.onComplete) rs.onComplete({ success: false, reason: 'no_eye' }); }, 2000);
        return;
      }

      rs.animFrame = requestAnimationFrame(loop);
    };

    rs.animFrame = requestAnimationFrame(loop);
  }

  // ── SCAN COMPLETE ──────────────────────────────────────────
  function onScanComplete(mode, userName, storedDescriptor) {
    stopCamera();
    const averaged = averageDescriptors(rs.descriptorHistory);

    if (!averaged) {
      rs.status = 'error';
      setStatus('SCAN FAILED — NO IRIS DATA', 'error');
      drawScanCanvas(false, 0, null);
      setTimeout(() => { if (rs.onComplete) rs.onComplete({ success: false, reason: 'no_data' }); }, 2000);
      return;
    }

    if (mode === 'enroll') {
      saveDescriptor(averaged, userName);
      rs.status = 'success';
      drawScanCanvas(true, 1, null);
      setStatus('IRIS ENROLLED ✓', 'success');
      setProgress(1);
      updateDataFields(true, null, null);
      setTimeout(() => {
        hide();
        if (rs.onComplete) rs.onComplete({ success: true, mode: 'enroll', descriptor: averaged });
      }, 2000);
      return;
    }

    // ── Login / Verify ────────────────────────────────────────
    if (!storedDescriptor) {
      rs.status = 'error';
      setStatus('NO ENROLLED IRIS — USE PASSWORD', 'error');
      drawScanCanvas(false, 1, null);
      setTimeout(() => {
        hide();
        if (rs.onComplete) rs.onComplete({ success: false, reason: 'not_enrolled' });
      }, 2200);
      return;
    }

    const dist  = descriptorDistance(averaged, storedDescriptor);
    const match = dist < rs.MATCH_THRESHOLD;

    const distEl = document.getElementById('rd-dist');
    if (distEl) distEl.textContent = dist.toFixed(3);

    if (match) {
      rs.status = 'success';
      drawScanCanvas(true, 1, dist);
      setStatus(mode === 'verify' ? 'AUTHORIZED — NOT AN INTRUDER' : 'IDENTITY CONFIRMED ✓', 'success');
      setProgress(1);
      setTimeout(() => {
        hide();
        if (rs.onComplete) rs.onComplete({ success: true, mode, dist, descriptor: averaged });
      }, 2000);
      return;
    }

    // ── NO LOCAL MATCH — fire Internet Face Lookup ────────────
    rs.status = 'failed';
    drawScanCanvas(false, 1, dist);
    setStatus('NO LOCAL MATCH — SCANNING INTERNET…', '');

    // Give the user a beat to see the status, then hand off to IFL
    setTimeout(() => {
      // Hide retina overlay — IFL will take over the screen
      hide();
      fireInternetLookup(averaged);
    }, 1200);
  }

  // ── INTERNET FACE LOOKUP HANDOFF ───────────────────────────
  // Called when local biometric match fails. Passes the averaged
  // face descriptor + a snapshot video element to IFL. IFL handles
  // the full HUD confirmation + signup flow and calls rs.onComplete.
  function fireInternetLookup(descriptor) {
    // IFL needs a video element to capture a frame from. Re-open the
    // camera briefly just for the snapshot, or use a hidden video.
    const iflCallback = rs.onComplete;

    if (!window.InternetFaceLookup) {
      console.warn('[RETINA] InternetFaceLookup not loaded — denying access');
      if (iflCallback) iflCallback({ success: false, reason: 'no_ifl_module' });
      return;
    }

    // Create a temporary video + camera stream for IFL to grab a frame
    const tempVid = document.createElement('video');
    tempVid.muted    = true;
    tempVid.autoplay = true;
    tempVid.playsInline = true;
    tempVid.style.cssText = 'position:fixed;opacity:0;pointer-events:none;width:1px;height:1px;top:0;left:0;';
    document.body.appendChild(tempVid);

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then(stream => {
        tempVid.srcObject = stream;
        return tempVid.play().then(() => new Promise(r => setTimeout(r, 600)));
      })
      .then(() => {
        InternetFaceLookup.search(tempVid, descriptor, (result) => {
          // Cleanup temp video
          if (tempVid.srcObject) tempVid.srcObject.getTracks().forEach(t => t.stop());
          document.body.removeChild(tempVid);

          if (result.enrolled && result.profile) {
            // User signed up via IFL — log them in as a new user
            const profile = result.profile;
            if (iflCallback) iflCallback({ success: true, mode: 'internet_signup', profile, descriptor });
          } else {
            if (iflCallback) iflCallback({ success: false, reason: result.reason || 'ifl_denied' });
          }
        });
      })
      .catch(e => {
        console.warn('[RETINA] IFL camera reopen failed:', e.message);
        document.body.removeChild(tempVid);
        // Still run IFL with a null video — it'll fail at capture but
        // at least show the "no match" panel gracefully
        InternetFaceLookup.search(null, descriptor, (result) => {
          if (result.enrolled && result.profile) {
            if (iflCallback) iflCallback({ success: true, mode: 'internet_signup', profile: result.profile, descriptor });
          } else {
            if (iflCallback) iflCallback({ success: false, reason: result.reason || 'ifl_denied' });
          }
        });
      });
  }

  // ── SHOW / HIDE ────────────────────────────────────────────
  function show(mode) {
    buildOverlay();
    const modeLabels = { enroll: 'IRIS ENROLLMENT', login: 'BIOMETRIC LOGIN', verify: 'IDENTITY VERIFICATION' };
    const modeEl = document.getElementById('retina-mode-label');
    if (modeEl) modeEl.textContent = modeLabels[mode] || 'RETINAL SCAN';
    rs.overlay.classList.remove('hidden');
    rs.status = 'idle'; rs.scanFrame = 0; rs.scanLine = 0; rs.scanDir = 1; rs.progress = 0;
    rs.mode = mode;
    setProgress(0);
    setStatus('STARTING CAMERA…', '');
    drawScanCanvas(false, 0, null);
  }

  function hide() {
    stopCamera();
    if (rs.overlay) rs.overlay.classList.add('hidden');
  }

  // ── PUBLIC API ─────────────────────────────────────────────
  async function enroll(userName) {
    return new Promise(async (resolve) => {
      rs.onComplete = resolve; rs.mode = 'enroll';
      show('enroll');
      setStatus('LOADING IRIS ENGINE…', '');
      try {
        await ensureFaceApi();
        const camOk = await startCamera();
        if (!camOk) { setStatus('CAMERA UNAVAILABLE', 'error'); setTimeout(() => { hide(); resolve({ success: false, reason: 'no_camera' }); }, 2000); return; }
        setStatus('OPEN YOUR EYES — LOOK AT CAMERA', '');
        await runScanLoop('enroll', userName, null);
      } catch (e) {
        setStatus('ENGINE ERROR', 'error');
        setTimeout(() => { hide(); resolve({ success: false, reason: e.message }); }, 2000);
      }
    });
  }

  async function login(userName) {
    return new Promise(async (resolve) => {
      rs.onComplete = resolve; rs.mode = 'login';
      show('login');
      setStatus('LOADING IRIS ENGINE…', '');
      try {
        await ensureFaceApi();
        const stored = loadDescriptor(userName);
        if (!stored) {
          setStatus('NO IRIS ON FILE — CHECKING INTERNET…', '');
          // Even with no local iris, still run a scan to capture the face
          // then hand off to IFL. Pass null as storedDescriptor — the scan
          // loop will run, collect descriptors, then onScanComplete will
          // hit the no-match path and fire IFL.
        }
        const camOk = await startCamera();
        if (!camOk) { setStatus('CAMERA UNAVAILABLE', 'error'); setTimeout(() => { hide(); resolve({ success: false, reason: 'no_camera' }); }, 2000); return; }
        setStatus('OPEN YOUR EYES — LOOK AT CAMERA', '');
        await runScanLoop('login', userName, stored);
      } catch (e) {
        setStatus('ENGINE ERROR', 'error');
        setTimeout(() => { hide(); resolve({ success: false, reason: e.message }); }, 2000);
      }
    });
  }

  async function verifyNotIntruder(ownerName) {
    return new Promise(async (resolve) => {
      rs.onComplete = resolve; rs.mode = 'verify';
      show('verify');
      setStatus('VERIFYING IDENTITY…', '');
      try {
        await ensureFaceApi();
        const stored = loadDescriptor(ownerName);
        if (!stored) { hide(); resolve({ success: false, reason: 'not_enrolled', isOwner: false }); return; }
        const camOk = await startCamera();
        if (!camOk) { hide(); resolve({ success: false, reason: 'no_camera', isOwner: false }); return; }
        setStatus('SCANNING — CHECKING IDENTITY', '');
        await runScanLoop('verify', ownerName, stored);
      } catch (e) {
        hide();
        resolve({ success: false, reason: e.message, isOwner: false });
      }
    });
  }

  function cancel() {
    stopCamera();
    hide();
    if (window.InternetFaceLookup) InternetFaceLookup.close();
    if (rs.onComplete) rs.onComplete({ success: false, reason: 'cancelled' });
    rs.onComplete = null;
  }

  return { enroll, login, verifyNotIntruder, cancel, hasEnrolledIris, show, hide };

})();
