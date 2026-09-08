// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — REMOTE PC VIEW WIDGET
//
// "Jarvis, show pc" opens this. It's a thin wrapper around an
// <iframe> pointed at Jarvis's E2B desktop sandbox's live VNC stream
// (see computer.js's ensureDesktopStream() / server.js's
// handlePcViewOpen()) — the stream itself is already a full
// browser-based VNC client with mouse/keyboard support, so this
// widget doesn't need to do any input-forwarding of its own.
//
// Also plays a companion <audio> element pointed at the sandbox's
// audio bridge (computer.js's ensureDesktopAudioStream()) when one is
// available — E2B's VNC stream itself is video-only, so this is a
// separate live HTTP audio stream running alongside it, not part of
// the iframe. Starts muted (autoplay-with-sound is blocked by every
// browser without a real user gesture first) — the "Sound" button is
// that gesture.
//
// window.PcViewWidget.show(streamUrl, opts?) / .hide()
//   opts.audioUrl — optional URL of the live audio bridge stream.
// ═══════════════════════════════════════════════════════════════

window.PcViewWidget = (function () {
  let scene = null, frame = null, statusEl = null, audioEl = null, unmuteBtn = null;

  function ensureDom() {
    if (scene) return;

    scene = document.createElement('div');
    scene.id = 'pcv-scene';
    scene.className = 'pcv-scene';
    scene.innerHTML = `
      <div class="pcv-card">
        <div class="pcv-head">
          <span class="pcv-title">JARVIS'S DESKTOP</span>
          <span class="pcv-status" id="pcv-status">loading…</span>
          <button class="pcv-unmute" id="pcv-unmute" title="Enable sound" hidden>&#128264; Sound</button>
          <button class="pcv-close" title="Close">&#10005;</button>
        </div>
        <div class="pcv-viewport">
          <iframe class="pcv-frame" id="pcv-frame" allow="clipboard-read; clipboard-write" title="Remote desktop"></iframe>
        </div>
      </div>
    `;
    document.body.appendChild(scene);

    frame = scene.querySelector('#pcv-frame');
    statusEl = scene.querySelector('#pcv-status');
    unmuteBtn = scene.querySelector('#pcv-unmute');
    scene.querySelector('.pcv-close').addEventListener('click', hide);

    frame.addEventListener('load', () => setStatus('live'));

    audioEl = document.createElement('audio');
    audioEl.id = 'pcv-audio';
    audioEl.autoplay = true;
    audioEl.muted = true;
    audioEl.style.display = 'none';
    scene.appendChild(audioEl);

    unmuteBtn.addEventListener('click', () => {
      audioEl.muted = false;
      audioEl.play().catch(() => {});
      unmuteBtn.hidden = true;
    });
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function show(streamUrl, opts) {
    ensureDom();
    scene.classList.add('in');
    if (!streamUrl) {
      setStatus('no stream URL');
      return;
    }
    setStatus('loading…');
    frame.src = streamUrl;

    const audioUrl = opts && opts.audioUrl;
    if (audioUrl) {
      audioEl.src = audioUrl;
      audioEl.muted = true;
      audioEl.play().catch(() => {}); // muted autoplay is always allowed; this just primes the stream
      unmuteBtn.hidden = false;
    } else {
      audioEl.removeAttribute('src');
      unmuteBtn.hidden = true;
    }
  }

  function hide() {
    if (scene) scene.classList.remove('in');
    if (frame) frame.src = 'about:blank';
    if (audioEl) { audioEl.pause(); audioEl.removeAttribute('src'); }
    if (unmuteBtn) unmuteBtn.hidden = true;
    // Closing the window used to only hide it client-side — the
    // sandbox kept running in the background regardless. This
    // actually tears it down server-side too. Fire-and-forget: the
    // window closes instantly either way, this just cleans up behind it.
    fetch('/api/pc/close', { method: 'POST' }).catch(() => {});
  }

  return { show, hide };
})();
