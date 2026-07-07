// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Daily Briefing Screen v1.0
// Plays after the boot log, before the main HUD. If no task has
// been set yet today, asks "what is going to be your task?", turns
// the answer into a short spoken briefing ("first... second...")
// via the server, then speaks it while the visuals play out.
// If a task was already set today, replays that same briefing
// without asking again.
//
// Public entry point: window.JarvisBriefing.run({ user, userTitle }, done)
// `done` is called exactly once, when the screen should hand off
// to the main HUD (or was skipped).
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  // ── ONE-TIME DOM BUILD ─────────────────────────────────────────
  let built = false;
  let refs = {};

  function build() {
    if (built) return;
    const root = $("briefing-screen");
    if (!root) return;

    root.innerHTML = `
      <div class="bf-topbar">
        <div class="bf-topbar-block">
          <div class="bf-topbar-label">OPERATOR</div>
          <div class="bf-topbar-val" id="bf-user">—</div>
        </div>
        <div class="bf-topbar-block bf-topbar-center">
          <div class="bf-title">J.A.R.V.I.S</div>
          <div class="bf-subtitle">DAILY BRIEFING</div>
        </div>
        <div class="bf-topbar-block right">
          <div class="bf-topbar-label">DATE</div>
          <div class="bf-topbar-val" id="bf-date">—</div>
        </div>
      </div>

      <div class="bf-body">
        <div class="bf-left">
          <div class="bf-panel-label">BRIEFING SEQUENCE</div>
          <div class="bf-stage-list" id="bf-stage-list"></div>
          <div class="bf-mini-stats">
            <div class="bf-mini-stat"><span>SESSION</span><span id="bf-time">00:00:00</span></div>
            <div class="bf-mini-stat"><span>ENGINE</span><span>ONLINE</span></div>
          </div>
        </div>

        <div class="bf-center">
          <div class="bf-globe-wrap">
            <canvas id="bf-globe-canvas"></canvas>
            <div class="bf-globe-ring"></div>
            <div class="bf-globe-ring r2"></div>
          </div>

          <div class="bf-textwrap" id="bf-textwrap">
            <div class="bf-eyebrow" id="bf-eyebrow">SYNCING TODAY'S SCHEDULE…</div>
            <div class="bf-line" id="bf-line"><span class="bf-cursor"></span></div>
            <div class="bf-steps-readout" id="bf-steps-readout"></div>
          </div>

          <div class="bf-eq-wrap" id="bf-eq-wrap">
            <div class="bf-eq-bar"></div><div class="bf-eq-bar"></div><div class="bf-eq-bar"></div>
            <div class="bf-eq-bar"></div><div class="bf-eq-bar"></div><div class="bf-eq-bar"></div>
            <div class="bf-eq-bar"></div><div class="bf-eq-bar"></div><div class="bf-eq-bar"></div>
          </div>
        </div>

        <div class="bf-right">
          <div class="bf-panel-label">PROGRESS</div>
          <div class="bf-donut-wrap">
            <div class="bf-donut" id="bf-donut" style="--bf-progress:0">
              <div class="bf-donut-label" id="bf-donut-label">0%</div>
            </div>
            <div class="bf-donut-caption">STEPS DELIVERED</div>
          </div>
          <div class="bf-ring-row" id="bf-ring-row"></div>
          <div class="bf-stat-block">
            <div class="bf-stat-block-label">TODAY'S OBJECTIVE</div>
            <div class="bf-stat-block-val" id="bf-stat-objective">Awaiting input…</div>
          </div>
          <div class="bf-stat-block">
            <div class="bf-stat-block-label">STEP COUNT</div>
            <div class="bf-stat-block-val" id="bf-stat-count">—</div>
          </div>
        </div>
      </div>
    `;

    refs = {
      user:      $("bf-user"),
      date:      $("bf-date"),
      time:      $("bf-time"),
      stageList: $("bf-stage-list"),
      textwrap:  $("bf-textwrap"),
      eyebrow:   $("bf-eyebrow"),
      line:      $("bf-line"),
      stepsReadout: $("bf-steps-readout"),
      eqWrap:    $("bf-eq-wrap"),
      donut:     $("bf-donut"),
      donutLabel: $("bf-donut-label"),
      ringRow:   $("bf-ring-row"),
      statObjective: $("bf-stat-objective"),
      statCount: $("bf-stat-count"),
    };

    built = true;
  }

  // ── GLOBE CANVAS — rotating sphere of points ───────────────────
  const Globe = {
    canvas: null, ctx: null, raf: null,
    pts: [], angle: 0, dpr: 1,

    start() {
      this.canvas = $("bf-globe-canvas");
      if (!this.canvas) return;
      this.ctx = this.canvas.getContext("2d");
      this.resize();
      window.addEventListener("resize", () => this.resize());
      if (!this.pts.length) this.spawn();
      this.loop();
    },

    resize() {
      const wrap = this.canvas.parentElement;
      const size = Math.min(wrap.clientWidth, wrap.clientHeight) || 300;
      this.dpr = window.devicePixelRatio || 1;
      this.canvas.width  = size * this.dpr;
      this.canvas.height = size * this.dpr;
      this.canvas.style.width  = size + "px";
      this.canvas.style.height = size + "px";
    },

    spawn() {
      const N = 260;
      // Fibonacci sphere distribution
      const golden = Math.PI * (3 - Math.sqrt(5));
      for (let i = 0; i < N; i++) {
        const y = 1 - (i / (N - 1)) * 2;
        const r = Math.sqrt(1 - y * y);
        const theta = golden * i;
        this.pts.push({
          x: Math.cos(theta) * r,
          y,
          z: Math.sin(theta) * r,
          tw: Math.random() * Math.PI * 2,
        });
      }
    },

    loop() {
      if (!this.active()) { this.raf = requestAnimationFrame(() => this.loop()); return; }
      this.raf = requestAnimationFrame(() => this.loop());
      const ctx = this.ctx;
      const size = this.canvas.width;
      const cx = size / 2, cy = size / 2;
      const R = size * 0.42;

      ctx.clearRect(0, 0, size, size);
      this.angle += 0.0028;

      const sorted = this.pts
        .map(p => {
          const cosA = Math.cos(this.angle), sinA = Math.sin(this.angle);
          const x = p.x * cosA - p.z * sinA;
          const z = p.x * sinA + p.z * cosA;
          const y = p.y;
          return { x, y, z, tw: p.tw };
        })
        .sort((a, b) => a.z - b.z);

      for (const p of sorted) {
        const depth = (p.z + 1) / 2; // 0..1
        const sx = cx + p.x * R;
        const sy = cy + p.y * R;
        const rad = (0.6 + depth * 1.8) * this.dpr;
        const tw = 0.55 + 0.45 * Math.sin(Date.now() * 0.002 + p.tw);
        const alpha = (0.15 + depth * 0.75) * tw;

        ctx.beginPath();
        ctx.arc(sx, sy, rad, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(0,200,255,${alpha.toFixed(3)})`;
        if (depth > 0.75) {
          ctx.shadowBlur = 10 * this.dpr;
          ctx.shadowColor = "rgba(0,200,255,0.7)";
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      // Thin equatorial rings for a "scanner" feel
      ctx.beginPath();
      ctx.ellipse(cx, cy, R * 1.02, R * 0.32, 0, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(0,200,255,0.18)";
      ctx.lineWidth = 1 * this.dpr;
      ctx.stroke();
    },

    active() { return $("briefing-screen") && $("briefing-screen").classList.contains("active"); },

    stop() { if (this.raf) cancelAnimationFrame(this.raf); },
  };

  // ── HELPERS ─────────────────────────────────────────────────────
  function setEyebrow(text) { if (refs.eyebrow) refs.eyebrow.textContent = text; }

  function typeLine(text, cb) {
    if (!refs.line) { cb && cb(); return; }
    refs.line.innerHTML = '<span class="bf-cursor"></span>';
    let i = 0;
    const speed = 16;
    function step() {
      if (i >= text.length) { cb && cb(); return; }
      i++;
      refs.line.innerHTML = escapeHtml(text.slice(0, i)) + '<span class="bf-cursor"></span>';
      setTimeout(step, speed);
    }
    step();
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function buildStageList(stages, currentIdx) {
    if (!refs.stageList) return;
    refs.stageList.innerHTML = "";
    stages.forEach((label, i) => {
      const row = el("div", "bf-stage" + (i < currentIdx ? " done" : i === currentIdx ? " current" : ""));
      row.innerHTML = `<span class="bf-stage-dot"></span><span>${label}</span>`;
      refs.stageList.appendChild(row);
    });
  }

  function buildRingRow(count) {
    if (!refs.ringRow) return;
    refs.ringRow.innerHTML = "";
    for (let i = 0; i < count; i++) {
      const dot = el("div", "bf-ring-dot", String(i + 1));
      refs.ringRow.appendChild(dot);
    }
  }

  function markRing(i, cls) {
    if (!refs.ringRow) return;
    const dot = refs.ringRow.children[i];
    if (dot) { dot.classList.add(cls); }
  }

  function setDonut(pct) {
    if (!refs.donut) return;
    refs.donut.style.setProperty("--bf-progress", (pct * 3.6).toFixed(1));
    if (refs.donutLabel) refs.donutLabel.textContent = Math.round(pct) + "%";
  }

  function clockTick() {
    const d = new Date();
    if (refs.date) refs.date.textContent = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    if (refs.time) refs.time.textContent = d.toLocaleTimeString();
  }

  // ── MAIN FLOW ───────────────────────────────────────────────────
  function run(opts, done) {
    build();
    const root = $("briefing-screen");
    if (!root) { done(); return; }

    const user      = (opts && opts.user) || (window.state && window.state.user) || "guest";
    const userTitle = (opts && opts.userTitle) || (window.state && window.state.userTitle) || "Sir";

    document.querySelectorAll(".screen.active").forEach(s => s.classList.remove("active"));
    const intro = $("intro-screen"); if (intro) intro.classList.remove("active");
    root.classList.add("active");

    if (refs.user) refs.user.textContent = user || "GUEST";
    clockTick();
    const clockTimer = setInterval(clockTick, 1000);

    Globe.start();

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearInterval(clockTimer);
      window.speechSynthesis && window.speechSynthesis.cancel();
      root.classList.remove("active");
      done();
    }

    // Skip control — always available
    let skipBtn = $("bf-skip-btn");
    if (!skipBtn) {
      skipBtn = el("button", "bf-skip-btn", "SKIP →");
      skipBtn.id = "bf-skip-btn";
      document.body.appendChild(skipBtn);
    }
    skipBtn.style.display = "block";
    skipBtn.onclick = finish;

    const STAGES_ASK   = ["SYNCING SCHEDULE", "AWAITING TASK", "BUILDING BRIEFING", "DELIVERING BRIEFING", "HANDOFF"];
    const STAGES_READY = ["SYNCING SCHEDULE", "BUILDING BRIEFING", "DELIVERING BRIEFING", "HANDOFF"];

    setEyebrow("SYNCING TODAY'S SCHEDULE…");
    buildStageList(STAGES_ASK, 0);
    typeLine("Checking whether today's task has already been set…");

    fetch(`/api/briefing/${encodeURIComponent(user)}`)
      .then(r => r.json())
      .catch(() => ({ briefing: null }))
      .then(data => {
        const existing = data && data.briefing;
        if (existing && existing.steps && existing.steps.length) {
          buildStageList(STAGES_READY, 1);
          deliverBriefing(existing, user, userTitle, STAGES_READY, finish, /*alreadyGreeted*/true);
        } else {
          buildStageList(STAGES_ASK, 1);
          askForTask(user, userTitle, STAGES_ASK, finish);
        }
      });
  }

  function askForTask(user, userTitle, stages, finish) {
    setEyebrow("AWAITING INPUT");
    typeLine("No task on file for today.", () => {
      refs.textwrap.innerHTML = `
        <div class="bf-eyebrow">AWAITING INPUT</div>
        <div class="bf-ask-wrap">
          <div class="bf-ask-question" id="bf-ask-question">Hey${window.state && window.state.user ? " " + window.state.user : ""}, what is going to be your task today?</div>
          <div class="bf-ask-input-row">
            <span class="bf-prefix">▶</span>
            <input type="text" id="bf-task-input" placeholder="e.g. I want to start a video about Jarvis…" autocomplete="off" spellcheck="false"/>
            <button class="bf-ask-submit" id="bf-task-submit">SET TASK</button>
          </div>
          <div class="bf-ask-hint">Whatever you say becomes today's briefing — say it however feels natural.</div>
        </div>
      `;
      // refs.eyebrow got replaced above; re-grab it
      refs.eyebrow = $("bf-eyebrow") || refs.eyebrow;

      const input  = $("bf-task-input");
      const submit = $("bf-task-submit");
      if (input) setTimeout(() => input.focus(), 50);

      function submitTask() {
        const task = (input && input.value || "").trim();
        if (!task) { if (input) input.focus(); return; }
        submit.disabled = true;
        submit.textContent = "THINKING…";
        buildStageList(stages, 2);
        setEyebrow("BUILDING BRIEFING");
        refs.textwrap.innerHTML = `
          <div class="bf-eyebrow" id="bf-eyebrow">BUILDING BRIEFING</div>
          <div class="bf-line" id="bf-line"><span class="bf-cursor"></span></div>
          <div class="bf-steps-readout" id="bf-steps-readout"></div>
        `;
        refs.eyebrow = $("bf-eyebrow");
        refs.line = $("bf-line");
        refs.stepsReadout = $("bf-steps-readout");
        typeLine("Breaking that down into a clear plan…");

        fetch("/api/briefing", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ user, userTitle, task }),
        })
          .then(r => r.json())
          .then(data => {
            const entry = data && data.briefing;
            if (!entry) throw new Error("no briefing returned");
            buildStageList(stages, 3);
            deliverBriefing(entry, user, userTitle, stages, finish, false);
          })
          .catch(() => {
            // Offline fallback so the flow never gets stuck
            const entry = { task, headline: task, steps: [task] };
            buildStageList(stages, 3);
            deliverBriefing(entry, user, userTitle, stages, finish, false);
          });
      }

      if (submit) submit.onclick = submitTask;
      if (input) input.addEventListener("keydown", e => { if (e.key === "Enter") submitTask(); });
    });
  }

  function ordinal(n) {
    const words = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth"];
    return words[n] || `Step ${n + 1}`;
  }

  function deliverBriefing(entry, user, userTitle, stages, finish, alreadyGreeted) {
    setEyebrow("DELIVERING BRIEFING");
    const steps = entry.steps || [];
    refs.stat_objective_set = true;
    if (refs.statObjective) refs.statObjective.textContent = entry.headline || entry.task || "—";
    if (refs.statCount) refs.statCount.textContent = `${steps.length} STEP${steps.length === 1 ? "" : "S"}`;
    buildRingRow(steps.length || 1);
    setDonut(0);

    refs.textwrap.innerHTML = `
      <div class="bf-eyebrow" id="bf-eyebrow">DELIVERING BRIEFING</div>
      <div class="bf-line" id="bf-line"><span class="bf-cursor"></span></div>
      <div class="bf-steps-readout" id="bf-steps-readout"></div>
    `;
    refs.eyebrow = $("bf-eyebrow");
    refs.line = $("bf-line");
    refs.stepsReadout = $("bf-steps-readout");

    const greetName = user && user !== "guest" ? `, ${user}` : "";
    const opener = `Hey${greetName}, here's today's daily briefing.`;
    const closer = `That's the plan, ${userTitle}. Handing off to the main interface now.`;

    const spokenParts = [opener];
    steps.forEach((s, i) => spokenParts.push(`${ordinal(i)}, ${s}.`));
    spokenParts.push(closer);
    const fullSpeech = spokenParts.join(" ");

    if (refs.eqWrap) refs.eqWrap.classList.add("speaking");

    typeLine(opener, () => {
      revealSteps(0, steps, () => {
        buildStageList(stages, stages.length - 1);
        setEyebrow("HANDOFF");
        typeLine(closer, () => {
          setTimeout(() => {
            if (refs.eqWrap) refs.eqWrap.classList.remove("speaking");
            finish();
          }, 900);
        });
      });
    });

    if (typeof window.speak === "function") {
      try { window.speak(fullSpeech, () => {}); } catch (e) { /* visuals still proceed on their own timer */ }
    }
  }

  function revealSteps(i, steps, done) {
    if (i >= steps.length) { setDonut(100); done(); return; }
    const row = el("div", "bf-step-row active");
    row.innerHTML = `<span class="bf-step-num">${String(i + 1).padStart(2, "0")}</span><span>${escapeHtml(steps[i])}</span>`;
    refs.stepsReadout.appendChild(row);
    markRing(i, "active");
    setDonut(((i + 1) / steps.length) * 100);

    const dwell = Math.max(1100, Math.min(3200, steps[i].length * 55));
    setTimeout(() => {
      markRing(i, "done");
      row.classList.remove("active");
      revealSteps(i + 1, steps, done);
    }, dwell);
  }

  function reset(user) {
    const u = user || (window.state && window.state.user) || "guest";
    return fetch("/api/briefing/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: u }),
    }).then(() => location.reload());
  }

  window.JarvisBriefing = { run, reset };
})();
