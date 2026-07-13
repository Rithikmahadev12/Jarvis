// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — FLOATING BOARD WIDGET
//
// Small info cards JARVIS can make on request ("make a board on
// how you work") and pull back up later by topic ("pull up the
// board we made on how you work") — rendered directly over the
// main screen (never a route/page, never a side panel).
//
//   - Grab it with a mouse, a finger, or a hand-tracking pinch
//     (rides the same [data-hand-drag] pointer pipeline the rest
//     of the app uses) and move it anywhere.
//   - The same drag also spins it in 3D — the faster/harder you
//     swipe, the longer it keeps turning, like flicking a real
//     object, with a slight tilt from vertical motion too.
//   - Drag it off the left or right edge of the screen to dismiss
//     it — that only removes it from view; the content itself is
//     saved on the server (boards.json) so asking for it again,
//     even after a full page refresh, brings the same board back.
//
// window.BoardWidget.show({ id, title, content }) — spawns/raises
//                                                    a board on screen.
// ═══════════════════════════════════════════════════════════════

window.BoardWidget = (function () {
  const EDGE_ZONE = 90; // px from either screen edge that arms dismissal
  const widgets = new Map(); // id -> { scene, card }
  let idCounter = 0;
  let spawnCount = 0;

  function ensureEdgeGlow() {
    if (document.getElementById('jb-edge-left')) return;
    const l = document.createElement('div');
    l.id = 'jb-edge-left'; l.className = 'jb-edge-glow left';
    const r = document.createElement('div');
    r.id = 'jb-edge-right'; r.className = 'jb-edge-glow right';
    document.body.appendChild(l);
    document.body.appendChild(r);
  }
  function setEdgeGlow(show, side) {
    const l = document.getElementById('jb-edge-left');
    const r = document.getElementById('jb-edge-right');
    if (l) l.classList.toggle('show', show && side === 'left');
    if (r) r.classList.toggle('show', show && side === 'right');
  }

  function nextSpawnPos() {
    const cascade = spawnCount++ % 5;
    return { x: 70 + cascade * 46, y: 90 + cascade * 34 };
  }

  function renderBody(content) {
    const lines = String(content || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) return '<div>Nothing on this one yet.</div>';
    return lines.map(l => `<div>${escapeHtml(l)}</div>`).join('');
  }
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function show({ id, title, content }) {
    ensureEdgeGlow();

    // Already on screen? Just re-show/raise it instead of duplicating.
    if (id && widgets.has(id)) {
      const w = widgets.get(id);
      w.scene.style.zIndex = 861 + (idCounter++);
      w.scene.classList.remove('dismissing');
      requestAnimationFrame(() => w.scene.classList.add('in'));
      return id;
    }

    const domId = 'jb-' + (idCounter++);
    const boardId = id || domId;

    const scene = document.createElement('div');
    scene.id = domId;
    scene.className = 'jb-scene';
    scene.dataset.handDrag = 'true'; // pinch-drag support (see hand-tracking.js)
    scene.innerHTML = `
      <div class="jb-card">
        <span class="jb-corner tl"></span><span class="jb-corner tr"></span>
        <span class="jb-corner bl"></span><span class="jb-corner br"></span>
        <div class="jb-head"><span>${escapeHtml((title || 'BOARD').toUpperCase())}</span><button class="jb-close" title="Dismiss">&#10005;</button></div>
        <div class="jb-body">${renderBody(content)}</div>
        <div class="jb-base"></div>
      </div>
    `;
    document.body.appendChild(scene);

    const pos = nextSpawnPos();
    scene.style.left = pos.x + 'px';
    scene.style.top = pos.y + 'px';

    const card = scene.querySelector('.jb-card');
    const w = { id: boardId, scene, card, rotY: 0, rotX: 0, velY: 0 };
    widgets.set(boardId, w);

    requestAnimationFrame(() => scene.classList.add('in'));

    scene.querySelector('.jb-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(boardId);
    });

    initDrag(w);
    return boardId;
  }

  // ── DRAG + SPIN (same gesture drives both: move it around, and
  //    swiping it makes it turn, with inertia like a flicked object) ──
  function initDrag(w) {
    const scene = w.scene;
    let dragging = false;
    let offsetX = 0, offsetY = 0, armedSide = null;
    let startX = 0, startY = 0, lastX = 0, lastT = 0;
    let inertiaRAF = null;

    function applyRotation() {
      w.card.style.transform = `rotateY(${w.rotY}deg) rotateX(${w.rotX}deg)`;
    }

    function stopInertia() {
      if (inertiaRAF) { cancelAnimationFrame(inertiaRAF); inertiaRAF = null; }
    }

    function runInertia() {
      stopInertia();
      const friction = 0.94;
      function tick() {
        w.velY *= friction;
        w.rotY += w.velY;
        w.rotX *= 0.9; // tilt settles back level quickly
        applyRotation();
        if (Math.abs(w.velY) > 0.05 || Math.abs(w.rotX) > 0.05) {
          inertiaRAF = requestAnimationFrame(tick);
        } else {
          inertiaRAF = null;
        }
      }
      inertiaRAF = requestAnimationFrame(tick);
    }

    scene.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.jb-close')) return;
      stopInertia();
      dragging = true;
      const rect = scene.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      startX = lastX = e.clientX;
      startY = e.clientY;
      lastT = performance.now();
      scene.classList.add('dragging');
      try { scene.setPointerCapture(e.pointerId); } catch (err) {}
    });

    scene.addEventListener('pointermove', (e) => {
      if (!dragging) return;

      // Position
      let x = e.clientX - offsetX;
      let y = e.clientY - offsetY;
      const maxY = window.innerHeight - scene.offsetHeight - 4;
      y = Math.min(Math.max(4, y), Math.max(4, maxY));
      x = Math.min(Math.max(-scene.offsetWidth * 0.4, x), window.innerWidth - scene.offsetWidth * 0.6);
      scene.style.left = x + 'px';
      scene.style.top = y + 'px';

      // Spin — driven live by drag delta since the gesture began, so
      // the board visibly turns as it's carried, like a real object.
      const dxTotal = e.clientX - startX;
      const dyTotal = e.clientY - startY;
      w.rotY = dxTotal * 0.35;
      w.rotX = Math.max(-18, Math.min(18, -dyTotal * 0.12));
      applyRotation();

      // Track instantaneous velocity for release-time inertia
      const now = performance.now();
      const dt = Math.max(1, now - lastT);
      w.velY = ((e.clientX - lastX) / dt) * 16; // deg per frame-ish, tuned by feel
      lastX = e.clientX;
      lastT = now;

      // Edge-dismiss arming
      const centerX = x + scene.offsetWidth / 2;
      if (centerX < EDGE_ZONE) armedSide = 'left';
      else if (centerX > window.innerWidth - EDGE_ZONE) armedSide = 'right';
      else armedSide = null;
      scene.classList.toggle('edge-armed', !!armedSide);
      setEdgeGlow(!!armedSide, armedSide);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      scene.classList.remove('dragging');
      try { scene.releasePointerCapture(e.pointerId); } catch (err) {}
      setEdgeGlow(false);

      if (armedSide) {
        dismiss(w.id, armedSide);
      } else {
        const rect = scene.getBoundingClientRect();
        const clampedX = Math.min(Math.max(4, rect.left), window.innerWidth - scene.offsetWidth - 4);
        scene.style.left = clampedX + 'px';
        runInertia(); // let the spin coast to a stop
      }
      armedSide = null;
    }
    scene.addEventListener('pointerup', endDrag);
    scene.addEventListener('pointercancel', endDrag);
  }

  function dismiss(id) {
    const w = widgets.get(id);
    if (!w) return;
    w.scene.classList.add('dismissing');
    setTimeout(() => {
      w.scene.remove();
      widgets.delete(id);
    }, 340);
  }

  return { show, dismiss };
})();
