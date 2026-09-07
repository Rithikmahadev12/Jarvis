// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — CODE REVEAL WIDGET
// A small floating card for anything the user needs to copy exactly
// — a claim code, a wallet address, a generated secret/PIN, etc.
// window.CodeWidget.open({ label, code, note }) is the only way it
// becomes visible — nothing shows it proactively, and it never
// fires on its own just because a reply contains numbers or a long
// string. Which replies trigger it is decided server-side (see
// server.js's CODE_REVEAL action on specific tools like
// get_superteam_claim_code / get_wallet_address) — a story or a
// news readout never sets that action, so this never appears for
// those no matter what the text looks like.
// ═══════════════════════════════════════════════════════════════

window.CodeWidget = (function () {
  let el = null;
  let copiedTimer = null;
  let autoHideTimer = null;

  function ensureEl() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "code-widget hidden";
    el.innerHTML = `
      <div class="cw-header">
        <div class="cw-label">CODE</div>
        <button class="cw-close" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="cw-body">
        <div class="cw-code"></div>
        <div class="cw-row">
          <button class="cw-copy">Copy</button>
          <span class="cw-copied">Copied!</span>
        </div>
        <div class="cw-note"></div>
      </div>
    `;
    document.body.appendChild(el);
    el.querySelector(".cw-close").addEventListener("click", close);
    el.querySelector(".cw-copy").addEventListener("click", copyCode);
    return el;
  }

  function fallbackCopy(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); } catch (e) { /* nothing more we can do */ }
    ta.remove();
  }

  function flashCopied() {
    ensureEl();
    const badge = el.querySelector(".cw-copied");
    badge.classList.add("show");
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => badge.classList.remove("show"), 1400);
  }

  function copyCode() {
    ensureEl();
    const text = el.querySelector(".cw-code").textContent || "";
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flashCopied).catch(() => {
        fallbackCopy(text);
        flashCopied();
      });
    } else {
      fallbackCopy(text);
      flashCopied();
    }
  }

  // { label: "SUPERTEAM CLAIM CODE", code: "abc123", note: "optional extra line" }
  function open({ label, code, note } = {}) {
    ensureEl();
    clearTimeout(autoHideTimer);
    el.querySelector(".cw-label").textContent = (label || "CODE").toUpperCase();
    el.querySelector(".cw-code").textContent = code || "";
    const noteEl = el.querySelector(".cw-note");
    if (note) {
      noteEl.textContent = note;
      noteEl.classList.add("show");
    } else {
      noteEl.textContent = "";
      noteEl.classList.remove("show");
    }
    el.classList.remove("hidden");
    // Two rAFs so the "hidden -> visible" transition reliably plays
    // instead of the browser coalescing it into the state it started in.
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add("open")));
  }

  function close() {
    if (!el) return;
    el.classList.remove("open");
    clearTimeout(autoHideTimer);
    autoHideTimer = setTimeout(() => el.classList.add("hidden"), 220);
  }

  return { open, close };
})();
