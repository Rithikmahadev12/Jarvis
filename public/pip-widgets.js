// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Picture-in-Picture HUD Widgets v2.0
// Each HUD panel becomes its own floating PiP window
// stays on top of ANY tab, zero extensions needed
// NEW: SOLVE widget — say "Jarvis, solve [problem]" from any tab
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

 if (!problem) {
        // No problem spoken — try to OCR the shared screen
        _solveState = {
          answer: 'Reading your screen…',
          category: 'SCREEN SCAN',
          sub: 'Looking for maths on your current tab',
          steps: [], extra: '', processing: true,
        };
        if (!widgets.has('solve')) await openWidget('solve');

        try {
          // Pull OCR text via the screen route
          const ocrResult = await new Promise((resolve) => {
            // Grab a frame from the existing screen stream
            const videoEl = document.createElement('video');
            const stream  = window.state?.screenStream;
            if (!stream) { resolve(null); return; }
            videoEl.srcObject = stream;
            videoEl.onloadedmetadata = () => {
              videoEl.play();
              setTimeout(() => {
                const c = document.createElement('canvas');
                c.width = videoEl.videoWidth || 1280;
                c.height = videoEl.videoHeight || 720;
                c.getContext('2d').drawImage(videoEl, 0, 0);
                videoEl.pause();
                resolve(c.toDataURL('image/png'));
              }, 200);
            };
          });

          if (ocrResult && window.Tesseract && window.state?.tesseractWorker) {
            const { data } = await window.state.tesseractWorker.recognize(ocrResult);
            const screenText = data.text || '';
            const result = computeSolve(screenText.trim());
            if (result) {
              _solveState = { ...result, processing: false };
              notify(`Solved from screen: ${result.answer}`);
            } else {
              _solveState = {
                answer: 'No equation found on screen',
                category: 'SCREEN SCAN',
                sub: 'Say "Jarvis solve [problem]" with the equation',
                steps: ['e.g. "Jarvis solve x² − 5x + 6 = 0"',
                        'e.g. "Jarvis solve 15% of 200"',
                        'e.g. "Jarvis solve is 97 prime"'],
                extra: '', processing: false,
              };
            }
          } else {
            _solveState = {
              answer: 'Say the problem aloud',
              category: 'AWAITING INPUT',
              sub: 'e.g. "Jarvis, solve x² − 5x + 6 = 0"',
              steps: [], extra: '', processing: false,
            };
          }
        } catch {
          _solveState = {
            answer: 'Say the problem aloud',
            category: 'AWAITING INPUT',
            sub: 'e.g. "Jarvis, solve x² − 5x + 6 = 0"',
            steps: [], extra: '', processing: false,
          };
        }

      } else {

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
      // close any unclosed sqrt parens
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

  function computeSolve(raw) {
    const q = raw.toLowerCase().trim();

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

    // Processing spinner animation
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
      ctx.fillText('PROCESSING', cx, cy + 36);
      ctx.textAlign = 'left';
      return;
    }

    // Category tag
    ctx.font = '700 8px Orbitron,monospace';
    ctx.fillStyle = C.amber;
    ctx.fillText(st.category.toUpperCase(), 14, 46);

    // Separator line under category
    ctx.strokeStyle = 'rgba(255,170,0,0.2)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(14, 52); ctx.lineTo(w - 14, 52); ctx.stroke();

    // Answer — word wrapped
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

    // Sub label
    if (st.sub) {
      ctx.font = '400 9.5px "Share Tech Mono",monospace';
      ctx.fillStyle = C.textDim;
      ctx.fillText(st.sub.slice(0, 68), 14, y);
      y += 18;
    }

    // Divider
    y += 4;
    ctx.strokeStyle = 'rgba(0,200,255,0.15)';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(14, y); ctx.lineTo(w - 14, y); ctx.stroke();
    y += 14;

    // Steps header
    if (st.steps && st.steps.length) {
      ctx.font = '700 7px Orbitron,monospace';
      ctx.fillStyle = C.textDim;
      ctx.fillText('SOLUTION PATH', 14, y);
      y += 13;

      ctx.font = '400 9.5px "Share Tech Mono",monospace';
      for (let i = 0; i < Math.min(st.steps.length, 5); i++) {
        // Step number
        ctx.fillStyle = C.blue;
        ctx.fillText(`0${i + 1}`, 14, y);
        // Step text
        ctx.fillStyle = C.text;
        const stepText = st.steps[i].slice(0, 58);
        ctx.fillText(stepText, 34, y);
        y += 15;
      }
    }

    // Extra info at bottom
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

    // Footer hint
    ctx.font = '700 7px Orbitron,monospace';
    ctx.fillStyle = 'rgba(0,200,255,0.18)';
    ctx.fillText('SAY "JARVIS SOLVE [PROBLEM]" TO UPDATE FROM ANY TAB', 14, h - 10);
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
        notify('PiP failed — try clicking the page first, then ask again.');
        stream.getTracks().forEach(t=>t.stop());
        return null;
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
    if(/\bsolve\b/.test(query))              return 'solve';
    if(/clock|time|date/.test(query))        return 'clock';
    if(/mood|emotion|feel/.test(query))      return 'mood';
    if(/system|status|uptime|phase/.test(query)) return 'system';
    if(/memor/.test(query))                  return 'memory';
    if(/neural|interact|activit/.test(query))return 'neural';
    if(/audio|mic|sound|listen/.test(query)) return 'audio';
    if(/user|authoris|profile/.test(query))  return 'user';
    if(/all|everything|full|hud/.test(query))return 'all';
    return null;
  }

  // ── EXTRACT SOLVE PROBLEM FROM VOICE QUERY ──────────────────
  function extractSolveProblem(query) {
    return query
      .replace(/jarvis[\s,]*/gi, '')
      .replace(/\bsolve\b\s*/gi, '')
      .replace(/\bplease\b/gi, '')
      .replace(/\bfor me\b/gi, '')
      .trim();
  }

  async function handleVoiceCommand(action, meta){
    const query=(meta?.query||'').toLowerCase();

    // ── SOLVE command — highest priority ──────────────────────
    if (/\bsolve\b/.test(query) && action === 'SHOW_HUD') {
      const problem = extractSolveProblem(query);

      if (!problem) {
        _solveState = {
          answer: 'State your problem, Sir.',
          category: 'AWAITING INPUT',
          sub: 'e.g. "Jarvis, solve x² − 5x + 6 = 0"',
          steps: [],
          extra: '',
          processing: false,
        };
      } else {
        // Show processing state while we compute
        _solveState = { ...(_solveState), processing: true };

        // Open/update widget immediately so user sees the spinner
        if (!widgets.has('solve')) {
          await openWidget('solve');
        }

        // Small delay so the spinner renders at least one frame
        await new Promise(r => setTimeout(r, 400));

        const result = computeSolve(problem);
        if (result) {
          _solveState = { ...result, processing: false };
          notify(`Solved: ${result.answer}`);
        } else {
          _solveState = {
            answer: 'Could not parse that, Sir.',
            category: 'PARSE ERROR',
            sub: `Query: "${problem}"`,
            steps: ['Try: "what is 15% of 200"', 'Or: "solve x² − 3x + 2 = 0"', 'Or: "is 97 prime"', 'Or: "72°F to Celsius"'],
            extra: '',
            processing: false,
          };
          notify(`Solve: could not parse "${problem}"`);
        }
      }

      // Open widget if not already open
      if (!widgets.has('solve')) {
        await openWidget('solve');
      }
      return;
    }

    if(action==='HIDE_HUD'){
      const targetId=detectWidgetId(query);
      if(targetId){
        await closeWidget(targetId);
        notify(`${WIDGET_DEFS[targetId]?.label||targetId} widget closed.`);
      } else {
        await closeAll();
        notify('All HUD widgets closed.');
      }
      return;
    }

    // SHOW_HUD (non-solve)
    const targetId=detectWidgetId(query)||'all';
    notify(`Launching ${WIDGET_DEFS[targetId]?.label||targetId} HUD as Picture-in-Picture…`);
    await openWidget(targetId);
  }

  return { open:openWidget, close:closeWidget, closeAll, openAll, handleVoiceCommand, detectWidgetId, computeSolve, list:()=>[...widgets.keys()], WIDGET_DEFS };

})();
