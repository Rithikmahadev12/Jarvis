"use strict";

// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — PROJECT STUDIO
// Backend for the in-browser coding + building workspace.
//   "Jarvis, start a project" → coding / building / hybrid.
// Coding projects get a real file tree, a save-to-disk editor
// backend, a one-click ZIP download, and a sandboxed "Run Script"
// executor so code can actually be tested from the browser —
// exactly like a mini VS Code + Replit baked into Jarvis.
// Hybrid projects are the same, plus a link over to Build Mode
// (build-engine.js / build-ai.js) for the physical/CAD side, so
// one project can hold both the code and the thing it controls.
// ═══════════════════════════════════════════════════════════════

const fs   = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const archiver = require("archiver");

const DATA_DIR    = path.join(__dirname, "data", "studio");
const PROJECTS_IDX = path.join(DATA_DIR, "projects.json");

const VALID_TYPES = new Set(["coding", "building", "hybrid"]);

// Extension → interpreter used by "Run Script". Kept short and
// explicit on purpose — arbitrary interpreters are not allowed.
const RUNNERS = {
  ".js":  { cmd: "node",   args: (f) => [f] },
  ".mjs": { cmd: "node",   args: (f) => [f] },
  ".py":  { cmd: "python3", args: (f) => [f] },
};

const MAX_RUN_MS   = 10000;   // hard timeout per run
const MAX_OUTPUT   = 20000;   // chars kept per stream

// ── SETUP ─────────────────────────────────────────────────────
function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PROJECTS_IDX)) fs.writeFileSync(PROJECTS_IDX, "[]");
}

function loadIndex() {
  ensureDataDir();
  try { return JSON.parse(fs.readFileSync(PROJECTS_IDX, "utf8")); }
  catch { return []; }
}
function saveIndex(list) {
  ensureDataDir();
  fs.writeFileSync(PROJECTS_IDX, JSON.stringify(list, null, 2));
}

function genId() {
  return "proj_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function projectDir(id)  { return path.join(DATA_DIR, id); }
function filesDir(id)    { return path.join(projectDir(id), "files"); }

// Resolve a user-supplied relative path safely inside a project's
// files/ directory. Throws on any attempt to escape it.
function safeFilePath(id, relPath) {
  const base = filesDir(id);
  const clean = String(relPath || "").replace(/^[/\\]+/, "");
  const resolved = path.normalize(path.join(base, clean));
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error("Invalid file path.");
  }
  return resolved;
}

function walkFiles(dir, base, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel  = path.relative(base, full).split(path.sep).join("/");
    if (e.isDirectory()) walkFiles(full, base, out);
    else out.push(rel);
  }
  return out;
}

// ── STARTER TEMPLATES ────────────────────────────────────────
function starterFiles(type, name) {
  const safeName = (name || "New Project").trim();
  if (type === "building") return {}; // pure build projects live in Build Mode

  if (type === "hybrid") {
    return {
      "main.js":
`// ${safeName}
// This is a HYBRID project: the code you write here can talk directly
// to the CAD model in the DESIGN tab, so you can build the physical
// thing AND the code that drives it, then test them together.
//
// THE BRIDGE: print a line shaped like
//   JARVIS_BUILD:{"action":"rotate","axis":"y","degrees":25}
// and Run Script will forward it straight to the DESIGN tab, which
// animates the currently-selected part (or the whole model if nothing
// is selected). That's it — no extra wiring required.
//
// Example below: simulate hearing the wake word "hey" and nudging an
// arm — swap this out for a real mic/sensor input once you have
// hardware attached; the bridge call is identical either way.

function onWakeWord(word) {
  if (word.toLowerCase() !== "hey") return;
  console.log('Heard "hey" — moving the arm.');
  console.log('JARVIS_BUILD:' + JSON.stringify({ action: "rotate", axis: "y", degrees: 25 }));
}

function main() {
  console.log("Hello from ${safeName}!");
  onWakeWord("hey");
}

main();
`,
      "README.md":
`# ${safeName}

Created in J.A.R.V.I.S Project Studio — **Hybrid** (code + build).

- Edit files in the tree on the left; the **DESIGN** tab holds the CAD model.
- **Save** writes your changes to the server.
- **Run Script** executes the selected file, shows live output below,
  AND forwards any \`JARVIS_BUILD:{...}\` lines it prints to the DESIGN
  tab so you can watch/test the build react in real time.
- Select a part in the DESIGN tab first if you want a command to target
  that specific part; otherwise it moves the whole model.
- **Download ZIP** exports the whole project to your computer.
`,
    };
  }

  return {
    "main.js":
`// ${safeName}
// Write your code here, then hit "Run Script" to test it live.
// Ask the AI assistant on the right for help any time.

function main() {
  console.log("Hello from ${safeName}!");
}

main();
`,
    "README.md":
`# ${safeName}

Created in J.A.R.V.I.S Project Studio.

- Edit files in the tree on the left.
- **Save** writes your changes to the server.
- **Run Script** executes the selected file and shows live output below.
- **Download ZIP** exports the whole project to your computer.
`,
  };
}

