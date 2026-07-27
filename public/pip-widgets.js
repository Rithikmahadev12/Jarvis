// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — HUD Overlay + Screen Annotator v3.0
// UPGRADED: No more PiP windows — everything renders as a
// full-screen Iron Man HUD overlay (like the hologram panel).
// "Jarvis pull up HUD" → full HUD with live screen annotation
// "Jarvis solve X"     → solve panel overlaid on screen
// "Jarvis hide HUD"    → closes everything
// ═══════════════════════════════════════════════════════════════

window.PiPWidgets = (function () {

  // ── ACTIVE WIDGET STORE ─────────────────────────────────────
  // Now tracks which widgets are shown inside the overlay, not
  // separate windows.
  const activeWidgets = new Set();
  let   overlayEl     = null;
  let   overlayCanvas = null;
  let   overlayCtx    = null;
  let   animHandle    = null;
  let   _frame        = 0;

  const _sessionStart = Date.now();

  // ── ANNOTATION STATE ────────────────────────────────────────
  const ann = {
    active:      false,
    annotations: [],   // { x, y, w, h, label, type, pulse }
    scanState:   'idle', // idle | scanning | done
    scanLabel:   '',
    query:       '',
    screenShot:  null,  // base64 data url of captured frame
    vidEl:       null,
    scanProgress: 0,
  };

  // ── COLOUR PALETTE (Iron Man) ───────────────────────────────
  const C = {
    bg:        'rgba(1,12,20,0.92)',
    blue:      '#00c8ff',
    blueGlow:  'rgba(0,200,255,0.35)',
    blueDim:   'rgba(0,200,255,0.18)',
    amber:     '#ffaa00',
    green:     '#00ff88',
    red:       '#ff3333',
    purple:    '#aa44ff',
    textDim:   '#3a6a88',
    text:      '#a8dff5',
    textBright:'#d8f4ff',
  };

  // annotation type → colour
  const ANN_COLOR = {
    text:    '#00c8ff',
    number:  '#ffaa00',
    ui:      '#00ff88',
    face:    '#ff3333',
    custom:  '#aa44ff',
    default: '#00c8ff',
  };

  // ─────────────────────────────────────────────────────────────
  // ── OVERLAY ENGINE ───────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────

  function buildOverlay () {
    if (overlayEl) return;

    // Outer shell — same z-index / structure as hologram panel
    overlayEl = document.createElement('div');
    overlayEl.id = '__jarvis_hud_overlay__';
    overlayEl.style.cssText = [
      'position:fixed', 'inset:0', 'z-index:200',
      'background:rgba(1,10,20,0.93)',
      'display:none',
      'flex-direction:column',
      'align-items:stretch',
      'overflow:hidden',
      'font-family:"Share Tech Mono",monospace',
    ].join(';');

    // ── CLOSE BUTTON ──
    const closeBtn = document.createElement('button');
    closeBtn.id = '__hud_close__';
    closeBtn.textContent = '✕  CLOSE HUD';
    closeBtn.style.cssText = [
      'position:absolute', 'top:18px', 'right:22px', 'z-index:10',
      'background:rgba(0,200,255,0.07)',
      'border:1px solid rgba(0,200,255,0.3)',
      'color:#00c8ff',
      'font-family:"Orbitron",monospace',
      'font-size:0.6rem',
      'letter-spacing:0.22em',
      'padding:7px 16px',
      'cursor:pointer',
      'border-radius:2px',
      'transition:all 0.2s',
    ].join(';');
    closeBtn.onmouseenter = () => closeBtn.style.background = 'rgba(0,200,255,0.16)';
    closeBtn.onmouseleave = () => closeBtn.style.background = 'rgba(0,200,255,0.07)';
    closeBtn.onclick = () => {
      closeAll();
    };
    overlayEl.appendChild(closeBtn);

    // ── MAIN CANVAS ──
    overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = '__hud_canvas__';
    overlayCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
    overlayEl.appendChild(overlayCanvas);

    // ── SCREENSHOT LAYER (behind canvas, shows captured screen) ──
    const ssLayer = document.createElement('div');
    ssLayer.id = '__hud_ss_layer__';
    ssLayer.style.cssText = [
      'position:absolute', 'inset:0',
      'background-size:cover',
      'background-position:center',
      'opacity:0',
      'transition:opacity 0.4s',
      'pointer-events:none',
      'z-index:0',
    ].join(';');
    overlayEl.appendChild(ssLayer);

    document.body.appendChild(overlayEl);

    // Resize handler
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
  }

  function resizeCanvas () {
    if (!overlayCanvas) return;
    overlayCanvas.width  = window.innerWidth;
    overlayCanvas.height = window.innerHeight;
    overlayCtx = overlayCanvas.getContext('2d');
  }

  function showOverlay () {
    buildOverlay();
    overlayEl.style.display = 'flex';
    startRenderLoop();
  }

  function hideOverlay () {
    if (!overlayEl) return;
    overlayEl.style.display = 'none';
    stopRenderLoop();
    // Reset annotation state
    ann.active      = false;
    ann.annotations = [];
    ann.scanState   = 'idle';
    ann.screenShot  = null;
    clearScreenShot();
  }

  function startRenderLoop () {
    if (animHandle) return;
    const loop = () => {
      _frame++;
      drawHUD();
      animHandle = requestAnimationFrame(loop);
    };
    animHandle = requestAnimationFrame(loop);
  }

  function stopRenderLoop () {
    if (animHandle) { cancelAnimationFrame(animHandle); animHandle = null; }
  }

  // ─────────────────────────────────────────────────────────────
  // ── MAIN DRAW ────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────

  function drawHUD () {
    if (!overlayCtx) return;
    const W = overlayCanvas.width;
    const H = overlayCanvas.height;
    const ctx = overlayCtx;

    ctx.clearRect(0, 0, W, H);

    // Grid background
    ctx.strokeStyle = 'rgba(0,200,255,0.03)';
    ctx.lineWidth = 0.5;
    for (let x = 0; x < W; x += 40) { ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke(); }
    for (let y = 0; y < H; y += 40) { ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(W,y); ctx.stroke(); }

    // Corner brackets
    drawCornerBrackets(ctx, W, H);

    // Scanline
    const scanY = ((_frame * 2) % (H + 4)) - 2;
    ctx.fillStyle = 'rgba(0,200,255,0.04)';
    ctx.fillRect(0, scanY, W, 2);

    // Top bar
    drawTopBar(ctx, W);

    // Bottom ticker
    drawBottomTicker(ctx, W, H);

    // Annotation overlays (bounding boxes on screen)
    if (ann.active && ann.annotations.length > 0) {
      drawAnnotations(ctx, W, H);
    }

    // Scan progress indicator
    if (ann.scanState === 'scanning') {
      drawScanProgress(ctx, W, H);
    }

    // Widget panels
    let panelX = 20;
    for (const id of activeWidgets) {
      const def = WIDGET_DEFS[id];
      if (def && def.render) {
        drawWidgetPanel(ctx, def, id, panelX, 80);
        panelX += def.w + 16;
      }
    }

    // Solve widget (special — centred, larger)
    if (activeWidgets.has('solve')) {
      drawSolvePanel(ctx, W, H);
    }
  }

  // ── CORNER BRACKETS ─────────────────────────────────────────
  function drawCornerBrackets (ctx, W, H) {
    const s = 40, t = 1.5;
    const pulse = 0.5 + 0.5 * Math.sin(_frame * 0.04);
    ctx.strokeStyle = `rgba(0,200,255,${0.4 + pulse * 0.3})`;
    ctx.lineWidth = t;
    const corners = [
      [18, 18, 1, 1], [W-18, 18, -1, 1],
      [18, H-18, 1, -1], [W-18, H-18, -1, -1],
    ];
    for (const [x, y, sx, sy] of corners) {
      ctx.beginPath(); ctx.moveTo(x + sx*s, y); ctx.lineTo(x, y); ctx.lineTo(x, y + sy*s); ctx.stroke();
      // Pip
      ctx.fillStyle = C.blue;
      ctx.shadowColor = C.blue; ctx.shadowBlur = 8;
      ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI*2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  }

  // ── TOP BAR ─────────────────────────────────────────────────
  function drawTopBar (ctx, W) {
    const now  = new Date();
    const time = now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false });
    const s    = window.state || {};
    const user = (s.user || '—').toUpperCase();
    const mood = (s.mood || 'neutral').toUpperCase();
    const phase= (s.phase || 'idle').toUpperCase();
    const phaseColors = { CHATTING:C.green, SPEAKING:C.amber, LISTENING:C.blue, THINKING:C.amber };

    ctx.font = '700 10px Orbitron,monospace';
    ctx.fillStyle = C.blue;
    ctx.textAlign = 'center';
    ctx.fillText('J.A.R.V.I.S  ·  COGNITIVE ENGINE v7.0', W/2, 36);

    ctx.font = '400 9px "Share Tech Mono",monospace';
    ctx.textAlign = 'left';
    ctx.fillStyle = C.textDim;
    ctx.fillText('USER: ', 70, 56);
    ctx.fillStyle = C.blue;
    ctx.fillText(user, 108, 56);

    ctx.fillStyle = C.textDim;
    ctx.fillText('MOOD: ', 200, 56);
    ctx.fillStyle = C.blue;
    ctx.fillText(mood, 238, 56);

    ctx.fillStyle = C.textDim;
    ctx.fillText('PHASE: ', 340, 56);
    ctx.fillStyle = phaseColors[phase] || C.textDim;
    ctx.fillText(phase, 385, 56);

    ctx.textAlign = 'right';
    ctx.fillStyle = C.blue;
    ctx.fillText(time, W - 70, 56);

    ctx.textAlign = 'left';

    // Divider line
    ctx.strokeStyle = 'rgba(0,200,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(60, 65); ctx.lineTo(W - 60, 65); ctx.stroke();
  }

  // ── BOTTOM TICKER ────────────────────────────────────────────
  const TICKER_ITEMS = [
    'ALL SYSTEMS NOMINAL', '·', 'COGNITIVE ENGINE ACTIVE', '·',
    'SCREEN ANNOTATION ONLINE', '·', 'OCR ENGINE LOADED', '·',
    'SAY "JARVIS ANNOTATE [THING]" TO TARGET', '·',
    'SAY "JARVIS HIDE HUD" TO CLOSE', '·',
    'ZERO PRESET RESPONSES', '·', 'MEMORY BANK PERSISTENT', '·',
  ];
  let tickerOffset = 0;

  function drawBottomTicker (ctx, W, H) {
    const y = H - 24;
    ctx.strokeStyle = 'rgba(0,200,255,0.15)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y - 4); ctx.lineTo(W, y - 4); ctx.stroke();

    ctx.font = '400 9px "Share Tech Mono",monospace';
    ctx.fillStyle = 'rgba(0,200,255,0.35)';
    const tickerText = TICKER_ITEMS.join('   ');
    tickerOffset = (tickerOffset + 0.6) % (W * 1.5);

    ctx.save();
    ctx.beginPath(); ctx.rect(0, y - 14, W, 20); ctx.clip();
    ctx.textAlign = 'left';
    ctx.fillText('▶', 10, y + 2);
    for (let rep = 0; rep < 4; rep++) {
      ctx.fillText(tickerText, 30 + rep * (ctx.measureText(tickerText).width + 60) - tickerOffset, y + 2);
    }
    ctx.restore();
  }

  // ── WIDGET PANEL (info widgets) ──────────────────────────────
  function drawWidgetPanel (ctx, def, id, px, py) {
    if (id === 'solve') return; // solve gets its own centred renderer
    const W = def.w, H = def.h;

    // Panel background
    ctx.fillStyle = 'rgba(1,12,20,0.88)';
    ctx.strokeStyle = 'rgba(0,200,255,0.3)';
    ctx.lineWidth = 1;
    roundRect(ctx, px, py, W, H, 2);
    ctx.fill(); ctx.stroke();

    // Top accent line
    ctx.strokeStyle = C.blue;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(px+2, py); ctx.lineTo(px + W - 2, py); ctx.stroke();

    // Render widget content inside a clipped region
    ctx.save();
    ctx.translate(px, py);
    ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
    def.render(ctx, W, H);
    ctx.restore();
  }

  // ── SOLVE PANEL (centred, large) ─────────────────────────────
  function drawSolvePanel (ctx, W, H) {
    const pw = 540, ph = 420;
    const px = (W - pw) / 2;
    const py = (H - ph) / 2;

    ctx.fillStyle = 'rgba(1,8,18,0.96)';
    ctx.strokeStyle = 'rgba(0,200,255,0.45)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, px, py, pw, ph, 3);
    ctx.fill(); ctx.stroke();

    // Glow border
    ctx.shadowColor = C.blue;
    ctx.shadowBlur  = 20;
    ctx.strokeStyle = 'rgba(0,200,255,0.2)';
    ctx.lineWidth = 3;
    roundRect(ctx, px-2, py-2, pw+4, ph+4, 4);
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.save();
    ctx.translate(px, py);
    ctx.beginPath(); ctx.rect(0, 0, pw, ph); ctx.clip();
    WIDGET_DEFS.solve.render(ctx, pw, ph);
    ctx.restore();
  }

  // ─────────────────────────────────────────────────────────────
  // ── SCREEN ANNOTATION ────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────

  // Capture a frame from the screen stream
  async function captureFrame () {
    const stream = window.state?.screenStream;
    if (!stream) return null;

    const track = stream.getVideoTracks().find(t => t.readyState === 'live');
    if (!track) return null;

    try {
      if (typeof ImageCapture !== 'undefined') {
        const ic     = new ImageCapture(track);
        const bitmap = await ic.grabFrame();
        const c = document.createElement('canvas');
        c.width = bitmap.width; c.height = bitmap.height;
        c.getContext('2d').drawImage(bitmap, 0, 0);
        return { dataUrl: c.toDataURL('image/png'), w: bitmap.width, h: bitmap.height };
      }
    } catch {}

    // Video element fallback
    try {
      const vid = document.createElement('video');
      vid.srcObject = stream; vid.muted = true; vid.playsInline = true;
      await new Promise(r => { vid.onloadeddata = r; vid.onerror = r; vid.play().catch(r); setTimeout(r, 3000); });
      await new Promise(r => setTimeout(r, 300));
      const c = document.createElement('canvas');
      c.width = vid.videoWidth || 1280; c.height = vid.videoHeight || 720;
      c.getContext('2d').drawImage(vid, 0, 0);
      vid.pause(); vid.srcObject = null;
      return { dataUrl: c.toDataURL('image/png'), w: c.width, h: c.height };
    } catch { return null; }
  }

  // Run OCR and get word-level bounding boxes
  async function ocrWithBoxes (dataUrl) {
    try {
      let result;
      if (window.state?.tesseractWorker && window.state?.tesseractReady) {
        result = await window.state.tesseractWorker.recognize(dataUrl);
      } else {
        if (!window.Tesseract) {
          await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
        }
        const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
        result = await worker.recognize(dataUrl);
        await worker.terminate();
      }

      const words = (result.data.words || [])
        .filter(w => w.text.trim().length > 0 && w.confidence > 35)
        .map(w => ({
          text:       w.text.trim(),
          confidence: w.confidence,
          bbox:       w.bbox, // x0, y0, x1, y1 in image coords
        }));

      const lines = (result.data.lines || [])
        .filter(l => l.text.trim().length > 1 && l.confidence > 35)
        .map(l => ({
          text:  l.text.trim(),
          bbox:  l.bbox,
        }));

      return { words, lines, fullText: result.data.text || '' };
    } catch (e) {
      console.warn('[HUD] OCR error:', e);
      return { words: [], lines: [], fullText: '' };
    }
  }

  // Classify each word/group into annotation types
  function classifyAnnotations (ocr, query, imgW, imgH) {
    const q    = (query || '').toLowerCase();
    const scaleX = window.innerWidth  / imgW;
    const scaleY = window.innerHeight / imgH;
    const result = [];

    const isNumberStr  = s => /^[\d\.,\$\%\+\-\/\:]+$/.test(s);
    const isUIKeyword  = s => /^(ok|cancel|submit|login|sign|button|close|open|menu|next|back|yes|no|confirm|save|delete|edit|add|new|search|home|settings|help|about)$/i.test(s);

    // Decide what to show based on query
    const wantAll     = !query || /all|everything|hud/i.test(q);
    const wantText    = wantAll || /text|word|read|label/i.test(q);
    const wantNumbers = wantAll || /number|data|stat|value|figure|amount|price|percent/i.test(q);
    const wantUI      = wantAll || /button|ui|element|control|click|link/i.test(q);

    // Group words into lines and annotate lines (cleaner than per-word)
    for (const line of ocr.lines) {
      const { x0, y0, x1, y1 } = line.bbox;
      const text  = line.text.trim();
      if (!text) continue;

      // Scale from image coords to screen coords
      const sx = x0 * scaleX, sy = y0 * scaleY;
      const sw = (x1 - x0) * scaleX, sh = (y1 - y0) * scaleY;

      // Ignore tiny fragments
      if (sw < 20 || sh < 4) continue;

      let type = 'text';

      // Classify
      if (isNumberStr(text.replace(/\s/g, ''))) type = 'number';
      else if (text.split(' ').every(w => isUIKeyword(w))) type = 'ui';

      // Filter by query intent
      if (type === 'text'   && !wantText)    continue;
      if (type === 'number' && !wantNumbers) continue;
      if (type === 'ui'     && !wantUI)      continue;

      // If query has specific words, only show matching lines
      if (q && !wantAll && !wantText && !wantNumbers && !wantUI) {
        if (!text.toLowerCase().includes(q) && !q.split(' ').some(w => text.toLowerCase().includes(w))) continue;
      }

      result.push({
        x: sx, y: sy, w: sw, h: sh,
        label: text.length > 40 ? text.slice(0, 40) + '…' : text,
        type,
        pulse: Math.random() * Math.PI * 2, // phase offset for animation
      });
    }

    return result;
  }

  // Show screenshot behind the HUD canvas
  function showScreenShot (dataUrl) {
    const layer = document.getElementById('__hud_ss_layer__');
    if (!layer) return;
    layer.style.backgroundImage = `url(${dataUrl})`;
    layer.style.opacity = '0.35'; // ghost — HUD draws on top
  }

  function clearScreenShot () {
    const layer = document.getElementById('__hud_ss_layer__');
    if (layer) { layer.style.backgroundImage = ''; layer.style.opacity = '0'; }
  }

  // Main annotation entry point
  async function runAnnotation (query) {
    ann.query     = query || '';
    ann.scanState = 'scanning';
    ann.scanLabel = 'CAPTURING SCREEN…';
    ann.scanProgress = 0;
    ann.annotations  = [];
    ann.active       = true;

    notify(query ? `Scanning screen for: "${query}"…` : 'Scanning screen…');

    // 1. Capture frame
    ann.scanProgress = 0.2;
    ann.scanLabel    = 'CAPTURING FRAME…';
    const frame = await captureFrame();

    if (!frame) {
      ann.scanState = 'idle';
      ann.active    = false;
      notify('Screen not shared — say "share screen" first, then try again.');
      return;
    }

    ann.screenShot = frame.dataUrl;
    showScreenShot(frame.dataUrl);

    // 2. Run OCR
    ann.scanProgress = 0.45;
    ann.scanLabel    = 'RUNNING OCR…';
    const ocr = await ocrWithBoxes(frame.dataUrl);

    // 3. Classify
    ann.scanProgress = 0.8;
    ann.scanLabel    = 'CLASSIFYING ELEMENTS…';
    const annotations = classifyAnnotations(ocr, query, frame.w, frame.h);

    ann.scanProgress  = 1.0;
    ann.annotations   = annotations;
    ann.scanState     = 'done';

    const count = annotations.length;
    notify(`Annotated ${count} element${count !== 1 ? 's' : ''}${query ? ` matching "${query}"` : ''}.`);

    // Speak the annotation count if JARVIS is available
    if (window.speak && count > 0) {
      const T = window.state?.userTitle || 'Sir';
      const summary = buildAnnotationSummary(annotations, T);
      window.speak(summary);
    }
  }

  function buildAnnotationSummary (annotations, T) {
    const byType = {};
    for (const a of annotations) byType[a.type] = (byType[a.type] || 0) + 1;
    const parts = Object.entries(byType).map(([t, n]) => `${n} ${t} element${n > 1 ? 's' : ''}`);
    return `Annotation complete, ${T}. Found ${parts.join(', ')} on screen.`;
  }

  // ── DRAW SCAN PROGRESS ───────────────────────────────────────
  function drawScanProgress (ctx, W, H) {
    const cx = W / 2, cy = H / 2;
    const pw = 420, ph = 80;
    const px = cx - pw / 2, py = cy - ph / 2;

    ctx.fillStyle = 'rgba(1,8,18,0.95)';
    ctx.strokeStyle = C.amber;
    ctx.lineWidth = 1;
    roundRect(ctx, px, py, pw, ph, 3); ctx.fill(); ctx.stroke();

    ctx.font = '700 10px Orbitron,monospace';
    ctx.fillStyle = C.amber;
    ctx.textAlign = 'center';
    ctx.fillText(ann.scanLabel, cx, cy - 8);

    // Progress bar
    const bx = px + 20, by = cy + 8, bw = pw - 40, bh = 6;
    ctx.fillStyle = 'rgba(255,170,0,0.12)'; ctx.fillRect(bx, by, bw, bh);
    ctx.fillStyle = C.amber;
    ctx.shadowColor = C.amber; ctx.shadowBlur = 8;
    ctx.fillRect(bx, by, bw * ann.scanProgress, bh);
    ctx.shadowBlur = 0;

    // Spinning ring
    ctx.save();
    ctx.translate(px + 26, cy - 6);
    ctx.rotate((_frame % 60) * (Math.PI * 2 / 60));
    ctx.strokeStyle = C.amber; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, 7, 0, Math.PI * 1.5); ctx.stroke();
    ctx.restore();

    ctx.textAlign = 'left';
  }

  // ── DRAW ANNOTATIONS ────────────────────────────────────────
  function drawAnnotations (ctx, W, H) {
    for (let i = 0; i < ann.annotations.length; i++) {
      const a = ann.annotations[i];
      const col = ANN_COLOR[a.type] || ANN_COLOR.default;
      const pulse = 0.6 + 0.4 * Math.sin(_frame * 0.05 + (a.pulse || 0));

      // Bounding box
      ctx.strokeStyle = col;
      ctx.globalAlpha = pulse;
      ctx.lineWidth   = 1.5;
      ctx.strokeRect(a.x, a.y, a.w, a.h);

      // Fill tint
      ctx.fillStyle = col.replace('#', 'rgba(').replace(')', ',0.06)');
      ctx.fillStyle = hexToRgba(col, 0.06);
      ctx.fillRect(a.x, a.y, a.w, a.h);

      // Corner pips (Iron Man style targeting)
      const pip = 6;
      ctx.globalAlpha = pulse;
      ctx.strokeStyle = col;
      ctx.lineWidth   = 1.5;
      // TL
      ctx.beginPath(); ctx.moveTo(a.x, a.y + pip); ctx.lineTo(a.x, a.y); ctx.lineTo(a.x + pip, a.y); ctx.stroke();
      // TR
      ctx.beginPath(); ctx.moveTo(a.x + a.w - pip, a.y); ctx.lineTo(a.x + a.w, a.y); ctx.lineTo(a.x + a.w, a.y + pip); ctx.stroke();
      // BL
      ctx.beginPath(); ctx.moveTo(a.x, a.y + a.h - pip); ctx.lineTo(a.x, a.y + a.h); ctx.lineTo(a.x + pip, a.y + a.h); ctx.stroke();
      // BR
      ctx.beginPath(); ctx.moveTo(a.x + a.w - pip, a.y + a.h); ctx.lineTo(a.x + a.w, a.y + a.h); ctx.lineTo(a.x + a.w, a.y + a.h - pip); ctx.stroke();

      // Label tag
      const label = a.label;
      ctx.font = '400 10px "Share Tech Mono",monospace';
      const tw = ctx.measureText(label).width + 10;
      const th = 16;
      const lx = a.x;
      const ly = a.y - th - 2;

      ctx.globalAlpha = pulse;
      ctx.fillStyle = 'rgba(1,8,20,0.92)';
      ctx.fillRect(lx, ly, tw, th);
      ctx.strokeStyle = col;
      ctx.lineWidth = 0.8;
      ctx.strokeRect(lx, ly, tw, th);

      ctx.fillStyle = col;
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.fillText(label, lx + 5, ly + 11);

      ctx.globalAlpha = 1;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ── WIDGET DEFINITIONS ───────────────────────────────────────
  // (Carried over from old pip-widgets.js, now render to overlay)
  // ─────────────────────────────────────────────────────────────

  // Shared solve state (same as before)
  let _solveState = {
    answer:   'AWAITING QUERY',
    category: 'STANDBY',
    sub:      'Say "Jarvis solve [problem]" or "Jarvis annotate" to scan screen.',
    steps:    [],
    extra:    '',
    processing: false,
  };

  function lbl (ctx, text, x, y) {
    ctx.font = '500 9px Orbitron,monospace';
    ctx.fillStyle = C.textDim; ctx.textAlign = 'left';
    ctx.fillText(text.toUpperCase(), x, y);
  }
  function sm (ctx, text, x, y, color) {
    ctx.font = '400 11px "Share Tech Mono",monospace';
    ctx.fillStyle = color || C.textDim; ctx.textAlign = 'left';
    ctx.fillText(text, x, y);
  }
  function titleBar (ctx, w, label) {
    ctx.font = '700 9px Orbitron,monospace';
    ctx.fillStyle = C.blue; ctx.textAlign = 'left';
    ctx.fillText('J.A.R.V.I.S  ·  ' + label, 10, 18);
  }
  function barGraph (ctx, x, y, w, pct, color) {
    ctx.fillStyle = 'rgba(0,200,255,0.08)'; ctx.fillRect(x, y, w, 4);
    ctx.fillStyle = color || C.blue;
    ctx.fillRect(x, y, w * Math.min(1, Math.max(0, pct)), 4);
  }

  const WIDGET_DEFS = {

    solve: {
      label: 'SOLVE',
      w: 540, h: 420,
      render (ctx, w, h) {
        ctx.clearRect(0, 0, w, h);
        titleBar(ctx, w, 'SOLVE MODULE');
        const st = _solveState;

        if (st.processing) {
          const cx = w/2, cy = h/2;
          ctx.save(); ctx.translate(cx, cy);
          ctx.rotate((_frame % 60) * (Math.PI*2/60));
          ctx.strokeStyle = C.amber; ctx.lineWidth = 2;
          ctx.beginPath(); ctx.arc(0,0,18,0,Math.PI*1.5); ctx.stroke();
          ctx.restore();
          ctx.font = '700 10px Orbitron,monospace';
          ctx.fillStyle = C.amber; ctx.textAlign = 'center';
          ctx.fillText(st.processingLabel || 'COMPUTING', cx, cy+36);
          ctx.textAlign = 'left'; return;
        }

        ctx.font = '700 8px Orbitron,monospace';
        ctx.fillStyle = C.amber; ctx.textAlign = 'left';
        ctx.fillText(st.category.toUpperCase(), 14, 46);

        ctx.strokeStyle = 'rgba(255,170,0,0.2)'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(14,52); ctx.lineTo(w-14,52); ctx.stroke();

        ctx.font = '400 20px "Share Tech Mono",monospace';
        ctx.fillStyle = C.blue;
        ctx.shadowColor = 'rgba(0,200,255,0.5)'; ctx.shadowBlur = 6;
        let y = 76; const maxW = w - 28; let line = '';
        for (const ch of (st.answer || '—')) {
          const test = line + ch;
          if (ctx.measureText(test).width > maxW && line) { ctx.fillText(line, 14, y); y += 24; line = ch; }
          else line = test;
        }
        if (line) { ctx.fillText(line, 14, y); y += 24; }
        ctx.shadowBlur = 0;

        if (st.sub) {
          ctx.font = '400 9.5px "Share Tech Mono",monospace';
          ctx.fillStyle = C.textDim; ctx.fillText(st.sub.slice(0,68), 14, y); y += 18;
        }

        y += 4;
        ctx.strokeStyle = 'rgba(0,200,255,0.15)'; ctx.lineWidth = 0.5;
        ctx.beginPath(); ctx.moveTo(14,y); ctx.lineTo(w-14,y); ctx.stroke(); y += 14;

        if (st.steps?.length) {
          ctx.font = '700 7px Orbitron,monospace'; ctx.fillStyle = C.textDim;
          ctx.fillText('SOLUTION PATH', 14, y); y += 13;
          ctx.font = '400 9.5px "Share Tech Mono",monospace';
          for (let i = 0; i < Math.min(st.steps.length, 5); i++) {
            ctx.fillStyle = C.blue; ctx.fillText(`0${i+1}`, 14, y);
            ctx.fillStyle = C.text; ctx.fillText(st.steps[i].slice(0,58), 34, y); y += 15;
          }
        }

        if (st.extra) {
          y += 4;
          ctx.strokeStyle = 'rgba(0,200,255,0.1)'; ctx.lineWidth = 0.5;
          ctx.beginPath(); ctx.moveTo(14,y); ctx.lineTo(w-14,y); ctx.stroke(); y += 12;
          ctx.font = '400 9px "Share Tech Mono",monospace';
          ctx.fillStyle = 'rgba(0,200,255,0.5)'; ctx.fillText(st.extra.slice(0,68), 14, y);
        }

        ctx.font = '700 7px Orbitron,monospace'; ctx.fillStyle = 'rgba(0,200,255,0.18)';
        ctx.fillText('SAY "JARVIS SOLVE [PROBLEM]" TO UPDATE', 14, h - 10);
      },
    },

    clock: {
      label:'CLOCK', w:280, h:150,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'CLOCK');
        const now = new Date();
        const time = now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
        const date = now.toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
        lbl(ctx,'LOCAL TIME',16,54);
        ctx.font = '400 30px "Share Tech Mono",monospace';
        ctx.fillStyle = C.blue; ctx.shadowColor = C.blueGlow; ctx.shadowBlur = 10;
        ctx.fillText(time,16,90); ctx.shadowBlur = 0;
        lbl(ctx,'DATE',16,110); sm(ctx,date.toUpperCase(),16,126,C.text);
        barGraph(ctx,16,140,w-32,now.getSeconds()/60,C.blue);
      },
    },

    mood: {
      label:'MOOD', w:280, h:150,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'MOOD');
        const s = window.state||{};
        const mood = s.mood||'neutral', score = s.moodScore||0;
        const MC = {excited:'#ffee55',pleased:C.green,curious:C.blue,neutral:'#88ccee',concerned:C.amber,bored:'#6688aa',tired:'#445566'};
        const MI = {excited:'⚡',pleased:'●',curious:'◈',neutral:'●',concerned:'▲',bored:'◌',tired:'◯'};
        const col = MC[mood]||C.blue;
        lbl(ctx,'EMOTIONAL STATE',16,54);
        ctx.font = '400 22px "Share Tech Mono",monospace';
        ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 8;
        ctx.fillText((MI[mood]||'●')+'  '+mood.toUpperCase(),16,86); ctx.shadowBlur = 0;
        lbl(ctx,'SCORE',16,106); sm(ctx,score.toString(),16,122,col);
        barGraph(ctx,16,136,w-32,(score+100)/200,col);
      },
    },

    system: {
      label:'SYSTEM', w:280, h:150,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'SYSTEM');
        const elapsed = Date.now()-_sessionStart;
        const hh=Math.floor(elapsed/3600000), mm=Math.floor((elapsed%3600000)/60000), ss=Math.floor((elapsed%60000)/1000);
        const uptime = `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
        const s = window.state||{};
        const phase = (s.phase||'idle').toUpperCase();
        const PC = {CHATTING:C.green,SPEAKING:C.amber,LISTENING:C.blue,THINKING:C.amber};
        lbl(ctx,'SESSION UPTIME',16,54);
        ctx.font = '400 24px "Share Tech Mono",monospace';
        ctx.fillStyle = C.blue; ctx.fillText(uptime,16,84);
        lbl(ctx,'PHASE',16,106);
        ctx.font = '400 14px "Share Tech Mono",monospace';
        ctx.fillStyle = PC[phase]||C.textDim; ctx.fillText(phase,16,124);
        barGraph(ctx,16,138,w-32,Math.min(1,elapsed/3600000),C.blue);
      },
    },

    memory: {
      label:'MEMORY', w:280, h:150,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'MEMORY');
        const s = window.state||{}, mem = s.memories||[], n = mem.length;
        lbl(ctx,'MEMORY BANK',16,54);
        ctx.font = '400 38px "Share Tech Mono",monospace';
        ctx.fillStyle = C.blue; ctx.shadowColor = C.blueGlow; ctx.shadowBlur = 10;
        ctx.fillText(n.toString(),16,98); ctx.shadowBlur = 0;
        sm(ctx,n===1?'LONG-TERM FACT':'LONG-TERM FACTS',60,90,C.textDim);
        if (mem.length>0) {
          lbl(ctx,'LAST STORED',16,112);
          const last = (typeof mem[mem.length-1]==='string'?mem[mem.length-1]:mem[mem.length-1]?.fact)||'';
          sm(ctx,last.slice(0,36)+(last.length>36?'…':''),16,128,C.text);
        } else { sm(ctx,'NO FACTS STORED YET',16,124,C.textDim); }
      },
    },

    neural: {
      label:'NEURAL', w:280, h:150,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'NEURAL ENGINE');
        const s = window.state||{}, count = s.interactionCount||0;
        lbl(ctx,'INTERACTIONS',16,54);
        ctx.font = '400 38px "Share Tech Mono",monospace';
        ctx.fillStyle = C.blue; ctx.shadowColor = C.blueGlow; ctx.shadowBlur = 10;
        ctx.fillText(count.toString(),16,98); ctx.shadowBlur = 0;
        lbl(ctx,'ACTIVITY',16,114);
        for (let i=0;i<10;i++){
          const active = i<(count%10+1);
          const bh = active?8+Math.random()*18:4;
          ctx.fillStyle = active?C.blue:'rgba(0,200,255,0.12)';
          ctx.fillRect(16+i*22,140-bh,16,bh);
        }
      },
    },

    audio: {
      label:'AUDIO', w:280, h:150,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'AUDIO INPUT');
        const s = window.state||{}, active = s.isListening||false;
        const col = active?C.blue:C.textDim;
        lbl(ctx,'MIC STATUS',16,54);
        ctx.font = '400 16px "Share Tech Mono",monospace';
        ctx.fillStyle = col; ctx.fillText(active?'● ACTIVE':'○ INACTIVE',16,78);
        lbl(ctx,'WAVEFORM',16,100);
        for (let i=0;i<18;i++){
          const bh = active?6+Math.random()*30:4;
          ctx.fillStyle = active?`rgba(0,200,255,${0.4+Math.random()*0.6})`:'rgba(0,200,255,0.1)';
          ctx.fillRect(16+i*13,140-bh,9,bh);
        }
      },
    },

    user: {
      label:'USER', w:280, h:150,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'USER');
        const s = window.state||{};
        lbl(ctx,'AUTHORISED USER',16,54);
        ctx.font = '400 20px "Share Tech Mono",monospace';
        ctx.fillStyle = C.blue; ctx.fillText((s.user||'—').toUpperCase(),16,80);
        lbl(ctx,'TITLE',16,100); sm(ctx,(s.userTitle||'—').toUpperCase(),16,116,C.text);
        lbl(ctx,'MOOD', 150,100); sm(ctx,(s.mood||'neutral').toUpperCase(),150,116,C.text);
      },
    },

    annotate: {
      label:'ANNOTATE', w:300, h:150,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'SCREEN ANNOTATOR');
        const stateColors = { idle:C.textDim, scanning:C.amber, done:C.green };
        const stateLabels = { idle:'READY', scanning:'SCANNING…', done:'ANNOTATED' };
        lbl(ctx,'STATUS',16,54);
        ctx.font = '400 16px "Share Tech Mono",monospace';
        ctx.fillStyle = stateColors[ann.scanState]||C.textDim;
        ctx.fillText(stateLabels[ann.scanState]||'IDLE',16,74);
        if (ann.annotations.length) {
          lbl(ctx,'ELEMENTS FOUND',16,94);
          ctx.font = '400 22px "Share Tech Mono",monospace';
          ctx.fillStyle = C.blue;
          ctx.shadowColor = C.blueGlow; ctx.shadowBlur = 8;
          ctx.fillText(ann.annotations.length.toString(),16,120); ctx.shadowBlur = 0;
        }
        if (ann.query) { lbl(ctx,'QUERY',80,94); sm(ctx,ann.query.slice(0,22),80,110,C.text); }
        sm(ctx,'SAY "ANNOTATE [THING]" TO TARGET',16,140,C.textDim);
      },
    },

    all: {
      label:'ALL SYSTEMS', w:600, h:330,
      render (ctx,w,h) {
        ctx.clearRect(0,0,w,h); titleBar(ctx,w,'ALL SYSTEMS');
        const s = window.state||{};
        const now = new Date();
        const time = now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
        const elapsed = Date.now()-_sessionStart;
        const mm = Math.floor(elapsed/60000), ss2 = Math.floor((elapsed%60000)/1000);
        const uptime = `${mm}m ${ss2}s`;
        const mood = s.mood||'neutral', score = s.moodScore||0, count = s.interactionCount||0;
        const phase = (s.phase||'idle').toUpperCase();
        const memN  = (s.memories||[]).length;
        const user  = (s.user||'—').toUpperCase();
        const MC = {excited:'#ffee55',pleased:C.green,curious:C.blue,neutral:'#88ccee',concerned:C.amber,bored:'#6688aa',tired:'#445566'};
        const PC = {CHATTING:C.green,SPEAKING:C.amber,LISTENING:C.blue,THINKING:C.amber};
        const moodCol = MC[mood]||C.blue, phaseCol = PC[phase]||C.textDim;
        function sec(x,y,label,val,color){
          lbl(ctx,label,x,y);
          ctx.font='400 16px "Share Tech Mono",monospace';
          ctx.fillStyle=color||C.blue; ctx.fillText(val,x,y+20);
        }
        const col1=16, col2=w/2+8;
        const rows=[48,110,172,234,290];
        sec(col1,rows[0],'LOCAL TIME',     time,         C.blue);
        sec(col2,rows[0],'UPTIME',         uptime,       C.blue);
        sec(col1,rows[1],'PHASE',          phase,        phaseCol);
        sec(col2,rows[1],'USER',           user,         C.blue);
        sec(col1,rows[2],'MOOD',           mood.toUpperCase(), moodCol);
        sec(col2,rows[2],'SCORE',          score.toString(), moodCol);
        sec(col1,rows[3],'INTERACTIONS',   count.toString(), C.blue);
        sec(col2,rows[3],'MEMORY BANK',    memN+' STORED', C.blue);
        sec(col1,rows[4],'ANNOTATOR',      ann.annotations.length ? ann.annotations.length+' ELEMENTS' : 'READY', ann.annotations.length?C.green:C.textDim);
        sec(col2,rows[4],'AI ENGINE',      'ONLINE',     C.green);
        ctx.strokeStyle='rgba(0,200,255,0.08)'; ctx.lineWidth=1;
        rows.forEach(y=>{ ctx.beginPath(); ctx.moveTo(16,y+32); ctx.lineTo(w-16,y+32); ctx.stroke(); });
        ctx.beginPath(); ctx.moveTo(w/2,36); ctx.lineTo(w/2,h-16); ctx.stroke();
      },
    },
  };

  // ─────────────────────────────────────────────────────────────
  // ── SOLVE ENGINE (unchanged from original) ───────────────────
  // ─────────────────────────────────────────────────────────────

  function isPrime(n) {
    if (n<2) return false;
    for (let i=2;i<=Math.sqrt(n);i++) if(n%i===0) return false;
    return true;
  }

  function solveMathExpr(expr) {
    try {
      let s = expr.toLowerCase().trim();
      s = s.replace(/(\d+\.?\d*)\s*%\s*of\s*(\d+\.?\d*)/gi,'($1/100*$2)');
      s = s.replace(/(\d+\.?\d*)\s*percent\s+of\s*(\d+\.?\d*)/gi,'($1/100*$2)');
      s = s.replace(/\bsquared\b/gi,'**2').replace(/\bcubed\b/gi,'**3');
      s = s.replace(/\bto the power of\b|\braised to\b/gi,'**');
      s = s.replace(/\bsquare root of\b|\bsqrt of\b|\broot of\b/gi,'Math.sqrt(');
      s = s.replace(/\btimes\b|\bmultiplied by\b/gi,'*');
      s = s.replace(/\bdivided by\b|\bover\b/gi,'/');
      s = s.replace(/\bplus\b|\badded to\b/gi,'+');
      s = s.replace(/\bminus\b|\bsubtracted from\b/gi,'-');
      s = s.replace(/\bmod(?:ulo)?\b/gi,'%');
      s = s.replace(/\^/g,'**').replace(/\bpi\b/gi,'Math.PI');
      const opens = (s.match(/Math\.sqrt\(/g)||[]).length;
      const closes= (s.match(/\)/g)||[]).length;
      for (let i=0;i<opens-closes;i++) s+=')';
      const m = s.match(/[\d\s\+\-\*\/\.\(\)\%\*MathsqrlogPIE]+/);
      if (!m) return null;
      let raw = m[0].trim();
      if (!raw||!/\d/.test(raw)) return null;
      // eslint-disable-next-line no-new-func
      const r = Function('Math',`"use strict"; return (${raw})`)(Math);
      if (typeof r!=='number'||!isFinite(r)) return null;
      return Number.isInteger(r)?r:parseFloat(r.toFixed(8));
    } catch { return null; }
  }

  function solvePatternPuzzle(text) {
    const rowRe = /(\d+)\s*\+\s*(\d+)\s*=\s*(\?|\d+)/gi;
    const rows=[]; let m;
    while ((m=rowRe.exec(text))!==null) rows.push({a:+m[1],b:+m[2],c:m[3]==='?'?null:+m[3]});
    const known=rows.filter(r=>r.c!==null), unknowns=rows.filter(r=>r.c===null);
    if (known.length<2) return null;
    const rules=[
      { name:'Cumulative: result = (a+b) + previous result',
        check(rows){ for(let i=1;i<rows.length;i++) if(rows[i].c!==rows[i].a+rows[i].b+rows[i-1].c)return false; return true; },
        solve(rows,prev){ return rows.a+rows.b+prev; },
        explain(rows){ return rows.map((r,i)=>i===0?`${r.a}+${r.b}=${r.c}`:`${r.a}+${r.b}+${rows[i-1].c}(prev)=${r.c}`); } },
      { name:'result = a×b+a', check(r){ return r.every(r=>r.c===r.a*r.b+r.a); }, solve(r){ return r.a*r.b+r.a; }, explain(r){ return r.map(r=>`${r.a}×${r.b}+${r.a}=${r.c}`); } },
      { name:'result = a×(a+b)', check(r){ return r.every(r=>r.c===r.a*(r.a+r.b)); }, solve(r){ return r.a*(r.a+r.b); }, explain(r){ return r.map(r=>`${r.a}×(${r.a}+${r.b})=${r.c}`); } },
      { name:'result = a²+b', check(r){ return r.every(r=>r.c===r.a*r.a+r.b); }, solve(r){ return r.a*r.a+r.b; }, explain(r){ return r.map(r=>`${r.a}²+${r.b}=${r.c}`); } },
    ];
    for (const rule of rules) {
      if (!rule.check(known)) continue;
      let answer;
      if (rule.name.startsWith('Cumulative')) { const lastKnown=known[known.length-1]; const target=unknowns[0]||rows[rows.length-1]; answer=target.a+target.b+lastKnown.c; }
      else { const target=unknowns[0]||rows[rows.length-1]; answer=rule.solve(target); }
      return { answer:String(answer), category:'PATTERN PUZZLE', sub:`Rule: ${rule.name}`, steps:rule.explain(known).concat(unknowns.length?[`? = ${answer}`]:[]), extra:`All ${known.length} known rows verified ✓` };
    }
    return null;
  }

  function computeSolve(raw) {
    const q = raw.toLowerCase().trim();
    const puzzle = solvePatternPuzzle(raw);
    if (puzzle) return puzzle;

    const qm = q.match(/(-?\d*\.?\d*)\s*x[²2]\s*([+\-]\s*\d*\.?\d*)\s*x\s*([+\-]\s*\d*\.?\d*)\s*=\s*0/);
    if (qm) {
      const a=parseFloat(qm[1]||'1')||1, b=parseFloat(qm[2].replace(/\s/g,'')), c=parseFloat(qm[3].replace(/\s/g,''));
      const disc=b*b-4*a*c;
      if (disc<0) return {answer:'No real solutions',category:'ALGEBRA',sub:`Δ=${disc.toFixed(4)} — complex roots`,steps:[`a=${a}, b=${b}, c=${c}`,`Δ=b²−4ac=${disc}`,'Δ<0 → no real solutions'],extra:''};
      if (disc===0) { const x=parseFloat((-b/(2*a)).toFixed(6)); return {answer:`x = ${x}`,category:'ALGEBRA',sub:'One real solution',steps:[`a=${a},b=${b},c=${c}`,`Δ=0`,`x=−b/2a=${x}`],extra:''}; }
      const x1=parseFloat(((-b+Math.sqrt(disc))/(2*a)).toFixed(6)), x2=parseFloat(((-b-Math.sqrt(disc))/(2*a)).toFixed(6));
      return {answer:`x₁=${x1}  x₂=${x2}`,category:'ALGEBRA',sub:`Δ=${disc.toFixed(4)}`,steps:[`a=${a},b=${b},c=${c}`,`Δ=${disc}`,`x₁=${x1}`,`x₂=${x2}`],extra:''};
    }

    const pm = q.match(/is\s+(\d+)\s+(?:a\s+)?prime/);
    if (pm) { const n=parseInt(pm[1]); const prime=isPrime(n); return {answer:prime?`${n} IS PRIME`:`${n} is NOT prime`,category:'NUMBER THEORY',sub:prime?`${n} is prime`:`${n} is composite`,steps:[`Check divisors to √${n}≈${Math.sqrt(n).toFixed(2)}`,prime?'No divisor found':`${n} is divisible`],extra:''}; }

    const fcM = q.match(/(-?\d+\.?\d*)\s*(?:°\s*)?f(?:ahrenheit)?\s*(?:to|in)\s*(?:°\s*)?c(?:elsius)?/i);
    if (fcM) { const f=parseFloat(fcM[1]),c=(f-32)*5/9; return {answer:`${c.toFixed(4)}°C`,category:'UNIT CONVERSION',sub:`${f}°F → Celsius`,steps:[`C=(F−32)×5/9`,`C=(${f}−32)×5/9`,`C=${c.toFixed(6)}`],extra:`Kelvin: ${(c+273.15).toFixed(4)}K`}; }

    const cfM = q.match(/(-?\d+\.?\d*)\s*(?:°\s*)?c(?:elsius)?\s*(?:to|in)\s*(?:°\s*)?f(?:ahrenheit)?/i);
    if (cfM) { const c=parseFloat(cfM[1]),f=c*9/5+32; return {answer:`${f.toFixed(4)}°F`,category:'UNIT CONVERSION',sub:`${c}°C → Fahrenheit`,steps:[`F=(C×9/5)+32`,`F=${f.toFixed(6)}`],extra:`Kelvin: ${(c+273.15).toFixed(4)}K`}; }

    const percM = q.match(/(\d+\.?\d*)\s*%\s*of\s+(\d+\.?\d*)/)||q.match(/what\s+is\s+(\d+\.?\d*)\s*percent\s+of\s+(\d+\.?\d*)/i);
    if (percM) { const p=parseFloat(percM[1]),v=parseFloat(percM[2]),res=p/100*v; return {answer:String(parseFloat(res.toFixed(6))),category:'PERCENTAGES',sub:`${p}% of ${v}`,steps:[`${p}/100=${(p/100).toFixed(6)}`,`×${v}=${res.toFixed(8)}`],extra:`Remaining ${100-p}%=${((100-p)/100*v).toFixed(4)}`}; }

    const mathRes = solveMathExpr(q);
    if (mathRes!==null) { const clean=q.replace(/(?:what is|calculate|compute|solve|jarvis|please)\s*/gi,'').replace(/[?!.]+$/,'').trim(); return {answer:String(mathRes),category:'ARITHMETIC',sub:`Result of: ${clean}`,steps:[],extra:''}; }
    return null;
  }

  // ─────────────────────────────────────────────────────────────
  // ── SCREENSHOT CAPTURE FOR SOLVE ─────────────────────────────
  // ─────────────────────────────────────────────────────────────

  async function captureScreenToDataUrl () {
    const existingStream = window.state?.screenStream;
    if (existingStream) {
      const tracks = existingStream.getVideoTracks();
      const liveTrack = tracks.find(t => t.readyState === 'live');
      if (liveTrack) {
        try {
          if (typeof ImageCapture !== 'undefined') {
            const capture = new ImageCapture(liveTrack);
            const bitmap  = await capture.grabFrame();
            const canvas  = document.createElement('canvas');
            canvas.width=bitmap.width; canvas.height=bitmap.height;
            canvas.getContext('2d').drawImage(bitmap,0,0);
            return canvas.toDataURL('image/png');
          }
        } catch {}
        try {
          const video=document.createElement('video'); video.srcObject=existingStream; video.muted=true; video.playsInline=true;
          await new Promise(r=>{video.onloadeddata=r;video.onerror=r;video.play().catch(r);setTimeout(r,3000);});
          await new Promise(r=>setTimeout(r,300));
          const canvas=document.createElement('canvas'); canvas.width=video.videoWidth||1280; canvas.height=video.videoHeight||720;
          canvas.getContext('2d').drawImage(video,0,0); video.pause(); video.srcObject=null;
          if (canvas.width>100) return canvas.toDataURL('image/png');
        } catch {}
      }
    }
    try {
      const stream=await navigator.mediaDevices.getDisplayMedia({video:{cursor:'never'},audio:false});
      const track=stream.getVideoTracks()[0]; let dataUrl=null;
      if (typeof ImageCapture!=='undefined') { try { const ic=new ImageCapture(track); const bm=await ic.grabFrame(); const c=document.createElement('canvas'); c.width=bm.width; c.height=bm.height; c.getContext('2d').drawImage(bm,0,0); dataUrl=c.toDataURL('image/png'); } catch {} }
      if (!dataUrl) { const video=document.createElement('video'); video.srcObject=stream; video.muted=true; video.playsInline=true; await new Promise(r=>{video.onloadeddata=r;video.onerror=r;video.play().catch(r);setTimeout(r,3000);}); await new Promise(r=>setTimeout(r,400)); const c=document.createElement('canvas'); c.width=video.videoWidth||1280; c.height=video.videoHeight||720; c.getContext('2d').drawImage(video,0,0); video.pause(); video.srcObject=null; dataUrl=c.toDataURL('image/png'); }
      stream.getTracks().forEach(t=>t.stop());
      return dataUrl;
    } catch { return null; }
  }

  async function grabScreenText () {
    const dataUrl = await captureScreenToDataUrl();
    if (!dataUrl) return '';
    try {
      if (window.state?.tesseractWorker&&window.state?.tesseractReady) { const r=await window.state.tesseractWorker.recognize(dataUrl); return r.data.text||''; }
      if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
      const worker=await Tesseract.createWorker('eng',1,{logger:()=>{}}); const result=await worker.recognize(dataUrl); await worker.terminate(); return result.data.text||'';
    } catch { return ''; }
  }

  // ─────────────────────────────────────────────────────────────
  // ── WIDGET OPEN / CLOSE ──────────────────────────────────────
  // ─────────────────────────────────────────────────────────────

  function openWidget (id) {
    if (!WIDGET_DEFS[id]) { notify('Unknown widget: ' + id); return; }
    activeWidgets.add(id);
    showOverlay();
    notify(`${WIDGET_DEFS[id].label} panel active.`);
  }

  function closeWidget (id) {
    activeWidgets.delete(id);
    if (activeWidgets.size === 0 && !ann.active) hideOverlay();
  }

  function closeAll () {
    activeWidgets.clear();
    ann.active      = false;
    ann.annotations = [];
    ann.scanState   = 'idle';
    hideOverlay();
    notify('HUD closed.');
    if (window.state?.phase === 'chatting' && window.mic) window.mic.resume();
  }

  function openAll () {
    for (const id of Object.keys(WIDGET_DEFS)) { if (id !== 'all' && id !== 'solve') activeWidgets.add(id); }
    showOverlay();
  }

  // ─────────────────────────────────────────────────────────────
  // ── MAIN VOICE COMMAND HANDLER ───────────────────────────────
  // ─────────────────────────────────────────────────────────────

  function detectWidgetId (query) {
    if (/\bsolve\b/.test(query))                  return 'solve';
    if (/clock|time|date/.test(query))             return 'clock';
    if (/mood|emotion|feel/.test(query))           return 'mood';
    if (/system|status|uptime|phase/.test(query))  return 'system';
    if (/memor/.test(query))                       return 'memory';
    if (/neural|interact|activit/.test(query))     return 'neural';
    if (/audio|mic|sound|listen/.test(query))      return 'audio';
    if (/user|authoris|profile/.test(query))       return 'user';
    if (/annotate|annotation|scan|screen|highlight|label|box/.test(query)) return 'annotate';
    if (/all|everything|full|hud/.test(query))     return 'all';
    return null;
  }

  function extractSolveProblem (query) {
    return query.replace(/jarvis[\s,]*/gi,'').replace(/\bsolve\b\s*/gi,'').replace(/\bplease\b/gi,'').replace(/\bfor me\b/gi,'').trim();
  }

  function extractAnnotateQuery (query) {
    return query
      .replace(/jarvis[\s,]*/gi,'')
      .replace(/\b(annotate|highlight|label|box|scan|show me|find|mark|identify|point out)\b\s*/gi,'')
      .replace(/\b(the|a|an|on screen|on my screen|my screen)\b/gi,'')
      .replace(/\bplease\b/gi,'')
      .trim();
  }

  async function handleVoiceCommand (action, meta) {
    const query = (meta?.query || '').toLowerCase();

    // ── HIDE HUD ──────────────────────────────────────────────
    if (action === 'HIDE_HUD') {
      const targetId = detectWidgetId(query);
      if (targetId) { closeWidget(targetId); notify(`${WIDGET_DEFS[targetId]?.label || targetId} closed.`); }
      else           { closeAll(); }
      return;
    }

    // ── ANNOTATE command ──────────────────────────────────────
    if (/annotate|highlight|label|scan.*screen|show.*screen|box|mark|identify/i.test(query) && action === 'SHOW_HUD') {
      const annotateQuery = extractAnnotateQuery(meta?.query || '');
      // Always add the annotate widget + show overlay
      activeWidgets.add('annotate');
      showOverlay();
      await runAnnotation(annotateQuery);
      return;
    }

    // ── SOLVE command ─────────────────────────────────────────
    if (/\bsolve\b/.test(query) && action === 'SHOW_HUD') {
      const problem = extractSolveProblem(meta?.query || '');
      activeWidgets.add('solve');
      showOverlay();

      if (!problem) {
        // No problem spoken — scan screen
        _solveState = { answer:'Taking screenshot…', category:'SCREEN SCAN', sub:'Select your screen when prompted.', steps:[], extra:'', processing:true, processingLabel:'CAPTURING SCREEN' };
        notify('Taking a screenshot — select your screen when prompted.');
        let screenText = '';
        try { screenText = await grabScreenText(); } catch {}
        if (screenText?.trim().length > 3) {
          const result = computeSolve(screenText.trim());
          _solveState = result ? { ...result, processing:false } : { answer:'No equation found on screen', category:'SCREEN SCAN', sub:`Read: "${screenText.trim().slice(0,80)}"`, steps:['Make sure an equation is visible','Or say "Jarvis solve [equation]" directly'], extra:'', processing:false };
        } else {
          _solveState = { answer:'Could not read screen', category:'SCREEN SCAN', sub:'Screenshot failed or no text found', steps:['Say "Jarvis solve [equation]" directly'], extra:'', processing:false };
        }
        return;
      }

      _solveState = { ..._solveState, processing:true, processingLabel:'COMPUTING' };
      await new Promise(r=>setTimeout(r,200));
      const result = computeSolve(problem);
      _solveState = result ? { ...result, processing:false } : { answer:'Could not parse that.', category:'PARSE ERROR', sub:`Query: "${problem}"`, steps:['Try: "15 percent of 200"','Try: "x squared minus 3x plus 2 equals 0"','Try: "is 97 prime"'], extra:'', processing:false };
      notify(result ? 'Solved: ' + result.answer : 'Could not parse "' + problem + '"');
      return;
    }

    // ── SHOW HUD (generic / specific widget) ─────────────────
    const targetId = detectWidgetId(query) || 'all';

    if (targetId === 'all') {
      // "Pull up HUD" with no specific target → open all info widgets + annotate
      for (const id of ['clock','mood','system','memory','neural','user']) activeWidgets.add(id);
      activeWidgets.add('annotate');
      showOverlay();
      notify('Full HUD active. Scanning screen…');
      // Auto-annotate when opening full HUD
      await runAnnotation('');
    } else {
      openWidget(targetId);
    }
  }

  // ─────────────────────────────────────────────────────────────
  // ── UTILITIES ────────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────

  function roundRect (ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w-r,y); ctx.arcTo(x+w,y,x+w,y+r,r);
    ctx.lineTo(x+w,y+h-r); ctx.arcTo(x+w,y+h,x+w-r,y+h,r);
    ctx.lineTo(x+r,y+h); ctx.arcTo(x,y+h,x,y+h-r,r);
    ctx.lineTo(x,y+r); ctx.arcTo(x,y,x+r,y,r);
    ctx.closePath();
  }

  function hexToRgba (hex, alpha) {
    const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function notify (msg) {
    if (window.addMsg) window.addMsg('system', msg);
    else console.log('[HUD]', msg);
  }

  function loadScript (src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script'); s.src=src; s.onload=resolve; s.onerror=reject; document.head.appendChild(s);
    });
  }

  // ─────────────────────────────────────────────────────────────
  // ── PUBLIC API ───────────────────────────────────────────────
  // ─────────────────────────────────────────────────────────────

  return {
    open:             openWidget,
    close:            closeWidget,
    closeAll,
    openAll,
    handleVoiceCommand,
    detectWidgetId,
    computeSolve,
    annotate:         runAnnotation,
    list:             () => [...activeWidgets],
    WIDGET_DEFS,
  };

})();
