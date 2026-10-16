// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Internet Face Lookup Module
// Save as: public/internet-face-lookup.js
// Drop <script src="internet-face-lookup.js"></script> in index.html
// AFTER retina-scan.js
//
// FLOW:
//   1. Receives a 128-d face descriptor (from face-api) + a captured frame
//   2. POSTs frame to /api/face-lookup/image-search → server uses Firecrawl
//      to reverse-image-search Google Lens and scrape result pages
//   3. If Firecrawl finds a candidate name → /api/face-lookup/sixtyfour
//      fires a SixtyFour people-intelligence async lookup
//   4. HUD panel appears: "IS THIS YOU?" with name, confidence, links
//   5. User hits YES → auto-enroll + register → drop straight into Jarvis
//   6. User hits NO or times out → access denied
// ═══════════════════════════════════════════════════════════════

window.InternetFaceLookup = (function () {

  // ── STATE ──────────────────────────────────────────────────
  const ifl = {
    panel:        null,
    active:       false,
    onResult:     null,
    pollTimer:    null,
    currentTaskId: null,
  };

  // ── HUD PANEL BUILDER ──────────────────────────────────────
  function buildPanel() {
    if (document.getElementById('ifl-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'ifl-panel';
    panel.innerHTML = `
      <div id="ifl-inner">
        <div id="ifl-header">
          <span class="ifl-corner tl"></span>
          <span class="ifl-corner tr"></span>
          <div id="ifl-title-row">
            <div id="ifl-scan-ring"></div>
            <div id="ifl-title">INTERNET FACE LOOKUP</div>
          </div>
          <div id="ifl-subtitle">SEARCHING GLOBAL DATABASE…</div>
        </div>

        <div id="ifl-loading-block">
          <div class="ifl-bar-wrap"><div class="ifl-bar-fill" id="ifl-bar"></div></div>
          <div id="ifl-stage-label">INITIALIZING FIRECRAWL SEARCH ENGINE…</div>
        </div>

        <div id="ifl-result-block" class="hidden">
          <div id="ifl-match-row">
            <div id="ifl-avatar-wrap">
              <div id="ifl-avatar-ring"></div>
              <div id="ifl-avatar-inner">?</div>
            </div>
            <div id="ifl-match-info">
              <div id="ifl-match-name">—</div>
              <div id="ifl-match-headline">—</div>
              <div id="ifl-match-location">—</div>
            </div>
          </div>

          <div id="ifl-confidence-row">
            <div class="ifl-data-cell">
              <div class="ifl-data-label">CONFIDENCE</div>
              <div class="ifl-data-val" id="ifl-conf">—</div>
            </div>
            <div class="ifl-data-cell">
              <div class="ifl-data-label">SOURCES</div>
              <div class="ifl-data-val" id="ifl-sources">—</div>
            </div>
            <div class="ifl-data-cell">
              <div class="ifl-data-label">PLATFORM</div>
              <div class="ifl-data-val" id="ifl-platform">—</div>
            </div>
          </div>

          <div id="ifl-links-row"></div>

          <div id="ifl-question">IS THIS YOU?</div>

          <div id="ifl-btn-row">
            <button id="ifl-yes-btn">✓ YES — SIGN ME IN</button>
            <button id="ifl-no-btn">✗ NO — DENY ACCESS</button>
          </div>

          <div id="ifl-signup-block" class="hidden">
            <div id="ifl-signup-title">SIGN UP TO USE JARVIS?</div>
            <div id="ifl-signup-sub">Your face will be enrolled as your login credential.</div>
            <div id="ifl-signup-fields">
              <input id="ifl-inp-name"  type="text" placeholder="Full name" autocomplete="off"/>
              <select id="ifl-inp-title">
                <option value="Sir">Sir</option>
                <option value="Ma'am">Ma'am</option>
                <option value="Boss">Boss</option>
                <option value="Chief">Chief</option>
              </select>
            </div>
            <div id="ifl-signup-btns">
              <button id="ifl-signup-confirm">ENROLL & ENTER JARVIS</button>
              <button id="ifl-signup-cancel">CANCEL</button>
            </div>
            <div id="ifl-signup-status"></div>
          </div>
        </div>

        <div id="ifl-denied-block" class="hidden">
          <div id="ifl-denied-icon">⛔</div>
          <div id="ifl-denied-text">ACCESS DENIED</div>
          <div id="ifl-denied-sub">No identity confirmed.</div>
        </div>

        <span class="ifl-corner bl"></span>
        <span class="ifl-corner br"></span>
      </div>
    `;

    // Styles
    const style = document.createElement('style');
    style.id = 'ifl-styles';
    style.textContent = `
      #ifl-panel {
        position: fixed; inset: 0; z-index: 99999;
        display: flex; align-items: center; justify-content: center;
        background: rgba(0,0,0,0.82);
        backdrop-filter: blur(12px);
        font-family: 'Orbitron', 'Courier New', monospace;
        animation: iflFadeIn 0.4s ease;
      }
      #ifl-panel.hidden { display: none; }
      @keyframes iflFadeIn { from { opacity:0; transform:scale(0.95); } to { opacity:1; transform:scale(1); } }

      #ifl-inner {
        position: relative;
        width: min(520px, 94vw);
        background: linear-gradient(145deg, rgba(0,15,30,0.98) 0%, rgba(0,5,20,0.99) 100%);
        border: 1px solid rgba(0,200,255,0.25);
        box-shadow: 0 0 60px rgba(0,200,255,0.12), inset 0 0 40px rgba(0,200,255,0.04);
        padding: 28px 28px 24px;
        color: #00c8ff;
      }
      .ifl-corner {
        position: absolute; width: 14px; height: 14px;
        border-color: rgba(0,200,255,0.6); border-style: solid;
      }
      .ifl-corner.tl { top:8px;  left:8px;  border-width: 2px 0 0 2px; }
      .ifl-corner.tr { top:8px;  right:8px; border-width: 2px 2px 0 0; }
      .ifl-corner.bl { bottom:8px; left:8px;  border-width: 0 0 2px 2px; }
      .ifl-corner.br { bottom:8px; right:8px; border-width: 0 2px 2px 0; }

      #ifl-title-row {
        display: flex; align-items: center; gap: 12px; margin-bottom: 4px;
      }
      #ifl-scan-ring {
        width: 18px; height: 18px; border-radius: 50%;
        border: 2px solid #00c8ff;
        border-top-color: transparent;
        animation: iflSpin 1s linear infinite;
        flex-shrink: 0;
      }
      @keyframes iflSpin { to { transform: rotate(360deg); } }
      #ifl-title {
        font-size: 0.7rem; letter-spacing: 0.35em;
        color: #00c8ff; font-weight: 700;
      }
      #ifl-subtitle {
        font-size: 0.5rem; letter-spacing: 0.25em;
        color: rgba(0,200,255,0.45); margin-bottom: 20px;
        padding-left: 30px;
      }

      /* Loading */
      .ifl-bar-wrap {
        height: 3px; background: rgba(0,200,255,0.1);
        margin-bottom: 10px; overflow: hidden;
      }
      .ifl-bar-fill {
        height: 100%; width: 0%; background: #00c8ff;
        transition: width 0.6s ease;
        box-shadow: 0 0 8px #00c8ff;
      }
      #ifl-stage-label {
        font-size: 0.48rem; letter-spacing: 0.2em;
        color: rgba(0,200,255,0.6); text-align: center;
        min-height: 16px;
      }

      /* Result */
      #ifl-result-block.hidden, #ifl-denied-block.hidden,
      #ifl-signup-block.hidden { display: none !important; }

      #ifl-match-row {
        display: flex; align-items: center; gap: 16px;
        margin-bottom: 18px;
      }
      #ifl-avatar-wrap {
        position: relative; width: 72px; height: 72px;
        flex-shrink: 0;
      }
      #ifl-avatar-ring {
        position: absolute; inset: -5px; border-radius: 50%;
        border: 2px solid rgba(0,200,255,0.5);
        animation: iflPulse 2s ease-in-out infinite;
      }
      @keyframes iflPulse {
        0%,100% { opacity:0.5; transform:scale(1); }
        50% { opacity:1; transform:scale(1.06); }
      }
      #ifl-avatar-inner {
        width: 72px; height: 72px; border-radius: 50%;
        background: rgba(0,200,255,0.1);
        border: 1px solid rgba(0,200,255,0.3);
        display: flex; align-items: center; justify-content: center;
        font-size: 1.8rem;
        font-family: sans-serif;
        overflow: hidden;
      }
      #ifl-avatar-inner img { width: 100%; height: 100%; object-fit: cover; border-radius: 50%; }
      #ifl-match-name {
        font-size: 1.1rem; letter-spacing: 0.08em;
        color: #fff; font-weight: 700; margin-bottom: 4px;
      }
      #ifl-match-headline {
        font-size: 0.48rem; letter-spacing: 0.12em;
        color: rgba(0,200,255,0.7); margin-bottom: 3px;
      }
      #ifl-match-location {
        font-size: 0.44rem; letter-spacing: 0.1em;
        color: rgba(255,255,255,0.35);
      }

      #ifl-confidence-row {
        display: flex; gap: 12px; margin-bottom: 14px;
      }
      .ifl-data-cell {
        flex: 1; background: rgba(0,200,255,0.05);
        border: 1px solid rgba(0,200,255,0.15);
        padding: 8px 10px;
        text-align: center;
      }
      .ifl-data-label {
        font-size: 0.4rem; letter-spacing: 0.2em;
        color: rgba(0,200,255,0.5); margin-bottom: 4px;
      }
      .ifl-data-val {
        font-size: 0.7rem; letter-spacing: 0.08em;
        color: #00c8ff; font-weight: 700;
      }

      #ifl-links-row {
        display: flex; flex-wrap: wrap; gap: 6px;
        margin-bottom: 18px; min-height: 0;
      }
      #ifl-links-row a {
        font-size: 0.42rem; letter-spacing: 0.15em;
        color: rgba(0,200,255,0.6);
        background: rgba(0,200,255,0.07);
        border: 1px solid rgba(0,200,255,0.2);
        padding: 4px 8px; text-decoration: none;
        transition: all 0.2s;
      }
      #ifl-links-row a:hover { background: rgba(0,200,255,0.18); color: #00c8ff; }

      #ifl-question {
        font-size: 1rem; letter-spacing: 0.25em;
        color: #fff; text-align: center;
        margin-bottom: 14px; font-weight: 700;
        text-shadow: 0 0 20px rgba(0,200,255,0.5);
      }

      #ifl-btn-row {
        display: flex; gap: 12px; margin-bottom: 0;
      }
      #ifl-btn-row button {
        flex: 1; padding: 12px;
        font-family: inherit; font-size: 0.58rem;
        letter-spacing: 0.18em; font-weight: 700;
        border: 1px solid; cursor: pointer;
        transition: all 0.2s;
        background: transparent;
      }
      #ifl-yes-btn {
        border-color: #00c8ff; color: #00c8ff;
      }
      #ifl-yes-btn:hover {
        background: rgba(0,200,255,0.15);
        box-shadow: 0 0 20px rgba(0,200,255,0.3);
      }
      #ifl-no-btn {
        border-color: rgba(255,80,80,0.5); color: rgba(255,80,80,0.7);
      }
      #ifl-no-btn:hover { background: rgba(255,60,60,0.12); }

      /* Signup block */
      #ifl-signup-block {
        margin-top: 20px; padding-top: 18px;
        border-top: 1px solid rgba(0,200,255,0.15);
      }
      #ifl-signup-title {
        font-size: 0.65rem; letter-spacing: 0.25em;
        color: #fff; margin-bottom: 6px; text-align: center;
      }
      #ifl-signup-sub {
        font-size: 0.44rem; letter-spacing: 0.1em;
        color: rgba(0,200,255,0.5); text-align: center; margin-bottom: 14px;
      }
      #ifl-signup-fields {
        display: flex; gap: 10px; margin-bottom: 12px;
      }
      #ifl-signup-fields input, #ifl-signup-fields select {
        flex: 1; background: rgba(0,200,255,0.05);
        border: 1px solid rgba(0,200,255,0.25);
        color: #fff; padding: 9px 12px;
        font-family: inherit; font-size: 0.55rem;
        letter-spacing: 0.08em; outline: none;
      }
      #ifl-signup-fields select { flex: 0 0 100px; color: #00c8ff; }
      #ifl-signup-fields input::placeholder { color: rgba(0,200,255,0.35); }
      #ifl-signup-btns { display: flex; gap: 10px; }
      #ifl-signup-confirm {
        flex: 1; padding: 11px;
        font-family: inherit; font-size: 0.55rem;
        letter-spacing: 0.15em; font-weight: 700;
        background: rgba(0,200,255,0.12);
        border: 1px solid #00c8ff; color: #00c8ff;
        cursor: pointer; transition: all 0.2s;
      }
      #ifl-signup-confirm:hover { background: rgba(0,200,255,0.25); box-shadow: 0 0 20px rgba(0,200,255,0.3); }
      #ifl-signup-cancel {
        padding: 11px 20px;
        font-family: inherit; font-size: 0.5rem;
        letter-spacing: 0.12em;
        background: transparent;
        border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.4);
        cursor: pointer; transition: all 0.2s;
      }
      #ifl-signup-status {
        margin-top: 10px; font-size: 0.48rem;
        letter-spacing: 0.12em; text-align: center;
        color: rgba(0,200,255,0.7); min-height: 16px;
      }

      /* Denied */
      #ifl-denied-block {
        text-align: center; padding: 30px 0 10px;
      }
      #ifl-denied-icon { font-size: 2.5rem; margin-bottom: 12px; }
      #ifl-denied-text {
        font-size: 1rem; letter-spacing: 0.3em;
        color: #ff4444; font-weight: 700; margin-bottom: 8px;
      }
      #ifl-denied-sub {
        font-size: 0.48rem; letter-spacing: 0.15em;
        color: rgba(255,255,255,0.35);
      }
    `;

    if (!document.getElementById('ifl-styles')) document.head.appendChild(style);
    document.body.appendChild(panel);
    ifl.panel = panel;

    document.getElementById('ifl-yes-btn').addEventListener('click', onUserSaidYes);
    document.getElementById('ifl-no-btn').addEventListener('click', onUserSaidNo);
    document.getElementById('ifl-signup-confirm').addEventListener('click', onSignupConfirm);
    document.getElementById('ifl-signup-cancel').addEventListener('click', onSignupCancel);
  }

  // ── STAGE PROGRESS ─────────────────────────────────────────
  const STAGES = [
    { pct: 8,  label: 'CAPTURING FACE FRAME…' },
    { pct: 18, label: 'ENCODING BIOMETRIC VECTOR…' },
    { pct: 30, label: 'LAUNCHING FIRECRAWL REVERSE IMAGE SEARCH…' },
    { pct: 45, label: 'CRAWLING GOOGLE LENS RESULTS…' },
    { pct: 60, label: 'EXTRACTING CANDIDATE IDENTITIES…' },
    { pct: 72, label: 'FIRING SIXTYFOUR OSINT LOOKUP…' },
    { pct: 85, label: 'AGGREGATING INTELLIGENCE PROFILE…' },
    { pct: 95, label: 'CROSS-REFERENCING PUBLIC RECORDS…' },
  ];
  let _stageIdx = 0;
  let _stageTimer = null;

  function setBar(pct) {
    const bar = document.getElementById('ifl-bar');
    if (bar) bar.style.width = pct + '%';
  }
  function setStageLabel(text) {
    const el = document.getElementById('ifl-stage-label');
    if (el) el.textContent = text;
  }
  function setSubtitle(text) {
    const el = document.getElementById('ifl-subtitle');
    if (el) el.textContent = text;
  }

  function startStageAnimation() {
    _stageIdx = 0;
    function tick() {
      if (_stageIdx >= STAGES.length) return;
      const s = STAGES[_stageIdx++];
      setBar(s.pct);
      setStageLabel(s.label);
      _stageTimer = setTimeout(tick, 1800 + Math.random() * 800);
    }
    tick();
  }
  function stopStageAnimation() {
    if (_stageTimer) clearTimeout(_stageTimer);
  }

  // ── CAPTURE FRAME AS BASE64 ────────────────────────────────
  function captureFrameBase64(videoEl, size = 512) {
    try {
      const c  = document.createElement('canvas');
      c.width  = size;
      c.height = size;
      const ctx = c.getContext('2d');
      const vw = videoEl.videoWidth  || videoEl.width  || size;
      const vh = videoEl.videoHeight || videoEl.height || size;
      const scale = size / Math.min(vw, vh);
      const dw    = vw * scale;
      const dh    = vh * scale;
      ctx.drawImage(videoEl, (size - dw) / 2, (size - dh) / 2, dw, dh);
      return c.toDataURL('image/jpeg', 0.88).split(',')[1];
    } catch (e) {
      console.warn('[IFL] frame capture failed', e.message);
      return null;
    }
  }

  // ── SHOW RESULT PANEL ──────────────────────────────────────
  function showResult(profile, confidence, sources) {
    stopStageAnimation();
    setBar(100);
    setStageLabel('IDENTITY LOCATED — CONFIRM BELOW');
    setSubtitle('MATCH FOUND — AWAITING CONFIRMATION');

    const spinEl = document.getElementById('ifl-scan-ring');
    if (spinEl) { spinEl.style.borderTopColor = '#00c8ff'; spinEl.style.borderColor = 'rgba(0,200,255,0.3)'; spinEl.style.animation = 'none'; }

    document.getElementById('ifl-loading-block').classList.add('hidden');
    document.getElementById('ifl-result-block').classList.remove('hidden');

    document.getElementById('ifl-match-name').textContent     = profile.full_name || profile.name || 'UNKNOWN';
    document.getElementById('ifl-match-headline').textContent = profile.headline  || profile.summary?.slice(0, 80) || '—';
    document.getElementById('ifl-match-location').textContent = profile.location  || '—';

    document.getElementById('ifl-conf').textContent     = Math.round((confidence || 0) * 100) + '%';
    document.getElementById('ifl-sources').textContent  = sources || '—';
    document.getElementById('ifl-platform').textContent = profile._source || 'WEB';

    // Profile links
    const linksEl = document.getElementById('ifl-links-row');
    linksEl.innerHTML = '';
    const linkFields = ['linkedin_url','twitter_url','instagram_url','github_url','website_url','facebook_url','tiktok_url'];
    for (const f of linkFields) {
      if (!profile[f]) continue;
      const a = document.createElement('a');
      a.href   = profile[f];
      a.target = '_blank';
      a.rel    = 'noopener noreferrer';
      a.textContent = f.replace('_url','').toUpperCase();
      linksEl.appendChild(a);
    }

    // Pre-fill name
    const nameInp = document.getElementById('ifl-inp-name');
    if (nameInp) nameInp.value = profile.full_name || profile.name || '';
  }

  function showDenied(reason) {
    stopStageAnimation();
    if (!ifl.panel) return;
    const lb = document.getElementById('ifl-loading-block');
    const rb = document.getElementById('ifl-result-block');
    const db = document.getElementById('ifl-denied-block');
    if (lb) lb.classList.add('hidden');
    if (rb) rb.classList.add('hidden');
    if (db) db.classList.remove('hidden');
    document.getElementById('ifl-denied-sub').textContent = reason || 'No match found online.';
    setTimeout(() => {
      close();
      if (ifl.onResult) ifl.onResult({ found: false, enrolled: false, reason });
    }, 2800);
  }

  // ── USER INTERACTIONS ──────────────────────────────────────
  let _pendingProfile  = null;
  let _pendingDescriptor = null;

  function onUserSaidYes() {
    // Show signup block
    const sb = document.getElementById('ifl-signup-block');
    if (sb) sb.classList.remove('hidden');
    document.getElementById('ifl-btn-row').style.opacity = '0.4';
    document.getElementById('ifl-btn-row').style.pointerEvents = 'none';
    document.getElementById('ifl-question').textContent = 'SIGN UP TO USE JARVIS?';
  }

  function onUserSaidNo() {
    showDenied('User denied identity match.');
  }

  async function onSignupConfirm() {
    const name  = (document.getElementById('ifl-inp-name')?.value || '').trim();
    const title = document.getElementById('ifl-inp-title')?.value || 'Sir';
    const statusEl = document.getElementById('ifl-signup-status');

    if (!name) { if (statusEl) statusEl.textContent = 'ENTER YOUR NAME FIRST'; return; }
    if (!_pendingDescriptor || _pendingDescriptor.length !== 128) {
      if (statusEl) statusEl.textContent = 'ERROR — NO FACE DATA'; return;
    }

    if (statusEl) statusEl.textContent = 'ENROLLING FACE — STAND BY…';
    document.getElementById('ifl-signup-confirm').disabled = true;

    try {
      const res  = await fetch('/api/register', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          title,
          faceDescriptor: Array.from(_pendingDescriptor),
          voiceAliases:   [],
          passcode:       null,
          _internetEnrolled: true,
          _sourceProfile:   _pendingProfile,
        }),
      });
      const data = await res.json();

      if (res.status === 403) {
        if (statusEl) statusEl.textContent = data.error || 'RESERVED USERNAME — TRY ANOTHER NAME';
        document.getElementById('ifl-signup-confirm').disabled = false;
        return;
      }
      if (!data.success) throw new Error('Server rejected registration');

      if (statusEl) statusEl.textContent = 'OK. SIGNED UP. WELCOME.';

      setTimeout(() => {
        close();
        if (ifl.onResult) ifl.onResult({
          found:    true,
          enrolled: true,
          profile:  { name, title, faceDescriptor: Array.from(_pendingDescriptor) },
        });
      }, 1200);

    } catch (e) {
      if (statusEl) statusEl.textContent = 'SERVER ERROR — CHECK JARVIS IS RUNNING';
      document.getElementById('ifl-signup-confirm').disabled = false;
    }
  }

  function onSignupCancel() {
    showDenied('Sign-up cancelled by user.');
  }

  // ── CLOSE ──────────────────────────────────────────────────
  function close() {
    ifl.active = false;
    if (ifl.panel) ifl.panel.classList.add('hidden');
    if (ifl.pollTimer) { clearInterval(ifl.pollTimer); ifl.pollTimer = null; }
  }

  // ── MAIN ENTRY POINT ───────────────────────────────────────
  // videoEl   — the camera video element that already has a face in frame
  // descriptor — Float32Array(128) from face-api
  // onResult  — callback({ found, enrolled, profile?, reason? })
  async function search(videoEl, descriptor, onResult) {
    if (ifl.active) return;
    ifl.active    = true;
    ifl.onResult  = onResult;
    _pendingDescriptor = descriptor;
    _pendingProfile    = null;

    buildPanel();
    ifl.panel.classList.remove('hidden');

    // Reset UI
    document.getElementById('ifl-loading-block').classList.remove('hidden');
    document.getElementById('ifl-result-block').classList.add('hidden');
    document.getElementById('ifl-denied-block').classList.add('hidden');
    document.getElementById('ifl-signup-block').classList.add('hidden');
    document.getElementById('ifl-btn-row').style.opacity = '';
    document.getElementById('ifl-btn-row').style.pointerEvents = '';
    document.getElementById('ifl-question').textContent = 'IS THIS YOU?';
    setBar(0);

    const spinEl = document.getElementById('ifl-scan-ring');
    if (spinEl) { spinEl.style.animation = 'iflSpin 1s linear infinite'; }

    startStageAnimation();

    // Capture frame
    const frameB64 = captureFrameBase64(videoEl, 480);
    if (!frameB64) {
      showDenied('Failed to capture camera frame.');
      return;
    }

    try {
      // Step 1: Firecrawl image search
      const searchRes = await fetch('/api/face-lookup/image-search', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: frameB64 }),
      });
      const searchData = await searchRes.json();

      if (!searchData.success || !searchData.candidates?.length) {
        showDenied('No identity match found on the internet.');
        return;
      }

      // Best candidate
      const topCandidate = searchData.candidates[0];
      setStageLabel('CANDIDATE FOUND — RUNNING SIXTYFOUR OSINT…');
      setBar(72);

      // Step 2: SixtyFour async lookup
      const lookupRes = await fetch('/api/face-lookup/sixtyfour', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: topCandidate.name, url: topCandidate.url }),
      });
      const lookupData = await lookupRes.json();

      if (!lookupData.success) {
        // Firecrawl found name but SixtyFour failed — use Firecrawl data alone
        _pendingProfile = { full_name: topCandidate.name, _source: 'FIRECRAWL', ...topCandidate };
        showResult(_pendingProfile, topCandidate.confidence, searchData.candidates.length + ' PAGES');
        return;
      }

      if (lookupData.status === 'complete') {
        _pendingProfile = { ...(lookupData.profile || {}), _source: 'SIXTYFOUR+FIRECRAWL' };
        showResult(_pendingProfile, topCandidate.confidence, searchData.candidates.length + ' PAGES');
      } else {
        // Poll for SixtyFour async completion
        const taskId = lookupData.taskId;
        ifl.currentTaskId = taskId;
        let polls = 0;
        const MAX_POLLS = 30;
        ifl.pollTimer = setInterval(async () => {
          polls++;
          if (polls > MAX_POLLS) {
            clearInterval(ifl.pollTimer);
            _pendingProfile = { full_name: topCandidate.name, _source: 'FIRECRAWL', ...topCandidate };
            showResult(_pendingProfile, topCandidate.confidence, searchData.candidates.length + ' PAGES');
            return;
          }
          try {
            const statusRes  = await fetch(`/api/face-lookup/sixtyfour-status/${taskId}`);
            const statusData = await statusRes.json();
            if (statusData.status === 'complete') {
              clearInterval(ifl.pollTimer);
              _pendingProfile = { ...(statusData.profile || {}), full_name: topCandidate.name, _source: 'SIXTYFOUR+FIRECRAWL' };
              showResult(_pendingProfile, topCandidate.confidence, searchData.candidates.length + ' PAGES');
            }
          } catch (_) {}
        }, 4000);
      }

    } catch (e) {
      console.error('[IFL] search error', e);
      showDenied('Network error during lookup.');
    }
  }

  return { search, close };

})();
