// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — PHONE CALL WIDGET
// A small floating card that shows up ONLY when a real phone call
// is proposed/placed (window.PhoneWidget.open(meta) is the only way
// it becomes visible — nothing shows it proactively). Connects to
// /api/phone/stream/:callSessionId over SSE and walks through the
// same states the backend actually goes through:
//   preparing -> confirm -> dialing -> on_call -> ended
// (or "cancelled" / "needs_number" if it stops early).
// ═══════════════════════════════════════════════════════════════

window.PhoneWidget = (function () {
  let es = null;
  let el = null;
  let closeTimer = null;

  const STATUS_LABEL = {
    preparing: "PREPARING",
    confirm: "CONFIRM",
    dialing: "DIALING",
    on_call: "ON THE CALL",
    ended: "ENDED",
    cancelled: "CANCELLED",
    needs_number: "NEEDS NUMBER",
  };

  const DEFAULT_MESSAGE = {
    preparing: "Setting up the call, sir...",
    dialing: "Connecting the call, sir...",
    on_call: "On the call now — I'll report back, sir.",
    cancelled: "Cancelled — nothing was dialed.",
  };

  function ensureEl() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "phone-widget hidden";
    el.innerHTML = `
      <div class="pw-header">
        <div class="pw-status">
          <span class="pw-dot"></span>
          <span class="pw-status-text">PREPARING</span>
        </div>
        <button class="pw-close" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="pw-body">
        <div class="pw-business"></div>
        <div class="pw-number"></div>
        <div class="pw-message"></div>
        <div class="pw-chips"></div>
      </div>
    `;
    document.body.appendChild(el);
    el.querySelector(".pw-close").addEventListener("click", close);
    return el;
  }

  function setState(state, { pulse } = {}) {
    ensureEl();
    el.dataset.state = state;
    const dot = el.querySelector(".pw-dot");
    const label = el.querySelector(".pw-status-text");
    label.textContent = STATUS_LABEL[state] || state.toUpperCase();
    dot.classList.toggle("pulse", !!pulse);
  }

  function setBusiness(name, number) {
    ensureEl();
    const nameEl = el.querySelector(".pw-business");
    const numEl = el.querySelector(".pw-number");
    if (name) nameEl.textContent = name;
    if (number) numEl.textContent = number;
  }

  function setMessage(text) {
    ensureEl();
    el.querySelector(".pw-message").innerHTML = "";
    const p = document.createElement("div");
    p.textContent = text || "";
    el.querySelector(".pw-message").appendChild(p);
  }

  function setChips(chips) {
    ensureEl();
    const wrap = el.querySelector(".pw-chips");
    wrap.innerHTML = "";
    (chips || []).forEach((c) => {
      const chip = document.createElement("span");
      chip.className = "pw-chip";
      chip.textContent = c;
      wrap.appendChild(chip);
    });
  }

  function addRecordingLink(url) {
    if (!url) return;
    ensureEl();
    const a = document.createElement("a");
    a.className = "pw-recording";
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = "\u25B6 recording";
    el.querySelector(".pw-body").appendChild(a);
  }

  function scheduleAutoClose(ms) {
    clearTimeout(closeTimer);
    closeTimer = setTimeout(close, ms);
  }

  // ── OPEN / STREAM ──────────────────────────────────────────────
  function open(meta) {
    if (!meta || !meta.callSessionId) return;
    ensureEl();
    clearTimeout(closeTimer);

    setState("preparing", { pulse: true });
    setBusiness(meta.businessName || "", meta.businessNumber || "");
    setMessage(DEFAULT_MESSAGE.preparing);
    setChips([]);

    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("open"));

    if (es) { try { es.close(); } catch {} es = null; }
    es = new EventSource(`/api/phone/stream/${encodeURIComponent(meta.callSessionId)}`);

    es.addEventListener("preparing", (e) => {
      let data; try { data = JSON.parse(e.data); } catch { data = {}; }
      setState("preparing", { pulse: true });
      setBusiness(data.businessName, data.businessNumber);
      setMessage(DEFAULT_MESSAGE.preparing);
    });

    es.addEventListener("confirm", (e) => {
      let data; try { data = JSON.parse(e.data); } catch { data = {}; }
      setState("confirm");
      setBusiness(data.businessName, data.businessNumber);
      setMessage(data.message || 'Say "do it" to ring — or "cancel".');
    });

    es.addEventListener("needs_number", () => {
      setState("needs_number");
      setMessage("I don't have a number on file for them yet.");
      scheduleAutoClose(6000);
    });

    es.addEventListener("dialing", (e) => {
      let data; try { data = JSON.parse(e.data); } catch { data = {}; }
      setState("dialing", { pulse: true });
      setBusiness(data.businessName, data.businessNumber);
      setMessage(DEFAULT_MESSAGE.dialing);
    });

    es.addEventListener("on_call", (e) => {
      let data; try { data = JSON.parse(e.data); } catch { data = {}; }
      setState("on_call", { pulse: true });
      setBusiness(data.businessName, data.businessNumber);
      setMessage(DEFAULT_MESSAGE.on_call);
    });

    es.addEventListener("ended", (e) => {
      let data; try { data = JSON.parse(e.data); } catch { data = {}; }
      el.dataset.ok = data.ok === false ? "false" : "true";
      setState("ended");
      setMessage(data.summary || (data.ok === false ? "The call didn't go through." : "Call finished."));
      setChips(data.chips || []);
      addRecordingLink(data.recordingUrl);
      if (es) { es.close(); es = null; }
      scheduleAutoClose(45000);
    });

    es.addEventListener("cancelled", () => {
      setState("cancelled");
      setMessage(DEFAULT_MESSAGE.cancelled);
      if (es) { es.close(); es = null; }
      scheduleAutoClose(5000);
    });

    es.addEventListener("error", (e) => {
      let data = {}; try { data = JSON.parse(e.data); } catch {}
      if (data.message) {
        setMessage(data.message);
        scheduleAutoClose(6000);
      }
      // Regular EventSource connection hiccups (no e.data) are left
      // alone — EventSource retries those on its own.
    });
  }

  function close() {
    if (!el) return;
    el.classList.remove("open");
    if (es) { try { es.close(); } catch {} es = null; }
    clearTimeout(closeTimer);
    setTimeout(() => el.classList.add("hidden"), 220);
  }

  return { open, close };
})();
