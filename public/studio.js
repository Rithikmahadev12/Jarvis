"use strict";

// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — PROJECT STUDIO (front end)
// ═══════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const state = {
  projectId: null,
  project: null,          // { id, name, type, files: [] }
  buffers: new Map(),     // path -> { content, loaded, dirty }
  openTabs: [],           // [path,...]
  activeFile: null,
  cm: null,               // CodeMirror instance
  aiHistory: [],          // [{role, content}]
  chosenType: null,
  designFeatureCount: 0,  // last known feature count from the DESIGN iframe (see jarvis_build_state below)
  designIframeReady: false,
};

// ── MODE DETECTION ──────────────────────────────────────────────
function modeForPath(p) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  const map = {
    js: "javascript", mjs: "javascript", jsx: "javascript",
    json: { name: "javascript", json: true },
    py: "python",
    html: "htmlmixed", htm: "htmlmixed",
    css: "css",
    md: "markdown",
    c: "text/x-csrc", cpp: "text/x-c++src", java: "text/x-java",
  };
  return map[ext] || null;
}

// ═══════════════════════════════════════════════════════════════
// ── ONBOARDING ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function initOnboarding() {
  document.querySelectorAll(".type-card").forEach((card) => {
    card.addEventListener("click", () => {
      document.querySelectorAll(".type-card").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
      state.chosenType = card.dataset.type;
      showNameStep(state.chosenType);
    });
  });

  $("name-confirm").addEventListener("click", confirmCreateProject);
  $("project-name-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") confirmCreateProject();
  });

  loadRecentProjects();

  // Deep-link support: /studio?type=coding jumps straight past the
  // picker (used by the "Jarvis, start a project" chat flow once the
  // person has already said which kind), and /studio?resume=<id>
  // reopens an existing project directly.
  const params = new URLSearchParams(location.search);
  const resumeId = params.get("resume");
  const typeParam = params.get("type");
  if (resumeId) {
    resumeProject(resumeId);
  } else if (typeParam && ["coding", "building", "hybrid"].includes(typeParam)) {
    const card = document.querySelector(`.type-card[data-type="${typeParam}"]`);
    if (card) card.click();
  }
}

function showNameStep(type) {
  const questions = {
    coding: "Excellent — a coding project. What shall we call it?",
    building: "A build. Let's get you into the design bay — what's it called?",
    hybrid: "Code and hardware together. What shall we name it?",
  };
  $("name-q").textContent = questions[type] || "What shall we call it?";
  $("name-step").classList.remove("hidden");
  $("project-name-input").focus();
}

async function confirmCreateProject() {
  const name = $("project-name-input").value.trim() || "Untitled Project";
  const type = state.chosenType;
  if (!type) return;
  $("name-confirm").textContent = "Creating…";
  $("name-confirm").disabled = true;
  try {
    const res = await fetch("/api/studio/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, type }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to create project.");

    if (type === "building") {
      // Pure build projects live entirely in the existing hand-tracked
      // CAD engine — no need to duplicate that UI here.
      window.location.href = "/build";
      return;
    }
    enterIDE(data.project);
  } catch (e) {
    alert(e.message);
    $("name-confirm").textContent = "Create Project →";
    $("name-confirm").disabled = false;
  }
}

async function loadRecentProjects() {
  try {
    const res = await fetch("/api/studio/projects");
    const data = await res.json();
    const list = $("recent-list");
    list.innerHTML = "";
    if (!data.projects || !data.projects.length) {
      $("recent-wrap").classList.add("hidden");
      return;
    }
    data.projects.slice(0, 8).forEach((p) => {
      const item = document.createElement("button");
      item.className = "recent-item";
      item.innerHTML = `<span class="rt">${escapeHtml(p.type)}</span><span>${escapeHtml(p.name)}</span>`;
      item.addEventListener("click", () => resumeProject(p.id));
      list.appendChild(item);
    });
  } catch (e) {
    $("recent-wrap").classList.add("hidden");
  }
}

