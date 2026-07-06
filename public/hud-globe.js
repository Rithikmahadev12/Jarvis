// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Reusable particle globe factory v1.0
// Same look as the Daily Briefing screen's globe, generalized so
// any canvas element can host its own rotating sphere of points.
//
// Usage: const g = window.createParticleGlobe('canvas-id', { count: 180, speed: 0.003 });
//        g.start(); // g.stop() to pause
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  function createParticleGlobe(canvasId, opts) {
    opts = opts || {};
    const COUNT = opts.count || 200;
    const SPEED = opts.speed != null ? opts.speed : 0.0028;
    const DOT_COLOR = opts.color || "0,200,255";

    let canvas = null, ctx = null, raf = null, dpr = 1;
    let angle = 0;
    let pts = [];
    let running = false;

    function spawn() {
      pts = [];
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < COUNT; i++) {
        const y = 1 - (i / (COUNT - 1)) * 2;
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        const theta = golden * i;
        pts.push({
          x: Math.cos(theta) * r,
          y,
          z: Math.sin(theta) * r,
          tw: Math.random() * Math.PI * 2,
        });
      }
    }

    function resize() {
      if (!canvas) return;
      const wrap = canvas.parentElement;
      const size = Math.min(wrap.clientWidth, wrap.clientHeight) || canvas.clientWidth || 100;
      dpr = window.devicePixelRatio || 1;
      canvas.width  = size * dpr;
      canvas.height = size * dpr;
    }

    function loop() {
      if (!running) return;
      raf = requestAnimationFrame(loop);
      if (!ctx || !canvas.width) return;

      const size = canvas.width;
      const cx = size / 2, cy = size / 2;
      const R = size * 0.42;

      ctx.clearRect(0, 0, size, size);
      angle += SPEED;

      const projected = pts.map(p => {
        const cosA = Math.cos(angle), sinA = Math.sin(angle);
        const x = p.x * cosA - p.z * sinA;
        const z = p.x * sinA + p.z * cosA;
        return { x, y: p.y, z, tw: p.tw };
      }).sort((a, b) => a.z - b.z);

      for (const p of projected) {
        const depth = (p.z + 1) / 2;
        const sx = cx + p.x * R;
        const sy = cy + p.y * R;
        const rad = (0.5 + depth * 1.5) * dpr;
        const tw = 0.55 + 0.45 * Math.sin(Date.now() * 0.002 + p.tw);
        const alpha = (0.12 + depth * 0.7) * tw;

        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${DOT_COLOR},${alpha.toFixed(3)})`;
        if (depth > 0.78) {
          ctx.shadowBlur = 8 * dpr;
          ctx.shadowColor = `rgba(${DOT_COLOR},0.7)`;
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.fill();
      }
      ctx.shadowBlur = 0;
    }

    function start() {
      canvas = document.getElementById(canvasId);
      if (!canvas) return;
      ctx = canvas.getContext("2d");
      resize();
      if (!pts.length) spawn();
      running = true;
      window.addEventListener("resize", resize);
      loop();
    }

    function stop() {
      running = false;
      if (raf) cancelAnimationFrame(raf);
    }

    return { start, stop, resize };
  }

  window.createParticleGlobe = createParticleGlobe;
})();
