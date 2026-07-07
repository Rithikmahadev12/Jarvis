// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Particle Field + Voice Waveform v2.0
// Drop in public/ and add two <canvas> elements + one <script>
// ═══════════════════════════════════════════════════════════════

window.JarvisVisuals = (function () {

  // ── PARTICLE FIELD ─────────────────────────────────────────
  const PC = {
    canvas: null, ctx: null,
    particles: [], lines: [],
    w: 0, h: 0,
    mouse: { x: -9999, y: -9999 },
    frame: 0,
    active: false,

    COUNT:       110,
    CONNECT_DIST: 130,
    MOUSE_PULL:   180,
    SPEED:        0.28,

    init() {
      this.canvas = document.getElementById('particle-canvas');
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext('2d');
      this.resize();
      this.spawn();
      window.addEventListener('resize', () => this.resize());
      window.addEventListener('mousemove', e => {
        this.mouse.x = e.clientX;
        this.mouse.y = e.clientY;
      });
      this.active = true;
      this.loop();
    },

    resize() {
      this.w = this.canvas.width  = window.innerWidth;
      this.h = this.canvas.height = window.innerHeight;
    },

    spawn() {
      this.particles = [];
      // Evenly-jittered grid spawn: divides the screen into cells and drops
      // one particle per cell (with small random jitter) so particles are
      // always spread across the whole viewport instead of risking a random
      // clump in one corner (which is what pure Math.random() placement
      // could produce, and looked like a "displaced" trail of dots).
      const cols = Math.max(1, Math.round(Math.sqrt(this.COUNT * (this.w / this.h))));
      const rows = Math.max(1, Math.ceil(this.COUNT / cols));
      const cellW = this.w / cols;
      const cellH = this.h / rows;
      let placed = 0;
      for (let ry = 0; ry < rows && placed < this.COUNT; ry++) {
        for (let rx = 0; rx < cols && placed < this.COUNT; rx++) {
          const jitterX = (Math.random() - 0.5) * cellW * 0.9;
          const jitterY = (Math.random() - 0.5) * cellH * 0.9;
          this.particles.push({
            x:    rx * cellW + cellW / 2 + jitterX,
            y:    ry * cellH + cellH / 2 + jitterY,
            vx:   (Math.random() - 0.5) * this.SPEED,
            vy:   (Math.random() - 0.5) * this.SPEED,
            r:    Math.random() * 1.2 + 0.3,
            base: Math.random(),          // phase offset
            bright: Math.random() < 0.08, // 8% are bright nodes
          });
          placed++;
        }
      }
    },

    loop() {
      if (!this.active) return;
      requestAnimationFrame(() => this.loop());
      this.frame++;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, this.w, this.h);

      const t = this.frame * 0.008;

      for (const p of this.particles) {
        // Mouse pull
        const dx = this.mouse.x - p.x;
        const dy = this.mouse.y - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < this.MOUSE_PULL && dist > 1) {
          const force = (this.MOUSE_PULL - dist) / this.MOUSE_PULL * 0.012;
          p.vx += (dx / dist) * force;
          p.vy += (dy / dist) * force;
        }

        // Dampen + move
        p.vx *= 0.992; p.vy *= 0.992;
        p.x  += p.vx;  p.y  += p.vy;

        // Wrap
        if (p.x < -10) p.x = this.w + 10;
        if (p.x > this.w + 10) p.x = -10;
        if (p.y < -10) p.y = this.h + 10;
        if (p.y > this.h + 10) p.y = -10;

        // Draw dot
        const alpha = p.bright
          ? 0.5 + 0.5 * Math.sin(t * 3 + p.base * 6)
          : 0.1 + 0.12 * Math.sin(t + p.base * 4);

        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        if (p.bright) {
          ctx.fillStyle = `rgba(0,200,255,${alpha})`;
          ctx.shadowBlur = 8;
          ctx.shadowColor = 'rgba(0,200,255,0.6)';
        } else {
          ctx.fillStyle = `rgba(0,150,210,${alpha})`;
          ctx.shadowBlur = 0;
        }
        ctx.fill();
        ctx.shadowBlur = 0;
      }

      // Draw connecting lines
      for (let i = 0; i < this.particles.length; i++) {
        for (let j = i + 1; j < this.particles.length; j++) {
          const a = this.particles[i], b = this.particles[j];
          const dx = a.x - b.x, dy = a.y - b.y;
          const d  = Math.sqrt(dx * dx + dy * dy);
          if (d < this.CONNECT_DIST) {
            const alpha = (1 - d / this.CONNECT_DIST) * 0.12;
            ctx.beginPath();
            ctx.moveTo(a.x, a.y);
            ctx.lineTo(b.x, b.y);
            ctx.strokeStyle = `rgba(0,200,255,${alpha})`;
            ctx.lineWidth   = 0.6;
            ctx.stroke();
          }
        }
      }

      // Occasional data pulse — horizontal line sweep
      if (this.frame % 420 === 0) {
        this._pulse = { y: 0, alpha: 0.4 };
      }
      if (this._pulse) {
        this._pulse.y     += 4;
        this._pulse.alpha -= 0.003;
        if (this._pulse.alpha <= 0 || this._pulse.y > this.h) {
          this._pulse = null;
        } else {
          ctx.beginPath();
          ctx.moveTo(0, this._pulse.y);
          ctx.lineTo(this.w, this._pulse.y);
          ctx.strokeStyle = `rgba(0,200,255,${this._pulse.alpha})`;
          ctx.lineWidth   = 1;
          ctx.stroke();
        }
      }
    },

    stop() { this.active = false; },
  };

  // ── VOICE WAVEFORM ─────────────────────────────────────────
  const WF = {
    canvas:  null, ctx: null,
    mode:    'idle',    // 'idle' | 'listening' | 'speaking'
    frame:   0,
    active:  false,
    history: new Array(64).fill(0),

    // Web Audio for mic visualisation
    audioCtx:   null,
    analyser:   null,
    micStream:  null,
    dataArr:    null,

    init() {
      this.canvas = document.getElementById('waveform-canvas');
      if (!this.canvas) return;
      this.ctx    = this.canvas.getContext('2d');
      this.active = true;
      this.loop();
    },

    async startMic() {
      try {
        if (!this.audioCtx) this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.audioCtx.state === 'suspended') await this.audioCtx.resume();
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        this.micStream = stream;
        const src    = this.audioCtx.createMediaStreamSource(stream);
        this.analyser = this.audioCtx.createAnalyser();
        this.analyser.fftSize = 128;
        this.dataArr  = new Uint8Array(this.analyser.frequencyBinCount);
        src.connect(this.analyser);
      } catch (e) { /* silent — visualiser falls back to synthetic */ }
    },

    stopMic() {
      if (this.micStream) {
        this.micStream.getTracks().forEach(t => t.stop());
        this.micStream = null;
      }
      this.analyser = null;
    },

    setMode(m) {
      this.mode = m;
      const canvas = this.canvas;
      if (!canvas) return;
      if (m === 'idle') {
        canvas.classList.remove('active');
      } else {
        canvas.classList.add('active');
      }
      if (m === 'listening') this.startMic();
      else                   this.stopMic();
    },

    loop() {
      if (!this.active) return;
      requestAnimationFrame(() => this.loop());
      if (!this.canvas || this.mode === 'idle') return;

      this.frame++;
      const ctx = this.ctx;
      const W = this.canvas.width, H = this.canvas.height;
      const t = this.frame * 0.04;

      ctx.clearRect(0, 0, W, H);

      const BARS = 64;
      const barW = W / BARS;

      // Pull real mic data or synthesise
      let values = new Array(BARS);
      if (this.analyser && this.dataArr) {
        this.analyser.getByteFrequencyData(this.dataArr);
        for (let i = 0; i < BARS; i++) {
          const idx = Math.floor(i / BARS * this.dataArr.length);
          values[i] = this.dataArr[idx] / 255;
        }
      } else {
        // Synthetic waveform
        for (let i = 0; i < BARS; i++) {
          const phase = (i / BARS) * Math.PI * 2;
          if (this.mode === 'speaking') {
            values[i] = 0.3
              + 0.35 * Math.sin(t * 2.5 + phase)
              + 0.15 * Math.sin(t * 5.1 + phase * 2.2)
              + 0.1  * Math.sin(t * 8   + phase * 3)
              + 0.05 * (Math.random() - 0.5);
          } else {
            // listening — quieter ripple
            values[i] = 0.08
              + 0.12 * Math.sin(t * 1.8 + phase)
              + 0.05 * (Math.random() - 0.5);
          }
          values[i] = Math.max(0, Math.min(1, values[i]));
        }
      }

      // Smooth with history
      for (let i = 0; i < BARS; i++) {
        this.history[i] = this.history[i] * 0.72 + values[i] * 0.28;
      }

      // Choose colour by mode
      const isListening = this.mode === 'listening';
      const baseColor   = isListening ? '0,200,255' : '0,255,136';
      const glowColor   = isListening ? 'rgba(0,200,255,0.35)' : 'rgba(0,255,136,0.3)';

      // Draw bars mirrored (top & bottom from centre)
      const cy = H / 2;
      for (let i = 0; i < BARS; i++) {
        const h    = this.history[i] * (H * 0.88);
        const x    = i * barW + barW * 0.15;
        const bw   = barW * 0.7;
        const alpha = 0.5 + this.history[i] * 0.5;

        // Gradient per bar
        const grad = ctx.createLinearGradient(x, cy - h / 2, x, cy + h / 2);
        grad.addColorStop(0,   `rgba(${baseColor},0.0)`);
        grad.addColorStop(0.3, `rgba(${baseColor},${alpha * 0.6})`);
        grad.addColorStop(0.5, `rgba(${baseColor},${alpha})`);
        grad.addColorStop(0.7, `rgba(${baseColor},${alpha * 0.6})`);
        grad.addColorStop(1,   `rgba(${baseColor},0.0)`);

        ctx.fillStyle = grad;
        ctx.fillRect(x, cy - h / 2, bw, h);
      }

      // Centre line
      ctx.beginPath();
      ctx.moveTo(0, cy);
      ctx.lineTo(W, cy);
      ctx.strokeStyle = `rgba(${baseColor},0.08)`;
      ctx.lineWidth   = 0.5;
      ctx.stroke();
    },

    stop() { this.active = false; },
  };

  // ── PUBLIC API ────────────────────────────────────────────
  function init() {
    PC.init();
    WF.init();
  }

  function setOrbMode(mode) {
    // 'idle' | 'listening' | 'thinking' | 'speaking'
    if (mode === 'listening') WF.setMode('listening');
    else if (mode === 'speaking') WF.setMode('speaking');
    else WF.setMode('idle');
  }

  return { init, setOrbMode };

})();

// Auto-init on load
document.addEventListener('DOMContentLoaded', () => JarvisVisuals.init());
