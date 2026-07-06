// J.A.R.V.I.S Extension — Content Script
// Polls the JARVIS server for commands and injects/removes the HUD overlay

(function () {
  "use strict";

  const JARVIS_URL = "http://localhost:3000";
  const POLL_MS    = 2000;

  let hudContainer = null;
  let hudShadow    = null;
  let hudVisible   = false;
  let pollTimer    = null;
  let dragState    = null;
  let lastStatus   = {};

  // ── POLL SERVER ─────────────────────────────────────────────
  async function poll() {
    try {
      const res  = await fetch(`${JARVIS_URL}/api/extension/poll`, { cache: "no-store" });
      const data = await res.json();

      for (const cmd of (data.commands || [])) handleCommand(cmd);
      if (hudVisible && data.status) updateStatus(data.status);
      lastStatus = data.status || lastStatus;
    } catch {
      // JARVIS server offline — don't crash
    }
  }

  function startPolling() {
    poll();
    pollTimer = setInterval(poll, POLL_MS);
  }

  // ── COMMAND ROUTER ───────────────────────────────────────────
  function handleCommand(cmd) {
    switch (cmd.action) {
      case "SHOW_HUD":   injectHUD(cmd.data);  break;
      case "HIDE_HUD":   removeHUD();           break;
      case "TOGGLE_HUD": hudVisible ? removeHUD() : injectHUD(); break;
      case "UPDATE_STATUS": updateStatus(cmd.data); break;
      case "FLASH":      flashCorners(cmd.data?.color); break;
      case "ANNOUNCE":   announce(cmd.data?.text); break;
      case "OPEN_URLS":  chrome.runtime.sendMessage({ type: "OPEN_URLS", urls: cmd.data?.urls || [] }); break;
    }
  }

  // ── HUD CSS (injected into Shadow DOM) ───────────────────────
  const HUD_CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Share+Tech+Mono&display=swap');

    :host { all: initial; }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --blue:      #00c8ff;
      --blue-glow: rgba(0,200,255,0.35);
      --amber:     #ffaa00;
      --red:       #ff3333;
      --green:     #00ff88;
      --text-dim:  #3a6a88;
      --bg:        rgba(1,12,20,0.92);
      --mono:      'Share Tech Mono', monospace;
      --hud:       'Orbitron', monospace;
    }

    /* ── CORNER BRACKETS ── */
    .corner {
      position: fixed;
      width: 40px; height: 40px;
      pointer-events: none;
      z-index: 2147483646;
    }
    .corner::before, .corner::after {
      content: '';
      position: absolute;
      background: var(--blue);
      opacity: 0.7;
    }
    .corner::before { width: 100%; height: 1px; top: 0; }
    .corner::after  { width: 1px; height: 100%; top: 0; }
    .corner .pip {
      position: absolute;
      width: 4px; height: 4px;
      background: var(--blue);
      border-radius: 50%;
      top: -2px; left: -2px;
      box-shadow: 0 0 8px var(--blue), 0 0 20px var(--blue-glow);
      animation: pipPulse 3s ease-in-out infinite;
    }
    .corner.tl { top: 16px; left: 16px; }
    .corner.tr { top: 16px; right: 16px; transform: scaleX(-1); }
    .corner.bl { bottom: 16px; left: 16px; transform: scaleY(-1); }
    .corner.br { bottom: 16px; right: 16px; transform: scale(-1); }
    @keyframes pipPulse {
      0%,100% { opacity:1; box-shadow: 0 0 8px var(--blue), 0 0 20px var(--blue-glow); }
      50%     { opacity:0.3; box-shadow: 0 0 3px var(--blue); }
    }

    /* ── STATUS TICKER ── */
    .ticker {
      position: fixed;
      bottom: 0; left: 0; right: 0;
      height: 20px;
      background: linear-gradient(90deg, rgba(1,12,20,0.9), rgba(2,15,30,0.95), rgba(1,12,20,0.9));
      border-top: 1px solid rgba(0,200,255,0.1);
      z-index: 2147483646;
      overflow: hidden;
      display: flex;
      align-items: center;
      pointer-events: none;
    }
    .ticker::before {
      content: '▶';
      font-size: 0.45rem;
      color: var(--blue);
      padding: 0 8px;
      flex-shrink: 0;
      opacity: 0.5;
      font-family: var(--mono);
    }
    .ticker-track {
      display: flex;
      white-space: nowrap;
      animation: tickerScroll 40s linear infinite;
      font-family: var(--mono);
      font-size: 0.52rem;
      color: var(--text-dim);
      letter-spacing: 0.14em;
    }
    .ticker-item { padding: 0 30px; }
    .ticker-item.blue { color: var(--blue); opacity: 0.7; }
    @keyframes tickerScroll {
      from { transform: translateX(0); }
      to   { transform: translateX(-50%); }
    }

    /* ── FLOATING ORB ── */
    .orb-wrap {
      position: fixed;
      bottom: 40px; right: 24px;
      z-index: 2147483647;
      cursor: grab;
      user-select: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 4px;
    }
    .orb-wrap:active { cursor: grabbing; }
    .orb {
      position: relative;
      width: 52px; height: 52px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .orb-ring {
      position: absolute;
      border-radius: 50%;
      border: 1px solid rgba(0,200,255,0.25);
      transition: border-color 0.4s, box-shadow 0.4s;
    }
    .r1 { width: 52px; height: 52px; }
    .r2 { width: 36px; height: 36px; }
    .orb-core {
      width: 18px; height: 18px;
      border-radius: 50%;
      background: radial-gradient(circle at 35% 35%, rgba(0,200,255,0.75), rgba(0,80,140,0.5));
      box-shadow: 0 0 10px rgba(0,200,255,0.45);
      transition: box-shadow 0.4s;
    }
    .orb.listening .r1,
    .orb.listening .r2 { border-color: var(--blue); box-shadow: 0 0 14px var(--blue-glow); animation: spin 4s linear infinite; }
    .orb.listening .orb-core { box-shadow: 0 0 20px rgba(0,200,255,0.9); animation: pulse 0.9s ease-in-out infinite; }
    .orb.thinking .r1,
    .orb.thinking .r2 { border-color: var(--amber); animation: spin 2s linear infinite; }
    .orb.thinking .orb-core { background: radial-gradient(circle at 35% 35%, rgba(255,200,80,0.85), rgba(140,80,0,0.5)); box-shadow: 0 0 20px rgba(255,170,0,0.8); }
    .orb.speaking .r1,
    .orb.speaking .r2 { border-color: var(--green); box-shadow: 0 0 14px rgba(0,255,136,0.3); animation: spin 6s linear infinite; }
    .orb.speaking .orb-core { background: radial-gradient(circle at 35% 35%, rgba(0,255,136,0.85), rgba(0,100,60,0.5)); box-shadow: 0 0 20px rgba(0,255,136,0.8); animation: pulse 0.5s ease-in-out infinite; }
    @keyframes spin  { to { transform: rotate(360deg); } }
    @keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.2)} }

    .orb-label {
      font-family: var(--hud);
      font-size: 0.36rem;
      letter-spacing: 0.2em;
      color: var(--text-dim);
    }

    /* ── CLOSE BUTTON ── */
    .hud-close {
      position: fixed;
      top: 18px; right: 18px;
      z-index: 2147483647;
      width: 22px; height: 22px;
      background: rgba(0,200,255,0.07);
      border: 1px solid rgba(0,200,255,0.2);
      border-radius: 2px;
      color: var(--text-dim);
      font-size: 0.6rem;
      font-family: var(--mono);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: border-color 0.2s, color 0.2s;
    }
    .hud-close:hover { border-color: var(--blue); color: var(--blue); }

    /* ── STATUS BADGE (top left) ── */
    .status-badge {
      position: fixed;
      top: 18px; left: 18px;
      z-index: 2147483646;
      font-family: var(--hud);
      font-size: 0.42rem;
      letter-spacing: 0.22em;
      color: var(--text-dim);
      pointer-events: none;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .status-badge .sb-title { color: var(--blue); font-size: 0.55rem; font-weight: 700; }
    .status-badge .sb-phase { color: var(--text-dim); }
    .status-badge .sb-user  { color: rgba(0,200,255,0.45); }

    /* ── ANNOUNCE TOAST ── */
    .announce {
      position: fixed;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      z-index: 2147483647;
      background: rgba(1,12,20,0.96);
      border: 1px solid rgba(0,200,255,0.4);
      box-shadow: 0 0 40px rgba(0,200,255,0.18);
      border-radius: 3px;
      padding: 14px 28px;
      font-family: var(--mono);
      font-size: 0.9rem;
      color: var(--blue);
      letter-spacing: 0.1em;
      text-align: center;
      max-width: 480px;
      animation: fadeIn 0.25s ease;
      pointer-events: none;
    }
    @keyframes fadeIn { from { opacity: 0; transform: translate(-50%,-46%); } }

    /* ── FLASH ── */
    .flash-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483645;
      pointer-events: none;
      animation: flashAnim 0.4s ease forwards;
    }
    @keyframes flashAnim {
      0%   { opacity: 0.25; }
      100% { opacity: 0; }
    }

    /* ── SCANLINE ── */
    .scanline {
      position: fixed;
      left: 0; right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, rgba(0,200,255,0.08) 50%, transparent);
      animation: scan 10s linear infinite;
      pointer-events: none;
      z-index: 2147483644;
    }
    @keyframes scan { from { top: -2px; } to { top: 100vh; } }
  `;

  const TICKER_TEXT = [
    "J.A.R.V.I.S ACTIVE",
    "ALL SYSTEMS NOMINAL",
    "COGNITIVE ENGINE ONLINE",
    "SEMANTIC NLP ENABLED",
    "ZERO PRESET RESPONSES",
    "PROACTIVE OBSERVER ACTIVE",
    "MEMORY BANK PERSISTENT",
    "ENCRYPTION AES-256",
  ];

  function buildTickerHTML() {
    const items = [...TICKER_TEXT, ...TICKER_TEXT];
    return items.map((t, i) =>
      `<span class="ticker-item${i % 3 === 0 ? " blue" : ""}">${t}</span><span class="ticker-item" style="opacity:0.25">·</span>`
    ).join("");
  }

  const HUD_HTML = `
    <div class="scanline"></div>

    <div class="corner tl"><div class="pip"></div></div>
    <div class="corner tr"><div class="pip"></div></div>
    <div class="corner bl"><div class="pip"></div></div>
    <div class="corner br"><div class="pip"></div></div>

    <div class="status-badge" id="hud-status-badge">
      <span class="sb-title">J.A.R.V.I.S</span>
      <span class="sb-phase" id="hud-phase">STANDBY</span>
      <span class="sb-user"  id="hud-user"></span>
    </div>

    <div class="orb-wrap" id="hud-orb-wrap">
      <div class="orb" id="hud-orb">
        <div class="orb-ring r1"></div>
        <div class="orb-ring r2"></div>
        <div class="orb-core"></div>
      </div>
      <span class="orb-label" id="hud-orb-label">STANDBY</span>
    </div>

    <div class="hud-close" id="hud-close-btn">✕</div>

    <div class="ticker">
      <div class="ticker-track">${buildTickerHTML()}</div>
    </div>
  `;

  // ── INJECT HUD ───────────────────────────────────────────────
  function injectHUD() {
    if (hudVisible) return;

    hudContainer = document.createElement("div");
    hudContainer.id = "__jarvis_hud__";
    hudContainer.style.cssText = [
      "position:fixed",
      "top:0", "left:0",
      "width:0", "height:0",
      "z-index:2147483647",
      "pointer-events:none",
    ].join(";");

    hudShadow = hudContainer.attachShadow({ mode: "open" });
    hudShadow.innerHTML = `<style>${HUD_CSS}</style>${HUD_HTML}`;

    document.body.appendChild(hudContainer);
    hudVisible = true;

    // Close button
    const closeBtn = hudShadow.getElementById("hud-close-btn");
    if (closeBtn) {
      closeBtn.style.pointerEvents = "auto";
      closeBtn.addEventListener("click", () => removeHUD());
    }

    // Make orb draggable
    makeOrbDraggable();

    // Apply last known status
    if (lastStatus) updateStatus(lastStatus);
  }

  // ── REMOVE HUD ───────────────────────────────────────────────
  function removeHUD() {
    if (hudContainer) {
      hudContainer.remove();
      hudContainer = null;
      hudShadow = null;
    }
    hudVisible = false;
  }

  // ── UPDATE STATUS ────────────────────────────────────────────
  function updateStatus(status) {
    if (!hudShadow || !status) return;

    const orbEl    = hudShadow.getElementById("hud-orb");
    const labelEl  = hudShadow.getElementById("hud-orb-label");
    const phaseEl  = hudShadow.getElementById("hud-phase");
    const userEl   = hudShadow.getElementById("hud-user");

    const phase = status.phase || "idle";
    const labels = { idle:"STANDBY", chatting:"ACTIVE", listening:"LISTENING", thinking:"PROCESSING", speaking:"SPEAKING" };

    if (orbEl) {
      orbEl.className = "orb" + (phase !== "idle" && phase !== "chatting" ? ` ${phase}` : "");
    }
    if (labelEl) labelEl.textContent = labels[phase] || "STANDBY";
    if (phaseEl) phaseEl.textContent = labels[phase] || "STANDBY";
    if (userEl && status.user) userEl.textContent = `${status.user.toUpperCase()} / ${status.userTitle || ""}`;
  }

  // ── FLASH CORNERS ────────────────────────────────────────────
  function flashCorners(color = "#00c8ff") {
    if (!hudShadow) return;
    const flash = document.createElement("div");
    flash.className = "flash-overlay";
    flash.style.background = color;
    hudShadow.appendChild(flash);
    setTimeout(() => flash.remove(), 500);
  }

  // ── ANNOUNCE TEXT ────────────────────────────────────────────
  function announce(text) {
    if (!hudShadow || !text) return;
    const el = document.createElement("div");
    el.className = "announce";
    el.textContent = text;
    hudShadow.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  // ── DRAGGABLE ORB ────────────────────────────────────────────
  function makeOrbDraggable() {
    const wrap = hudShadow?.getElementById("hud-orb-wrap");
    if (!wrap) return;
    wrap.style.pointerEvents = "auto";

    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      dragState = {
        startX: e.clientX - rect.left,
        startY: e.clientY - rect.top,
      };
    });

    document.addEventListener("mousemove", (e) => {
      if (!dragState || !wrap) return;
      const x = e.clientX - dragState.startX;
      const y = e.clientY - dragState.startY;
      wrap.style.left   = `${x}px`;
      wrap.style.top    = `${y}px`;
      wrap.style.right  = "auto";
      wrap.style.bottom = "auto";
    });

    document.addEventListener("mouseup", () => { dragState = null; });
  }

  // ── BOOT ────────────────────────────────────────────────────
  startPolling();

})();
