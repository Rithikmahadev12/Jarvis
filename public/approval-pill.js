/* ═══════════════════════════════════════════════════════════════
   J.A.R.V.I.S — Approval pill
   A small pill at the top-centre of the screen. It shows what Jarvis is
   about to do and waits for Allow / Deny / Always (or a choice), and
   shows a live feed of what Jarvis is doing.

   • In a browser: renders inside the page.
   • In the Electron app: the page is skipped and the always-on-top
     overlay window (approval-pill.html?standalone=1) renders it instead,
     so it's visible over any app. The overlay reports its size to the
     main process, which shows/hides the window.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var standalone = params.get("standalone") === "1";
  var desktop = !!(window.jarvisDesktop && window.jarvisDesktop.isDesktop);
  if (desktop && !standalone) return;   // Electron overlay handles it
  if (window.__jarvisApprovalPill) return;
  window.__jarvisApprovalPill = true;

  var pending = [];      // pending approval cards
  var feed = [];         // recent steps
  var expanded = false;
  var tickerUntil = 0;
  var tickerTimer = null;

  var css = [
    ".jap{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483000;width:min(440px,calc(100vw - 20px));font:13px/1.35 'Rajdhani','Segoe UI',system-ui,sans-serif;color:#e8f4ff;pointer-events:none}",
    ".jap *{box-sizing:border-box}",
    ".jap-wrap{pointer-events:auto;background:rgba(8,14,22,.94);border:1px solid rgba(0,200,255,.35);border-radius:18px;box-shadow:0 8px 32px rgba(0,0,0,.5);backdrop-filter:blur(14px);overflow:hidden}",
    ".jap-head{display:flex;align-items:center;gap:8px;padding:8px 12px;cursor:pointer;user-select:none}",
    ".jap-dot{width:9px;height:9px;border-radius:50%;background:#37d67a;flex:none}",
    ".jap-dot.wait{background:#ff9f1c;animation:japp 1s infinite}",
    ".jap-dot.work{background:#3aa0ff}",
    "@keyframes japp{50%{opacity:.35}}",
    ".jap-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:.04em}",
    ".jap-count{font-size:11px;opacity:.7}",
    ".jap-card{padding:10px 12px 12px;border-top:1px solid rgba(0,200,255,.18)}",
    ".jap-ct{font-weight:600;font-size:14px;margin-bottom:4px;display:flex;align-items:center;gap:6px}",
    ".jap-risk{font-size:10px;padding:1px 6px;border-radius:8px;text-transform:uppercase;letter-spacing:.06em}",
    ".jap-risk.low{background:#1d4a2e;color:#7dffb0}.jap-risk.medium{background:#4a3c12;color:#ffd36b}.jap-risk.high{background:#4a1d1d;color:#ff8f8f}",
    ".jap-detail{font:12px/1.4 'Share Tech Mono',ui-monospace,Menlo,monospace;background:rgba(255,255,255,.06);border-radius:8px;padding:7px 9px;max-height:120px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:4px 0 8px}",
    ".jap-btns{display:flex;gap:6px;flex-wrap:wrap}",
    ".jap-b{flex:1;min-width:70px;border:0;border-radius:10px;padding:7px 10px;font:inherit;font-weight:600;cursor:pointer;color:#06101a}",
    ".jap-b.allow{background:#37d67a}.jap-b.deny{background:#ff6b6b}.jap-b.always{background:#3aa0ff}.jap-b.opt{background:#cfe8ff}",
    ".jap-b:disabled{opacity:.5;cursor:default}",
    ".jap-feed{padding:6px 12px 10px;border-top:1px solid rgba(0,200,255,.18);max-height:200px;overflow:auto}",
    ".jap-row{display:flex;gap:6px;padding:2px 0;font-size:12px;opacity:.9}",
    ".jap-row.error{color:#ff8f8f}.jap-row .t{opacity:.5;flex:none;font-family:ui-monospace,monospace}",
    ".jap-empty{opacity:.5;font-size:12px;padding:2px 0}"
  ].join("");

  var style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  if (standalone) {
    document.documentElement.style.background = "transparent";
    document.body && (document.body.style.background = "transparent");
  }

  var root = document.createElement("div");
  root.className = "jap";
  root.style.display = "none";
  (document.body || document.documentElement).appendChild(root);

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function hhmm(ts) {
    var d = new Date(ts);
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().catch(function () { return {}; }); });
  }

  function decide(id, decision, btn) {
    var btns = btn.parentNode.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    function send(pass) {
      post("/api/approvals/" + id + "/decide", { decision: decision, passcode: pass || "" }).then(function (r) {
        if (r && r.needPasscode) {
          try { sessionStorage.removeItem("jap_pass"); } catch (e) {}
          var p = window.prompt(pass ? "Wrong passcode. Owner passcode to approve this:" : "Owner passcode needed to approve this:");
          if (p) { try { sessionStorage.setItem("jap_pass", p); } catch (e) {} return send(p); }
          for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
          return;
        }
        if (r && r.ok === false) { addFeed({ at: Date.now(), title: r.error || "That didn't go through", status: "error" }); }
        pending = pending.filter(function (p) { return p.id !== id; });
        render();
      });
    }
    var saved = ""; try { saved = sessionStorage.getItem("jap_pass") || ""; } catch (e) {}
    send(saved);
  }
  function answer(id, choice, btn) {
    var btns = btn.parentNode.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    post("/api/approvals/" + id + "/answer", { choice: choice }).then(function () {
      pending = pending.filter(function (p) { return p.id !== id; });
      render();
    });
  }

  function cardHtml(p) {
    var h = '<div class="jap-card" data-id="' + esc(p.id) + '">';
    h += '<div class="jap-ct">' + esc(p.title) + ' <span class="jap-risk ' + esc(p.risk) + '">' + esc(p.risk) + "</span></div>";
    if (p.detail) h += '<div class="jap-detail">' + esc(p.detail) + "</div>";
    h += '<div class="jap-btns">';
    if (p.options) {
      p.options.forEach(function (o, i) { h += '<button class="jap-b opt" data-a="answer" data-i="' + i + '">' + esc(o) + "</button>"; });
    } else {
      h += '<button class="jap-b allow" data-a="allow">Allow</button>';
      h += '<button class="jap-b deny" data-a="deny">Deny</button>';
      if (p.canAlways) h += '<button class="jap-b always" data-a="always">Always</button>';
    }
    return h + "</div></div>";
  }

  function render() {
    var latest = feed.length ? feed[feed.length - 1] : null;
    var showTicker = latest && Date.now() < tickerUntil;
    var visible = pending.length > 0 || showTicker || expanded;

    if (!visible) {
      root.style.display = "none";
      reportSize();
      return;
    }
    root.style.display = "block";

    var waiting = pending.length > 0;
    var title = waiting
      ? "Jarvis needs your OK"
      : (showTicker ? latest.title : "Jarvis activity");
    var dot = waiting ? "wait" : (showTicker && latest.status === "running" ? "work" : "");

    var h = '<div class="jap-wrap"><div class="jap-head" data-a="toggle">';
    h += '<span class="jap-dot ' + dot + '"></span><span class="jap-title">' + esc(title) + "</span>";
    if (waiting && pending.length > 1) h += '<span class="jap-count">' + pending.length + " waiting</span>";
    h += "</div>";
    pending.forEach(function (p) { h += cardHtml(p); });
    if (expanded) {
      h += '<div class="jap-feed">';
      if (!feed.length) h += '<div class="jap-empty">Nothing yet.</div>';
      feed.slice(-12).reverse().forEach(function (f) {
        h += '<div class="jap-row ' + esc(f.status) + '"><span class="t">' + hhmm(f.at) + "</span><span>" + esc(f.title) +
          (f.detail ? " — " + esc(String(f.detail).slice(0, 120)) : "") + "</span></div>";
      });
      h += "</div>";
    }
    h += "</div>";
    root.innerHTML = h;
    reportSize();
  }

  root.addEventListener("click", function (ev) {
    var el = ev.target.closest("[data-a]");
    if (!el) return;
    var a = el.getAttribute("data-a");
    if (a === "toggle") { expanded = !expanded; render(); return; }
    var card = el.closest(".jap-card");
    if (!card) return;
    var id = card.getAttribute("data-id");
    if (a === "answer") {
      var p = pending.filter(function (x) { return x.id === id; })[0];
      var choice = p && p.options ? p.options[Number(el.getAttribute("data-i"))] : null;
      if (choice != null) answer(id, choice, el);
      return;
    }
    decide(id, a, el);
  });

  function addFeed(item) {
    feed.push(item);
    if (feed.length > 60) feed.shift();
    tickerUntil = Date.now() + 6000;
    clearTimeout(tickerTimer);
    tickerTimer = setTimeout(render, 6100);
  }

  // Tell the Electron main process how big the overlay needs to be
  var lastReport = "";
  function reportSize() {
    if (!standalone || !window.jarvisDesktop || !window.jarvisDesktop.approvalResize) return;
    var vis = root.style.display !== "none";
    var h = vis ? Math.ceil(root.getBoundingClientRect().height) + 20 : 0;
    var key = vis + ":" + h;
    if (key === lastReport) return;
    lastReport = key;
    window.jarvisDesktop.approvalResize({ visible: vis, height: h });
  }

  function connect() {
    var es = new EventSource("/api/approvals/stream");
    es.addEventListener("snapshot", function (e) {
      var d = JSON.parse(e.data);
      pending = d.pending || [];
      feed = d.feed || [];
      render();
    });
    es.addEventListener("approval", function (e) {
      var p = JSON.parse(e.data);
      pending = pending.filter(function (x) { return x.id !== p.id; });
      pending.push(p);
      try { if (window.Notification && Notification.permission === "granted" && document.hidden) new Notification("Jarvis needs your OK", { body: p.title }); } catch (_) {}
      render();
    });
    es.addEventListener("resolved", function (e) {
      var d = JSON.parse(e.data);
      pending = pending.filter(function (x) { return x.id !== d.id; });
      render();
    });
    es.addEventListener("step", function (e) {
      addFeed(JSON.parse(e.data));
      render();
    });
    // EventSource reconnects by itself; on reconnect the server sends a fresh snapshot.
  }

  // Cards expire server-side; also drop them locally so a stale card never lingers
  setInterval(function () {
    var now = Date.now(), before = pending.length;
    pending = pending.filter(function (p) { return !p.expiresAt || p.expiresAt > now; });
    if (pending.length !== before) render();
  }, 5000);

  connect();
})();
