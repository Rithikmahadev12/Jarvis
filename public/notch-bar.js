/* ═══════════════════════════════════════════════════════════════
   J.A.R.V.I.S — Notch Bar
   Always-listening. No buttons.
   • Passive mic loop — always on, wakes on "hey jarvis" / "jarvis"
   • Intent classifier — decides if speech is directed at Jarvis
     or just ambient conversation, ignores ambient
   • Auto screen grab — fires silently when question implies screen
   • Wallet / memory / account data pulled on demand
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── WAKE WORDS ── */
  const WAKE_PATTERNS = [
    /\bhey\s+jarvis\b/i,
    /\bjarvis\b/i,
    /\bj\.?a\.?r\.?v\.?i\.?s\b/i,
  ];

  /* ── SCREEN TRIGGERS — auto-grab when these appear ── */
  const SCREEN_TRIGGERS = /\b(screen|show(ing)?|see(ing)?|look(ing)?|display|window|page|open|tab|browser|reading|watch(ing)?|what('?s| is) (on|in|that)|this (app|site|page|code|file)|my (screen|monitor|display))\b/i;

  /* ── AMBIENT CLASSIFIER — phrases that are clearly NOT to Jarvis ── */
  const AMBIENT_PHRASES = /\b(never mind|nothing|talking to (myself|you|him|her|them)|just (thinking|kidding|saying))\b/i;

  /* ── STATE ── */
  const S = {
    expanded: false,
    awake: false,           // mid-conversation window (5s after last exchange)
    listening: false,
    thinking: false,
    sessionId: 'notch_' + Math.random().toString(36).slice(2),
    userName: null,
    userTitle: 'Sir',
    memories: [],
    backendUrl: '',
    recognition: null,
    mediaRecorder: null,
    audioChunks: [],
    screenText: null,
    screenTs: 0,            // timestamp of last screen capture
    msgs: [],
    speechSynth: window.speechSynthesis || null,
    wakeTimer: null,        // timeout to drop awake state
    restartTimer: null,     // debounce recognition restart
    desktopMicActive: false,
  };

  const SCREEN_CACHE_MS = 8000; // re-use screen grab for 8s to avoid spam

  /* ─────────────────────────────────────────────
     BOOT
  ───────────────────────────────────────────── */
  async function boot() {
    try {
      if (window.jarvisDesktop?.getBackendUrl)
        S.backendUrl = await window.jarvisDesktop.getBackendUrl() || '';
    } catch (_) {}

    await loadProfile();
    setStatus('ONLINE', 'idle');
    startPassiveListen();
    setupKeyboard();
    setInterval(reportSize, 250);
  }

  async function loadProfile() {
    try {
      const p = await apiFetch('/api/profiles');
      if (p?.profiles?.length) {
        const u = p.profiles[0];
        S.userName  = u.name || u.userName || null;
        S.userTitle = u.title || 'Sir';
      }
    } catch (_) {}
    try {
      if (S.userName) {
        const m = await apiFetch(`/api/memory/${encodeURIComponent(S.userName)}`);
        S.memories = m?.memories || [];
      }
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────
     PASSIVE ALWAYS-ON LISTEN LOOP
     Uses continuous Web Speech. On Electron (where Web Speech
     has no Google key) falls back to chunked MediaRecorder loop.
  ───────────────────────────────────────────── */
  function startPassiveListen() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (SR) {
      startWebSpeechLoop(SR);
    } else {
      startDesktopMicLoop();
    }
  }

  function startWebSpeechLoop(SR) {
    const rec = new SR();
    rec.continuous      = true;
    rec.interimResults  = true;
    rec.lang            = 'en-US';
    rec.maxAlternatives = 1;
    S.recognition = rec;

    let interimText = '';

    rec.onstart = () => { S.listening = true; };

    rec.onresult = (e) => {
      let interim = '', final = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) final += t;
        else interim += t;
      }
      interimText = interim;

      // Show interim hearing only when awake or contains wake word
      const combined = (final || interim).trim();
      if (containsWakeWord(combined) || S.awake) {
        setHearing(interimText || final);
      }

      if (final.trim()) {
        interimText = '';
        setHearing('');
        handleSpeech(final.trim());
      }
    };

    rec.onend = () => {
      S.listening = false;
      // Always restart — this is the passive loop
      if (!S.thinking) {
        S.restartTimer = setTimeout(() => {
          try { rec.start(); } catch (_) {
            // SR died, rebuild it
            setTimeout(() => startWebSpeechLoop(SR), 1000);
          }
        }, 300);
      } else {
        // Thinking — restart once thinking finishes
        const poll = setInterval(() => {
          if (!S.thinking) { clearInterval(poll); try { rec.start(); } catch (_) {} }
        }, 400);
      }
    };

    rec.onerror = (ev) => {
      // 'no-speech' is normal and fires constantly — ignore it
      if (ev.error === 'no-speech') return;
      S.listening = false;
      setTimeout(() => startWebSpeechLoop(SR), 1500);
    };

    try { rec.start(); } catch (_) {}
  }

  /* Electron fallback: 3-second rolling MediaRecorder chunks,
     transcribed via /api/transcribe, same intent logic applied */
  function startDesktopMicLoop() {
    if (S.desktopMicActive) return;
    S.desktopMicActive = true;

    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
      function recordChunk() {
        if (!S.desktopMicActive) return;
        const mr = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        const chunks = [];
        mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
        mr.onstop = async () => {
          if (!S.desktopMicActive) return;
          const blob = new Blob(chunks, { type: 'audio/webm' });
          const b64 = await blobToBase64(blob);
          try {
            const res = await apiFetch('/api/transcribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audio: b64, mimeType: 'audio/webm' }),
            });
            const txt = res?.transcript?.trim();
            if (txt) handleSpeech(txt);
          } catch (_) {}
          // Keep looping unless thinking
          if (!S.thinking) recordChunk();
          else {
            const poll = setInterval(() => {
              if (!S.thinking) { clearInterval(poll); recordChunk(); }
            }, 400);
          }
        };
        mr.start();
        setTimeout(() => { try { mr.stop(); } catch (_) {} }, 3000);
      }
      recordChunk();
    }).catch(() => {
      // Mic denied — show hint
      setStatus('MIC DENIED', 'idle');
    });
  }

  /* ─────────────────────────────────────────────
     INTENT CLASSIFIER
     Returns: 'wake_command' | 'awake_command' | 'ambient' | 'ignore'
  ───────────────────────────────────────────── */
  function classifyIntent(text) {
    const lower = text.toLowerCase().trim();

    // Too short to be useful
    if (lower.length < 3) return 'ignore';

    // Explicit ambient bail-out
    if (AMBIENT_PHRASES.test(lower)) return 'ignore';

    // Contains wake word — definitely for Jarvis
    if (containsWakeWord(lower)) return 'wake_command';

    // Currently in awake window (within 5s of last exchange) — treat as follow-up
    if (S.awake) return 'awake_command';

    // Heuristic: short confident questions with question words
    // directed at nobody in particular — might still be ambient
    // Only pass these through if they sound like commands, not chatter
    const looksLikeCommand = /\b(what|where|when|how|who|show|open|get|find|check|read|tell|give|pull|look)\b/i.test(lower);
    const looksLikeChatter = /\b(i (think|feel|was|am|did)|we (should|could|were)|they (said|told)|it (was|is)|yeah|okay|no|yes|sure|right|cool|nice|wow|lol)\b/i.test(lower);

    if (looksLikeCommand && !looksLikeChatter) return 'awake_command';

    return 'ambient';
  }

  function containsWakeWord(text) {
    return WAKE_PATTERNS.some(p => p.test(text));
  }

  /* Strip wake word prefix before sending to AI */
  function stripWakeWord(text) {
    return text
      .replace(/^(hey\s+jarvis|jarvis)[,.\s]*/i, '')
      .trim();
  }

  /* ─────────────────────────────────────────────
     HANDLE INCOMING SPEECH
  ───────────────────────────────────────────── */
  async function handleSpeech(text) {
    const intent = classifyIntent(text);
    if (intent === 'ignore' || intent === 'ambient') return;

    const clean = stripWakeWord(text);
    if (!clean) return; // bare "hey jarvis" with nothing after — just expand
    if (!S.expanded) toggleExpand();

    bumpAwake();
    await sendMessage(clean);
  }

  /* Keep Jarvis "awake" for 5s after last exchange — follow-up questions
     don't need the wake word */
  function bumpAwake() {
    S.awake = true;
    clearTimeout(S.wakeTimer);
    S.wakeTimer = setTimeout(() => { S.awake = false; }, 5000);
  }

  /* ─────────────────────────────────────────────
     AUTO SCREEN GRAB
     Fires silently before sending to /api/chat when query implies screen.
     Re-uses cached grab if < SCREEN_CACHE_MS old.
  ───────────────────────────────────────────── */
  async function maybeGrabScreen(text) {
    if (!SCREEN_TRIGGERS.test(text)) return; // not a screen question
    const age = Date.now() - S.screenTs;
    if (age < SCREEN_CACHE_MS && S.screenText) return; // fresh enough

    setStatus('SCANNING…', 'thinking');
    try {
      let dataUrl;
      if (window.jarvisDesktop?.captureScreen) {
        dataUrl = await window.jarvisDesktop.captureScreen();
      }
      if (!dataUrl) return;

      // Send to /api/screen-ocr for text extraction
      const res = await apiFetch('/api/screen-ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageData: dataUrl }),
      });
      S.screenText = res?.text || null;
      S.screenTs   = Date.now();
    } catch (_) {
      S.screenText = null;
    }
  }

  /* ─────────────────────────────────────────────
     SEND TO JARVIS
  ───────────────────────────────────────────── */
  window.sendMessage = async function (overrideText) {
    const input = document.getElementById('notch-input');
    const text  = (overrideText || input?.value || '').trim();
    if (!text || S.thinking) return;
    if (input) input.value = '';

    addMsg('user', text);
    setThinking(true, 'THINKING…');
    setStatus('THINKING', 'thinking');

    // Pause passive recognition while thinking (prevents feedback loop)
    try { if (S.recognition) S.recognition.stop(); } catch (_) {}

    // Screen auto-grab
    await maybeGrabScreen(text);

    // Wallet chips if relevant
    let chips = [];
    if (/wallet|address|balance|solana|\bsol\b|pubkey|earn/i.test(text))
      chips = await fetchWalletChips();

    // Enrich with screen context
    let enriched = text;
    if (S.screenText)
      enriched = `[Screen context: "${S.screenText.slice(0, 700)}"] ${text}`;

    try {
      const res = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: enriched,
          sessionId: S.sessionId,
          userName: S.userName,
          userTitle: S.userTitle,
          memories: S.memories,
          screenActive: !!S.screenText,
        }),
      });

      setThinking(false);
      const reply = res?.reply || res?.text || '…';
      addMsg('jarvis', reply, chips.length ? chips : extractChips(reply));
      setStatus('ONLINE', 'idle');
      bumpAwake();
      speak(reply);

      // Refresh memories async
      if (S.userName)
        apiFetch(`/api/memory/${encodeURIComponent(S.userName)}`)
          .then(m => { if (m?.memories) S.memories = m.memories; });

    } catch (_) {
      setThinking(false);
      addMsg('jarvis', 'Connection issue, ' + S.userTitle + '.', []);
      setStatus('ONLINE', 'idle');
    }

    // Resume passive listen
    try { if (S.recognition) S.recognition.start(); } catch (_) {}
  };

  /* ─────────────────────────────────────────────
     WALLET CHIPS
  ───────────────────────────────────────────── */
  async function fetchWalletChips() {
    const chips = [];
    try {
      const [policy, balances, earnings] = await Promise.all([
        apiFetch('/api/wallet/policy'),
        apiFetch('/api/wallet/balances'),
        apiFetch('/api/wallet/earnings'),
      ]);
      if (policy?.ownerWallet) chips.push({ icon: '◎', label: 'Owner Wallet', value: policy.ownerWallet });
      if (policy?.agentWallet) chips.push({ icon: '⬡', label: 'Agent Wallet', value: policy.agentWallet });
      if (balances?.sol  != null) chips.push({ icon: '◎', label: 'SOL',  value: balances.sol  + ' SOL' });
      if (balances?.usdc != null) chips.push({ icon: '$', label: 'USDC', value: balances.usdc + ' USDC' });
      if (earnings?.total != null) chips.push({ icon: '↑', label: 'Earned', value: earnings.total + ' SOL' });
    } catch (_) {}
    return chips;
  }

  function extractChips(reply) {
    const chips = [];
    const addr = reply.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
    if (addr) addr.slice(0, 2).forEach(a => chips.push({ icon: '◎', label: 'Address', value: a }));
    const urls = reply.match(/https?:\/\/[^\s"')>]+/g);
    if (urls) urls.slice(0, 2).forEach(u => chips.push({ icon: '🔗', label: 'Link', value: u }));
    return chips;
  }

  /* ─────────────────────────────────────────────
     TTS
  ───────────────────────────────────────────── */
  function speak(text) {
    if (!S.speechSynth || text.length > 320) return;
    try {
      S.speechSynth.cancel();
      const utt = new SpeechSynthesisUtterance(text);
      utt.rate = 1.05; utt.pitch = 0.9; utt.volume = 0.9;
      utt.onstart = () => setStatus('SPEAKING…', 'speaking');
      utt.onend   = () => setStatus('ONLINE', 'idle');
      S.speechSynth.speak(utt);
    } catch (_) {}
  }

  /* ─────────────────────────────────────────────
     UI
  ───────────────────────────────────────────── */
  function setStatus(text, mode) {
    const el = document.getElementById('pill-status-text');
    if (el) el.textContent = text;
    ['pill-orb', 'exp-orb'].forEach(id => {
      const o = document.getElementById(id);
      if (!o) return;
      o.className = 'pill-orb';
      if (mode === 'listening') o.classList.add('listening');
      else if (mode === 'thinking') o.classList.add('thinking');
      else if (mode === 'speaking') o.classList.add('speaking');
    });
  }

  function setThinking(on, label) {
    S.thinking = on;
    const row = document.getElementById('thinking-row');
    if (!row) return;
    if (on) { row.classList.add('show'); const l = document.getElementById('thinking-label'); if (l) l.textContent = label || 'PROCESSING…'; }
    else row.classList.remove('show');
  }

  function setHearing(text) {
    const el = document.getElementById('notch-hearing');
    if (el) el.textContent = text || '';
  }

  function reportSize() {
    if (!window.jarvisDesktop?.notchResize) return;
    const n = document.getElementById('notch');
    const h = n ? Math.ceil(n.getBoundingClientRect().height) + 4 : 0;
    window.jarvisDesktop.notchResize({ height: h });
  }

  window.toggleExpand = function () {
    S.expanded = !S.expanded;
    document.getElementById('pill-expanded')?.classList.toggle('open', S.expanded);
    if (S.expanded) {
      setTimeout(() => document.getElementById('notch-input')?.focus(), 120);
      scrollTranscript();
    }
    reportSize();
  };

  function scrollTranscript() {
    const t = document.getElementById('notch-transcript');
    if (t) t.scrollTop = t.scrollHeight;
  }

  /* ── TRANSCRIPT ── */
  function addMsg(role, text, chips) {
    S.msgs.push({ role, text, chips: chips || [] });
    if (S.msgs.length > 40) S.msgs.shift();
    renderTranscript();
    if (!S.expanded) toggleExpand();
  }

  function renderTranscript() {
    const c = document.getElementById('notch-transcript');
    if (!c) return;
    c.innerHTML = S.msgs.slice(-20).map(m => {
      const isUser = m.role === 'user';
      const chipHtml = (m.chips || []).map(ch =>
        `<div class="data-chip" onclick="copyChip('${esc(ch.value)}')" title="Click to copy">
          <span>${ch.icon || '⬡'}</span><span>${esc(ch.label)}</span>
          <code style="font-size:10px;opacity:.8">${esc(ch.value.length > 24 ? ch.value.slice(0,12)+'…'+ch.value.slice(-6) : ch.value)}</code>
        </div>`
      ).join('');
      return `<div class="msg ${isUser ? 'user' : 'jarvis'}">
        <span class="msg-avatar">${isUser ? '▶' : '⬡'}</span>
        <div class="msg-bubble">${esc(m.text)}${chipHtml ? `<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px">${chipHtml}</div>` : ''}</div>
      </div>`;
    }).join('');
    scrollTranscript();
  }

  window.copyChip = function (val) {
    navigator.clipboard?.writeText(val).catch(() => {});
    setStatus('COPIED ✓', 'idle');
    setTimeout(() => setStatus('ONLINE', 'idle'), 1200);
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
  }

  /* ── KEYBOARD ── */
  function setupKeyboard() {
    const inp = document.getElementById('notch-input');
    if (inp) {
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); sendMessage(); }
        if (e.key === 'Escape') toggleExpand();
      });
    }
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && S.expanded) toggleExpand();
    });
  }

  /* ── UTIL ── */
  function apiFetch(path, opts) {
    return fetch(S.backendUrl + path, opts).then(r => r.json()).catch(() => null);
  }

  function blobToBase64(blob) {
    return new Promise(res => {
      const r = new FileReader();
      r.onload = () => res(r.result.split(',')[1]);
      r.readAsDataURL(blob);
    });
  }

  /* ── BOOT ── */
  boot();
})();
