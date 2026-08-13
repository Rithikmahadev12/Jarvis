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
// window.PcViewWidget.show(streamUrl) / .hide()
// ═══════════════════════════════════════════════════════════════

window.PcViewWidget = (function () {
  let scene = null, frame = null, statusEl = null;

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
    scene.querySelector('.pcv-close').addEventListener('click', hide);

    frame.addEventListener('load', () => setStatus('live'));
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function show(streamUrl) {
    ensureDom();
    scene.classList.add('in');
    if (!streamUrl) {
      setStatus('no stream URL');
      return;
    }
    setStatus('loading…');
    frame.src = streamUrl;
  }

  function hide() {
    if (scene) scene.classList.remove('in');
    if (frame) frame.src = 'about:blank';
  }

  return { show, hide };
})();
