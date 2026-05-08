// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Picture-in-Picture HUD Widgets v2.3
// FIX: SOLVE widget now takes a FRESH screenshot via getDisplayMedia
// instead of relying on a stale stored stream reference.
// ═══════════════════════════════════════════════════════════════

window.PiPWidgets = (function () {

  const widgets = new Map();

  const WIDGET_DEFS = {
    solve:  { label:"SOLVE",        w:520, h:400, render:renderSolve  },
    clock:  { label:"CLOCK",        w:300, h:160, render:renderClock  },
    mood:   { label:"MOOD",         w:300, h:160, render:renderMood   },
    system: { label:"SYSTEM",       w:300, h:160, render:renderSystem },
    memory: { label:"MEMORY",       w:300, h:160, render:renderMemory },
    neural: { label:"NEURAL",       w:300, h:160, render:renderNeural },
    audio:  { label:"AUDIO",        w:300, h:160, render:renderAudio  },
    user:   { label:"USER",         w:300, h:160, render:renderUser   },
    all:    { label:"ALL SYSTEMS",  w:620, h:340, render:renderAll    },
  };

  const C = {
    bg:"#010c14", bg2:"#021828", blue:"#00c8ff",
    blueDim:"rgba(0,200,255,0.18)", blueGlow:"rgba(0,200,255,0.35)",
    amber:"#ffaa00", green:"#00ff88", red:"#ff3333",
    textDim:"#3a6a88", text:"#a8dff5", textBright:"#d8f4ff",
  };

  const _sessionStart = Date.now();
  let   _frame        = 0;

  // ── SOLVE STATE ─────────────────────────────────────────────
  let _solveState = {
    answer:   'AWAITING QUERY',
    category: 'STANDBY',
    sub:      'Say "Jarvis solve [problem]" or "Jarvis solve" to scan screen.',
    steps:    [],
    extra:    '',
    processing: false,
  };

  // ═══════════════════════════════════════════════════════════════
  // ── SCREENSHOT ENGINE ─────────────────────────────────────────
  // Takes a FRESH screenshot every time — no stale stream issues.
  // Strategy:
  //   1. Try existing screen stream (fastest, no prompt)
  //   2. If that fails, call getDisplayMedia() for a one-shot capture
  //   3. Run Tesseract OCR on the captured frame
  // ═══════════════════════════════════════════════════════════════

  async function captureScreenToDataUrl() {
    // ── Method A: Use existing stream track via ImageCapture ──
    const existingStream = window.state && window.state.screenStream;
    if (existingStream) {
      const tracks = existingStream.getVideoTracks();
      const liveTrack = tracks.find(t => t.readyState === 'live');
      if (liveTrack) {
        try {
          if (typeof ImageCapture !== 'undefined') {
            const capture = new ImageCapture(liveTrack);
            const bitmap  = await capture.grabFrame();
            const canvas  = document.createElement('canvas');
            canvas.width  = bitmap.width;
            canvas.height = bitmap.height;
            canvas.getContext('2d').drawImage(bitmap, 0, 0);
            return canvas.toDataURL('image/png');
          }
        } catch (e) {
          console.warn('[SOLVE] ImageCapture from existing stream failed:', e.message);
        }

        // Fallback: video element with existing stream
        try {
          const video = document.createElement('video');
          video.srcObject = existingStream;
          video.muted = true;
          video.playsInline = true;
          await new Promise((resolve) => {
            video.onloadeddata = resolve;
            video.onerror = resolve;
            video.play().catch(resolve);
            setTimeout(resolve, 3000);
          });
          await new Promise(r => setTimeout(r, 300));
          const canvas = document.createElement('canvas');
          canvas.width  = video.videoWidth  || 1280;
          canvas.height = video.videoHeight || 720;
          canvas.getContext('2d').drawImage(video, 0, 0);
          video.pause();
          video.srcObject = null;
          const dataUrl = canvas.toDataURL('image/png');
          if (canvas.width > 100) return dataUrl;
        } catch (e) {
          console.warn('[SOLVE] Video fallback from existing stream failed:', e.message);
        }
      }
    }

    // ── Method B: Fresh getDisplayMedia capture ──
    // User will see a "Share your screen" prompt — one-shot, stops immediately after.
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'never', displaySurface: 'monitor' },
        audio: false,
      });

      const track = stream.getVideoTracks()[0];
      let dataUrl = null;

      if (typeof ImageCapture !== 'undefined') {
        try {
          const capture = new ImageCapture(track);
          // grabFrame works immediately on a fresh stream
          const bitmap  = await capture.grabFrame();
          const canvas  = document.createElement('canvas');
          canvas.width  = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext('2d').drawImage(bitmap, 0, 0);
          dataUrl = canvas.toDataURL('image/png');
        } catch (e) {
          console.warn('[SOLVE] ImageCapture on fresh stream failed:', e.message);
        }
      }

      if (!dataUrl) {
        // Video element fallback on fresh stream
        const video = document.createElement('video');
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        await new Promise((resolve) => {
          video.onloadeddata = resolve;
          video.onerror = resolve;
          video.play().catch(resolve);
          setTimeout(resolve, 3000);
        });
        await new Promise(r => setTimeout(r, 400));
        const canvas = document.createElement('canvas');
        canvas.width  = video.videoWidth  || 1280;
        canvas.height = video.videoHeight || 720;
        canvas.getContext('2d').drawImage(video, 0, 0);
        video.pause();
        video.srcObject = null;
        dataUrl = canvas.toDataURL('image/png');
      }

      // Stop the stream immediately — we only needed one frame
      stream.getTracks().forEach(t => t.stop());

      return dataUrl;
    } catch (e) {
      console.warn('[SOLVE] getDisplayMedia failed:', e.message);
      return null;
    }
  }

  async function grabScreenText() {
    const dataUrl = await captureScreenToDataUrl();
    if (!dataUrl) return '';

    // ── Run Tesseract OCR ──
    // Try shared worker first (fastest, already warmed up)
    if (window.state && window.state.tesseractWorker && window.state.tesseractReady) {
      try {
        const result = await window.state.tesseractWorker.recognize(dataUrl);
        return result.data.text || '';
      } catch (e) {
        console.warn('[SOLVE] Tesseract shared worker failed:', e.message);
      }
    }

    // Load Tesseract and spin up a one-shot worker
    try {
      if (!window.Tesseract) {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
          s.onload = resolve;
          s.onerror = reject;
          document.head.appendChild(s);
        });
      }
      const worker = await Tesseract.createWorker('eng', 1, { logger: () => {} });
      const result = await worker.recognize(dataUrl);
      await worker.terminate();
      return result.data.text || '';
    } catch (e) {
      console.warn('[SOLVE] On-demand Tesseract failed:', e.message);
    }

    return '';
  }

  // ── SOLVE ENGINE ────────────────────────────────────────────
  function isPrime(n) {
    if (n < 2) return false;
    for (let i = 2; i <= Math.sqrt(n); i++) if (n % i === 0) return false;
    return true;
  }

  function solveMathExpr(expr) {
    try {
      let s = expr.toLowerCase().trim();
      s = s.replace(/(\d+\.?\d*)\s*%\s*of\s*(\d+\.?\d*)/gi, '($1/100*$2)');
      s = s.replace(/(\d+\.?\d*)\s*percent\s+of\s*(\d+\.?\d*)/gi, '($1/100*$2)');
      s = s.replace(/\bsquared\b/gi, '**2').replace(/\bcubed\b/gi, '**3');
      s = s.replace(/\bto the power of\b|\braised to\b/gi, '**');
      s = s.replace(/\bsquare root of\b|\bsqrt of\b|\broot of\b/gi, 'Math.sqrt(');
      s = s.replace(/\btimes\b|\bmultiplied by\b/gi, '*');
      s = s.replace(/\bdivided by\b|\bover\b/gi, '/');
      s = s.replace(/\bplus\b|\badded to\b/gi, '+');
      s = s.replace(/\bminus\b|\bsubtracted from\b/gi, '-');
      s = s.replace(/\bmod(?:ulo)?\b/gi, '%');
      s = s.replace(/\^/g, '**').replace(/\bpi\b/gi, 'Math.PI');
      const opens = (s.match(/Math\.sqrt\(/g) || []).length;
      const closes = (s.match(/\)/g) || []).length;
      for (let i = 0; i < opens - closes; i++) s += ')';
      const m = s.match(/[\d\s\+\-\*\/\.\(\)\%\*MathsqrlogPIE]+/);
      if (!m) return null;
      let raw = m[0].trim();
      if (!raw || !/\d/.test(raw)) return null;
      // eslint-disable-next-line no-new-func
      const r = Function('Math', `"use strict"; return (${raw})`)(Math);
      if (typeof r !== 'number' || !isFinite(r)) return null;
      return Number.isInteger(r) ? r : parseFloat(r.toFixed(8));
    } catch { return null; }
  }

  // ── PATTERN PUZZLE SOLVER ────────────────────────────────────
  // Detects viral "find the missing number" puzzles like:
  //   1 + 4 = 5
  //   2 + 5 = 12
  //   3 + 6 = 21
  //   8 + 11 = ?
  // Tries multiple rules and picks the one that fits all known rows.
  function solvePatternPuzzle(text) {
    // Extract all rows of the form  A + B = C  or  A + B = ?
    const rowRe = /(\d+)\s*\+\s*(\d+)\s*=\s*(\?|\d+)/gi;
    const rows = [];
    let m;
    while ((m = rowRe.exec(text)) !== null) {
      rows.push({ a: +m[1], b: +m[2], c: m[3] === '?' ? null : +m[3] });
    }

    const known  = rows.filter(r => r.c !== null);
    const unknowns = rows.filter(r => r.c === null);
    if (known.length < 2) return null; // need at least 2 examples to find a pattern

    // ── Try candidate rules ──
    const rules = [
      {
        name: 'Cumulative: result = (a+b) + previous result',
        check(rows) {
          for (let i = 1; i < rows.length; i++) {
            if (rows[i].c !== rows[i].a + rows[i].b + rows[i-1].c) return false;
          }
          return true;
        },
        solve(rows, prev) { return rows.a + rows.b + prev; },
        explain(rows) {
          return rows.map((r,i) => i === 0
            ? `${r.a} + ${r.b} = ${r.c}`
            : `${r.a} + ${r.b} + ${rows[i-1].c} (prev) = ${r.c}`
          );
        },
      },
      {
        name: 'result = a × b + a',
        check(rows) { return rows.every(r => r.c === r.a * r.b + r.a); },
        solve(r)    { return r.a * r.b + r.a; },
        explain(rows) { return rows.map(r => `${r.a} × ${r.b} + ${r.a} = ${r.c}`); },
      },
      {
        name: 'result = a × (a + b)',
        check(rows) { return rows.every(r => r.c === r.a * (r.a + r.b)); },
        solve(r)    { return r.a * (r.a + r.b); },
        explain(rows) { return rows.map(r => `${r.a} × (${r.a}+${r.b}) = ${r.c}`); },
      },
      {
        name: 'result = a² + b',
        check(rows) { return rows.every(r => r.c === r.a * r.a + r.b); },
        solve(r)    { return r.a * r.a + r.b; },
        explain(rows) { return rows.map(r => `${r.a}² + ${r.b} = ${r.c}`); },
      },
      {
        name: 'result = a × b + b',
        check(rows) { return rows.every(r => r.c === r.a * r.b + r.b); },
        solve(r)    { return r.a * r.b + r.b; },
        explain(rows) { return rows.map(r => `${r.a} × ${r.b} + ${r.b} = ${r.c}`); },
      },
      {
        name: 'result = (a + b) × a',
        check(rows) { return rows.every(r => r.c === (r.a + r.b) * r.a); },
        solve(r)    { return (r.a + r.b) * r.a; },
        explain(rows) { return rows.map(r => `(${r.a}+${r.b}) × ${r.a} = ${r.c}`); },
      },
      {
        name: 'result = a × b',
        check(rows) { return rows.every(r => r.c === r.a * r.b); },
        solve(r)    { return r.a * r.b; },
        explain(rows) { return rows.map(r => `${r.a} × ${r.b} = ${r.c}`); },
      },
    ];

    for (const rule of rules) {
      if (!rule.check(known)) continue;

      // Found a matching rule — solve unknowns
      let answer;
      if (rule.name.startsWith('Cumulative')) {
        // needs previous result
        const lastKnown = known[known.length - 1];
        const target    = unknowns[0] || rows[rows.length - 1];
        answer = target.a + target.b + lastKnown.c;
      } else {
        const target = unknowns[0] || rows[rows.length - 1];
        answer = rule.solve(target);
      }

      return {
        answer:   String(answer),
        category: 'PATTERN PUZZLE',
        sub:      `Rule: ${rule.name}`,
        steps:    rule.explain(known).concat(
          unknowns.length ? [`? = ${answer}`] : []
        ),
        extra: `All ${known.length} known rows verified ✓`,
      };
    }

    return null; // no rule matched
  }

  function computeSolve(raw) {
    const q = raw.toLowerCase().trim();

    // ── Pattern puzzle — try this FIRST before anything else ──
    const puzzle = solvePatternPuzzle(raw);
    if (puzzle) return puzzle;

    // ── Quadratic ──
    const qm = q.match(/(-?\d*\.?\d*)\s*x[²2]\s*([+\-]\s*\d*\.?\d*)\s*x\s*([+\-]\s*\d*\.?\d*)\s*=\s*0/);
    if (qm) {
      const a = parseFloat(qm[1] || '1') || 1;
      const b = parseFloat(qm[2].replace(/\s/g, ''));
      const c = parseFloat(qm[3].replace(/\s/g, ''));
      const disc = b * b - 4 * a * c;
      if (disc < 0) return {
        answer: 'No real solutions', category: 'ALGEBRA',
        sub: `Discriminant = ${disc.toFixed(4)} — complex roots`,
        steps: [`a=${a}, b=${b}, c=${c}`, `Δ = b²−4ac = ${b*b}−${4*a*c} = ${disc}`, 'Δ < 0 → no real solutions'],
        extra: `Complex: x = (${-b} ± ${Math.sqrt(-disc).toFixed(4)}i) / ${2*a}`,
      };
      if (disc === 0) {
        const x = parseFloat((-b / (2 * a)).toFixed(6));
        return {
          answer: `x = ${x}`, category: 'ALGEBRA',
          sub: 'One real solution (double root)',
          steps: [`a=${a}, b=${b}, c=${c}`, `Δ = b²−4ac = 0`, `x = −b / 2a = ${-b} / ${2*a} = ${x}`],
          extra: `Factor form: ${a}(x − ${x})²`,
        };
      }
      const x1 = parseFloat(((-b + Math.sqrt(disc)) / (2 * a)).toFixed(6));
      const x2 = parseFloat(((-b - Math.sqrt(disc)) / (2 * a)).toFixed(6));
      return {
        answer: `x₁ = ${x1}   x₂ = ${x2}`, category: 'ALGEBRA',
        sub: `Discriminant = ${disc.toFixed(4)}`,
        steps: [
          `a=${a}, b=${b}, c=${c}`,
          `Δ = b²−4ac = ${b*b} − ${4*a*c} = ${disc}`,
          `√Δ = ${Math.sqrt(disc).toFixed(6)}`,
          `x₁ = (−${b} + √Δ) / ${2*a} = ${x1}`,
          `x₂ = (−${b} − √Δ) / ${2*a} = ${x2}`,
        ],
        extra: `Sum of roots: ${(x1+x2).toFixed(4)}  ·  Product: ${(x1*x2).toFixed(4)}`,
      };
    }

    // ── Prime check ──
    const pm = q.match(/is\s+(\d+)\s+(?:a\s+)?prime/);
    if (pm) {
      const n = parseInt(pm[1]);
      const prime = isPrime(n);
      const factors = [];
      if (!prime) { for (let i = 2; i <= n; i++) if (n % i === 0) { factors.push(i); if (factors.length >= 4) break; } }
      return {
        answer: prime ? `${n} IS PRIME` : `${n} is NOT prime`,
        category: 'NUMBER THEORY',
        sub: prime ? `${n} has no divisors other than 1 and itself` : `Factors include: ${factors.join(', ')}`,
        steps: [
          `Check divisors from 2 to √${n} ≈ ${Math.sqrt(n).toFixed(2)}`,
          prime ? 'No integer divisor found' : `${n} ÷ ${factors[0]} = ${n / factors[0]} (integer)`,
          prime ? `∴ ${n} is prime` : `∴ ${n} is composite`,
        ],
        extra: '',
      };
    }

    // ── Fibonacci ──
    const fibM = q.match(/fibonacci.{0,20}(\d+)/) || q.match(/first\s+(\d+)\s+fibonacci/);
    if (fibM) {
      const n = Math.min(parseInt(fibM[1]), 20);
      const seq = [0, 1];
      for (let i = 2; i < n; i++) seq.push(seq[i-1] + seq[i-2]);
      const out = seq.slice(0, n);
      return {
        answer: out.join(', '),
        category: 'SEQUENCES',
        sub: `First ${n} Fibonacci numbers`,
        steps: ['F(0)=0, F(1)=1', 'F(n) = F(n−1) + F(n−2)', `F(${n-1}) = ${out[out.length-1]}`],
        extra: `Last term: ${out[out.length-1]}`,
      };
    }

    // ── Circle area ──
    const circM = q.match(/area of (?:a )?circle.{0,10}radius\s*(\d+\.?\d*)/i)
                || q.match(/circle.{0,10}radius\s*(\d+\.?\d*).{0,10}area/i);
    if (circM) {
      const r = parseFloat(circM[1]);
      const area = Math.PI * r * r;
      return {
        answer: `${area.toFixed(4)} sq units`,
        category: 'GEOMETRY',
        sub: `A = π × r² where r = ${r}`,
        steps: [`r = ${r}`, `A = π × ${r}² = π × ${r*r}`, `A = ${area.toFixed(8)}`],
        extra: `Circumference = 2πr = ${(2*Math.PI*r).toFixed(4)}`,
      };
    }

    // ── Speed = distance / time ──
    const speedM = q.match(/speed.{0,20}distance\s*=?\s*(\d+\.?\d*).{0,15}time\s*=?\s*(\d+\.?\d*)/i)
                 || q.match(/distance\s+(\d+\.?\d*).{0,10}time\s+(\d+\.?\d*).{0,10}speed/i);
    if (speedM) {
      const d = parseFloat(speedM[1]), t = parseFloat(speedM[2]);
      const sp = d / t;
      return {
        answer: `${sp.toFixed(4)} km/h`,
        category: 'PHYSICS',
        sub: `v = d / t = ${d} / ${t}`,
        steps: [`d = ${d} km`, `t = ${t} h`, `v = ${d} / ${t} = ${sp.toFixed(6)} km/h`],
        extra: `In m/s: ${(sp / 3.6).toFixed(4)} m/s`,
      };
    }

    // ── °F → °C ──
    const fcM = q.match(/(-?\d+\.?\d*)\s*(?:°\s*)?f(?:ahrenheit)?\s*(?:to|in)\s*(?:°\s*)?c(?:elsius)?/i);
    if (fcM) {
      const f = parseFloat(fcM[1]);
      const c = (f - 32) * 5 / 9;
      return {
        answer: `${c.toFixed(4)}°C`,
        category: 'UNIT CONVERSION',
        sub: `${f}°F → Celsius`,
        steps: [`C = (F − 32) × 5/9`, `C = (${f} − 32) × 5/9`, `C = ${(f-32).toFixed(4)} × 0.5556`, `C = ${c.toFixed(6)}`],
        extra: `Kelvin: ${(c + 273.15).toFixed(4)} K`,
      };
    }

    // ── °C → °F ──
    const cfM = q.match(/(-?\d+\.?\d*)\s*(?:°\s*)?c(?:elsius)?\s*(?:to|in)\s*(?:°\s*)?f(?:ahrenheit)?/i);
    if (cfM) {
      const c = parseFloat(cfM[1]);
      const f = c * 9 / 5 + 32;
      return {
        answer: `${f.toFixed(4)}°F`,
        category: 'UNIT CONVERSION',
        sub: `${c}°C → Fahrenheit`,
        steps: [`F = (C × 9/5) + 32`, `F = (${c} × 1.8) + 32`, `F = ${(c*1.8).toFixed(4)} + 32`, `F = ${f.toFixed(6)}`],
        extra: `Kelvin: ${(c + 273.15).toFixed(4)} K`,
      };
    }

    // ── km → miles ──
    const kmM = q.match(/(\d+\.?\d*)\s*km\s*(?:to|in)\s*miles/i);
    if (kmM) {
      const km = parseFloat(kmM[1]);
      const mi = km * 0.621371;
      return {
        answer: `${mi.toFixed(4)} miles`,
        category: 'UNIT CONVERSION',
        sub: `${km} km → miles`,
        steps: [`1 km = 0.621371 miles`, `${km} × 0.621371 = ${mi.toFixed(6)}`],
        extra: '',
      };
    }

    // ── Percentage ──
    const percM = q.match(/(\d+\.?\d*)\s*%\s*of\s+(\d+\.?\d*)/)
                || q.match(/what\s+is\s+(\d+\.?\d*)\s*percent\s+of\s+(\d+\.?\d*)/i);
    if (percM) {
      const p = parseFloat(percM[1]), v = parseFloat(percM[2]);
      const res = p / 100 * v;
      return {
        answer: String(parseFloat(res.toFixed(6))),
        category: 'PERCENTAGES',
        sub: `${p}% of ${v}`,
        steps: [`${p} / 100 = ${(p/100).toFixed(6)}`, `${(p/100).toFixed(6)} × ${v} = ${res.toFixed(8)}`],
        extra: `Remaining ${100-p}% = ${((100-p)/100*v).toFixed(4)}`,
      };
    }

    // ── Pythagorean theorem ──
    const pytM = q.match(/(?:hypotenuse|pythagoras).{0,20}a\s*=?\s*(\d+\.?\d*).{0,10}b\s*=?\s*(\d+\.?\d*)/i)
               || q.match(/a\s*=\s*(\d+\.?\d*).*b\s*=\s*(\d+\.?\d*).*(?:hypotenuse|pythagoras)/i);
    if (pytM) {
      const a = parseFloat(pytM[1]), b = parseFloat(pytM[2]);
      const c = Math.sqrt(a*a + b*b);
      return {
        answer: `c = ${c.toFixed(6)}`,
        category: 'GEOMETRY',
        sub: `c = √(a² + b²) where a=${a}, b=${b}`,
        steps: [`a² = ${a*a}`, `b² = ${b*b}`, `a² + b² = ${a*a + b*b}`, `c = √${a*a + b*b} = ${c.toFixed(8)}`],
        extra: '',
      };
    }

    // ── General math expression ──
    const mathRes = solveMathExpr(q);
    if (mathRes !== null) {
      const clean = q
        .replace(/(?:what is|calculate|compute|solve|jarvis|please)\s*/gi, '')
        .replace(/[?!.]+$/, '').trim();
      return {
        answer: String(mathRes),
        category: 'ARITHMETIC',
        sub: `Result of: ${clean}`,
        steps: [],
        extra: '',
      };
    }

    return null;
  }

  // ── DRAW HELPERS ────────────────────────────────────────────
  function hud(ctx, w, h) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = 'rgba(0,200,255,0.04)';
    ctx.lineWidth   = 0.5;
    for (let x=0;x<w;x+=30){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
    for (let y=0;y<h;y+=30){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}

    ctx.strokeStyle = 'rgba(0,200,255,0.25)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(1,1,w-2,h-2);

    const s=16;
    ctx.strokeStyle=C.blue; ctx.lineWidth=1.5;
    [[2,2],[w-2-s,2],[2,h-2-s],[w-2-s,h-2-s]].forEach(([cx,cy],i)=>{
      ctx.beginPath();
      if(i===0){ctx.moveTo(cx+s,cy);ctx.lineTo(cx,cy);ctx.lineTo(cx,cy+s);}
      if(i===1){ctx.moveTo(cx,cy);ctx.lineTo(cx+s,cy);ctx.lineTo(cx+s,cy+s);}
      if(i===2){ctx.moveTo(cx+s,cy+s);ctx.lineTo(cx,cy+s);ctx.lineTo(cx,cy);}
      if(i===3){ctx.moveTo(cx,cy+s);ctx.lineTo(cx+s,cy+s);ctx.lineTo(cx+s,cy);}
      ctx.stroke();
    });

    ctx.strokeStyle='rgba(0,200,255,0.12)'; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(0,28);ctx.lineTo(w,28);ctx.stroke();
  }

  function lbl(ctx,text,x,y){
    ctx.font='500 9px Orbitron,monospace';
    ctx.fillStyle=C.textDim; ctx.fillText(text.toUpperCase(),x,y);
  }
  function big(ctx,text,x,y,color){
    ctx.font='400 28px "Share Tech Mono",monospace';
    ctx.fillStyle=color||C.blue; ctx.fillText(text,x,y);
  }
  function sm(ctx,text,x,y,color){
    ctx.font='400 11px "Share Tech Mono",monospace';
    ctx.fillStyle=color||C.textDim; ctx.fillText(text,x,y);
  }
  function bar(ctx,x,y,w,pct,color){
    ctx.fillStyle='rgba(0,200,255,0.08)'; ctx.fillRect(x,y,w,4);
    ctx.fillStyle=color||C.blue; ctx.fillRect(x,y,w*Math.min(1,Math.max(0,pct)),4);
  }
  function titleBar(ctx,w,wlabel){
    ctx.font='700 9px Orbitron,monospace';
    ctx.fillStyle=C.blue;
    ctx.fillText('J.A.R.V.I.S  ·  '+wlabel,10,18);
    ctx.beginPath();ctx.arc(w-12,14,3,0,Math.PI*2);
    ctx.fillStyle=C.blue;ctx.fill();
  }

  // ── SOLVE RENDERER ───────────────────────────────────────────
  function renderSolve(ctx, w, h) {
    _frame++;
    hud(ctx, w, h);
    titleBar(ctx, w, 'SOLVE MODULE');

    const st = _solveState;

    if (st.processing) {
      const cx = w / 2, cy = h / 2;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate((_frame % 60) * (Math.PI * 2 / 60));
      ctx.strokeStyle = C.amber;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(0, 0, 18, 0, Math.PI * 1.5);
      ctx.stroke();
      ctx.restore();
      ctx.font = '700 10px Orbitron,monospace';
      ctx.fillStyle = C.amber;
      ctx.textAlign = 'center';
      ctx.fillText(st.processingLabel || 'PROCESSING', cx, cy + 36);
      ctx.textAlign = 'left';
      return;
    }

    ctx.font = '700 8px Orbitron,monospace';
    ctx.fillStyle = C.amber;
    ctx.fillText(st.category.toUpperCase(), 14, 46);

    ctx.strokeStyle = 'rgba(255,170,0,0.2)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(14, 52); ctx.lineTo(w - 14, 52); ctx.stroke();

    ctx.font = '400 20px "Share Tech Mono",monospace';
    ctx.fillStyle = C.blue;
    ctx.shadowColor = 'rgba(0,200,255,0.5)';
    ctx.shadowBlur = 6;
    let y = 76;
    const maxW = w - 28;
    let line = '';
    for (const ch of (st.answer || '—')) {
      const test = line + ch;
      if (ctx.measureText(test).width > maxW && line) {
        ctx.fillText(line, 14, y); y += 24; line = ch;
      } else line = test;
    }
    if (line) { ctx.fillText(line, 14, y); y += 24; }
    ctx.shadowBlur = 0;

    if (st.sub) {
      ctx.font = '400 9.5px "Share Tech Mono",monospace';
      ctx.fillStyle = C.textDim;
      ctx.fillText(st.sub.slice(0, 68), 14, y);
      y += 18;
    }

    y += 4;
    ctx.strokeStyle = 'rgba(0,200,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(14, y); ctx.lineTo(w - 14, y); ctx.stroke();
    y += 14;

    if (st.steps && st.steps.length) {
      ctx.font = '700 7px Orbitron,monospace';
      ctx.fillStyle = C.textDim;
      ctx.fillText('SOLUTION PATH', 14, y);
      y += 13;

      ctx.font = '400 9.5px "Share Tech Mono",monospace';
      for (let i = 0; i < Math.min(st.steps.length, 5); i++) {
        ctx.fillStyle = C.blue;
        ctx.fillText(`0${i + 1}`, 14, y);
        ctx.fillStyle = C.text;
        ctx.fillText(st.steps[i].slice(0, 58), 34, y);
        y += 15;
      }
    }

    if (st.extra) {
      y += 4;
      ctx.strokeStyle = 'rgba(0,200,255,0.1)';
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(14, y); ctx.lineTo(w - 14, y); ctx.stroke();
      y += 12;
      ctx.font = '400 9px "Share Tech Mono",monospace';
      ctx.fillStyle = 'rgba(0,200,255,0.5)';
      ctx.fillText(st.extra.slice(0, 68), 14, y);
    }

    ctx.font = '700 7px Orbitron,monospace';
    ctx.fillStyle = 'rgba(0,200,255,0.18)';
    ctx.fillText('SAY "JARVIS SOLVE [PROBLEM]" TO UPDATE', 14, h - 10);
  }

  // ── WIDGET RENDERERS ────────────────────────────────────────
  function renderClock(ctx,w,h){
    _frame++;
    hud(ctx,w,h); titleBar(ctx,w,'CLOCK');
    const now=new Date();
    const time=now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    const date=now.toLocaleDateString('en-GB',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
    lbl(ctx,'LOCAL TIME',16,54);
    ctx.font='400 34px "Share Tech Mono",monospace';
    ctx.fillStyle=C.blue; ctx.shadowColor=C.blueGlow; ctx.shadowBlur=10;
    ctx.fillText(time,16,96); ctx.shadowBlur=0;
    lbl(ctx,'DATE',16,116);
    sm(ctx,date.toUpperCase(),16,134,C.text);
    bar(ctx,16,148,w-32,now.getSeconds()/60,C.blue);
  }

  function renderMood(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,'MOOD');
    const s=window.state||{};
    const mood=s.mood||'neutral', score=s.moodScore||0;
    const MC={excited:'#ffee55',pleased:C.green,curious:C.blue,neutral:'#88ccee',concerned:C.amber,bored:'#6688aa',tired:'#445566'};
    const MI={excited:'⚡',pleased:'●',curious:'◈',neutral:'●',concerned:'▲',bored:'◌',tired:'◯'};
    const col=MC[mood]||C.blue;
    lbl(ctx,'EMOTIONAL STATE',16,54);
    ctx.font='400 24px "Share Tech Mono",monospace';
    ctx.fillStyle=col; ctx.shadowColor=col; ctx.shadowBlur=8;
    ctx.fillText((MI[mood]||'●')+'  '+mood.toUpperCase(),16,90); ctx.shadowBlur=0;
    lbl(ctx,'SCORE',16,112);
    sm(ctx,score.toString(),16,130,col);
    bar(ctx,16,144,w-32,(score+100)/200,col);
  }

  function renderSystem(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,'SYSTEM');
    const elapsed=Date.now()-_sessionStart;
    const hh=Math.floor(elapsed/3600000);
    const mm=Math.floor((elapsed%3600000)/60000);
    const ss=Math.floor((elapsed%60000)/1000);
    const uptime=`${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}`;
    const s=window.state||{};
    const phase=(s.phase||'idle').toUpperCase();
    const PL={IDLE:'STANDBY',CHATTING:'ACTIVE',LISTENING:'LISTENING',THINKING:'PROCESSING',SPEAKING:'SPEAKING'};
    const PC={CHATTING:C.green,SPEAKING:C.amber,LISTENING:C.blue,THINKING:C.amber};
    lbl(ctx,'SESSION UPTIME',16,54);
    ctx.font='400 26px "Share Tech Mono",monospace';
    ctx.fillStyle=C.blue; ctx.fillText(uptime,16,88);
    lbl(ctx,'PHASE',16,110);
    ctx.font='400 15px "Share Tech Mono",monospace';
    ctx.fillStyle=PC[phase]||C.textDim; ctx.fillText(PL[phase]||'STANDBY',16,130);
    bar(ctx,16,148,w-32,Math.min(1,elapsed/3600000),C.blue);
  }

  function renderMemory(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,'MEMORY');
    const s=window.state||{}, mem=s.memories||[], n=mem.length;
    lbl(ctx,'MEMORY BANK',16,54);
    ctx.font='400 40px "Share Tech Mono",monospace';
    ctx.fillStyle=C.blue; ctx.shadowColor=C.blueGlow; ctx.shadowBlur=10;
    ctx.fillText(n.toString(),16,104); ctx.shadowBlur=0;
    sm(ctx,n===1?'LONG-TERM FACT':'LONG-TERM FACTS',66,96,C.textDim);
    if(mem.length>0){
      lbl(ctx,'LAST STORED',16,118);
      const last=(typeof mem[mem.length-1]==='string'?mem[mem.length-1]:mem[mem.length-1]?.fact)||'';
      sm(ctx,last.slice(0,38)+(last.length>38?'…':''),16,136,C.text);
    } else {
      sm(ctx,'NO FACTS STORED YET',16,130,C.textDim);
    }
  }

  function renderNeural(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,'NEURAL ENGINE');
    const s=window.state||{}, count=s.interactionCount||0;
    lbl(ctx,'INTERACTIONS',16,54);
    ctx.font='400 40px "Share Tech Mono",monospace';
    ctx.fillStyle=C.blue; ctx.shadowColor=C.blueGlow; ctx.shadowBlur=10;
    ctx.fillText(count.toString(),16,104); ctx.shadowBlur=0;
    lbl(ctx,'ACTIVITY',16,118);
    for(let i=0;i<10;i++){
      const active=i<(count%10+1);
      const bh=active?10+Math.random()*18:4;
      ctx.fillStyle=active?C.blue:'rgba(0,200,255,0.12)';
      ctx.fillRect(16+i*22,148-bh,16,bh);
    }
  }

  function renderAudio(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,'AUDIO INPUT');
    const s=window.state||{}, active=s.isListening||false;
    const col=active?C.blue:C.textDim;
    lbl(ctx,'MIC STATUS',16,54);
    ctx.font='400 18px "Share Tech Mono",monospace';
    ctx.fillStyle=col; ctx.fillText(active?'● ACTIVE':'○ INACTIVE',16,82);
    lbl(ctx,'WAVEFORM',16,104);
    for(let i=0;i<20;i++){
      const bh=active?8+Math.random()*32:4;
      ctx.fillStyle=active?`rgba(0,200,255,${0.4+Math.random()*0.6})`:'rgba(0,200,255,0.1)';
      ctx.fillRect(16+i*13,148-bh,8,bh);
    }
  }

  function renderUser(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,'USER');
    const s=window.state||{};
    const user=(s.user||'—').toUpperCase();
    const title=(s.userTitle||'—').toUpperCase();
    const mood=(s.mood||'neutral').toUpperCase();
    lbl(ctx,'AUTHORISED USER',16,54);
    ctx.font='400 22px "Share Tech Mono",monospace';
    ctx.fillStyle=C.blue; ctx.fillText(user,16,84);
    lbl(ctx,'TITLE',16,106); sm(ctx,title,16,124,C.text);
    lbl(ctx,'MOOD',130,106); sm(ctx,mood,130,124,C.text);
  }

  function renderAll(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,'ALL SYSTEMS');
    const s=window.state||{};
    const now=new Date();
    const time=now.toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
    const elapsed=Date.now()-_sessionStart;
    const mm=Math.floor(elapsed/60000), ss=Math.floor((elapsed%60000)/1000);
    const uptime=`${mm}m ${ss}s`;
    const mood=s.mood||'neutral', score=s.moodScore||0, count=s.interactionCount||0;
    const phase=(s.phase||'idle').toUpperCase();
    const memN=(s.memories||[]).length;
    const user=(s.user||'—').toUpperCase();
    const MC={excited:'#ffee55',pleased:C.green,curious:C.blue,neutral:'#88ccee',concerned:C.amber,bored:'#6688aa',tired:'#445566'};
    const PC={CHATTING:C.green,SPEAKING:C.amber,LISTENING:C.blue,THINKING:C.amber};
    const moodCol=MC[mood]||C.blue, phaseCol=PC[phase]||C.textDim;

    const col1=16, col2=w/2+8;
    const rows=[48,108,168,228,288];

    function sec(x,y,label,val,color){
      lbl(ctx,label,x,y);
      ctx.font='400 17px "Share Tech Mono",monospace';
      ctx.fillStyle=color||C.blue; ctx.fillText(val,x,y+22);
    }

    sec(col1,rows[0],'LOCAL TIME',    time,              C.blue);
    sec(col2,rows[0],'UPTIME',        uptime,            C.blue);
    sec(col1,rows[1],'PHASE',         phase,             phaseCol);
    sec(col2,rows[1],'USER',          user,              C.blue);
    sec(col1,rows[2],'MOOD',          mood.toUpperCase(),moodCol);
    sec(col2,rows[2],'SCORE',         score.toString(),  moodCol);
    sec(col1,rows[3],'INTERACTIONS',  count.toString(),  C.blue);
    sec(col2,rows[3],'MEMORY BANK',   memN+' STORED',    C.blue);
    sec(col1,rows[4],'MIC',           s.isListening?'ACTIVE':'STANDBY', s.isListening?C.green:C.textDim);
    sec(col2,rows[4],'AI ENGINE',     'ONLINE',          C.green);

    ctx.strokeStyle='rgba(0,200,255,0.08)'; ctx.lineWidth=1;
    rows.forEach(y=>{ctx.beginPath();ctx.moveTo(16,y+34);ctx.lineTo(w-16,y+34);ctx.stroke();});
    ctx.beginPath();ctx.moveTo(w/2,36);ctx.lineTo(w/2,h-16);ctx.stroke();
  }

  // ── PIP ENGINE ──────────────────────────────────────────────
  async function openWidget(id){
    if(widgets.has(id)){
      notify(`${WIDGET_DEFS[id]?.label||id} widget is already open.`);
      return widgets.get(id);
    }
    const def=WIDGET_DEFS[id];
    if(!def){notify('Unknown widget: '+id);return null;}

    const canvas=document.createElement('canvas');
    canvas.width=def.w; canvas.height=def.h;
    const ctx=canvas.getContext('2d');
    def.render(ctx,def.w,def.h);

    const stream=canvas.captureStream(30);
    const video=document.createElement('video');
    video.srcObject=stream; video.muted=true;
    video.width=def.w; video.height=def.h;
    await video.play();

    let pipWindow=null;

    if('documentPictureInPicture' in window){
      try{
        pipWindow=await window.documentPictureInPicture.requestWindow({width:def.w,height:def.h});
        pipWindow.document.body.style.cssText='margin:0;padding:0;background:#010c14;overflow:hidden;';
        video.style.cssText='width:100%;height:100%;display:block;';
        pipWindow.document.body.appendChild(video);
      }catch(e){
        console.warn('[PiP] Document PiP failed:',e);
        pipWindow=null;
      }
    }

    if(!pipWindow){
      try{
        await video.requestPictureInPicture();
      }catch(e){
        const popup = window.open('', 'jarvis_pip_' + id,
          `width=${def.w},height=${def.h},top=100,left=100,toolbar=no,menubar=no,scrollbars=no,resizable=yes`);
        if(!popup){
          notify('PiP blocked — allow popups for localhost in your browser settings.');
          stream.getTracks().forEach(t=>t.stop());
          return null;
        }
        popup.document.body.style.cssText='margin:0;padding:0;background:#010c14;overflow:hidden;';
        video.style.cssText='width:100%;height:100%;display:block;';
        popup.document.body.appendChild(video);
        const interval=setInterval(()=>def.render(ctx,def.w,def.h), 1000/30);
        const entry={video,canvas,ctx,interval,stream,def,pipWindow:popup};
        widgets.set(id,entry);
        popup.addEventListener('beforeunload',()=>{
          clearInterval(interval);
          stream.getTracks().forEach(t=>t.stop());
          widgets.delete(id);
        });
        return entry;
      }
    }

    const interval=setInterval(()=>def.render(ctx,def.w,def.h), 1000/30);
    const entry={video,canvas,ctx,interval,stream,def,pipWindow};
    widgets.set(id,entry);

    const cleanup=()=>{
      clearInterval(interval);
      stream.getTracks().forEach(t=>t.stop());
      widgets.delete(id);
    };
    if(pipWindow) pipWindow.addEventListener('pagehide',cleanup);
    else video.addEventListener('leavepictureinpicture',cleanup);

    return entry;
  }

  async function closeWidget(id){
    const entry=widgets.get(id);
    if(!entry)return;
    clearInterval(entry.interval);
    entry.stream.getTracks().forEach(t=>t.stop());
    if(entry.pipWindow) try{entry.pipWindow.close();}catch{}
    else try{await document.exitPictureInPicture();}catch{}
    widgets.delete(id);
  }

  async function closeAll(){
    for(const id of [...widgets.keys()]) await closeWidget(id);
  }

  async function openAll(){
    for(const id of Object.keys(WIDGET_DEFS)){
      if(id==='all')continue;
      await openWidget(id);
      await new Promise(r=>setTimeout(r,500));
    }
  }

  function notify(msg){
    if(window.addMsg) window.addMsg('system',msg);
    else console.log('[PiP]',msg);
  }

  function detectWidgetId(query){
    if(/\bsolve\b/.test(query))                  return 'solve';
    if(/clock|time|date/.test(query))             return 'clock';
    if(/mood|emotion|feel/.test(query))           return 'mood';
    if(/system|status|uptime|phase/.test(query))  return 'system';
    if(/memor/.test(query))                       return 'memory';
    if(/neural|interact|activit/.test(query))     return 'neural';
    if(/audio|mic|sound|listen/.test(query))      return 'audio';
    if(/user|authoris|profile/.test(query))       return 'user';
    if(/all|everything|full|hud/.test(query))     return 'all';
    return null;
  }

  function extractSolveProblem(query) {
    return query
      .replace(/jarvis[\s,]*/gi, '')
      .replace(/\bsolve\b\s*/gi, '')
      .replace(/\bplease\b/gi, '')
      .replace(/\bfor me\b/gi, '')
      .trim();
  }

  // ── MAIN VOICE COMMAND HANDLER ───────────────────────────────
  async function handleVoiceCommand(action, meta) {
    const query = (meta?.query || '').toLowerCase();

    // ── SOLVE command ───────────────────────────────────────
    if (/\bsolve\b/.test(query) && action === 'SHOW_HUD') {
      const problem = extractSolveProblem(query);

      if (!problem) {
        // No problem spoken — take a screenshot and scan it

        // Open widget immediately so user sees feedback
        if (!widgets.has('solve')) await openWidget('solve');

        _solveState = {
          answer:         'Taking screenshot…',
          category:       'SCREEN SCAN',
          sub:            'Select your screen when prompted',
          steps:          [],
          extra:          '',
          processing:     true,
          processingLabel:'CAPTURING SCREEN',
        };

        notify('Taking a screenshot of your screen — select the screen/window when prompted.');

        let screenText = '';
        try {
          screenText = await grabScreenText();
        } catch (e) {
          console.warn('[SOLVE] grabScreenText error:', e.message);
        }

        if (screenText && screenText.trim().length > 3) {
          const result = computeSolve(screenText.trim());
          if (result) {
            _solveState = { ...result, processing: false };
            notify('Solved from screenshot: ' + result.answer);
          } else {
            const preview = screenText.trim().slice(0, 80);
            _solveState = {
              answer:   'No equation found on screen',
              category: 'SCREEN SCAN',
              sub:      `Read: "${preview}${preview.length < screenText.trim().length ? '…' : ''}"`,
              steps: [
                'Make sure an equation is visible on screen',
                'Or say "Jarvis solve [equation]" directly',
                'e.g. "Jarvis solve x squared minus 5x plus 6 equals 0"',
                'e.g. "Jarvis solve 15 percent of 200"',
              ],
              extra:      '',
              processing: false,
            };
          }
        } else {
          _solveState = {
            answer:   'Could not read screen',
            category: 'SCREEN SCAN',
            sub:      'Screenshot failed or returned no text',
            steps: [
              'Say "Jarvis solve [equation]" to solve directly without screenshot',
              'e.g. "Jarvis solve 25 percent of 80"',
              'e.g. "Jarvis solve is 97 prime"',
              'e.g. "Jarvis solve 72 fahrenheit to celsius"',
            ],
            extra:      '',
            processing: false,
          };
        }

        return;
      }

      // Problem was spoken — solve immediately
      _solveState = { ..._solveState, processing: true, processingLabel: 'COMPUTING' };
      if (!widgets.has('solve')) await openWidget('solve');
      await new Promise(r => setTimeout(r, 300));

      const result = computeSolve(problem);
      if (result) {
        _solveState = { ...result, processing: false };
        notify('Solved: ' + result.answer);
      } else {
        _solveState = {
          answer:   'Could not parse that.',
          category: 'PARSE ERROR',
          sub:      `Query: "${problem}"`,
          steps: [
            'Try: "Jarvis solve 15 percent of 200"',
            'Try: "Jarvis solve x squared minus 3x plus 2 equals 0"',
            'Try: "Jarvis solve is 97 prime"',
            'Try: "Jarvis solve 72 fahrenheit to celsius"',
          ],
          extra:      '',
          processing: false,
        };
        notify('Solve: could not parse "' + problem + '"');
      }

      if (!widgets.has('solve')) await openWidget('solve');
      return;
    }

    // ── HIDE HUD ──────────────────────────────────────────────
    if (action === 'HIDE_HUD') {
      const targetId = detectWidgetId(query);
      if (targetId) {
        await closeWidget(targetId);
        notify(`${WIDGET_DEFS[targetId]?.label || targetId} widget closed.`);
      } else {
        await closeAll();
        notify('All HUD widgets closed.');
      }
      return;
    }

    // ── SHOW HUD (non-solve) ──────────────────────────────────
    const targetId = detectWidgetId(query) || 'all';
    notify(`Launching ${WIDGET_DEFS[targetId]?.label || targetId} HUD as Picture-in-Picture…`);
    await openWidget(targetId);
  }

  return {
    open:             openWidget,
    close:            closeWidget,
    closeAll,
    openAll,
    handleVoiceCommand,
    detectWidgetId,
    computeSolve,
    list:             () => [...widgets.keys()],
    WIDGET_DEFS,
  };

})();
