// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — HOME DASHBOARD v1.0
// Glass "widget desktop" home screen. Purely additive: builds its
// own DOM, doesn't touch jarvis.js state. Shows itself once the
// existing #main-screen becomes active (i.e. login/intro is done),
// and hands off to the normal chat HUD when the orb is tapped.
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const DB_KEY_POS   = "jarvis_dash_widget_pos_v1";
  const DB_KEY_NOTES = "jarvis_dash_notes_v1";
  const DB_KEY_HIDDEN = "jarvis_dash_widget_hidden_v1"; // array of widget ids currently closed
  const DB_KEY_BG_META = "jarvis_dash_bg_meta_v1"; // {type:'image'|'video'|'none'}

  // ── canonical widget id list + spoken-name aliases, shared with
  //    jarvis.js via window.JarvisDashboard.resolveWidget() so "pull up
  //    the news widget" / "close weather widget" resolve to the right
  //    card regardless of phrasing ──
  const WIDGET_META = {
    "db-w-clock":   { label: "Clock",   aliases: ["clock", "time"] },
    "db-w-weather": { label: "Weather", aliases: ["weather"] },
    "db-w-todo":    { label: "To-Do",   aliases: ["todo", "to-do", "to do", "tasks", "task"] },
    "db-w-music":   { label: "Music",   aliases: ["music", "song", "player"] },
    "db-w-notes":   { label: "Notes",   aliases: ["notes", "note"] },
    "db-w-news":    { label: "News",    aliases: ["news", "headlines", "headline"] },
  };
  function resolveWidget(word) {
    if (!word) return null;
    const norm = String(word).toLowerCase().trim().replace(/\s+/g, " ");
    for (const id of Object.keys(WIDGET_META)) {
      if (WIDGET_META[id].aliases.includes(norm)) return id;
    }
    return null;
  }
  const IDB_NAME = "jarvis-dashboard";
  const IDB_STORE = "bg";

  // ── tiny IndexedDB helper (handles large video files that would
  //    blow past localStorage's ~5MB quota) ──
  function idbOpen() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbSet(key, val) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }
  async function idbGet(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readonly");
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbDel(key) {
    const db = await idbOpen();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  function $(id) { return document.getElementById(id); }

  // ── DEFAULT WIDGET LAYOUT (percent of viewport, top-left origin) ──
  const DEFAULT_LAYOUT = {
    "db-w-clock":   { x: 4,  y: 12 },
    "db-w-weather": { x: 78, y: 12 },
    "db-w-todo":    { x: 78, y: 30 },
    "db-w-music":   { x: 4,  y: 78 },
    "db-w-notes":   { x: 78, y: 62 },
    "db-w-news":    { x: 4,  y: 40 },
  };

  const WIDGETS_HTML = `
    <div class="db-widget db-widget-clock" id="db-w-clock" data-widget data-hand-drag="true">
      <div class="db-widget-close" data-close title="Close (say &quot;pull up the clock widget&quot; to bring it back)">✕</div>
      <div class="db-widget-label">TIME</div>
      <div class="db-time" id="db-time">--:--</div>
      <div class="db-date" id="db-date">—</div>
    </div>

    <div class="db-widget db-widget-weather" id="db-w-weather" data-widget data-hand-drag="true">
      <div class="db-widget-close" data-close title="Close (say &quot;pull up the weather widget&quot; to bring it back)">✕</div>
      <div class="db-widget-label">WEATHER</div>
      <div class="db-weather-main">
        <div class="db-temp" id="db-temp">--°</div>
        <div class="db-cond" id="db-cond">Loading…</div>
      </div>
      <div class="db-loc" id="db-loc">Locating…</div>
    </div>

    <div class="db-widget db-widget-todo" id="db-w-todo" data-widget data-hand-drag="true">
      <div class="db-widget-close" data-close title="Close (say &quot;pull up the to-do widget&quot; to bring it back)">✕</div>
      <div class="db-widget-label">TO-DO</div>
      <div class="db-todo-list" id="db-todo-list" data-hand-drag="true">
        <div class="db-todo-empty">Loading…</div>
      </div>
    </div>

    <div class="db-widget db-widget-music paused" id="db-w-music" data-widget data-hand-drag="true">
      <div class="db-widget-close" data-close title="Close (say &quot;pull up the music widget&quot; to bring it back)">✕</div>
      <div class="db-widget-label">MUSIC</div>
      <!-- Default placeholder shown until a track actually plays; the real
           now-playing card (cover art + controls, from music-widget.js) gets
           mounted into #db-music-embed at that point and this is hidden. -->
      <div class="db-music-placeholder" id="db-music-placeholder">
        <div class="db-music-track">Nothing playing</div>
        <div class="db-music-artist">Say "Jarvis, play something"</div>
        <div class="db-music-bars"><span></span><span></span><span></span><span></span><span></span></div>
      </div>
      <div class="db-music-embed" id="db-music-embed"></div>
    </div>

    <div class="db-widget db-widget-notes" id="db-w-notes" data-widget data-hand-drag="true">
      <div class="db-widget-close" data-close title="Close (say &quot;pull up the notes widget&quot; to bring it back)">✕</div>
      <div class="db-widget-label">NOTES</div>
      <textarea id="db-notes-area" placeholder="Jot something down…"></textarea>
    </div>

    <div class="db-widget db-widget-news" id="db-w-news" data-widget data-hand-drag="true">
      <div class="db-widget-close" data-close title="Close (say &quot;pull up the news widget&quot; to bring it back)">✕</div>
      <div class="db-widget-label">NEWS</div>
      <div class="db-news-list" id="db-news-list" data-hand-drag="true">
        <div class="db-news-empty">Loading…</div>
      </div>
    </div>
  `;

  const DASHBOARD_HTML = `
    <div id="db-bg-layer"></div>
    <div id="db-bg-video-tint"></div>
    <div id="db-bg-scrim"></div>

    <div id="db-top-row">
      <div id="db-search">
        <span>⌕</span>
        <input type="text" id="db-search-input" placeholder="Search or ask Jarvis anything…" />
      </div>
      <button class="db-icon-btn" id="db-settings-btn" title="Settings">⚙</button>
    </div>

    <div id="db-widget-layer">
      ${WIDGETS_HTML}
    </div>

    <div id="db-orb-launcher" title="Talk to Jarvis">
      <div class="db-orb-tip">TALK TO JARVIS</div>
      <div class="db-orb-mini-wrap">
        <div class="jr-orb">
          <div class="jr-core-glow"></div>
          <div class="jr-inner-ring">
            <div class="jr-title">JARVIS</div>
          </div>
          <svg class="jr-hud-svg" viewBox="0 0 400 400">
            <g class="jr-dot-ring">
              <circle cx="355.0" cy="200.0" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="351.6" cy="232.2" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="341.6" cy="263.0" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="325.4" cy="291.1" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="303.7" cy="315.2" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="277.5" cy="334.2" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="247.9" cy="347.4" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="216.2" cy="354.2" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="183.8" cy="354.2" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="152.1" cy="347.4" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="122.5" cy="334.2" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="96.3" cy="315.2" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="74.6" cy="291.1" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="58.4" cy="263.0" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="48.4" cy="232.2" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="45.0" cy="200.0" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="48.4" cy="167.8" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="58.4" cy="137.0" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="74.6" cy="108.9" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="96.3" cy="84.8" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="122.5" cy="65.8" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="152.1" cy="52.6" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="183.8" cy="45.8" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="216.2" cy="45.8" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="247.9" cy="52.6" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="277.5" cy="65.8" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="303.7" cy="84.8" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="325.4" cy="108.9" r="2.0" fill="#cfeeff" opacity="0.85"/>
              <circle cx="341.6" cy="137.0" r="1.6" fill="#cfeeff" opacity="0.5"/>
              <circle cx="351.6" cy="167.8" r="1.6" fill="#cfeeff" opacity="0.5"/>
            </g>
            <g class="jr-ticks">
              <line x1="311.7" y1="81.2" x2="324.5" y2="68.5" stroke="rgba(220,240,255,0.6)" stroke-width="1.6" stroke-linecap="round"/>
              <line x1="318.8" y1="88.3" x2="331.5" y2="75.5" stroke="rgba(220,240,255,0.6)" stroke-width="1.6" stroke-linecap="round"/>
              <line x1="311.7" y1="324.5" x2="324.5" y2="311.7" stroke="rgba(220,240,255,0.6)" stroke-width="1.6" stroke-linecap="round"/>
              <line x1="318.8" y1="331.5" x2="331.5" y2="318.8" stroke="rgba(220,240,255,0.6)" stroke-width="1.6" stroke-linecap="round"/>
              <line x1="68.5" y1="324.5" x2="81.2" y2="311.7" stroke="rgba(220,240,255,0.6)" stroke-width="1.6" stroke-linecap="round"/>
              <line x1="75.5" y1="331.5" x2="88.3" y2="318.8" stroke="rgba(220,240,255,0.6)" stroke-width="1.6" stroke-linecap="round"/>
              <line x1="68.5" y1="81.2" x2="81.2" y2="68.5" stroke="rgba(220,240,255,0.6)" stroke-width="1.6" stroke-linecap="round"/>
              <line x1="75.5" y1="88.3" x2="88.3" y2="75.5" stroke="rgba(220,240,255,0.6)" stroke-width="1.6" stroke-linecap="round"/>
            </g>
            <circle class="jr-arc-white" cx="200" cy="200" r="130"
                    fill="none" stroke="rgba(230,245,255,0.55)" stroke-width="1.6"
                    stroke-linecap="round" stroke-dasharray="360 456"/>
            <circle class="jr-arc-blue" cx="200" cy="200" r="115"
                    fill="none" stroke="rgba(58,134,255,0.85)" stroke-width="3"
                    stroke-linecap="round" stroke-dasharray="262 460"/>
          </svg>
        </div>
      </div>
    </div>

    <div id="db-settings-overlay">
      <div id="db-settings-panel">
        <div class="db-settings-close" id="db-settings-close">✕</div>
        <div class="db-settings-title">⬡ DASHBOARD SETTINGS</div>

        <div class="db-settings-row">
          <label>Language</label>
          <select class="db-lang-select" id="db-lang-select">
            <option>English</option>
            <option>Español</option>
            <option>Français</option>
            <option>Deutsch</option>
          </select>
        </div>

        <div class="db-settings-divider"></div>

        <div class="db-settings-row">
          <label>Background</label>
          <button class="db-btn" id="db-upload-photo-btn">🖼 Upload Photo</button>
          <button class="db-btn" id="db-upload-video-btn">🎬 Upload Video (live wallpaper)</button>
          <input type="file" id="db-bg-file-input" accept="image/*,video/*" />
          <button class="db-btn db-btn-primary" id="db-apply-bg-btn">Apply</button>
          <button class="db-btn db-btn-ghost db-btn-danger" id="db-reset-bg-btn">Reset to Default</button>
        </div>

        <div class="db-settings-divider"></div>

        <div class="db-settings-row">
          <label>Microphone</label>
          <select class="db-lang-select" id="db-mic-select">
            <option value="">Loading devices…</option>
          </select>
        </div>

        <div class="db-settings-divider"></div>

        <div class="db-settings-toggle-row">
          <span>Motion effects</span>
          <div class="db-switch on" id="db-motion-switch"></div>
        </div>

        <div class="db-settings-divider"></div>

        <div class="db-settings-toggle-row">
          <span>Sleep Mode <small style="opacity:.55;font-size:.7em;">(now-playing screensaver when you tab back in)</small></span>
          <div class="db-switch on" id="db-sleepmode-switch"></div>
        </div>

        <div class="db-settings-divider"></div>

        <div class="db-settings-row db-settings-row-col">
          <label>Widgets</label>
          <div id="db-widget-toggle-list"></div>
        </div>

        <div class="db-settings-divider"></div>

        <button class="db-btn" id="db-reset-layout-btn">↺ Reset Layout</button>
        <button class="db-btn db-btn-primary" id="db-settings-done-btn" style="margin-top:14px">Done</button>
      </div>
    </div>
  `;

  let pendingBgFile = null;
  let pendingBgKind = null;
  let dashRoot = null;

  function buildDashboard() {
    const wrap = document.createElement("div");
    wrap.id = "jarvis-dashboard";
    wrap.className = "db-hidden";
    wrap.innerHTML = DASHBOARD_HTML;
    document.body.appendChild(wrap);

    const homeBtn = document.createElement("button");
    homeBtn.id = "db-home-btn";
    homeBtn.title = "Back to Home";
    homeBtn.textContent = "⌂";
    document.body.appendChild(homeBtn);

    dashRoot = wrap;
    return wrap;
  }

  // Bring the widget desktop back to the front (used by the orb's own
  // home button, and by the "pull up X widget" voice/text command so
  // the widget you just asked for is actually visible).
  function revealDashboard() {
    if (!dashRoot) return;
    dashRoot.classList.remove("db-hidden");
    $("db-home-btn")?.classList.remove("db-show");
  }
  function hideDashboardToHUD() {
    // Disabled: the widget dashboard (image 1 layout) is now the
    // permanent main screen. The old chat-HUD/orb screen is no longer
    // shown, so this is intentionally a no-op — the dashboard just
    // stays in front, always.
    return;
  }

  // ── CLOCK ──
  function tickClock() {
    const now = new Date();
    const timeEl = $("db-time");
    const dateEl = $("db-date");
    if (timeEl) {
      timeEl.textContent = now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    }
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
    }
  }

  // ── WEATHER (wired to existing /api/weather endpoint) ──
  async function loadWeather() {
    const tempEl = $("db-temp"), condEl = $("db-cond"), locEl = $("db-loc");
    try {
      const res = await fetch("/api/weather", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "weather" }),
      });
      const data = await res.json();
      const text = data.reply || data.text || data.message || "";
      if (text) {
        const tempMatch = text.match(/-?\d+°?\s?[FC]?/);
        if (tempEl) tempEl.textContent = tempMatch ? tempMatch[0].replace(/\s/g, "") : "—";
        if (condEl) condEl.textContent = text.length > 60 ? text.slice(0, 60) + "…" : text;
      } else {
        if (condEl) condEl.textContent = "Unavailable";
      }
      if (locEl) locEl.textContent = data.location || "";
    } catch (e) {
      if (condEl) condEl.textContent = "Offline";
      if (locEl) locEl.textContent = "";
    }
  }

  // ── TO-DO (wired to existing /api/reminders endpoint) ──
  async function loadTodos() {
    const list = $("db-todo-list");
    if (!list) return;
    try {
      const res = await fetch("/api/reminders");
      const data = await res.json();
      const items = data.items || [];
      if (!items.length) {
        list.innerHTML = `<div class="db-todo-empty">Nothing on the list</div>`;
        return;
      }
      list.innerHTML = items.slice(0, 6).map(it => {
        const label = it.text || it.title || it.label || "Reminder";
        return `<div class="db-todo-item"><span class="db-todo-dot"></span>${escapeHtml(label)}</div>`;
      }).join("");
    } catch (e) {
      list.innerHTML = `<div class="db-todo-empty">Couldn't load</div>`;
    }
  }

  // ── MUSIC (the real now-playing card from music-widget.js mounts itself
  //    into #db-music-embed and owns its own title/artist/art/controls —
  //    this just shows/hides the "nothing playing" placeholder behind it
  //    and keeps the .paused state in sync for the CSS. /api/spotify is a
  //    fallback poll for setups that do have Spotify configured but where
  //    the embedded YouTube player hasn't reported anything yet) ──
  let musicWidgetHasData = false; // true once we've heard from the real player at least once
  function applyMusicState(title, artist, playing) {
    const widget = $("db-w-music"), placeholder = $("db-music-placeholder");
    const hasTrack = !!title;
    widget?.classList.toggle("paused", !playing);
    widget?.classList.toggle("has-track", hasTrack);
    if (placeholder) placeholder.style.display = hasTrack ? "none" : "";
  }
  window.addEventListener("jarvis:music-changed", (e) => {
    musicWidgetHasData = true;
    const { title, artist, playing } = e.detail || {};
    applyMusicState(title, artist, playing);
  });

  async function loadMusic() {
    if (musicWidgetHasData) return; // the real player is already reporting state directly
    const widget = $("db-w-music");
    try {
      const res = await fetch("/api/spotify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: "now playing" }),
      });
      const data = await res.json();
      if (data.track || data.title) {
        applyMusicState(data.track || data.title, data.artist, true);
      } else {
        widget?.classList.add("paused");
      }
    } catch (e) {
      widget?.classList.add("paused");
    }
  }

  // ── NEWS (wired to existing /api/news endpoint) ──
  async function loadNews() {
    const list = $("db-news-list");
    if (!list) return;
    try {
      const res = await fetch("/api/news");
      const data = await res.json();
      const items = data.articles || data.items || [];
      if (!items.length) {
        list.innerHTML = `<div class="db-news-empty">Nothing new</div>`;
        return;
      }
      list.innerHTML = items.slice(0, 5).map(it => {
        const label = it.title || it.headline || "Untitled";
        return `<div class="db-news-item">${escapeHtml(label)}</div>`;
      }).join("");
    } catch (e) {
      list.innerHTML = `<div class="db-news-empty">Couldn't load</div>`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  // ── NOTES (local persistence) ──
  function initNotes() {
    const area = $("db-notes-area");
    if (!area) return;
    area.value = localStorage.getItem(DB_KEY_NOTES) || "";
    area.addEventListener("input", () => {
      localStorage.setItem(DB_KEY_NOTES, area.value);
    });
    area.addEventListener("pointerdown", e => e.stopPropagation());
  }

  // ── WIDGET DRAGGING (always on) ──
  function loadLayout() {
    try { return JSON.parse(localStorage.getItem(DB_KEY_POS)) || {}; }
    catch (e) { return {}; }
  }
  function saveLayout(layout) {
    localStorage.setItem(DB_KEY_POS, JSON.stringify(layout));
  }

  function applyLayout() {
    const layout = Object.assign({}, DEFAULT_LAYOUT, loadLayout());
    document.querySelectorAll("#db-widget-layer [data-widget]").forEach(el => {
      const pos = layout[el.id] || DEFAULT_LAYOUT[el.id] || { x: 10, y: 10 };
      el.style.left = pos.x + "vw";
      el.style.top = pos.y + "vh";
    });
  }

  function resetLayout() {
    localStorage.removeItem(DB_KEY_POS);
    applyLayout();
  }

  // ── WIDGET CLOSE / RE-OPEN ──
  // Closed widgets are hidden (not removed from the DOM, so their
  // internal state — notes text, music polling, etc. — isn't lost)
  // and the set persists across reloads. Bring one back either via
  // the ✕ button's undo path (settings panel toggle) or by asking
  // Jarvis: "pull up the news widget" / "close the weather widget".
  function loadHidden() {
    try { return new Set(JSON.parse(localStorage.getItem(DB_KEY_HIDDEN)) || []); }
    catch (e) { return new Set(); }
  }
  function saveHidden(set) {
    localStorage.setItem(DB_KEY_HIDDEN, JSON.stringify(Array.from(set)));
  }
  let hiddenWidgets = loadHidden();

  function applyHiddenState() {
    Object.keys(WIDGET_META).forEach(id => {
      const el = $(id);
      if (!el) return;
      el.classList.toggle("db-widget-closed", hiddenWidgets.has(id));
    });
    syncWidgetToggleList();
  }
  function hideWidgetById(id) {
    if (!WIDGET_META[id]) return false;
    hiddenWidgets.add(id);
    saveHidden(hiddenWidgets);
    applyHiddenState();
    return true;
  }
  function showWidgetById(id) {
    if (!WIDGET_META[id]) return false;
    hiddenWidgets.delete(id);
    saveHidden(hiddenWidgets);
    applyHiddenState();
    revealDashboard();
    return true;
  }
  function toggleWidgetById(id) {
    return hiddenWidgets.has(id) ? showWidgetById(id) : hideWidgetById(id);
  }

  function initCloseButtons() {
    document.querySelectorAll("#db-widget-layer [data-close]").forEach(btn => {
      btn.addEventListener("pointerdown", e => e.stopPropagation()); // don't start a drag
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const widget = btn.closest("[data-widget]");
        if (widget) hideWidgetById(widget.id);
      });
    });
  }

  // ── Widgets list inside settings panel — lets you re-open a closed
  //    widget with a tap instead of needing to ask Jarvis for it ──
  function syncWidgetToggleList() {
    const host = $("db-widget-toggle-list");
    if (!host) return;
    host.innerHTML = Object.keys(WIDGET_META).map(id => {
      const on = !hiddenWidgets.has(id);
      return `
        <div class="db-settings-toggle-row db-widget-toggle-row">
          <span>${WIDGET_META[id].label}</span>
          <div class="db-switch ${on ? "on" : ""}" data-widget-toggle="${id}"></div>
        </div>`;
    }).join("");
    host.querySelectorAll("[data-widget-toggle]").forEach(sw => {
      sw.addEventListener("click", () => toggleWidgetById(sw.dataset.widgetToggle));
    });
  }

  // ── SCROLL-DRAG for widget content lists (news, to-do) ──
  // Mouse wheel already scrolls these normally. This adds the same
  // grab-and-move interaction the widgets use for repositioning, but
  // applied to scrollTop instead — so hand-tracking's pinch-drag (which
  // just dispatches real pointer events at whatever [data-hand-drag]
  // element is under the cursor) can scroll these lists the same way it
  // drags a widget, with no gesture-specific code needed here.
  function initScrollDragLists() {
    document.querySelectorAll("#db-news-list, #db-todo-list").forEach(el => {
      let dragging = false, startY = 0, startScroll = 0;
      el.addEventListener("pointerdown", (e) => {
        dragging = true;
        startY = e.clientY;
        startScroll = el.scrollTop;
        el.setPointerCapture(e.pointerId);
        e.stopPropagation(); // don't also start a whole-widget drag
      });
      el.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        el.scrollTop = startScroll - (e.clientY - startY);
        e.stopPropagation();
      });
      const end = (e) => { dragging = false; e.stopPropagation(); };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
  }

  function initDragging() {
    let dragEl = null, startX = 0, startY = 0, origLeftPx = 0, origTopPx = 0;

    document.querySelectorAll("#db-widget-layer [data-widget]").forEach(el => {
      el.addEventListener("pointerdown", (e) => {
        if (e.target.closest("textarea, input, button, .mw-progress-track")) return;
        dragEl = el;
        el.classList.add("db-dragging");
        el.setPointerCapture(e.pointerId);
        const rect = el.getBoundingClientRect();
        startX = e.clientX; startY = e.clientY;
        origLeftPx = rect.left; origTopPx = rect.top;
      });
      el.addEventListener("pointermove", (e) => {
        if (dragEl !== el) return;
        const dx = e.clientX - startX, dy = e.clientY - startY;
        let newLeft = origLeftPx + dx, newTop = origTopPx + dy;
        newLeft = Math.max(6, Math.min(window.innerWidth - el.offsetWidth - 6, newLeft));
        newTop = Math.max(6, Math.min(window.innerHeight - el.offsetHeight - 6, newTop));
        el.style.left = (newLeft / window.innerWidth * 100) + "vw";
        el.style.top = (newTop / window.innerHeight * 100) + "vh";
      });
      const end = (e) => {
        if (dragEl !== el) return;
        el.classList.remove("db-dragging");
        dragEl = null;
        const layout = loadLayout();
        const leftVw = parseFloat(el.style.left);
        const topVh = parseFloat(el.style.top);
        layout[el.id] = { x: leftVw, y: topVh };
        saveLayout(layout);
      };
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    });
  }

  // ── BACKGROUND (image / live video wallpaper) ──
  async function restoreBackground() {
    let meta = {};
    try { meta = JSON.parse(localStorage.getItem(DB_KEY_BG_META)) || {}; } catch (e) {}
    if (!meta.type || meta.type === "none") return;
    try {
      const blob = await idbGet("bg-media");
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      renderBackground(meta.type, url);
      if (meta.type === "image" && window.JarvisTheme) window.JarvisTheme.setFromImageURL(url);
    } catch (e) { /* fall back to default gradient */ }
  }

  function renderBackground(type, url) {
    const layer = $("db-bg-layer");
    const scrim = $("db-bg-scrim");
    const tint = $("db-bg-video-tint");
    if (!layer) return;
    layer.querySelectorAll("img, video").forEach(n => n.remove());
    if (type === "image") {
      const img = document.createElement("img");
      img.src = url;
      layer.appendChild(img);
      scrim?.classList.remove("db-scrim-video");
      tint?.classList.remove("db-tint-active");
      dashRoot?.classList.remove("db-video-active");
    } else if (type === "video") {
      const vid = document.createElement("video");
      vid.src = url;
      vid.autoplay = true; vid.loop = true; vid.muted = true; vid.playsInline = true;
      vid.preload = "auto";
      vid.disablePictureInPicture = true;
      layer.appendChild(vid);
      scrim?.classList.add("db-scrim-video");
      tint?.classList.add("db-tint-active");
      dashRoot?.classList.add("db-video-active");
    }
  }

  async function applyPendingBackground() {
    if (!pendingBgFile || !pendingBgKind) {
      closeSettings();
      return;
    }
    await idbSet("bg-media", pendingBgFile);
    localStorage.setItem(DB_KEY_BG_META, JSON.stringify({ type: pendingBgKind }));
    const url = URL.createObjectURL(pendingBgFile);
    renderBackground(pendingBgKind, url);
    if (pendingBgKind === "image" && window.JarvisTheme) window.JarvisTheme.setFromImageURL(url);
    pendingBgFile = null; pendingBgKind = null;
    closeSettings();
  }

  async function resetBackground() {
    await idbDel("bg-media");
    localStorage.removeItem(DB_KEY_BG_META);
    const layer = $("db-bg-layer");
    if (layer) layer.querySelectorAll("img, video").forEach(n => n.remove());
    $("db-bg-scrim")?.classList.remove("db-scrim-video");
    $("db-bg-video-tint")?.classList.remove("db-tint-active");
    dashRoot?.classList.remove("db-video-active");
    if (window.JarvisTheme) window.JarvisTheme.reset();
    else resetHandTrackingTint();
  }

  // Sample the wallpaper's average color so the hand-tracking cursor
  // reads as a tinted piece of glass rather than a fixed color.
  function tintHandTrackingFromImage(url) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 24; c.height = 24;
        const ctx = c.getContext("2d");
        ctx.drawImage(img, 0, 0, 24, 24);
        const data = ctx.getImageData(0, 0, 24, 24).data;
        let r = 0, g = 0, b = 0, n = 0;
        for (let i = 0; i < data.length; i += 4) { r += data[i]; g += data[i+1]; b += data[i+2]; n++; }
        r = Math.round(r / n); g = Math.round(g / n); b = Math.round(b / n);
        // blend toward white so it still reads as "glass", just tinted
        const blend = (ch) => Math.round(ch * 0.35 + 255 * 0.65);
        const rr = blend(r), gg = blend(g), bb = blend(b);
        document.documentElement.style.setProperty("--ht-glass", `rgba(${rr},${gg},${bb},0.92)`);
        document.documentElement.style.setProperty("--ht-glass-glow", `rgba(${r},${g},${b},0.5)`);
        document.documentElement.style.setProperty("--ht-glass-glow-strong", `rgba(${r},${g},${b},0.85)`);
      } catch (e) { /* canvas tainted (cross-origin) — keep default glass */ }
    };
    img.src = url;
  }
  function resetHandTrackingTint() {
    document.documentElement.style.removeProperty("--ht-glass");
    document.documentElement.style.removeProperty("--ht-glass-glow");
    document.documentElement.style.removeProperty("--ht-glass-glow-strong");
  }

  // ── SETTINGS PANEL ──
  function openSettings() { $("db-settings-overlay")?.classList.add("db-open"); populateMicSelect(); }
  function closeSettings() { $("db-settings-overlay")?.classList.remove("db-open"); }

  async function populateMicSelect() {
    const sel = $("db-mic-select");
    if (!sel || typeof window.listMicDevices !== "function") return;
    const devices = await window.listMicDevices();
    const current = typeof window.getMicDevice === "function" ? window.getMicDevice() : null;
    sel.innerHTML = "";
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "System default";
    sel.appendChild(defaultOpt);
    devices.forEach((d, i) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || `Microphone ${i + 1}`;
      if (d.deviceId === current) opt.selected = true;
      sel.appendChild(opt);
    });
    if (!current) defaultOpt.selected = true;
  }

  function initMicSelect() {
    $("db-mic-select")?.addEventListener("change", (e) => {
      if (typeof window.setMicDevice === "function") window.setMicDevice(e.target.value || null);
    });
  }

  function initSettings() {
    $("db-settings-btn")?.addEventListener("click", openSettings);
    $("db-settings-close")?.addEventListener("click", closeSettings);
    $("db-settings-done-btn")?.addEventListener("click", closeSettings);
    $("db-settings-overlay")?.addEventListener("click", (e) => {
      if (e.target.id === "db-settings-overlay") closeSettings();
    });

    const fileInput = $("db-bg-file-input");
    $("db-upload-photo-btn")?.addEventListener("click", () => {
      fileInput.accept = "image/*";
      fileInput.dataset.kind = "image";
      fileInput.click();
    });
    $("db-upload-video-btn")?.addEventListener("click", () => {
      fileInput.accept = "video/*";
      fileInput.dataset.kind = "video";
      fileInput.click();
    });
    fileInput?.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      pendingBgFile = file;
      pendingBgKind = fileInput.dataset.kind;
    });
    $("db-apply-bg-btn")?.addEventListener("click", applyPendingBackground);
    $("db-reset-bg-btn")?.addEventListener("click", resetBackground);
    $("db-reset-layout-btn")?.addEventListener("click", resetLayout);

    const motionSwitch = $("db-motion-switch");
    motionSwitch?.addEventListener("click", () => {
      motionSwitch.classList.toggle("on");
      document.body.classList.toggle("db-motion-off", !motionSwitch.classList.contains("on"));
    });

    // Sleep Mode master on/off — server-persisted (see settings.js /
    // /api/settings), read on boot and pushed to sleep-mode.js live.
    const sleepSwitch = $("db-sleepmode-switch");
    fetch("/api/settings").then((r) => r.json()).then((s) => {
      const on = s.sleepMode !== false; // default on
      sleepSwitch?.classList.toggle("on", on);
      window.setSleepModeEnabled?.(on);
    }).catch(() => {});
    sleepSwitch?.addEventListener("click", () => {
      const on = !sleepSwitch.classList.contains("on");
      sleepSwitch.classList.toggle("on", on);
      window.setSleepModeEnabled?.(on);
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sleepMode: on }),
      }).catch(() => {});
    });
  }

  // ── ORB / SHOW-HIDE WIRING ──
  function initOrbAndVisibility(dash) {
    const homeBtn = $("db-home-btn");
    $("db-orb-launcher")?.addEventListener("click", () => {
      if (typeof window.toggleListening === "function") window.toggleListening();
    });
    homeBtn?.addEventListener("click", revealDashboard);

    // Reveal the dashboard the moment the existing app finishes its
    // login/intro sequence and shows the chat HUD (#main-screen.active).
    const mainScreen = $("main-screen");
    if (mainScreen) {
      const reveal = () => {
        if (mainScreen.classList.contains("active")) {
          dash.classList.remove("db-hidden");
        }
      };
      reveal();
      new MutationObserver(reveal).observe(mainScreen, { attributes: true, attributeFilter: ["class"] });
    }
  }

  // ── SEARCH BAR → hands off to the existing chat input ──
  function initSearch(dash) {
    const input = $("db-search-input");
    if (!input) return;
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = input.value.trim();
      if (!q) return;
      hideDashboardToHUD();
      setTimeout(() => {
        if (typeof window.handleChatCommand === "function") {
          window.handleChatCommand(q);
        } else {
          const typeInput = $("type-input");
          if (typeInput) { typeInput.value = q; typeInput.dispatchEvent(new Event("input")); }
        }
      }, 200);
      input.value = "";
    });
  }

  function init() {
    const dash = buildDashboard();
    tickClock();
    setInterval(tickClock, 1000 * 15);
    applyLayout();
    initDragging();
    initScrollDragLists();
    initNotes();
    initCloseButtons();
    applyHiddenState();
    initSettings();
    initMicSelect();
    initOrbAndVisibility(dash);
    initSearch(dash);
    restoreBackground();
    loadWeather();
    loadTodos();
    loadMusic();
    loadNews();
    setInterval(loadWeather, 10 * 60 * 1000);
    setInterval(loadTodos, 2 * 60 * 1000);
    setInterval(loadMusic, 30 * 1000);
    setInterval(loadNews, 15 * 60 * 1000);
    window.addEventListener("resize", applyLayout);

    // ── Public API — lets jarvis.js's chat/voice command handler
    //    show/hide widgets by spoken name ("pull up the news widget",
    //    "close the weather widget") and bring the home screen back
    //    to front when it does. ──
    window.JarvisDashboard = {
      resolveWidget,
      show: showWidgetById,
      hide: hideWidgetById,
      toggle: toggleWidgetById,
      isHidden: (id) => hiddenWidgets.has(id),
      reveal: revealDashboard,
      hideToHUD: hideDashboardToHUD,
      widgetLabel: (id) => WIDGET_META[id]?.label || id,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
