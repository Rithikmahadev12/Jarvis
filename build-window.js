// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — SITE BUILD WINDOW
// A floating, draggable OS-style window (not a full-screen mode).
// When "build_website" fires, the server hands back a buildId
// instantly; this connects to /api/sites/stream/:buildId over SSE
// and renders the generated HTML as it's actually written — a real
// code stream, not a fake typing effect — then cross-fades into a
// live preview once the model is done.
// ═══════════════════════════════════════════════════════════════

window.BuildWindow = (function () {
  const $ = (id) => document.getElementById(id);

  let es = null;
  let raw = "";        // full accumulated source so far
  let lineCount = 1;
  let downloadSlug = "";

  // ── DRAGGING (titlebar only) ──────────────────────────────────
  let dragging = false, dragDX = 0, dragDY = 0;
  function initDrag() {
    const bar = $("build-win-titlebar");
    const win = $("build-win");
    if (!bar || bar.dataset.dragBound) return;
    bar.dataset.dragBound = "1";

    const onDown = (e) => {
      if (e.target.closest(".build-win-dot") || e.target.closest(".build-win-btn")) return;
      const inner = win.querySelector(".build-win-inner");
      const rect = inner.getBoundingClientRect();
      dragging = true;
      dragDX = (e.clientX ?? e.touches?.[0]?.clientX) - rect.left;
      dragDY = (e.clientY ?? e.touches?.[0]?.clientY) - rect.top;
      // switch from centered-flex to absolute positioning at current spot
      inner.style.position = "absolute";
      inner.style.left = rect.left + "px";
      inner.style.top  = rect.top + "px";
      inner.style.margin = "0";
      win.style.justifyContent = "flex-start";
      win.style.alignItems = "flex-start";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.addEventListener("touchmove", onMove, { passive: false });
      document.addEventListener("touchend", onUp);
    };
    const onMove = (e) => {
      if (!dragging) return;
      e.preventDefault?.();
      const x = e.clientX ?? e.touches?.[0]?.clientX;
      const y = e.clientY ?? e.touches?.[0]?.clientY;
      const inner = win.querySelector(".build-win-inner");
      const w = inner.offsetWidth, h = inner.offsetHeight;
      const left = Math.min(Math.max(0, x - dragDX), window.innerWidth - w * 0.3);
      const top  = Math.min(Math.max(0, y - dragDY), window.innerHeight - 30);
      inner.style.left = left + "px";
      inner.style.top  = top + "px";
    };
    const onUp = () => {
      dragging = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.removeEventListener("touchmove", onMove);
      document.removeEventListener("touchend", onUp);
    };
    bar.addEventListener("mousedown", onDown);
    bar.addEventListener("touchstart", onDown, { passive: true });
  }

  // ── LIGHTWEIGHT HTML TOKEN HIGHLIGHTING ─────────────────────────
  // Not a full parser — just enough regex-based coloring on the
  // streamed text to make it read like real syntax-highlighted code
  // instead of a plain gray wall of text.
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function highlight(text) {
    let out = escapeHtml(text);
    out = out.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-cmt">$1</span>');
    out = out.replace(/(&lt;\/?)([a-zA-Z0-9-]+)/g, '<span class="tok-punct">$1</span><span class="tok-tag">$2</span>');
    out = out.replace(/([a-zA-Z-]+)(=)(&quot;.*?&quot;|".*?"|'.*?')/g, '<span class="tok-attr">$1</span>$2<span class="tok-str">$3</span>');
    out = out.replace(/(&gt;)/g, '<span class="tok-punct">$1</span>');
    return out;
  }

  function renderCode() {
    const codeEl = $("build-win-code-content");
    const gutter = $("build-win-gutter");
    if (!codeEl) return;
    codeEl.innerHTML = highlight(raw);
    const lines = raw.split("\n").length;
    if (lines !== lineCount) {
      lineCount = lines;
      if (gutter) {
        let s = "";
        for (let i = 1; i <= lineCount; i++) s += i + "\n";
        gutter.textContent = s;
      }
    }
    const pane = $("build-win-code");
    if (pane) pane.scrollTop = pane.scrollHeight;
    const bc = $("build-win-bytecount");
    if (bc) bc.textContent = formatBytes(raw.length);
  }

  function formatBytes(n) {
    if (n < 1024) return n + " B";
    return (n / 1024).toFixed(1) + " KB";
  }

  function setStatus(text, kind) {
    const t = $("build-win-status-text");
    const d = $("build-win-status-dot");
    if (t) t.textContent = text;
    if (d) d.className = "build-win-status-dot" + (kind ? " " + kind : "");
  }

  // ── OPEN / STREAM ────────────────────────────────────────────
  function open(meta) {
    const win = $("build-win");
    if (!win) return;
    initDrag();
    resetInner();

    $("build-win-title-name").textContent = (meta?.name || "site") + ".build";
    $("build-win-title-status").textContent = "generating";
    setStatus("Connecting to build engine…");

    win.classList.remove("hidden");
    requestAnimationFrame(() => win.classList.add("open"));

    if (es) { try { es.close(); } catch {} es = null; }
    if (!meta?.buildId) { showError("No build in progress."); return; }

    es = new EventSource(`/api/sites/stream/${encodeURIComponent(meta.buildId)}`);

    es.addEventListener("chunk", (e) => {
      let data; try { data = JSON.parse(e.data); } catch { return; }
      raw += data.delta || "";
      setStatus(data.fallback ? "Using a fallback template…" : "Writing " + meta.name + "…");
      renderCode();
    });

    es.addEventListener("done", (e) => {
      let data; try { data = JSON.parse(e.data); } catch { data = {}; }
      $("build-win-title-status").textContent = "done";
      setStatus("Build complete", "ok");
      downloadSlug = data.slug || "";
      const dl = $("build-win-download");
      if (dl) { dl.classList.remove("hidden"); dl.dataset.slug = downloadSlug; dl.dataset.name = data.name || meta.name || ""; }
      showPreview(data.url);
      es.close(); es = null;
    });

    es.addEventListener("error", (e) => {
      let msg = "Connection to the build engine dropped.";
      try { const data = JSON.parse(e.data); if (data.message) msg = data.message; } catch {}
      showError(msg);
      if (es) { es.close(); es = null; }
    });
  }

  function resetInner() {
    raw = ""; lineCount = 1; downloadSlug = "";
    const codeEl = $("build-win-code-content");
    if (codeEl) codeEl.innerHTML = "";
    const gutter = $("build-win-gutter");
    if (gutter) gutter.textContent = "1\n";
    const pane = $("build-win-code");
    if (pane) { pane.classList.remove("leaving"); pane.style.display = "flex"; }
    const preview = $("build-win-preview");
    if (preview) { preview.classList.add("hidden"); preview.classList.remove("show"); preview.src = "about:blank"; }
    const errEl = $("build-win-error");
    if (errEl) { errEl.classList.add("hidden"); errEl.innerHTML = ""; }
    const cursor = document.querySelector(".build-win-cursor");
    if (cursor) cursor.classList.remove("hidden");
    const dl = $("build-win-download");
    if (dl) dl.classList.add("hidden");
    const bc = $("build-win-bytecount");
    if (bc) bc.textContent = "0 B";
  }

  function showPreview(url) {
    const codePane = $("build-win-code");
    const preview  = $("build-win-preview");
    const cursor   = document.querySelector(".build-win-cursor");
    if (cursor) cursor.classList.add("hidden");
    if (!preview) return;

    preview.classList.remove("hidden");
    preview.src = url || "about:blank";

    const sweep = document.createElement("div");
    sweep.className = "build-win-sweep";
    $("build-win-body")?.appendChild(sweep);

    const finish = () => {
      preview.classList.add("show");
      requestAnimationFrame(() => sweep.classList.add("play"));
      setTimeout(() => { sweep.remove(); if (codePane) codePane.style.display = "none"; }, 950);
    };
    if (preview.complete === false) preview.onload = finish; else setTimeout(finish, 150);
  }

  function showError(message) {
    const errEl = $("build-win-error");
    setStatus("Build failed", "err");
    $("build-win-title-status").textContent = "error";
    if (errEl) {
      errEl.classList.remove("hidden");
      errEl.innerHTML = `<div>⚠ ${escapeHtml(message)}</div>`;
    }
  }

  function close() {
    const win = $("build-win");
    if (!win) return;
    win.classList.remove("open");
    if (es) { try { es.close(); } catch {} es = null; }
    setTimeout(() => win.classList.add("hidden"), 260);
  }

  function downloadCurrent() {
    const dl = $("build-win-download");
    const slug = dl?.dataset.slug;
    if (!slug) return;
    const a = document.createElement("a");
    a.href = `/api/sites/${slug}/download`;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  document.addEventListener("DOMContentLoaded", () => {
    $("build-win-close")?.addEventListener("click", close);
    $("build-win-download")?.addEventListener("click", downloadCurrent);
  });

  return { open, close };
})();