async function resumeProject(id) {
  try {
    const res = await fetch(`/api/studio/projects/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Project not found.");
    if (data.project.type === "building") {
      window.location.href = "/build";
      return;
    }
    enterIDE(data.project);
  } catch (e) {
    alert(e.message);
  }
}

// ═══════════════════════════════════════════════════════════════
// ── IDE ─────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function enterIDE(project) {
  state.project = project;
  state.projectId = project.id;
  state.buffers.clear();
  state.openTabs = [];
  state.activeFile = null;

  $("onboard").classList.add("hidden");
  $("ide").classList.remove("hidden");

  $("proj-name").textContent = project.name;
  $("proj-name").title = project.name;
  $("proj-type-badge").textContent = project.type;

  if (project.type === "hybrid") {
    $("ws-design-tab").classList.remove("hidden");
    $("design-iframe").src = "/build";
  }

  initCodeMirror();
  renderFileList();

  // Open a sensible default file
  const files = project.files || [];
  const preferred = files.find((f) => f === "main.js") || files[0];
  if (preferred) openFile(preferred);

  initWorkspaceTabs();
  initToolbar();
  initConsole();
  initAIPanel();
}

function initCodeMirror() {
  if (state.cm) return;
  state.cm = CodeMirror($("editor-host"), {
    value: "",
    theme: "dracula",
    lineNumbers: true,
    indentUnit: 2,
    tabSize: 2,
    autofocus: true,
    lineWrapping: false,
  });
  state.cm.on("change", () => {
    const path = state.activeFile;
    if (!path) return;
    const buf = state.buffers.get(path);
    if (buf) {
      buf.content = state.cm.getValue();
      buf.dirty = true;
      renderTabs();
    }
  });
}

function renderFileList() {
  const wrap = $("file-list");
  wrap.innerHTML = "";
  const files = (state.project.files || []).slice().sort();
  files.forEach((f) => {
    const row = document.createElement("div");
    row.className = "file-item" + (f === state.activeFile ? " active" : "");
    const label = document.createElement("span");
    label.textContent = f;
    const del = document.createElement("span");
    del.className = "fx";
    del.textContent = "×";
    del.title = "Delete file";
    del.addEventListener("click", (e) => { e.stopPropagation(); deleteFile(f); });
    row.appendChild(label);
    row.appendChild(del);
    row.addEventListener("click", () => openFile(f));
    wrap.appendChild(row);
  });
}

async function openFile(p) {
  if (!state.buffers.has(p)) {
    try {
      const res = await fetch(`/api/studio/projects/${state.projectId}/file?path=${encodeURIComponent(p)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not load file.");
      state.buffers.set(p, { content: data.content, dirty: false });
    } catch (e) {
      alert(e.message);
      return;
    }
  }
  if (!state.openTabs.includes(p)) state.openTabs.push(p);
  switchToFile(p);
}

function switchToFile(p) {
  state.activeFile = p;
  const buf = state.buffers.get(p);
  const mode = modeForPath(p);
  state.cm.setOption("mode", mode || null);
  state.cm.setValue(buf ? buf.content : "");
  renderTabs();
  renderFileList();
}

function renderTabs() {
  const wrap = $("editor-tabs");
  wrap.innerHTML = "";
  state.openTabs.forEach((p) => {
    const buf = state.buffers.get(p);
    const tab = document.createElement("div");
    tab.className = "editor-tab" + (p === state.activeFile ? " active" : "");
    const label = document.createElement("span");
    label.textContent = p + (buf && buf.dirty ? " ●" : "");
    const close = document.createElement("span");
    close.className = "close";
    close.textContent = "✕";
    close.addEventListener("click", (e) => { e.stopPropagation(); closeTab(p); });
    tab.appendChild(label);
    tab.appendChild(close);
    tab.addEventListener("click", () => switchToFile(p));
    wrap.appendChild(tab);
  });
}

function closeTab(p) {
  state.openTabs = state.openTabs.filter((t) => t !== p);
  if (state.activeFile === p) {
    const next = state.openTabs[state.openTabs.length - 1] || null;
    if (next) switchToFile(next);
    else {
      state.activeFile = null;
      state.cm.setValue("");
    }
  }
  renderTabs();
}

async function deleteFile(p) {
  if (!confirm(`Delete ${p}? This can't be undone.`)) return;
  try {
    const res = await fetch(`/api/studio/projects/${state.projectId}/file?path=${encodeURIComponent(p)}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Delete failed.");
    state.project = data.project;
    state.buffers.delete(p);
    closeTab(p);
    renderFileList();
  } catch (e) {
    alert(e.message);
  }
}

async function createNewFile() {
  const name = prompt("New file name (e.g. utils.js, robot.py):");
  if (!name) return;
  try {
    const res = await fetch(`/api/studio/projects/${state.projectId}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: name, content: "" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Could not create file.");
    state.project = data.project;
    state.buffers.set(name, { content: "", dirty: false });
    renderFileList();
    openFile(name);
  } catch (e) {
    alert(e.message);
  }
}

async function saveActiveFile() {
  const p = state.activeFile;
  if (!p) return;
  const buf = state.buffers.get(p);
  if (!buf) return;
  try {
    const res = await fetch(`/api/studio/projects/${state.projectId}/file`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p, content: buf.content }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Save failed.");
    buf.dirty = false;
    renderTabs();
    flashButton($("btn-save"), "SAVED ✓");
  } catch (e) {
    alert(e.message);
  }
}

function flashButton(btn, text) {
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = original; }, 1200);
}

