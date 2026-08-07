// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — LOOKUP WIDGET (SixtyFour)
// Small floating card that shows up ONLY when a
// "jarvis lookup <name/email/username>" command fires
// (window.LookupWidget.show(meta) is the only way it becomes
// visible — nothing shows it proactively). Polls
// /api/lookup/status/:taskId until SixtyFour's async job finishes,
// then renders a short profile with clickable links out to every
// account/profile that was found.
// ═══════════════════════════════════════════════════════════════

window.LookupWidget = (function () {
  let el = null;
  let pollTimer = null;
  let pollAttempts = 0;

  const POLL_INTERVAL_MS = 4000;
  const MAX_POLL_ATTEMPTS = 120; // ~8 minutes ceiling — SixtyFour deep lookups can take a few minutes

  function ensureEl() {
    if (el) return el;
    el = document.createElement("div");
    el.className = "lookup-widget hidden";
    el.innerHTML = `
      <div class="lw-header">
        <div class="lw-status">
          <span class="lw-dot"></span>
          <span class="lw-status-text">SEARCHING</span>
        </div>
        <button class="lw-close" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="lw-body">
        <div class="lw-query"></div>
        <div class="lw-content"></div>
      </div>
    `;
    document.body.appendChild(el);
    el.querySelector(".lw-close").addEventListener("click", close);
    return el;
  }

  function setState(state, label, { pulse } = {}) {
    ensureEl();
    el.dataset.state = state;
    el.querySelector(".lw-status-text").textContent = label || state.toUpperCase();
    el.querySelector(".lw-dot").classList.toggle("pulse", !!pulse);
  }

  function setQueryLine(query, tier) {
    ensureEl();
    const who = (query && (query.name || query.email || query.username)) || "";
    const tierTag = tier ? ` · ${String(tier).toUpperCase()} TIER` : "";
    el.querySelector(".lw-query").textContent = who ? `LOOKUP: ${who}${tierTag}` : "";
  }

  function escapeHtml(s) {
    return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function renderMessage(text) {
    ensureEl();
    el.querySelector(".lw-content").innerHTML = `<div class="lw-message">${escapeHtml(text)}</div>`;
  }

  function renderProfile(profile) {
    ensureEl();
    const content = el.querySelector(".lw-content");
    const parts = [];

    if (profile.name)     parts.push(`<div class="lw-name">${escapeHtml(profile.name)}</div>`);
    if (profile.headline) parts.push(`<div class="lw-headline">${escapeHtml(profile.headline)}</div>`);
    if (profile.location) parts.push(`<div class="lw-location">${escapeHtml(profile.location)}</div>`);
    if (profile.summary)  parts.push(`<div class="lw-summary">${escapeHtml(profile.summary)}</div>`);
    if (profile.otherNote) parts.push(`<div class="lw-note">${escapeHtml(profile.otherNote)}</div>`);

    if (profile.links && profile.links.length) {
      const linkRows = profile.links.map(l => `
        <a class="lw-link" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">
          <span class="lw-link-platform">${escapeHtml(l.platform)}</span>
          <span class="lw-link-arrow">&#8599;</span>
        </a>
      `).join("");
      parts.push(`<div class="lw-links">${linkRows}</div>`);
    } else {
      parts.push(`<div class="lw-empty-links">No public accounts turned up for this one.</div>`);
    }

    if (typeof profile.confidence === "number") {
      parts.push(`<div class="lw-confidence">Confidence: ${profile.confidence.toFixed(1)}/10</div>`);
    }

    content.innerHTML = parts.join("") || `<div class="lw-message">Nothing found.</div>`;
  }

  function stopPolling() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
  }

  async function poll(taskId) {
    if (!taskId) return;
    pollAttempts++;

    let data;
    try {
      const res = await fetch(`/api/lookup/status/${encodeURIComponent(taskId)}`);
      data = await res.json();
    } catch (e) {
      data = { error: "Lost connection checking the lookup status." };
    }

    // Widget may have been closed while this request was in flight.
    if (!el || el.classList.contains("hidden")) return;

    if (data.error) {
      setState("error", "FAILED", { pulse: false });
      renderMessage(data.error);
      return;
    }

    if (data.status === "completed") {
      setState("done", "FOUND", { pulse: false });
      renderProfile(data.profile || {});
      return;
    }

    if (pollAttempts >= MAX_POLL_ATTEMPTS) {
      setState("error", "TIMED OUT", { pulse: false });
      renderMessage("This is taking longer than expected — SixtyFour hasn't finished. Try again in a bit.");
      return;
    }

    // still running — keep polling
    setState("searching", "SEARCHING", { pulse: true });
    pollTimer = setTimeout(() => poll(taskId), POLL_INTERVAL_MS);
  }

  // ── OPEN ─────────────────────────────────────────────────────
  function show(meta) {
    if (!meta || !meta.taskId) return;
    ensureEl();
    stopPolling();
    pollAttempts = 0;

    setState("searching", "SEARCHING", { pulse: true });
    setQueryLine(meta.query, meta.tier);
    renderMessage("Pulling public records and profiles now...");

    el.classList.remove("hidden");
    requestAnimationFrame(() => el.classList.add("open"));

    poll(meta.taskId);
  }

  function close() {
    if (!el) return;
    stopPolling();
    el.classList.remove("open");
    setTimeout(() => { if (el) el.classList.add("hidden"); }, 240);
  }

  return { show, close };
})();
