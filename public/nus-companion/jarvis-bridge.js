/**
 * jarvis-bridge.js  —  NUS Companion ↔ Full Jarvis Brain
 * ────────────────────────────────────────────────────────
 * Drops window.nus into the page so the unmodified NUS companion renderer
 * thinks it's inside Electron.  Every IPC call routes to full Jarvis:
 *
 *   nus.ask({ mode, text })   → POST /api/chat  (SSE or JSON)
 *   nus.settingsGet/Set()     → localStorage + /api/nus/settings
 *   nus.captureToggle()       → browser MediaRecorder → /api/stt
 *
 * NEW: SHOW_PC_VIEW intercept
 *   When /api/chat returns  action: "SHOW_PC_VIEW"  with meta.streamUrl,
 *   the bridge opens an inline VNC overlay bubble attached to the knot
 *   glass panel — exactly how NUS Desktop popped guide bubbles.  The
 *   viewer auto-closes with an ✕ button.  Audio bridge URL also wired if
 *   the server supplies meta.audioUrl.
 */
(function () {
  'use strict';

  /* ── config ──────────────────────────────────────────────────────────── */
  const BASE = window.JARVIS_BASE || '';
  const SETTINGS_KEY = 'jarvis_nus_settings';

  /* ── event bus ───────────────────────────────────────────────────────── */
  const listeners = new Map();
  function emit(channel, payload) {
    const cb = listeners.get(channel);
    if (cb) cb(payload);
  }

  /* ── in-memory settings ──────────────────────────────────────────────── */
  function defaultSettings() {
    return {
      provider: 'jarvis',
      apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '' },
      models: { jarvis: { fast: 'jarvis', smart: 'jarvis' } },
      shortcuts: { assist: 'CommandOrControl+Return' },
      smart: false, onboarded: false, resumeContext: '',
      packPath: '', sparPath: '', speakReplies: false,
      shareNusContextWithProvider: false, reportToNus: false,
      persistTranscripts: true, saveAudio: false, stealth: false,
      knotCorner: 'br', _founderTools: false, _migrationNote: '',
    };
  }
  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (raw) return Object.assign(defaultSettings(), JSON.parse(raw));
    } catch (_) {}
    return defaultSettings();
  }
  let _settings = loadSettings();
  function saveSettingsLocal() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(_settings)); } catch (_) {}
  }

  /* ══════════════════════════════════════════════════════════════════════
   *  VNC OVERLAY — pops when SHOW_PC_VIEW fires
   * ══════════════════════════════════════════════════════════════════════ */
  let _vncOverlay = null;
  let _audioEl    = null;

  /**
   * buildVncOverlay() — creates a floating glass panel overlay with an
   * embedded VNC iframe.  Styled to match the NUS knot glass aesthetic:
   * dark blur background, rounded corners, header bar with ✕ close.
   * If audioUrl is supplied, an invisible <audio> element streams desktop
   * audio alongside the VNC video.
   */
  function buildVncOverlay(streamUrl, audioUrl) {
    if (_vncOverlay) destroyVncOverlay();

    const overlay = document.createElement('div');
    overlay.id = '__jarvis_vnc_overlay';
    overlay.style.cssText = `
      position: fixed;
      z-index: 999999;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: min(90vw, 1024px);
      height: min(80vh, 650px);
      background: rgba(10, 10, 20, 0.92);
      backdrop-filter: blur(24px) saturate(1.4);
      -webkit-backdrop-filter: blur(24px) saturate(1.4);
      border: 1px solid rgba(255,255,255,0.10);
      border-radius: 16px;
      box-shadow: 0 32px 80px rgba(0,0,0,0.75), 0 0 0 1px rgba(255,255,255,0.04);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      animation: __jarvis_vnc_in 0.22s cubic-bezier(0.16,1,0.3,1) both;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    `;

    /* keyframe injection (idempotent) */
    if (!document.getElementById('__jarvis_vnc_kf')) {
      const style = document.createElement('style');
      style.id = '__jarvis_vnc_kf';
      style.textContent = `
        @keyframes __jarvis_vnc_in {
          from { opacity: 0; transform: translate(-50%, -48%) scale(0.96); }
          to   { opacity: 1; transform: translate(-50%, -50%) scale(1);    }
        }
        @keyframes __jarvis_vnc_out {
          from { opacity: 1; transform: translate(-50%, -50%) scale(1);    }
          to   { opacity: 0; transform: translate(-50%, -48%) scale(0.95); }
        }
      `;
      document.head.appendChild(style);
    }

    /* header bar */
    const header = document.createElement('div');
    header.style.cssText = `
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 16px;
      background: rgba(255,255,255,0.04);
      border-bottom: 1px solid rgba(255,255,255,0.07);
      flex-shrink: 0;
    `;

    const title = document.createElement('span');
    title.style.cssText = 'color: rgba(255,255,255,0.75); font-size: 13px; font-weight: 500; letter-spacing: 0.02em; display: flex; align-items: center; gap: 8px;';
    title.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="6" cy="6" r="5" stroke="rgba(80,220,120,0.9)" stroke-width="1.5"/>
        <circle cx="6" cy="6" r="2.5" fill="rgba(80,220,120,0.9)"/>
      </svg>
      Jarvis Desktop
    `;

    const headerRight = document.createElement('div');
    headerRight.style.cssText = 'display: flex; align-items: center; gap: 10px;';

    /* audio indicator */
    const audioIndicator = document.createElement('span');
    audioIndicator.id = '__jarvis_vnc_audio_indicator';
    audioIndicator.style.cssText = 'color: rgba(255,255,255,0.35); font-size: 11px; display: none;';
    audioIndicator.textContent = '🔊 Audio';

    /* close button */
    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = `
      background: rgba(255,255,255,0.08);
      border: none;
      border-radius: 6px;
      color: rgba(255,255,255,0.6);
      cursor: pointer;
      font-size: 13px;
      height: 26px;
      width: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: background 0.15s, color 0.15s;
    `;
    closeBtn.onmouseenter = () => {
      closeBtn.style.background = 'rgba(255,60,60,0.25)';
      closeBtn.style.color = 'rgba(255,100,100,0.9)';
    };
    closeBtn.onmouseleave = () => {
      closeBtn.style.background = 'rgba(255,255,255,0.08)';
      closeBtn.style.color = 'rgba(255,255,255,0.6)';
    };
    closeBtn.onclick = () => destroyVncOverlay();

    headerRight.append(audioIndicator, closeBtn);
    header.append(title, headerRight);

    /* VNC iframe */
    const iframe = document.createElement('iframe');
    iframe.src = streamUrl;
    iframe.allow = 'fullscreen; autoplay; camera; microphone';
    iframe.style.cssText = 'flex: 1; border: none; background: #000; border-radius: 0 0 15px 15px;';
    iframe.title = 'Jarvis Desktop';

    overlay.append(header, iframe);

    /* dim-backdrop (click outside = close) */
    const backdrop = document.createElement('div');
    backdrop.id = '__jarvis_vnc_backdrop';
    backdrop.style.cssText = `
      position: fixed; inset: 0; z-index: 999998;
      background: rgba(0,0,0,0.55);
      animation: __jarvis_vnc_in 0.18s ease both;
    `;
    backdrop.onclick = () => destroyVncOverlay();

    document.body.append(backdrop, overlay);
    _vncOverlay = overlay;

    /* audio bridge */
    if (audioUrl) {
      _audioEl = new Audio(audioUrl);
      _audioEl.autoplay = true;
      _audioEl.addEventListener('playing', () => {
        const ind = document.getElementById('__jarvis_vnc_audio_indicator');
        if (ind) { ind.style.display = 'inline'; ind.style.color = 'rgba(80,220,120,0.8)'; }
      }, { once: true });
      _audioEl.play().catch(() => {
        // browser blocked autoplay — show a muted indicator
        const ind = document.getElementById('__jarvis_vnc_audio_indicator');
        if (ind) { ind.style.display = 'inline'; ind.textContent = '🔇 Audio blocked'; }
      });
    }

    /* keyboard escape closes overlay */
    function onKeydown(e) {
      if (e.key === 'Escape') { destroyVncOverlay(); document.removeEventListener('keydown', onKeydown); }
    }
    document.addEventListener('keydown', onKeydown);
    overlay._keyHandler = onKeydown;
  }

  function destroyVncOverlay() {
    if (_vncOverlay) {
      if (_vncOverlay._keyHandler) document.removeEventListener('keydown', _vncOverlay._keyHandler);
      _vncOverlay.style.animation = '__jarvis_vnc_out 0.18s ease forwards';
      setTimeout(() => { try { _vncOverlay.remove(); } catch {} _vncOverlay = null; }, 200);
    }
    const bd = document.getElementById('__jarvis_vnc_backdrop');
    if (bd) { bd.style.opacity = '0'; setTimeout(() => { try { bd.remove(); } catch {} }, 200); }
    if (_audioEl) { try { _audioEl.pause(); _audioEl.src = ''; } catch {} _audioEl = null; }
  }

  /* ══════════════════════════════════════════════════════════════════════
   *  ACTION ROUTER — handles everything /api/chat can return
   * ══════════════════════════════════════════════════════════════════════ */
  function handleAction(action, meta, reply) {
    switch (action) {
      case 'SHOW_PC_VIEW':
        if (meta && meta.streamUrl) {
          buildVncOverlay(meta.streamUrl, meta.audioUrl || null);
        } else {
          emit('llm:token', { text: reply || 'Desktop stream starting…' });
          emit('llm:done', {});
        }
        break;

      case 'PC_CLOSED':
        destroyVncOverlay();
        emit('llm:token', { text: reply || 'Desktop closed.' });
        emit('llm:done', {});
        break;

      case 'ERROR':
      case 'RATE_LIMITED':
        emit('llm:error', { message: reply || 'Something went wrong.' });
        break;

      default:
        // CHAT, TOOL, or anything else — just stream the reply text
        if (reply) {
          wordStream(reply);
        } else {
          emit('llm:done', {});
        }
        break;
    }
  }

  /* word-stream a plain string as tokens */
  async function wordStream(text) {
    const words = String(text || '').split(' ');
    for (let i = 0; i < words.length; i++) {
      emit('llm:token', { text: (i ? ' ' : '') + words[i] });
      await delay(14);
    }
    emit('llm:done', {});
  }

  /* ══════════════════════════════════════════════════════════════════════
   *  MAIN ASK — routes through full Jarvis /api/chat
   * ══════════════════════════════════════════════════════════════════════ */
  let _sessionId = 'nus-' + Math.random().toString(36).slice(2);
  let _abortCtrl = null;

  async function jarvisAsk(mode, text) {
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }

    emit('llm:start', { userBubble: text || mode, small: false });

    const systemHint = buildSystemHint(mode);
    const userMessage = text || modeDefault(mode);

    _abortCtrl = new AbortController();
    const ctrl = _abortCtrl;

    try {
      const res = await fetch(BASE + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({
          message: userMessage,
          sessionId: _sessionId,
          systemHint,
          source: 'nus-companion',
        }),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => res.statusText);
        emit('llm:error', { message: 'Jarvis error: ' + err });
        return;
      }

      const ct = res.headers.get('content-type') || '';

      if (ct.includes('text/event-stream')) {
        /* ── true SSE streaming ── */
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') { emit('llm:done', {}); return; }
            try {
              const obj = JSON.parse(data);
              if (obj.error)  { emit('llm:error', { message: obj.error }); return; }
              const token = obj.token || obj.text || obj.delta || '';
              if (token) emit('llm:token', { text: token });
              if (obj.done)   { emit('llm:done', {}); return; }
            } catch (_) {
              if (data) emit('llm:token', { text: data });
            }
          }
        }
        emit('llm:done', {});

      } else {
        /* ── JSON response (tool call or action) ── */
        const json = await res.json();
        const action = json.action || 'CHAT';
        const meta   = json.meta   || null;
        const reply  = json.reply  || json.text || json.message || '';
        handleAction(action, meta, reply);
      }

    } catch (err) {
      if (err.name === 'AbortError') return;
      // last-resort: direct Anthropic if Jarvis is unreachable
      await claudeFallback(userMessage);
    }
  }

  function buildSystemHint(mode) {
    const resume = _settings.resumeContext ? `\n\nUser background:\n${_settings.resumeContext}` : '';
    const hints = {
      guide:     'You are Jarvis. The user clicked "What should I do?" — give a clear, prioritized answer about their immediate next best action.',
      assist:    'You are Jarvis. Help the user with whatever they are currently working on. Be concise and actionable.',
      say:       'You are Jarvis. Suggest what the user should say next in their current conversation. Be direct.',
      objection: 'You are Jarvis. Help the user handle the objection being raised. Give a clear, persuasive response.',
      numbers:   'You are Jarvis. Surface the key numbers and metrics relevant to the user\'s current situation.',
      followup:  'You are Jarvis. Suggest smart follow-up questions. Make them thoughtful and strategic.',
      recap:     'You are Jarvis. Give a brief, structured recap of the current situation.',
      brief:     'You are Jarvis. Give a pre-meeting briefing. Cover key points and what matters.',
      spar:      'You are Jarvis playing an adversarial sparring partner. Challenge the user\'s thinking rigorously.',
      score:     'You are Jarvis. Score the user\'s performance and give actionable, honest feedback.',
      ask:       'You are Jarvis, a sharp AI assistant. Answer the user\'s question directly and helpfully.',
    };
    return (hints[mode] || hints.ask) + resume;
  }

  function modeDefault(mode) {
    const d = {
      guide:     'What should I do right now? Give me a clear, prioritized answer.',
      assist:    'Help me with what I am working on right now.',
      say:       'What should I say next in this conversation?',
      objection: 'Help me handle the objection being raised.',
      numbers:   'What are the key numbers or metrics relevant here?',
      followup:  'What follow-up questions should I ask?',
      recap:     'Give me a quick recap of what has been discussed.',
      brief:     'Give me a pre-call briefing.',
      spar:      'Start a sparring session. Challenge my thinking.',
      score:     'Score my performance so far and give me feedback.',
    };
    return d[mode] || 'Help me.';
  }

  /* ── direct Anthropic fallback when Jarvis backend is unreachable ─────── */
  async function claudeFallback(message) {
    const key = _settings.apiKeys && _settings.apiKeys.anthropic;
    if (!key) {
      emit('llm:error', { message: 'Jarvis backend unreachable. Add an Anthropic key in Settings to use direct AI.' });
      return;
    }
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6', max_tokens: 1024, stream: true,
          messages: [{ role: 'user', content: message }],
        }),
      });
      if (!res.ok) { emit('llm:error', { message: 'Anthropic error ' + res.status }); return; }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') { emit('llm:done', {}); return; }
          try {
            const obj = JSON.parse(data);
            if (obj.type === 'content_block_delta' && obj.delta?.text) emit('llm:token', { text: obj.delta.text });
            if (obj.type === 'message_stop') { emit('llm:done', {}); return; }
          } catch (_) {}
        }
      }
      emit('llm:done', {});
    } catch (err) {
      emit('llm:error', { message: err.message });
    }
  }

  /* ── microphone capture → /api/stt ──────────────────────────────────── */
  let _mediaRec      = null;
  let _audioChunks   = [];
  let _captureActive = false;

  async function startCapture() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _audioChunks = [];
      _mediaRec = new MediaRecorder(stream);
      _mediaRec.ondataavailable = (e) => { if (e.data.size > 0) _audioChunks.push(e.data); };
      _mediaRec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        await transcribeBlob(new Blob(_audioChunks, { type: 'audio/webm' }));
      };
      _mediaRec.start(250);
      _captureActive = true;
    } catch (err) {
      console.error('[jarvis-bridge] mic error:', err);
    }
  }

  function stopCapture() {
    if (_mediaRec && _mediaRec.state !== 'inactive') _mediaRec.stop();
    _captureActive = false;
  }

  async function transcribeBlob(blob) {
    try {
      const form = new FormData();
      form.append('audio', blob, 'capture.webm');
      form.append('sessionId', _sessionId);
      const res = await fetch(BASE + '/api/stt', { method: 'POST', body: form });
      if (!res.ok) return;
      const { text } = await res.json();
      if (text && text.trim()) {
        emit('llm:start', { userBubble: text.trim(), small: false });
        await jarvisAsk('ask', text.trim());
      }
    } catch (_) {}
  }

  /* ── NUS context status ──────────────────────────────────────────────── */
  async function getNusContextStatus() {
    try {
      const res = await fetch(BASE + '/api/status');
      if (res.ok) return { ok: true, updatedAt: new Date().toISOString() };
    } catch (_) {}
    return { ok: false };
  }

  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ══════════════════════════════════════════════════════════════════════
   *  window.nus  — the bridge object the NUS renderer calls into
   * ══════════════════════════════════════════════════════════════════════ */
  window.nus = {
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',

    // Settings
    settingsGet: async () => ({ ..._settings }),
    settingsSet: async (patch) => { Object.assign(_settings, patch); saveSettingsLocal(); return true; },

    // The main AI call
    ask: (opts) => {
      const mode = (opts && opts.mode) || 'ask';
      const text = (opts && opts.text) || '';
      jarvisAsk(mode, text).catch((e) => emit('llm:error', { message: e.message }));
    },

    // Microphone
    captureState:  async () => ({ active: _captureActive }),
    captureToggle: async () => {
      if (_captureActive) stopCapture(); else await startCapture();
      return { active: _captureActive };
    },
    micPcm:    () => {},
    systemPcm: () => {},

    // Deep query
    deepQuery: async (text) => {
      try {
        const res = await fetch(BASE + '/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, sessionId: _sessionId, source: 'nus-deep' }),
        });
        const j = await res.json();
        return j.reply || j.text || '';
      } catch (_) { return ''; }
    },

    // VNC overlay controls (exposed so renderer could trigger / dismiss)
    showDesktop: (streamUrl, audioUrl) => buildVncOverlay(streamUrl, audioUrl),
    hideDesktop: () => destroyVncOverlay(),

    // Shortcuts
    shortcutAssistSet: async (accelerator) => ({ ok: true, accelerator }),

    // NUS context
    nusContextStatus: getNusContextStatus,

    // Spar / rehearsal
    sparReset:   async () => true,
    packStatus:  async () => ({
      live: { ok: false, path: '', chars: 0, error: '' },
      spar: { ok: false, path: '', chars: 0, error: '' },
    }),

    // Guide callbacks
    guideAsk:     (p) => { if (p && p.text) jarvisAsk('ask', p.text).catch(() => {}); },
    guideDismiss: () => {},
    guideKeep:    () => {},
    guideSkip:    () => {},
    strandArrived: () => {},

    // Knot corner
    knotCornerSet: async (corner) => { _settings.knotCorner = corner; saveSettingsLocal(); return true; },

    // Zoom
    getZoomLevel: () => 0,

    // Desktop tour
    desktopTour: () => {},

    // Log / openPane
    log:    (...args) => console.log('[nus]', ...args),
    openPane: (url) => { try { window.open(url, '_blank', 'noopener'); } catch (_) {} },

    // Click-through (Electron-only)
    setIgnoreMouse: () => {},

    // Event subscription
    on: (channel, callback) => { listeners.set(channel, callback); },
  };

  window.setIgnoreSafe = () => {};

  console.log('[jarvis-bridge] ✓ full-brain bridge ready — VNC overlay armed, wired to', BASE || 'same-origin Jarvis');
})();
