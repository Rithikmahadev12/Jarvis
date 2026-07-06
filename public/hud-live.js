// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Main HUD live-data wiring v1.0
// Purely additive: reads window.state (already maintained by
// jarvis.js) and the existing /api/memory endpoint, and updates the
// redesigned panel elements. Never throws if an element is missing.
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const $ = id => document.getElementById(id);

  function fmtTime() {
    return new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  function fmtDate() {
    return new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  }

  function tickClock() {
    const t = $("hud-clock"); if (t) t.textContent = fmtTime();
    const d = $("hud-date"); if (d) d.textContent = fmtDate();
  }

  // ── Mood donut — reads window.state.mood / moodScore (set by jarvis.js) ──
  function tickMood() {
    const s = window.state;
    if (!s) return;
    const score = typeof s.moodScore === "number" ? s.moodScore : 0;
    const pct = Math.round(((score + 100) / 200) * 100); // -100..100 -> 0..100
    const donut = $("mood-donut");
    if (donut) donut.style.setProperty("--bf-progress", (pct * 3.6).toFixed(1));
    const label = $("mood-label-big");
    if (label) label.textContent = pct + "%";
    const caption = $("mood-score-val");
    if (caption) caption.textContent = `MOOD · ${(s.mood || "neutral").toUpperCase()}`;
  }

  // ── Memory count — reused across left + right panels ──────────
  let lastMemFetch = 0;
  async function tickMemory() {
    const now = Date.now();
    if (now - lastMemFetch < 15000) return; // don't hammer the API
    lastMemFetch = now;
    const user = (window.state && window.state.user) || "";
    if (!user) return;
    try {
      const res = await fetch(`/api/memory/${encodeURIComponent(user.toLowerCase().trim())}`);
      const data = await res.json();
      const mem = data.memories || [];
      const countText = `${mem.length} stored`;
      const left = $("hud-mem-count-left"); if (left) left.textContent = countText;
      const right = $("mem-count-right"); if (right) right.textContent = countText;
      const sub = $("mem-sub-right");
      if (sub) sub.textContent = mem.length ? mem[mem.length - 1].fact.slice(0, 60) : "No facts yet";
    } catch { /* silent — offline is fine */ }
  }

  // ── Session interaction counter — counts transcript entries ───
  function tickInteractions() {
    const transcript = $("transcript");
    const el = $("interaction-count");
    if (!transcript || !el) return;
    const n = transcript.children.length;
    el.textContent = `${n} interaction${n === 1 ? "" : "s"}`;
  }

  // ── Camera ring-dot reflects the real camera-status class ─────
  function tickCameraRing() {
    const status = $("camera-status");
    const ring = $("ring-cam");
    if (!status || !ring) return;
    if (status.classList.contains("online")) ring.classList.add("done");
    else ring.classList.remove("done");
  }

  function tick() {
    tickClock();
    tickMood();
    tickMemory();
    tickInteractions();
    tickCameraRing();
  }

  function init() {
    tick();
    setInterval(tick, 1000);

    // Start the two ambient particle globes (safe no-ops if canvases absent)
    if (typeof window.createParticleGlobe === "function") {
      const mini = window.createParticleGlobe("orb-globe-canvas", { count: 90, speed: 0.004 });
      mini.start();
      const ambient = window.createParticleGlobe("ambient-globe-canvas", { count: 220, speed: 0.0018 });
      ambient.start();
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
