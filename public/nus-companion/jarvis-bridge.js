/**
 * jarvis-bridge.js
 * Drops window.nus into the page so the unmodified NUS companion renderer
 * thinks it is running inside Electron.  Every IPC call is wired to Jarvis's
 * existing /api/chat endpoint and Socket.IO bus instead.
 *
 * The companion renderer does:
 *   nus.ask({ mode, text })          → POST /api/nus/ask   (streaming SSE reply)
 *   nus.settingsGet()                → GET  /api/nus/settings
 *   nus.settingsSet(patch)           → POST /api/nus/settings
 *   nus.captureState()               → { active: false }  (mic is browser-side)
 *   nus.captureToggle()              → toggles MediaRecorder in-page
 *   nus.on('llm:start', cb)          → fires when stream starts
 *   nus.on('llm:token', cb)          → fires per token
 *   nus.on('llm:done',  cb)          → fires when stream ends
 *   nus.on('llm:error', cb)          → fires on error
 *
 * Everything that was Electron-specific (global shortcuts, screen capture,
 * safeStorage, openPane) is stubbed to no-ops so the renderer never crashes.
 */
(function () {
  'use strict';

  /* ── config ──────────────────────────────────────────────────────────── */
  const BASE = window.JARVIS_BASE || '';  // empty = same origin
  const SETTINGS_KEY = 'jarvis_nus_settings';

  /* ── event bus ───────────────────────────────────────────────────────── */
  const listeners = new Map();
  function emit(channel, payload) {
    const cb = listeners.get(channel);
    if (cb) cb(payload);
  }

  /* ── in-memory settings with localStorage persistence ───────────────── */
  function defaultSettings() {
    return {
      provider: 'jarvis',
      apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '' },
      models: { jarvis: { fast: 'jarvis', smart: 'jarvis' } },
      shortcuts: { assist: 'CommandOrControl+Return' },
      smart: false,
      onboarded: false,
      resumeContext: '',
      packPath: '',
      sparPath: '',
      speakReplies: false,
      shareNusContextWithProvider: false,
      reportToNus: false,
      persistTranscripts: true,
      saveAudio: false,
      stealth: false,
      knotCorner: 'br',
      _founderTools: false,
      _migrationNote: '',
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

  /* ── streaming ask → Jarvis /api/chat via SSE ───────────────────────── */
  let _sessionId = 'nus-' + Math.random().toString(36).slice(2);
  let _abortCtrl = null;
  let _capturing = false;

  async function jarvisAsk(mode, text) {
    // Abort any in-flight request
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null; }

    emit('llm:start', { userBubble: text || mode, small: false });

    const systemHint = buildSystemHint(mode);
    const userMessage = text
      ? text
      : mode === 'guide'
        ? 'What should I do right now? Give me a clear, prioritized answer.'
        : mode === 'assist'
          ? 'Help me with what I am working on right now.'
          : mode === 'say'
            ? 'What should I say next in this conversation?'
            : mode === 'objection'
              ? 'Help me handle the objection being raised.'
              : mode === 'numbers'
                ? 'Give me the key numbers or metrics relevant here.'
                : mode === 'followup'
                  ? 'What follow-up questions should I ask?'
                  : mode === 'recap'
                    ? 'Give me a quick recap of what has been discussed.'
                    : mode === 'brief'
                      ? 'Give me a pre-call briefing.'
                      : text || 'Help me.';

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
          stream: true,
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
        // True SSE streaming
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
              const token = obj.token || obj.text || obj.delta || '';
              if (token) emit('llm:token', { text: token });
              if (obj.done) { emit('llm:done', {}); return; }
            } catch (_) {
              // raw text token
              if (data) emit('llm:token', { text: data });
            }
          }
        }
        emit('llm:done', {});
      } else {
        // Non-streaming JSON fallback
        const json = await res.json();
        const reply = json.reply || json.text || json.message || JSON.stringify(json);
        // Simulate streaming: chunk by words so the caret animates
        const words = reply.split(' ');
        for (let i = 0; i < words.length; i++) {
          emit('llm:token', { text: (i ? ' ' : '') + words[i] });
          await delay(18);
        }
        emit('llm:done', {});
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      // Fallback: call Anthropic Claude API directly if Jarvis is unreachable
      await claudeFallback(userMessage);
    }
  }

  function buildSystemHint(mode) {
    const resume = _settings.resumeContext ? `\n\nUser background:\n${_settings.resumeContext}` : '';
    const modeHints = {
      guide: 'You are Jarvis, a sharp AI companion. The user clicked "What should I do?" — give a clear, prioritized answer about their immediate next best action.',
      assist: 'You are Jarvis. Help the user with whatever they are currently working on. Be concise and actionable.',
      say: 'You are Jarvis. Suggest what the user should say next in their current conversation. Be direct and natural.',
      objection: 'You are Jarvis. Help the user handle an objection being raised. Give a clear, persuasive response.',
      numbers: 'You are Jarvis. Give the user the key numbers, metrics, or data points relevant to their situation.',
      followup: 'You are Jarvis. Suggest follow-up questions the user should ask. Make them thoughtful and strategic.',
      recap: 'You are Jarvis. Give a brief, structured recap of the current conversation or situation.',
      brief: 'You are Jarvis. Give a pre-meeting briefing. Cover the key points, participants, and what matters.',
      spar: 'You are Jarvis playing the role of an adversarial sparring partner. Challenge the user\'s thinking.',
      score: 'You are Jarvis. Score the user\'s performance and give actionable feedback.',
      ask: 'You are Jarvis, a sharp AI assistant. Answer the user\'s question directly and helpfully.',
    };
    return (modeHints[mode] || modeHints.ask) + resume;
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
          model: 'claude-sonnet-4-6',
          max_tokens: 1024,
          stream: true,
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
            if (obj.type === 'content_block_delta' && obj.delta && obj.delta.text) {
              emit('llm:token', { text: obj.delta.text });
            }
            if (obj.type === 'message_stop') { emit('llm:done', {}); return; }
          } catch (_) {}
        }
      }
      emit('llm:done', {});
    } catch (err) {
      emit('llm:error', { message: err.message });
    }
  }

  /* ── microphone capture (browser MediaRecorder → STT via Jarvis) ─────── */
  let _mediaRec = null;
  let _audioChunks = [];
  let _captureActive = false;

  async function startCapture() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      _audioChunks = [];
      _mediaRec = new MediaRecorder(stream);
      _mediaRec.ondataavailable = (e) => { if (e.data.size > 0) _audioChunks.push(e.data); };
      _mediaRec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(_audioChunks, { type: 'audio/webm' });
        await transcribeBlob(blob);
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
        // Push transcript into chat as if the user typed it
        emit('llm:start', { userBubble: text.trim(), small: false });
        await jarvisAsk('ask', text.trim());
      }
    } catch (_) {}
  }

  /* ── NUS context status (we report "connected" to Jarvis) ───────────── */
  async function getNusContextStatus() {
    try {
      const res = await fetch(BASE + '/api/status', { method: 'GET' });
      if (res.ok) return { ok: true, updatedAt: new Date().toISOString() };
    } catch (_) {}
    return { ok: false };
  }

  /* ── utils ───────────────────────────────────────────────────────────── */
  function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

  /* ── the nus bridge object ───────────────────────────────────────────── */
  window.nus = {
    platform: navigator.platform.toLowerCase().includes('mac') ? 'darwin' : 'win32',

    // Settings
    settingsGet: async () => ({ ..._settings }),
    settingsSet: async (patch) => {
      Object.assign(_settings, patch);
      saveSettingsLocal();
      return true;
    },

    // The main AI call — renderer calls this, we stream back via events
    ask: (opts) => {
      const mode = (opts && opts.mode) || 'ask';
      const text = (opts && opts.text) || '';
      jarvisAsk(mode, text).catch((e) => emit('llm:error', { message: e.message }));
    },

    // Microphone capture
    captureState: async () => ({ active: _captureActive }),
    captureToggle: async () => {
      if (_captureActive) {
        stopCapture();
      } else {
        await startCapture();
      }
      return { active: _captureActive };
    },
    micPcm: () => {},    // PCM streaming used by Electron only
    systemPcm: () => {}, // system audio — Electron only

    // Deep query (vault search)
    deepQuery: async (text) => {
      try {
        const res = await fetch(BASE + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, sessionId: _sessionId, source: 'nus-deep' }),
        });
        const j = await res.json();
        return j.reply || j.text || '';
      } catch (_) { return ''; }
    },

    // Shortcut registration — no-op in browser (we can't register global shortcuts)
    shortcutAssistSet: async (accelerator) => ({ ok: true, accelerator }),

    // NUS context link
    nusContextStatus: getNusContextStatus,

    // Spar / rehearsal
    sparReset: async () => true,
    packStatus: async () => ({
      live: { ok: false, path: '', chars: 0, error: '' },
      spar: { ok: false, path: '', chars: 0, error: '' },
    }),

    // Guide callbacks
    guideAsk: (p) => {
      if (p && p.text) jarvisAsk('ask', p.text).catch(() => {});
    },
    guideDismiss: () => {},
    guideKeep: () => {},
    guideSkip: () => {},
    strandArrived: () => {},

    // Knot corner persistence
    knotCornerSet: async (corner) => {
      _settings.knotCorner = corner;
      saveSettingsLocal();
      return true;
    },

    // Zoom (always 1 in browser — no Electron zoom)
    getZoomLevel: () => 0,

    // Desktop tour stub
    desktopTour: () => {},

    // Log
    log: (...args) => console.log('[nus]', ...args),

    // openPane / shell — no-op in browser
    openPane: (url) => { try { window.open(url, '_blank', 'noopener'); } catch (_) {} },

    // Click-through — no-op (we're in a normal browser window)
    setIgnoreMouse: () => {},

    // Event subscription (renderer calls nus.on('llm:token', cb) etc.)
    on: (channel, callback) => { listeners.set(channel, callback); },
  };

  /* ── fake setIgnoreSafe so renderer's global doesn't blow up ─────────── */
  window.setIgnoreSafe = () => {};

  console.log('[jarvis-bridge] nus bridge ready — wired to', BASE || 'same-origin Jarvis');
})();
