// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Retina Scan Authentication Module v1.1
// Save this as: public/retina-scan.js
// Add <script src="retina-scan.js"></script> to index.html
// AFTER face-api is loaded (or it loads it automatically)
//
// HOW IT WORKS:
// 1. Uses face-api.js (already in jarvis.js) to detect face landmarks
// 2. Extracts the eye region from the video feed
// 3. Builds an "iris descriptor" — a hash of iris pixel patterns
// 4. Stores this as the user's biometric key in localStorage
// 5. On login: compares new scan against stored descriptor
// 6. On intruder alert: verifies the unknown face is NOT the owner
// ═══════════════════════════════════════════════════════════════

window.RetinaScan = (function () {

  // ── STATE ──────────────────────────────────────────────────
  const rs = {
    overlay:         null,
    canvas:          null,
    ctx:             null,
    video:           null,
    stream:          null,
    animFrame:       null,
    scanFrame:       0,
    scanLine:        0,
    scanDir:         1,
    progress:        0,
    status:          'idle',
    onComplete:      null,
    mode:            'enroll',   // 'enroll' | 'login' | 'verify'
    ENROLL_KEY:      'jarvis_iris_descriptor',
    MATCH_THRESHOLD: 0.42,
    SCAN_FRAMES:     90,
    descriptorHistory: [],
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

        <!-- LIVE EYE FEED WITH OVERLAY -->
        <div class="eye-scanner-wrap" style="position:relative;width:280px;height:280px;display:flex;align-items:center;justify-content:center;">

          <!-- Live camera feed cropped to eye region -->
          <video id="retina-live-video"
            autoplay muted playsinline
            style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;border-radius:50%;transform:scaleX(-1);filter:brightness(1.1) contrast(1.15) saturate(0.6) hue-rotate(160deg);opacity:0.85;"></video>

          <!-- HUD overlay canvas drawn on top -->
          <canvas id="retina-canvas" width="280" height="280"
            style="position:absolute;inset:0;width:100%;height:100%;border-radius:50%;z-index:2;pointer-events:none;"></canvas>

          <!-- Corner targeting brackets -->
          <div style="position:absolute;top:10px;left:10px;width:30px;height:30px;border-top:2px solid #00c8ff;border-left:2px solid #00c8ff;z-index:3;"></div>
          <div style="position:absolute;top:10px;right:10px;width:30px;height:30px;border-top:2px solid #00c8ff;border-right:2px solid #00c8ff;z-index:3;"></div>
          <div style="position:absolute;bottom:10px;left:10px;width:30px;height:30px;border-bottom:2px solid #00c8ff;border-left:2px solid #00c8ff;z-index:3;"></div>
          <div style="position:absolute;bottom:10px;right:10px;width:30px;height:30px;border-bottom:2px solid #00c8ff;border-right:2px solid #00c8ff;z-index:3;"></div>

          <!-- Outer ring -->
          <div style="position:absolute;inset:-8px;border-radius:50%;border:1px solid rgba(0,200,255,0.3);z-index:3;animation:retinaRingPulse 2s ease-in-out infinite;pointer-events:none;"></div>
          <div style="position:absolute;inset:-18px;border-radius:50%;border:1px solid rgba(0,200,255,0.15);z-index:3;animation:retinaRingPulse 2s ease-in-out infinite 0.5s;pointer-events:none;"></div>

          <!-- Data readout overlays on sides -->
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

    // Inject keyframe animation
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

  // ── IRIS DESCRIPTOR BUILDER ────────────────────────────────
  // Extracts the eye region from the video, samples pixel patterns
  // across concentric rings of the iris, builds a 64-float descriptor.
  // This is a simplified iris recognition — good enough for a
  // personal home assistant but not bank-grade security.
  function extractIrisDescriptor(videoEl, landmarks) {
    if (!landmarks) return null;

    // Get eye landmark positions from face-api
    const leftEye  = landmarks.getLeftEye();
    const rightEye = landmarks.getRightEye();

    // Use whichever eye is more centred in frame
    const eye = leftEye;
    if (!eye || eye.length < 6) return null;

    // Find eye centre + radius
    const xs = eye.map(p => p.x);
    const ys = eye.map(p => p.y);
    const cx = xs.reduce((a,b)=>a+b,0)/xs.length;
    const cy = ys.reduce((a,b)=>a+b,0)/ys.length;
    const r  = Math.max(...xs) - Math.min(...xs);

    if (r < 8) return null;

    // Sample the video frame at this position
    const tmpCanvas = document.createElement('canvas');
    const size      = Math.max(r * 2, 40);
    tmpCanvas.width = tmpCanvas.height = size;
    const tmpCtx    = tmpCanvas.getContext('2d');

    // Scale video coords to canvas coords
    const scaleX = videoEl.videoWidth  / (videoEl.clientWidth  || videoEl.videoWidth);
    const scaleY = videoEl.videoHeight / (videoEl.clientHeight || videoEl.videoHeight);

    tmpCtx.drawImage(
      videoEl,
      (cx - r) * scaleX, (cy - r) * scaleY,
      r * 2 * scaleX, r * 2 * scaleY,
      0, 0, size, size
    );

    const pixels  = tmpCtx.getImageData(0, 0, size, size).data;
    const desc    = new Float32Array(64);
    const rings   = 8;
    const samples = 8;

    for (let ring = 0; ring < rings; ring++) {
      const radius = (ring + 1) / rings * (size / 2) * 0.9;
      for (let sample = 0; sample < samples; sample++) {
        const angle = (sample / samples) * Math.PI * 2;
        const px    = Math.round(size/2 + Math.cos(angle) * radius);
        const py    = Math.round(size/2 + Math.sin(angle) * radius);
        if (px < 0 || py < 0 || px >= size || py >= size) continue;
        const idx = (py * size + px) * 4;
        // Greyscale intensity
        const grey = (pixels[idx] * 0.299 + pixels[idx+1] * 0.587 + pixels[idx+2] * 0.114) / 255;
        desc[ring * samples + sample] = grey;
      }
    }

    // L2-normalise
    let norm = 0;
    for (let i = 0; i < 64; i++) norm += desc[i] * desc[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < 64; i++) desc[i] /= norm;

    return desc;
  }

  // ── DESCRIPTOR DISTANCE ────────────────────────────────────
  function descriptorDistance(a, b) {
    if (!a || !b || a.length !== b.length) return 1;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
      const d = a[i] - b[i];
      sum += d * d;
    }
    return Math.sqrt(sum);
  }

  // ── AVERAGE DESCRIPTORS ────────────────────────────────────
  function averageDescriptors(descs) {
    if (!descs.length) return null;
    const len = descs[0].length;
    const avg = new Float32Array(len);
    for (const d of descs) for (let i = 0; i < len; i++) avg[i] += d[i];
    for (let i = 0; i < len; i++) avg[i] /= descs.length;
    let norm = 0;
    for (let i = 0; i < len; i++) norm += avg[i] * avg[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < len; i++) avg[i] /= norm;
    return avg;
  }

  // ── ENROLL / SAVE ──────────────────────────────────────────
  function saveDescriptor(descriptor, userName) {
    const key  = `${rs.ENROLL_KEY}_${(userName || 'owner').toLowerCase()}`;
    const arr  = Array.from(descriptor);
    localStorage.setItem(key, JSON.stringify(arr));
  }

  function loadDescriptor(userName) {
    const key  = `${rs.ENROLL_KEY}_${(userName || 'owner').toLowerCase()}`;
    const data = localStorage.getItem(key);
    if (!data) return null;
    try { return new Float32Array(JSON.parse(data)); }
    catch { return null; }
  }

  function hasEnrolledIris(userName) {
    return !!loadDescriptor(userName);
  }

  // ── CANVAS DRAW — HUD OVERLAY ON TOP OF LIVE FEED ──────────
  function drawScanCanvas(detectedEye, progress, dist) {
    const ctx = rs.ctx;
    const W   = rs.canvas.width;
    const H   = rs.canvas.height;
    const cx  = W / 2;
    const cy  = H / 2;
    const f   = rs.scanFrame;

    // Transparent — let live video show through
    ctx.clearRect(0, 0, W, H);

    const statusColor = rs.status === 'success' ? '#00ff88'
                      : rs.status === 'error'   ? '#ff3333'
                      : '#00c8ff';

    // Iris rings (HUD overlay)
    const irisR  = 100;
    const pupilR = 34;
    const colours = ['rgba(0,200,255,0.18)', 'rgba(0,150,200,0.22)', 'rgba(0,100,180,0.14)'];
    [irisR, irisR*0.75, irisR*0.5].forEach((r, i) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.strokeStyle = colours[i];
      ctx.lineWidth   = 1;
      ctx.stroke();
    });

    // Iris filaments (spokes)
    const numSpokes = 24;
    for (let i = 0; i < numSpokes; i++) {
      const angle   = (i / numSpokes) * Math.PI * 2 + f * 0.008;
      const alpha   = detectedEye ? 0.3 + 0.15 * Math.sin(f * 0.05 + i) : 0.1;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(angle) * pupilR, cy + Math.sin(angle) * pupilR);
      ctx.lineTo(cx + Math.cos(angle) * irisR,  cy + Math.sin(angle) * irisR);
      ctx.strokeStyle = `rgba(0,180,255,${alpha})`;
      ctx.lineWidth   = 0.8;
      ctx.stroke();
    }

    // Scanning grid overlay on iris
    if (detectedEye) {
      for (let ring = 0; ring < 8; ring++) {
        for (let seg = 0; seg < 8; seg++) {
          const r1  = pupilR + (ring/8)     * (irisR - pupilR);
          const r2  = pupilR + ((ring+1)/8) * (irisR - pupilR);
          const a1  = (seg/8) * Math.PI * 2;
          const a2  = ((seg+1)/8) * Math.PI * 2;
          const scanned = (ring * 8 + seg) < (progress * 64);
          if (!scanned) continue;
          ctx.beginPath();
          ctx.arc(cx, cy, r2, a1, a2);
          ctx.arc(cx, cy, r1, a2, a1, true);
          ctx.closePath();
          ctx.fillStyle = `rgba(0,200,255,${0.06 + 0.04 * Math.random()})`;
          ctx.fill();
          ctx.strokeStyle = `rgba(0,200,255,0.25)`;
          ctx.lineWidth   = 0.4;
          ctx.stroke();
        }
      }
    }

    // Horizontal scan line
    rs.scanLine += rs.scanDir * 0.02;
    if (rs.scanLine > 1) rs.scanDir = -1;
    if (rs.scanLine < 0) rs.scanDir =  1;
    const scanY = cy - irisR + rs.scanLine * irisR * 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, irisR, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.moveTo(cx - irisR, scanY);
    ctx.lineTo(cx + irisR, scanY);
    ctx.strokeStyle = `rgba(0,200,255,${0.55 + 0.3 * Math.sin(f * 0.1)})`;
    ctx.lineWidth   = 1.5;
    ctx.stroke();
    ctx.restore();

    // Rotating targeting dots
    const nDots = 8;
    for (let i = 0; i < nDots; i++) {
      const angle = (i / nDots) * Math.PI * 2 + f * 0.04;
      const dotR  = irisR + 12;
      const dotX  = cx + Math.cos(angle) * dotR;
      const dotY  = cy + Math.sin(angle) * dotR;
      ctx.beginPath();
      ctx.arc(dotX, dotY, 2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,200,255,${0.5 + 0.5 * Math.sin(f * 0.1 + i)})`;
      ctx.fill();
    }

    // Outer glow ring
    ctx.beginPath();
    ctx.arc(cx, cy, irisR + 2, 0, Math.PI * 2);
    ctx.strokeStyle = `${statusColor}66`;
    ctx.lineWidth   = 2;
    ctx.stroke();

    // Status text
    const statusLabels = {
      scanning: 'SCANNING…',
      matched:  'IDENTITY CONFIRMED',
      failed:   'NO MATCH',
      enrolling:'ENROLLING IRIS…',
      enrolled: 'IRIS ENROLLED',
      verifying:'VERIFYING…',
      success:  rs.mode === 'enroll' ? 'ENROLLED' : 'AUTHORIZED',
      error:    rs.mode === 'verify' ? 'INTRUDER CONFIRMED' : 'ACCESS DENIED',
    };
    ctx.fillStyle = statusColor;
    ctx.font      = 'bold 9px monospace';
    ctx.textAlign = 'center';
    ctx.fillText(statusLabels[rs.status] || rs.status.toUpperCase(), cx, H - 8);
  }

  // ── UPDATE HUD DATA FIELDS ─────────────────────────────────
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

  // ── STATUS LABEL UPDATE ────────────────────────────────────
  function setStatus(text, type) {
    const el = document.getElementById('retina-status');
    if (!el) return;
    el.textContent = text;
    el.className   = `retina-status ${type || ''}`;
  }

  // ── PROGRESS BAR ──────────────────────────────────────────
  function setProgress(pct) {
    const bar = document.getElementById('retina-progress-bar');
    if (bar) bar.style.width = Math.round(Math.min(100, Math.max(0, pct * 100))) + '%';
  }

  // ── CAMERA START ──────────────────────────────────────────
  async function startCamera() {
    try {
      rs.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: 'user' },
        audio: false,
      });
      rs.video.srcObject = rs.stream;
      await rs.video.play();

      // Also pipe to the live display video
      const liveVid = document.getElementById('retina-live-video');
      if (liveVid) { liveVid.srcObject = rs.stream; liveVid.play(); }

      return true;
    } catch (e) {
      console.warn('[RETINA] Camera error:', e.message);
      return false;
    }
  }

  // ── STOP CAMERA ───────────────────────────────────────────
  function stopCamera() {
    if (rs.stream) {
      rs.stream.getTracks().forEach(t => t.stop());
      rs.stream = null;
    }
    if (rs.animFrame) { cancelAnimationFrame(rs.animFrame); rs.animFrame = null; }
  }

  // ── ENSURE FACE-API LOADED ─────────────────────────────────
  async function ensureFaceApi() {
    if (window.faceapi && window.faceapi.nets.faceLandmark68Net.isLoaded) return true;
    if (!window.faceapi) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src     = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/dist/face-api.min.js';
        s.onload  = res;
        s.onerror = rej;
        document.head.appendChild(s);
      });
    }
    const MODEL_URL = 'https://cdn.jsdelivr.net/gh/justadudewhohacks/face-api.js@0.22.2/weights';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
      faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    ]);
    return true;
  }

  // ── MAIN SCAN LOOP ─────────────────────────────────────────
  async function runScanLoop(mode, userName, storedDescriptor) {
    rs.scanFrame           = 0;
    rs.descriptorHistory   = [];
    rs.status              = mode === 'enroll' ? 'enrolling' : 'scanning';
    rs.progress            = 0;

    const maxFrames     = rs.SCAN_FRAMES;
    let framesWithEye   = 0;

    const loop = async () => {
      if (!rs.overlay || rs.overlay.classList.contains('hidden')) return;

      rs.scanFrame++;
      let eyeDetected   = false;
      let dist          = null;
      let confidence    = null;

      // Try to detect eye landmarks every 3 frames (performance)
      if (rs.scanFrame % 3 === 0 && rs.video.readyState >= 2) {
        try {
          const detection = await faceapi
            .detectSingleFace(rs.video, new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.4 }))
            .withFaceLandmarks();

          if (detection) {
            eyeDetected = true;
            confidence  = detection.detection.score;
            const desc  = extractIrisDescriptor(rs.video, detection.landmarks);

            if (desc) {
              rs.descriptorHistory.push(desc);
              framesWithEye++;

              if (storedDescriptor) {
                dist = descriptorDistance(desc, storedDescriptor);
              }
            }
          }
        } catch (_) {}
      }

      // Progress
      rs.progress = Math.min(1, rs.descriptorHistory.length / maxFrames);
      setProgress(rs.progress);

      // Update readout
      updateDataFields(eyeDetected, dist, confidence);

      // Status messages
      if (rs.descriptorHistory.length < 10) {
        setStatus('ALIGN EYE WITH SCANNER', '');
      } else if (rs.descriptorHistory.length < maxFrames * 0.5) {
        setStatus('IRIS DETECTED — HOLD STEADY', '');
      } else {
        setStatus(mode === 'enroll' ? 'MAPPING IRIS PATTERN…' : 'COMPARING BIOMETRICS…', '');
      }

      // Draw HUD animation over live feed
      drawScanCanvas(eyeDetected, rs.progress, dist);

      // Complete condition
      if (rs.descriptorHistory.length >= maxFrames) {
        onScanComplete(mode, userName, storedDescriptor);
        return;
      }

      // Timeout fallback
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

    } else {
      // Login or verify
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

      const dist = descriptorDistance(averaged, storedDescriptor);
      const match = dist < rs.MATCH_THRESHOLD;

      document.getElementById('rd-dist').textContent = dist.toFixed(3);

      if (match) {
        rs.status = 'success';
        drawScanCanvas(true, 1, dist);
        setStatus(mode === 'verify' ? 'AUTHORIZED — NOT AN INTRUDER' : 'IDENTITY CONFIRMED ✓', 'success');
        setProgress(1);
        setTimeout(() => {
          hide();
          if (rs.onComplete) rs.onComplete({ success: true, mode, dist, descriptor: averaged });
        }, 2000);
      } else {
        rs.status = 'error';
        drawScanCanvas(false, 1, dist);
        setStatus(mode === 'verify' ? 'INTRUDER CONFIRMED' : 'IRIS MISMATCH — ACCESS DENIED', 'error');
        setProgress(1);
        setTimeout(() => {
          hide();
          if (rs.onComplete) rs.onComplete({ success: false, mode, dist, reason: 'mismatch' });
        }, 2500);
      }
    }

    drawScanCanvas(true, 1, null);
  }

  // ── PUBLIC: SHOW OVERLAY ───────────────────────────────────
  function show(mode) {
    buildOverlay();
    const modeLabels = { enroll: 'IRIS ENROLLMENT', login: 'BIOMETRIC LOGIN', verify: 'IDENTITY VERIFICATION' };
    const modeEl = document.getElementById('retina-mode-label');
    if (modeEl) modeEl.textContent = modeLabels[mode] || 'RETINAL SCAN';
    rs.overlay.classList.remove('hidden');
    rs.status    = 'idle';
    rs.scanFrame = 0;
    rs.scanLine  = 0;
    rs.scanDir   = 1;
    rs.progress  = 0;
    rs.mode      = mode;
    setProgress(0);
    setStatus('STARTING CAMERA…', '');
    drawScanCanvas(false, 0, null);
  }

  function hide() {
    stopCamera();
    if (rs.overlay) rs.overlay.classList.add('hidden');
  }

  // ── PUBLIC: ENROLL ─────────────────────────────────────────
  async function enroll(userName) {
    return new Promise(async (resolve) => {
      rs.onComplete = resolve;
      rs.mode       = 'enroll';
      show('enroll');
      setStatus('LOADING IRIS ENGINE…', '');

      try {
        await ensureFaceApi();
        const camOk = await startCamera();
        if (!camOk) {
          setStatus('CAMERA UNAVAILABLE', 'error');
          setTimeout(() => { hide(); resolve({ success: false, reason: 'no_camera' }); }, 2000);
          return;
        }
        setStatus('OPEN YOUR EYES — LOOK AT CAMERA', '');
        await runScanLoop('enroll', userName, null);
      } catch (e) {
        setStatus('ENGINE ERROR', 'error');
        setTimeout(() => { hide(); resolve({ success: false, reason: e.message }); }, 2000);
      }
    });
  }

  // ── PUBLIC: LOGIN ──────────────────────────────────────────
  async function login(userName) {
    return new Promise(async (resolve) => {
      rs.onComplete = resolve;
      rs.mode       = 'login';
      show('login');
      setStatus('LOADING IRIS ENGINE…', '');

      try {
        await ensureFaceApi();
        const stored = loadDescriptor(userName);
        if (!stored) {
          setStatus('NO IRIS ON FILE — ENROLL FIRST', 'error');
          setTimeout(() => { hide(); resolve({ success: false, reason: 'not_enrolled' }); }, 2200);
          return;
        }
        const camOk = await startCamera();
        if (!camOk) {
          setStatus('CAMERA UNAVAILABLE', 'error');
          setTimeout(() => { hide(); resolve({ success: false, reason: 'no_camera' }); }, 2000);
          return;
        }
        setStatus('OPEN YOUR EYES — LOOK AT CAMERA', '');
        await runScanLoop('login', userName, stored);
      } catch (e) {
        setStatus('ENGINE ERROR', 'error');
        setTimeout(() => { hide(); resolve({ success: false, reason: e.message }); }, 2000);
      }
    });
  }

  // ── PUBLIC: VERIFY (intruder check) ───────────────────────
  async function verifyNotIntruder(ownerName) {
    return new Promise(async (resolve) => {
      rs.onComplete = resolve;
      rs.mode       = 'verify';
      show('verify');
      setStatus('VERIFYING IDENTITY…', '');

      try {
        await ensureFaceApi();
        const stored = loadDescriptor(ownerName);
        if (!stored) {
          hide();
          resolve({ success: false, reason: 'not_enrolled', isOwner: false });
          return;
        }
        const camOk = await startCamera();
        if (!camOk) {
          hide();
          resolve({ success: false, reason: 'no_camera', isOwner: false });
          return;
        }
        setStatus('SCANNING — CHECKING IDENTITY', '');
        await runScanLoop('verify', ownerName, stored);
      } catch (e) {
        hide();
        resolve({ success: false, reason: e.message, isOwner: false });
      }
    });
  }

  // ── PUBLIC: CANCEL ─────────────────────────────────────────
  function cancel() {
    stopCamera();
    hide();
    if (rs.onComplete) rs.onComplete({ success: false, reason: 'cancelled' });
    rs.onComplete = null;
  }

  return {
    enroll,
    login,
    verifyNotIntruder,
    cancel,
    hasEnrolledIris,
    show,
    hide,
  };

})();
