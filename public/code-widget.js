// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — CODE REVEAL WIDGET
// A small floating card for anything the user needs to copy exactly
// — a claim code, a wallet address, a generated secret/PIN, etc.
// window.CodeWidget.open({ label, code, note }) is the classic
// single-value shape and still works exactly as before. There's also
// a multi-value shape — open({ label, fields: [{label, value}, ...],
// note }) — for cases like the wallet card where an address AND a
// private key need to be shown together: those used to get jammed
// into one `code` box plus a small dim `note` underneath with no
// visual separation between them (a `\n` in a plain textContent note
// doesn't even render as a line break), so the two values read as one
// undifferentiated blob. Multi-field mode gives each value its own
// labeled box and its own Copy button instead.
//
// Nothing shows this proactively, and it never fires on its own just
// because a reply contains numbers or a long string. Which replies
// trigger it is decided server-side (see server.js's CODE_REVEAL
// action on specific tools like get_superteam_claim_code /
// get_wallet_address) — a story or a news readout never sets that
// action, so this never appears for those no matter what the text
// looks like.
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
        <div class="cw-fields"></div>
        <div class="cw-note"></div>
      </div>
    `;
    document.body.appendChild(el);
    el.querySelector(".cw-close").addEventListener("click", close);
    el.querySelector(".cw-copy").addEventListener("click", () => copyText(el.querySelector(".cw-code").textContent || "", el.querySelector(".cw-copy")));
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

  // Generic copy for any button + text pair — used by both the
  // classic single "Copy" button and each per-field copy button in
  // multi-field mode. Flashes that SPECIFIC button's own "Copied!"
  // state rather than one shared badge, so copying the address vs.
  // the key gives distinct feedback about which one just got copied.
  function copyText(text, btn) {
    if (!text) return;
    const flash = () => {
      if (!btn) return;
      const original = btn.dataset.originalLabel || btn.textContent;
      btn.dataset.originalLabel = original;
      btn.textContent = "Copied!";
      btn.classList.add("copied");
      clearTimeout(btn._cwTimer);
      btn._cwTimer = setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("copied");
      }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flash).catch(() => { fallbackCopy(text); flash(); });
    } else {
      fallbackCopy(text);
      flash();
    }
  }

  // { label: "SUPERTEAM CLAIM CODE", code: "abc123", note: "optional extra line" }
  //   — classic single-value mode.
  // { label: "Solana wallet — rithik", fields: [
  //     { label: "Address",     value: "FRBZ..." },
  //     { label: "Private key", value: "5Kx..."  },
  //   ], note: "optional warning line" }
  //   — multi-value mode: each field gets its own labeled, individually
  //   copyable box. Takes priority over `code` when both are given.
  function open({ label, code, note, fields } = {}) {
    ensureEl();
    clearTimeout(autoHideTimer);
    el.querySelector(".cw-label").textContent = (label || "CODE").toUpperCase();

    const codeEl   = el.querySelector(".cw-code");
    const rowEl    = el.querySelector(".cw-row");
    const fieldsEl = el.querySelector(".cw-fields");

    if (Array.isArray(fields) && fields.length) {
      codeEl.classList.add("hidden-field");
      rowEl.classList.add("hidden-field");
      fieldsEl.innerHTML = fields.map((f, i) => `
        <div class="cw-field">
          <div class="cw-field-label">${(f.label || "").toUpperCase()}</div>
          <div class="cw-field-body">
            <div class="cw-field-value">${(f.value || "").replace(/</g, "&lt;")}</div>
            <button class="cw-field-copy" data-idx="${i}" type="button">Copy</button>
          </div>
        </div>
      `).join("");
      fieldsEl.classList.add("show");
      fieldsEl.querySelectorAll(".cw-field-copy").forEach((btn, i) => {
        btn.addEventListener("click", () => copyText(fields[i].value || "", btn));
      });
    } else {
      fieldsEl.classList.remove("show");
      fieldsEl.innerHTML = "";
      codeEl.classList.remove("hidden-field");
      rowEl.classList.remove("hidden-field");
      codeEl.textContent = code || "";
    }

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