// ── WORKSPACE TABS (CODE / DESIGN) ─────────────────────────────
function initWorkspaceTabs() {
  document.querySelectorAll(".ws-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".ws-tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.ws;
      $("ws-code").classList.toggle("active", target === "code");
      $("ws-design").classList.toggle("active", target === "design");
    });
  });
  $("ws-code").classList.add("active");
}

// ── TOOLBAR ─────────────────────────────────────────────────
function initToolbar() {
  $("btn-new-file").onclick = createNewFile;
  $("btn-save").onclick = saveActiveFile;
  $("btn-run").onclick = runActiveFile;
  $("btn-download").onclick = () => {
    window.location.href = `/api/studio/projects/${state.projectId}/download`;
  };
  $("btn-back").onclick = () => {
    if (confirm("Leave Project Studio? Unsaved changes in open tabs will be lost.")) {
      window.location.href = "/";
    }
  };

  // Ctrl/Cmd+S to save
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveActiveFile();
    }
  });
}

// ── CONSOLE / RUN SCRIPT ────────────────────────────────────
function initConsole() {
  $("console-toggle").addEventListener("click", () => {
    $("console-wrap").classList.toggle("collapsed");
  });
}

async function runActiveFile() {
  const p = state.activeFile;
  if (!p) { alert("Open a file to run it first."); return; }

  // Save first so the run reflects what's on screen.
  await saveActiveFile();

  $("console-wrap").classList.remove("collapsed");
  const statusEl = $("console-status");
  const bodyEl = $("console-body");
  statusEl.textContent = "Running…";
  statusEl.className = "console-status running";
  bodyEl.textContent = `$ run ${p}\n`;

  try {
    const res = await fetch(`/api/studio/projects/${state.projectId}/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: p }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || "Run failed.");

    let out = `$ run ${p}  (${data.ms}ms)\n`;
    if (data.stdout) out += data.stdout;
    if (data.stderr) out += (data.stdout ? "\n" : "") + data.stderr;
    if (data.timedOut) out += "\n[Timed out — script was killed after 10s]";
    if (!data.stdout && !data.stderr && !data.timedOut) out += "(no output)";

    // ── CODE ↔ BUILD BRIDGE ──────────────────────────────────────
    // Hybrid projects can drive the CAD model straight from a script:
    // any stdout line shaped like JARVIS_BUILD:{...json...} gets parsed
    // out and forwarded to the DESIGN tab's iframe, which animates the
    // matching (or selected) part live. This is what makes "write the
    // code, hit Run, watch the build react" actually work end-to-end.
    if (state.project.type === "hybrid" && data.stdout) {
      const sent = forwardBuildCommands(data.stdout);
      if (sent > 0) out += `\n\n[→ sent ${sent} command${sent === 1 ? "" : "s"} to the DESIGN tab]`;
    }

    bodyEl.textContent = out;

    if (data.timedOut || data.exitCode !== 0) {
      statusEl.textContent = data.timedOut ? "Timed out" : `Exited (${data.exitCode})`;
      statusEl.className = "console-status err";
    } else {
      statusEl.textContent = "Success";
      statusEl.className = "console-status";
    }
  } catch (e) {
    bodyEl.textContent = `$ run ${p}\n${e.message}`;
    statusEl.textContent = "Error";
    statusEl.className = "console-status err";
  }
}

// The DESIGN iframe (build-mode.html) posts its current feature count
// every time it rebuilds, so the AI panel can tell whether the CAD scene
// is empty or not without having to reach into the iframe's internals.
window.addEventListener("message", (ev) => {
  const d = ev.data;
  if (!d || d.type !== "jarvis_build_state") return;
  state.designFeatureCount = Number(d.count) || 0;
  state.designIframeReady = true;
});

// ── CODE ↔ BUILD BRIDGE ─────────────────────────────────────
// Scans run-script stdout for lines like:
//   JARVIS_BUILD:{"action":"rotate","axis":"y","degrees":25}
// and posts each parsed command to the DESIGN tab's iframe. Returns
// how many commands were successfully sent (shown in the console).
function forwardBuildCommands(stdout) {
  const iframe = $("design-iframe");
  if (!iframe || !iframe.contentWindow) return 0;
  const lines = String(stdout).split("\n");
  let sent = 0;
  for (const line of lines) {
    const m = line.match(/JARVIS_BUILD:\s*(\{.*\})\s*$/);
    if (!m) continue;
    let cmd;
    try { cmd = JSON.parse(m[1]); } catch { continue; }
    iframe.contentWindow.postMessage({ type: "jarvis_build_cmd", cmd }, "*");
    sent++;
  }
  // Bring the DESIGN tab into view so the reaction is actually visible
  // during a live demo, instead of happening silently behind the CODE tab.
  if (sent > 0) {
    document.querySelectorAll(".ws-tab").forEach((t) => t.classList.toggle("active", t.dataset.ws === "design"));
    $("ws-code").classList.remove("active");
    $("ws-design").classList.add("active");
  }
  return sent;
}

// ── AI ASSISTANT ────────────────────────────────────────────
// Loosely matches "build/make/design/construct a robot arm", "model a
// gripper", "cad" mentions, etc. Deliberately permissive rather than
// exact — false positives just mean an extra (cheap) /api/build/generate
// call, but false negatives mean "make it wave" silently does nothing,
// which is the actually annoying failure mode.
const BUILD_INTENT_RE = /\b(build|make|create|design|construct|generate|model)\b[^.?!]{0,40}\b(arm|robot|gripper|claw|drone|car|chassis|frame|wheel|leg|hand|body|servo|motor|joint|part|shape|model|structure|mechanism|device|thing)\b|\bcad\b|\b3d model\b/i;

function initAIPanel() {
  $("ai-send").onclick = sendAIMessage;
  $("ai-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendAIMessage();
    }
  });
}

async function sendAIMessage() {
  const input = $("ai-input");
  const message = input.value.trim();
  if (!message) return;
  input.value = "";
  appendAIMessage("user", message);
  state.aiHistory.push({ role: "user", content: message });

  const thinking = appendAIMessage("jarvis", "…thinking…");

  const activeFile = state.activeFile;
  const activeFileContent = activeFile ? (state.buffers.get(activeFile)?.content || "") : "";

  try {
    const res = await fetch(`/api/studio/projects/${state.projectId}/ai`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, activeFile, activeFileContent, history: state.aiHistory }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "The AI assistant is unavailable.");
    thinking.remove();
    appendAIMessage("jarvis", data.reply);
    state.aiHistory.push({ role: "assistant", content: data.reply });

    // ── AUTO-INSERT: drop the AI's code straight into the open file
    //    instead of making you copy/paste it in by hand. ──
    await autoInsertCode(data.reply, activeFile);

    // ── AUTO-BUILD: hybrid projects only, and only if the DESIGN tab
    //    doesn't already have something in it — this never silently
    //    overwrites a model you've already built. ──
    if (state.project?.type === "hybrid" && BUILD_INTENT_RE.test(message) && state.designFeatureCount === 0) {
      await autoBuildFromPrompt(message);
    }
  } catch (e) {
    thinking.remove();
    appendAIMessage("jarvis", `Apologies — ${e.message}`);
  }
}

// Pulls every ```lang\ncode``` block out of an AI reply and returns the
// biggest one (by character count) — reliably "the actual file", as
// opposed to a short inline example mentioned elsewhere in the reply.
function extractLargestCodeBlock(text) {
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let best = null, m;
  while ((m = re.exec(String(text)))) {
    const code = m[2].replace(/\n$/, "");
    if (!code.trim()) continue;
    if (!best || code.length > best.code.length) best = { lang: m[1], code };
  }
  return best;
}

// Writes the AI's code straight into the file that was open when the
// question was asked (not necessarily the one on screen right now, in
// case the person tabbed away while waiting on a reply) and saves it.
async function autoInsertCode(reply, targetFile) {
  if (!targetFile) return;
  const block = extractLargestCodeBlock(reply);
  if (!block) return;
  const buf = state.buffers.get(targetFile);
  if (!buf) return;

  buf.content = block.code;
  buf.dirty = true;
  if (state.activeFile === targetFile) state.cm.setValue(block.code);
  renderTabs();

  const prevActive = state.activeFile;
  state.activeFile = targetFile; // saveActiveFile() saves whatever this points at
  await saveActiveFile();
  state.activeFile = prevActive;
  if (prevActive !== targetFile && state.cm) switchToFile(prevActive); // restore the visible tab/mode

  appendAIMessage("jarvis", `✓ Inserted into ${targetFile} and saved.`);
}

// Calls the same /api/build/generate endpoint the DESIGN tab's own
// prompt bar uses, then forwards the resulting plan into the iframe so
// "build me a robot arm that waves" actually produces a model, not just
// runnable code with nothing to run it against yet.
async function autoBuildFromPrompt(prompt) {
  const iframe = $("design-iframe");
  if (!iframe) return;
  const note = appendAIMessage("jarvis", "…building it in the CAD engine…");
  try {
    await waitForDesignIframeReady();
    const res = await fetch("/api/build/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Build generation failed.");
    note.remove();
    iframe.contentWindow?.postMessage({ type: "jarvis_build_plan", plan: data.plan, append: true }, "*");
    appendAIMessage("jarvis", `✓ Built it in the DESIGN tab${data.plan?.name ? ` — "${data.plan.name}"` : ""}. Switching you over now — hit Run on your script to see the code drive it.`);
    document.querySelectorAll(".ws-tab").forEach((t) => t.classList.toggle("active", t.dataset.ws === "design"));
    $("ws-code").classList.remove("active");
    $("ws-design").classList.add("active");
  } catch (e) {
    note.remove();
    appendAIMessage("jarvis", `Couldn't auto-build the CAD model: ${e.message}`);
  }
}

// The DESIGN iframe only starts posting jarvis_build_state once its own
// script has run (see build-mode.html's rebuildAll()). If the AI panel's
// first message arrives before that iframe has finished loading, wait a
// beat rather than firing a postMessage into a page with no listener yet.
async function waitForDesignIframeReady(timeoutMs = 4000) {
  const start = Date.now();
  while (!state.designIframeReady && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Renders AI text safely: plain text is escaped; fenced ```code```
// blocks become <pre><code> elements built via textContent, never
// innerHTML, so nothing in a reply can execute as markup.
function appendAIMessage(who, text) {
  const log = $("ai-log");
  const el = document.createElement("div");
  el.className = `ai-msg ${who}`;

  const parts = String(text).split(/```(\w*)\n?/);
  // parts alternates: [plainText, lang, code, plainText, lang, code, ...]
  for (let i = 0; i < parts.length; i++) {
    if (i % 3 === 0) {
      if (parts[i]) el.appendChild(document.createTextNode(parts[i]));
    } else if (i % 3 === 2) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = parts[i];
      pre.appendChild(code);
      el.appendChild(pre);
    }
  }
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

document.addEventListener("DOMContentLoaded", initOnboarding);
