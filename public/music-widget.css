/* ═══════════════════════════════════════════════════════════════
   J.A.R.V.I.S — MUSIC WIDGET (styles)
   Floating "now playing" card for music-widget.js. Draggable,
   fixed-size cover art (never blows up to the image's native
   size), and an animated color-wheel ring around the edge.
   Also covers the shrunk-down ".mw-embedded" variant that mounts
   inside the dashboard's MUSIC card (see dashboard.css / .js).
   ═══════════════════════════════════════════════════════════════ */

.music-widget {
  position: fixed;
  right: 24px;
  bottom: 24px;
  width: 230px;
  z-index: 640;
  border-radius: 22px;
  padding: 3px;
  box-sizing: border-box;
  isolation: isolate;
  overflow: hidden;
  font-family: var(--raj, 'Rajdhani', sans-serif);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
  cursor: grab;
  touch-action: none;
}
.music-widget.dragging { cursor: grabbing; }
.music-widget.hidden { display: none; }

/* Animated color-wheel ring — a big rotating conic-gradient sits behind
   everything (clipped to the rounded rect by overflow:hidden above);
   the opaque card content on top covers all of it except a thin ring
   at the very edge, so what's actually visible is a spinning rainbow
   border rather than a flat/static gradient. Rotation speed, glow
   blur/opacity, and scale are driven live by music-widget.js's ring
   loop (--mw-angle/--mw-scale/--mw-glow-opacity/--mw-blur) so the ring
   spins up and flares brighter on the beat instead of just looping at
   a constant rate. Falls back to the plain --mw-angle default (0deg,
   static) if JS hasn't started the loop yet. */
.music-widget::before {
  content: "";
  position: absolute;
  inset: -60%;
  background: conic-gradient(from var(--mw-angle, 0deg),
    #ff2d95, #ff5a3c, #ffb020, #ffe135, #6bff5a, #00d2ff, #7a3cff, #ff2d95);
  opacity: var(--mw-glow-opacity, 0.85);
  filter: blur(var(--mw-blur, 2px));
  transform: scale(var(--mw-scale, 1));
  z-index: 0;
}

.mw-close {
  position: absolute;
  top: 9px;
  right: 9px;
  z-index: 3;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: none;
  background: rgba(0, 0, 0, 0.35);
  color: rgba(255, 255, 255, 0.75);
  font-size: 0.7rem;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.mw-close:hover { background: rgba(255, 45, 90, 0.55); color: #fff; }

.mw-content {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  border-radius: 19px;
  background: rgba(9, 12, 18, 0.94);
  backdrop-filter: blur(16px) saturate(140%);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  border: 1px solid rgba(255, 255, 255, 0.06);
  overflow: hidden;
}

/* Cover art — fixed square, never grows past the card no matter how
   large the source image actually is (this was the bug: with no CSS
   at all, a 1200x1200 artwork URL rendered at its native pixel size). */
.mw-art {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  flex-shrink: 0;
  background: linear-gradient(135deg, #141a22, #05080c);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.mw-art img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.mw-art #mw-art-fallback {
  width: 34px;
  height: 34px;
  color: rgba(255, 255, 255, 0.28);
}
.mw-art.playing #mw-art-fallback { color: rgba(255, 255, 255, 0.4); }

.mw-info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 14px 14px;
  min-width: 0;
}

.mw-title {
  color: #fff;
  font-size: 0.92rem;
  font-weight: 600;
  line-height: 1.25;
  overflow: hidden;
  text-overflow: ellipsis;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.mw-artist {
  color: rgba(210, 225, 235, 0.62);
  font-size: 0.76rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mw-album {
  color: rgba(190, 205, 220, 0.4);
  font-size: 0.68rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.mw-album:empty { display: none; }

.mw-progress-container {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-top: 8px;
  color: rgba(200, 220, 235, 0.5);
  font-family: var(--mono, 'Share Tech Mono', monospace);
  font-size: 0.6rem;
}
.mw-progress-track {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: rgba(255, 255, 255, 0.14);
  cursor: pointer;
  position: relative;
}
.mw-progress-fill {
  position: absolute;
  inset: 0 auto 0 0;
  width: 0%;
  border-radius: 2px;
  background: linear-gradient(90deg, #ff2d95, #00d2ff);
}

.mw-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 10px;
}
.mw-btn {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.8);
  width: 30px;
  height: 30px;
  border-radius: 50%;
  font-size: 0.75rem;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, transform 0.15s ease;
}
.mw-btn:hover { background: rgba(255, 255, 255, 0.14); color: #fff; transform: scale(1.06); }
.mw-btn#mw-playpause {
  width: 36px;
  height: 36px;
  font-size: 0.85rem;
  background: #00d2ff;
  border-color: #00d2ff;
  color: #04141c;
}
.mw-btn#mw-playpause:hover { background: #33dcff; }
.mw-btn#mw-repeat.active { background: #ff2d95; border-color: #ff2d95; color: #fff; }

#mw-yt-mount {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
}
#mw-audio { display: none; }

/* ── Embedded in the dashboard's MUSIC card ───────────────────
   Compact horizontal "media bar" layout instead of the floating
   card look — no drag, no rotating ring, no close button, sized
   to sit inside the ~240px dashboard widget. */
.music-widget.mw-embedded {
  position: relative;
  inset: auto;
  right: auto;
  bottom: auto;
  width: 100%;
  padding: 0;
  border-radius: 0;
  box-shadow: none;
  cursor: default;
  overflow: visible;
}
.music-widget.mw-embedded::before { display: none; }
.music-widget.mw-embedded .mw-close { display: none; }
.music-widget.mw-embedded .mw-content {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  background: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border: none;
  border-radius: 0;
}
.music-widget.mw-embedded .mw-art {
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  border-radius: 10px;
}
.music-widget.mw-embedded .mw-info { padding: 0; flex: 1; min-width: 0; }
.music-widget.mw-embedded .mw-title { font-size: 0.82rem; -webkit-line-clamp: 1; }
.music-widget.mw-embedded .mw-artist { font-size: 0.7rem; }
.music-widget.mw-embedded .mw-album { display: none; }
.music-widget.mw-embedded .mw-progress-container { margin-top: 5px; }
.music-widget.mw-embedded .mw-controls { justify-content: flex-start; gap: 8px; margin-top: 6px; }
.music-widget.mw-embedded .mw-btn { width: 24px; height: 24px; font-size: 0.62rem; }
.music-widget.mw-embedded .mw-btn#mw-playpause { width: 28px; height: 28px; font-size: 0.7rem; }

@media (max-width: 520px) {
  .music-widget:not(.mw-embedded) { width: min(78vw, 210px); right: 14px; bottom: 14px; }
}