// ── CRUD ──────────────────────────────────────────────────────
function listProjects() {
  return loadIndex().sort((a, b) => b.updatedAt - a.updatedAt);
}

function createProject({ name, type }) {
  if (!VALID_TYPES.has(type)) throw new Error("type must be coding, building, or hybrid.");
  ensureDataDir();
  const id = genId();
  const now = Date.now();
  const meta = {
    id,
    name: (name || "Untitled Project").trim().slice(0, 80),
    type,
    createdAt: now,
    updatedAt: now,
  };

  fs.mkdirSync(filesDir(id), { recursive: true });
  const starters = starterFiles(type, meta.name);
  for (const [rel, content] of Object.entries(starters)) {
    fs.writeFileSync(safeFilePath(id, rel), content);
  }

  const idx = loadIndex();
  idx.push(meta);
  saveIndex(idx);
  return getProject(id);
}

function getProject(id) {
  const idx = loadIndex();
  const meta = idx.find((p) => p.id === id);
  if (!meta) throw new Error("Project not found.");
  const files = walkFiles(filesDir(id), filesDir(id)).sort();
  return { ...meta, files };
}

function touchProject(id) {
  const idx = loadIndex();
  const meta = idx.find((p) => p.id === id);
  if (meta) { meta.updatedAt = Date.now(); saveIndex(idx); }
}

function deleteProject(id) {
  const idx = loadIndex();
  const next = idx.filter((p) => p.id !== id);
  if (next.length === idx.length) throw new Error("Project not found.");
  saveIndex(next);
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}

// ── FILE OPS ──────────────────────────────────────────────────
function readFile(id, relPath) {
  const full = safeFilePath(id, relPath);
  return fs.readFileSync(full, "utf8");
}

function saveFile(id, relPath, content) {
  const full = safeFilePath(id, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content ?? "");
  touchProject(id);
  return getProject(id);
}

function renameFile(id, fromPath, toPath) {
  const from = safeFilePath(id, fromPath);
  const to   = safeFilePath(id, toPath);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  touchProject(id);
  return getProject(id);
}

function deleteFile(id, relPath) {
  const full = safeFilePath(id, relPath);
  fs.rmSync(full, { force: true });
  touchProject(id);
  return getProject(id);
}

// ── ZIP DOWNLOAD ──────────────────────────────────────────────
function streamZip(id, res) {
  const meta = getProject(id);
  const zipName = meta.name.replace(/[^a-z0-9-_ ]/gi, "").trim() || "project";
  res.attachment(`${zipName}.zip`);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.on("error", (err) => { throw err; });
  archive.pipe(res);
  archive.directory(filesDir(id), false);
  archive.finalize();
}

// ── RUN SCRIPT (sandboxed-ish local execution) ────────────────
// Runs a single file with a hard timeout and captures stdout/stderr.
// This trusts the local process the same way a terminal would —
// it is scoped to the project's own files/ directory as its cwd
// and the file must live inside the project, but it is NOT a
// hardened multi-tenant sandbox. Fine for a personal assistant
// running your own code; don't expose this endpoint publicly
// without adding real isolation (container/VM) first.
function runScript(id, relPath) {
  return new Promise((resolve) => {
    let full;
    try { full = safeFilePath(id, relPath); }
    catch (e) { return resolve({ ok: false, error: e.message }); }

    if (!fs.existsSync(full)) {
      return resolve({ ok: false, error: "File not found." });
    }
    const ext = path.extname(full).toLowerCase();
    const runner = RUNNERS[ext];
    if (!runner) {
      return resolve({ ok: false, error: `Don't know how to run a "${ext || "no-extension"}" file. Supported: .js, .mjs, .py` });
    }

    const startedAt = Date.now();
    let stdout = "", stderr = "", killed = false;

    let child;
    try {
      child = spawn(runner.cmd, runner.args(full), {
        cwd: filesDir(id),
        env: { ...process.env, NODE_ENV: "sandbox" },
      });
    } catch (e) {
      return resolve({ ok: false, error: `Could not start ${runner.cmd}: ${e.message}` });
    }

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill("SIGKILL"); } catch {}
    }, MAX_RUN_MS);

    child.stdout.on("data", (d) => {
      if (stdout.length < MAX_OUTPUT) stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < MAX_OUTPUT) stderr += d.toString();
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `${runner.cmd} is not available on this server (${e.message}).` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: !killed && code === 0,
        exitCode: code,
        timedOut: killed,
        stdout: stdout.slice(0, MAX_OUTPUT),
        stderr: stderr.slice(0, MAX_OUTPUT),
        ms: Date.now() - startedAt,
      });
    });
  });
}

module.exports = {
  listProjects,
  createProject,
  getProject,
  deleteProject,
  readFile,
  saveFile,
  renameFile,
  deleteFile,
  streamZip,
  runScript,
  filesDir,
};
