// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Live HUD Panels v2.0
// Injects left & right sidebars + status ticker into main screen
// Drop in public/ and add <script src="hud-panels.js"></script>
// AFTER jarvis.js so it can read window.state
// ═══════════════════════════════════════════════════════════════

window.JarvisHUD = (function () {

  // ── HELPERS ────────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls)  e.className   = cls;
    if (html) e.innerHTML   = html;
    return e;
  }

  function fmtTime() {
    return new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  }
  function fmtDate() {
    return new Date().toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' });
  }
  function fmtUptime(startMs) {
    const s = Math.floor((Date.now() - startMs) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  }

  const sessionStart = Date.now();
  let   tickCount    = 0;
  let   msgCount     = 0;
  let   lastMoodClass = '';

  // ── BUILD LEFT PANEL ───────────────────────────────────────
  function buildLeft(parent) {
    // Clock block
    const clockBlock = el('div', 'hud-panel-block');
    clockBlock.innerHTML = `
      <div class="hud-panel-label">LOCAL TIME</div>
      <div class="hud-panel-value" id="hud-clock">--:--:--</div>
      <div class="hud-panel-sub"  id="hud-date">--- -- ---</div>`;
    parent.appendChild(clockBlock);

    // Session uptime block
    const uptimeBlock = el('div', 'hud-panel-block');
    uptimeBlock.innerHTML = `
      <div class="hud-panel-label">SESSION UPTIME</div>
      <div class="hud-panel-value" id="hud-uptime">00:00:00</div>
      <div class="hud-uptime-bar"><div class="hud-uptime-fill" id="hud-uptime-fill" style="width:0%"></div></div>`;
    parent.appendChild(uptimeBlock);

    // Neural engine / interactions
    const interBlock = el('div', 'hud-panel-block');
    interBlock.innerHTML = `
      <div class="hud-panel-label">NEURAL ENGINE</div>
      <div class="hud-panel-value" id="hud-interactions">0</div>
      <div class="hud-panel-sub">INTERACTIONS</div>
      <div class="hud-mini-bars" id="hud-activity-bars">
        ${Array.from({length: 10}, (_,i) => `<div class="hud-mini-bar" id="hud-bar-${i}"></div>`).join('')}
      </div>`;
    parent.appendChild(interBlock);

    // Memory count
    const memBlock = el('div', 'hud-panel-block');
    memBlock.innerHTML = `
      <div class="hud-panel-label">MEMORY BANK</div>
      <div class="hud-mem-badge"><span class="hud-mem-dot"></span><span id="hud-mem-count">0 STORED</span></div>
      <div class="hud-panel-sub" id="hud-mem-sub">LONG-TERM FACTS</div>`;
    parent.appendChild(memBlock);
  }

  // ── BUILD RIGHT PANEL ──────────────────────────────────────
  function buildRight(parent) {
    // Emotional state
    const moodBlock = el('div', 'hud-panel-block');
    moodBlock.innerHTML = `
      <div class="hud-panel-label">EMOTIONAL STATE</div>
      <div class="hud-panel-value mood-val" id="hud-mood-val">● NEUTRAL</div>
      <div class="hud-panel-sub"  id="hud-mood-score">SCORE: 0</div>`;
    parent.appendChild(moodBlock);

    // System status
    const sysBlock = el('div', 'hud-panel-block');
    sysBlock.innerHTML = `
      <div class="hud-panel-label">SYSTEM STATUS</div>
      <div class="hud-panel-value" id="hud-status-val" style="font-size:0.85rem">STANDBY</div>
      <div class="hud-panel-sub"  id="hud-phase">PHASE: IDLE</div>`;
    parent.appendChild(sysBlock);

    // Listening indicator with animated bars
    const micBlock = el('div', 'hud-panel-block');
    micBlock.innerHTML = `
      <div class="hud-panel-label">AUDIO INPUT</div>
      <div class="hud-panel-value" id="hud-mic-val" style="font-size:0.78rem;color:var(--text-dim)">INACTIVE</div>
      <div class="voice-bars" id="hud-mic-bars" style="margin-top:6px;height:18px">
        <span style="height:4px"></span><span style="height:4px"></span>
        <span style="height:4px"></span><span style="height:4px"></span>
        <span style="height:4px"></span>
      </div>`;
    parent.appendChild(micBlock);

    // Authorized user
    const userBlock = el('div', 'hud-panel-block');
    userBlock.innerHTML = `
      <div class="hud-panel-label">AUTHORIZED USER</div>
      <div class="hud-panel-value" id="hud-user-val" style="font-size:0.78rem">—</div>
      <div class="hud-panel-sub"  id="hud-user-title">—</div>`;
    parent.appendChild(userBlock);
  }

  // ── STATUS TICKER ──────────────────────────────────────────
  const TICKER_ITEMS = [
    { text: 'ALL SYSTEMS NOMINAL', cls: 'blue' },
    { text: 'COGNITIVE ENGINE ACTIVE', cls: '' },
    { text: 'FACIAL RECOGNITION ONLINE', cls: '' },
    { text: 'ROLLING BUFFER: 65s', cls: '' },
    { text: 'SEMANTIC NLP: ENABLED', cls: 'blue' },
    { text: 'MEMORY BANK: PERSISTENT', cls: '' },
    { text: 'INTEGRATIONS: WEATHER · SPOTIFY · GMAIL · CALENDAR', cls: '' },
    { text: 'OCR ENGINE: LOADED', cls: 'blue' },
    { text: 'ZERO PRESET RESPONSES', cls: '' },
    { text: 'PROACTIVE OBSERVER: ACTIVE', cls: '' },
    { text: 'ENCRYPTION: AES-256', cls: 'blue' },
    { text: 'LINK BANK: LOADED', cls: '' },
  ];

  function buildTicker() {
    const existing = $('status-ticker');
    if (existing) return;

    const ticker = el('div', '', '');
    ticker.id = 'status-ticker';

    const track = el('div', 'ticker-track');
    // Duplicate for seamless loop
    const allItems = [...TICKER_ITEMS, ...TICKER_ITEMS];
    allItems.forEach(item => {
      const span = el('span', `ticker-item ${item.cls}`, item.text);
      track.appendChild(span);
      const sep = el('span', 'ticker-item', '·');
      sep.style.opacity = '0.3';
      track.appendChild(sep);
    });

    ticker.appendChild(track);
    document.body.appendChild(ticker);
  }

  // ── INJECT CANVASES & WAVEFORM ─────────────────────────────
  function injectCanvases() {
    if (!$('particle-canvas')) {
      const pc = document.createElement('canvas');
      pc.id = 'particle-canvas';
      document.body.insertBefore(pc, document.body.firstChild);
    }
    if (!$('waveform-canvas')) {
      const wc = document.createElement('canvas');
      wc.id     = 'waveform-canvas';
      wc.width  = 500;
      wc.height = 52;
      document.body.appendChild(wc);
    }
  }

  // ── UPGRADE CAMERA PANEL ────────────────────────────────────
  function upgradeCamera() {
    const feed = $('camera-feed');
    if (!feed) return;
    const panel = $('camera-panel');
    if (!panel) return;

    // Wrap feed in a relative container if not already
    let wrap = panel.querySelector('.camera-feed-wrap');
    if (!wrap) {
      wrap = el('div', 'camera-feed-wrap');
      feed.parentNode.insertBefore(wrap, feed);
      wrap.appendChild(feed);

      // Corner brackets
      ['tl','tr','bl','br'].forEach(pos => {
        const b = el('div', `cam-bracket ${pos}`);
        wrap.appendChild(b);
      });

      // Scan line
      const scan = el('div', 'cam-scan');
      wrap.appendChild(scan);
    }
  }

  // ── INJECT CORNER PIPS ─────────────────────────────────────
  function upgradeCorners() {
    document.querySelectorAll('.corner').forEach(c => {
      if (!c.querySelector('.pip')) {
        const pip = el('div', 'pip');
        c.appendChild(pip);
      }
    });
  }

  // ── BUILD FULL HUD ─────────────────────────────────────────
  function build() {
    const main = $('main-screen');
    if (!main) return;

    // Remove old hud-top side blocks (we'll use panel sidebars instead)
    // But keep the orb / center col
    const oldLeft  = main.querySelector('.hud-block:not(.right)');
    const oldRight = main.querySelector('.hud-block.right');
    if (oldLeft)  oldLeft.remove();
    if (oldRight) oldRight.remove();

    // Inject left panel
    if (!$('hud-left')) {
      const left = el('div', 'hud-panel left');
      left.id = 'hud-left';
      buildLeft(left);
      main.appendChild(left);
    }

    // Inject right panel
    if (!$('hud-right')) {
      const right = el('div', 'hud-panel right');
      right.id = 'hud-right';
      buildRight(right);
      main.appendChild(right);
    }

    buildTicker();
    injectCanvases();
    upgradeCamera();
    upgradeCorners();

    // Init visuals if available
    if (window.JarvisVisuals) window.JarvisVisuals.init();
  }

  // ── TICK — update all live values ─────────────────────────
  function tick() {
    tickCount++;
    const s = window.state;

    // Clock
    const clockEl = $('hud-clock');
    if (clockEl) clockEl.textContent = fmtTime();
    const dateEl  = $('hud-date');
    if (dateEl)   dateEl.textContent = fmtDate();

    // Uptime
    const uptimeEl   = $('hud-uptime');
    const uptimeFill = $('hud-uptime-fill');
    if (uptimeEl) uptimeEl.textContent = fmtUptime(sessionStart);
    if (uptimeFill) {
      // Fill to 100% over 1 hour
      const pct = Math.min(100, (Date.now() - sessionStart) / 3600000 * 100);
      uptimeFill.style.width = pct + '%';
    }

    // Interactions
    const interEl = $('hud-interactions');
    if (interEl && s) interEl.textContent = s.interactionCount || 0;

    // Activity bars — mini history
    if (s) {
      const barIdx = tickCount % 10;
      const bar    = $('hud-bar-' + barIdx);
      if (bar) {
        const level = Math.min(100, ((Date.now() - (s.lastInteraction || Date.now())) < 5000 ? 70 + Math.random()*30 : Math.random()*20));
        bar.style.height      = level + '%';
        bar.style.background  = level > 40 ? 'var(--blue)' : 'rgba(0,200,255,0.15)';
        bar.style.boxShadow   = level > 40 ? '0 0 4px var(--blue-glow)' : 'none';
        const classes = bar.className.replace(' active', '');
        bar.className = level > 40 ? classes + ' active' : classes;
      }
    }

    // Memories
    const memEl  = $('hud-mem-count');
    const memSub = $('hud-mem-sub');
    if (memEl && s && s.memories) {
      const n = s.memories.length;
      memEl.textContent = `${n} STORED`;
      if (memSub) memSub.textContent = n === 0 ? 'NO FACTS YET' : `${n} LONG-TERM FACT${n > 1 ? 'S' : ''}`;
    }

    // Mood
    const moodVal   = $('hud-mood-val');
    const moodScore = $('hud-mood-score');
    if (moodVal && s) {
      const mood = s.mood || 'neutral';
      const icons = { pleased:'●', excited:'⚡', curious:'◈', concerned:'▲', bored:'◌', tired:'◯', neutral:'●' };
      const moodText = `${icons[mood] || '●'} ${mood.toUpperCase()}`;
      if (moodVal.textContent !== moodText) moodVal.textContent = moodText;

      const moodCls = 'hud-panel-value mood-val mood-' + mood;
      if (moodVal.className !== moodCls) moodVal.className = moodCls;
      if (moodScore) moodScore.textContent = `SCORE: ${s.moodScore || 0}`;
    }

    // Status / phase
    const statusVal = $('hud-status-val');
    const phaseEl   = $('hud-phase');
    if (statusVal && s) {
      const labels = { idle:'STANDBY', chatting:'ACTIVE', listening:'LISTENING', thinking:'PROCESSING', speaking:'SPEAKING' };
      statusVal.textContent = labels[s.phase] || 'STANDBY';
      if (phaseEl) phaseEl.textContent = `PHASE: ${(s.phase || 'idle').toUpperCase()}`;
    }

    // Mic
    const micVal  = $('hud-mic-val');
    const micBars = $('hud-mic-bars');
    if (micVal && s) {
      const active = s.isListening;
      micVal.textContent  = active ? 'ACTIVE' : 'INACTIVE';
      micVal.style.color  = active ? 'var(--blue)' : 'var(--text-dim)';
      if (micBars) micBars.style.opacity = active ? '1' : '0.2';
    }

    // User
    const userVal   = $('hud-user-val');
    const userTitle = $('hud-user-title');
    if (userVal && s && s.user) {
      userVal.textContent   = s.user.toUpperCase();
      if (userTitle) userTitle.textContent = s.userTitle || '—';
    }

    // Sync orb mode with waveform
    if (window.JarvisVisuals && s) {
      const orbEl = $('orb');
      if (orbEl) {
        const cls = orbEl.className;
        if      (cls.includes('speaking'))  window.JarvisVisuals.setOrbMode('speaking');
        else if (cls.includes('listening')) window.JarvisVisuals.setOrbMode('listening');
        else if (cls.includes('thinking'))  window.JarvisVisuals.setOrbMode('idle');
        else                                window.JarvisVisuals.setOrbMode('idle');
      }
    }
  }

  // ── START ─────────────────────────────────────────────────
  function start() {
    // Wait for main screen to be active
    const check = setInterval(() => {
      if ($('main-screen')?.classList.contains('active')) {
        clearInterval(check);
        build();
        setInterval(tick, 1000);
      }
    }, 300);
  }

  return { start, build, tick };

})();

// Auto-start
window.addEventListener('load', () => {
  // Small delay so jarvis.js can set up state first
  setTimeout(() => JarvisHUD.start(), 800);
});
