// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — THEME SYNC v1.0
// One shared "accent color" that every page (main HUD, map, news,
// build mode, widget-host, hologram views, monitor wall...) pulls
// from. The dashboard samples the user's wallpaper and calls
// JarvisTheme.setFromImageURL(url) — every other open page picks
// the change up live via the native `storage` event, and every
// fresh page load applies it instantly (runs synchronously, before
// paint, so there's no flash of the old color).
// Include this script as early as possible in <head>, before other
// stylesheets/scripts, on any page that should react to the theme.
// ═══════════════════════════════════════════════════════════════
(function () {
  "use strict";

  const STORAGE_KEY = "jarvis_theme_accent_v1"; // {r,g,b}

  function clamp(n) { return Math.max(0, Math.min(255, Math.round(n))); }

  // Push a sampled color toward a usable HUD accent: bright and
  // saturated enough to read against the dark UI, whatever the
  // source pixel looked like.
  function normalizeAccent(r, g, b) {
    let max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lum = (max + min) / 2;
    // too dark → lighten toward the color's own hue
    if (lum < 90) {
      const boost = (90 - lum) / 255;
      r = clamp(r + (255 - r) * boost);
      g = clamp(g + (255 - g) * boost);
      b = clamp(b + (255 - b) * boost);
    }
    // too washed out / near-white → pull back down so it isn't just white
    max = Math.max(r, g, b); min = Math.min(r, g, b);
    if (max - min < 25 && max > 200) {
      r = clamp(r * 0.75); g = clamp(g * 0.75); b = clamp(b * 0.75);
    }
    return { r: clamp(r), g: clamp(g), b: clamp(b) };
  }

  function rgba(c, a) { return `rgba(${c.r},${c.g},${c.b},${a})`; }
  function hex(c) {
    const h = (n) => n.toString(16).padStart(2, "0");
    return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  }

  function apply(c) {
    const root = document.documentElement.style;
    const solid = hex(c);
    // primary HUD accent (used app-wide as var(--blue) in every mode page)
    root.setProperty("--blue", solid);
    root.setProperty("--blue-glow", rgba(c, 0.35));
    root.setProperty("--blue-dim", rgba(c, 0.18));
    root.setProperty("--blue-mid", rgba(c, 0.12));
    root.setProperty("--blue-deep", rgba(c, 0.06));
    // dashboard accent
    root.setProperty("--db-accent", solid);
    root.setProperty("--db-accent-glow", rgba(c, 0.45));
    // build-mode / studio editor pages use a different var name for the same idea
    root.setProperty("--accent", solid);
    // hand-tracking cursor — blended toward white so it still reads as glass
    const blend = (ch) => clamp(ch * 0.35 + 255 * 0.65);
    const glassC = { r: blend(c.r), g: blend(c.g), b: blend(c.b) };
    root.setProperty("--ht-glass", rgba(glassC, 0.92));
    root.setProperty("--ht-glass-glow", rgba(c, 0.5));
    root.setProperty("--ht-glass-glow-strong", rgba(c, 0.85));
    document.dispatchEvent(new CustomEvent("jarvis:theme-changed", { detail: c }));
  }

  function save(c) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(c)); } catch (e) {}
  }

  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      apply(JSON.parse(raw));
    } catch (e) {}
  }

  function reset() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    const root = document.documentElement.style;
    ["--blue","--blue-glow","--blue-dim","--blue-mid","--blue-deep",
     "--db-accent","--db-accent-glow","--accent","--ht-glass","--ht-glass-glow","--ht-glass-glow-strong"]
      .forEach(p => root.removeProperty(p));
    document.dispatchEvent(new CustomEvent("jarvis:theme-changed", { detail: null }));
  }

  // Sample the average color of an image (a wallpaper, typically) and
  // adopt it as the app-wide accent.
  function setFromImageURL(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        try {
          const c = document.createElement("canvas");
          c.width = 32; c.height = 32;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, 0, 0, 32, 32);
          const data = ctx.getImageData(0, 0, 32, 32).data;
          let r = 0, g = 0, b = 0, n = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 40) continue; // skip transparent pixels
            r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
          }
          n = n || 1;
          const avg = normalizeAccent(r / n, g / n, b / n);
          apply(avg);
          save(avg);
          resolve(avg);
        } catch (e) {
          resolve(null); // canvas tainted (cross-origin) — leave theme as-is
        }
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // Live-sync across every other open window/tab (incl. Electron
  // widget-host popouts) the instant one of them changes the theme.
  window.addEventListener("storage", (e) => {
    if (e.key === STORAGE_KEY) restore();
  });

  restore(); // apply immediately on load, before first paint if possible

  window.JarvisTheme = { apply, save, restore, reset, setFromImageURL, STORAGE_KEY };
})();
