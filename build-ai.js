"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — BUILD MODE AI GENERATOR (feature-tree kernel)
//
// Turns a text prompt into a real parametric feature tree — sketches,
// extrudes, revolves, boolean CSG, primitives, and linear/circular
// patterns — that public/build-mode.html's CAD engine executes
// directly. This is NOT a catalog of pre-made parts: every feature is
// generated with its own numbers (radii, depths, spacing, angles) so
// arbitrary mechanical assemblies (an engine, a bracket, a gearbox...)
// can come out the other end, not just a fixed part list.
//
// Uses the same Groq connection as the rest of Jarvis (hermes-engine).
// If Groq isn't configured, callers get a clear error so the UI can
// tell the user why nothing happened instead of failing silently.
// ═══════════════════════════════════════════════════════════════

let Hermes = null;
try { Hermes = require("./hermes-engine"); } catch { Hermes = null; }

const FEATURE_TYPES = new Set(["sketch", "primitive", "extrude", "revolve", "boolean", "pattern"]);
const PLANES = new Set(["XY", "XZ", "YZ"]);
const SKETCH_SHAPES = new Set(["rect", "circle", "polygon"]);
const PRIM_SHAPES = new Set(["box", "cylinder", "sphere", "cone", "torus"]);
const BOOL_OPS = new Set(["union", "subtract", "intersect"]);
const PATTERN_MODES = new Set(["linear", "circular"]);

const MAX_FEATURES = 40;

const SYSTEM_PROMPT = `You are the modeling brain behind J.A.R.V.I.S's CAD engine — a real feature-tree kernel, not a library of preset parts. You output a sequence of features that a client-side kernel executes literally: sketches become solids via extrude/revolve, solids combine via boolean CSG, and solids can be arrayed with linear/circular patterns. There is no "just place a premade gear" option — if the build needs a gear, you construct it from a sketch + extrude (or revolve) + pattern of teeth, etc.

Output ONLY a single JSON object (no markdown fences, no prose, no commentary):

{
  "name": "short name for the build",
  "features": [ /* ordered — later features may reference earlier ones by id */
    {
      "id": "short_unique_id",
      "type": "sketch",
      "plane": "XY" | "XZ" | "YZ",
      "origin": [x, y, z],
      "shape": "rect" | "circle" | "polygon",
      "rect": { "w": number, "h": number },
      "circle": { "r": number },
      "polygon": { "points": [[u, v], ...] }
    },
    {
      "id": "short_unique_id",
      "type": "primitive",
      "shape": "box" | "cylinder" | "sphere" | "cone" | "torus",
      "dims": { /* box: w,h,d · cylinder/cone: r,h,segments · sphere: r · torus: r,tube */ },
      "position": [x, y, z],
      "rotationDeg": [x, y, z],
      "material": { "color": "#rrggbb", "metalness": 0-1, "roughness": 0-1 }
    },
    {
      "id": "short_unique_id",
      "type": "extrude",
      "sketch": "id_of_a_sketch_feature",
      "depth": number,
      "symmetric": true|false,
      "material": { "color": "#rrggbb" }
    },
    {
      "id": "short_unique_id",
      "type": "revolve",
      "sketch": "id_of_a_sketch_feature (profile: u = radius >= 0, v = height along axis)",
      "angleDeg": 0-360,
      "segments": 16-64,
      "material": { "color": "#rrggbb" }
    },
    {
      "id": "short_unique_id",
      "type": "boolean",
      "a": "id_of_solid_feature",
      "b": "id_of_solid_feature",
      "op": "union" | "subtract" | "intersect"
    },
    {
      "id": "short_unique_id",
      "type": "pattern",
      "source": "id_of_solid_feature",
      "mode": "linear" | "circular",
      "count": integer,
      "linear": { "axis": [x,y,z], "spacing": number },
      "circular": { "axis": [x,y,z], "center": [x,y,z], "angleDeg": number },
      "hideSource": true
    }
  ]
}

Modeling rules:
- Units are meters. Keep the whole build roughly within -6..6 on x/z and 0..8 on y.
- A sketch is a flat profile on one of three planes, described in that plane's own local (u,v) coordinates around its own origin — it renders nothing solid by itself.
- "extrude" pushes a sketch's profile straight along the plane's normal by "depth". Use "symmetric": true to extrude half each way.
- "revolve" spins a sketch's profile 360° (or "angleDeg" less) around the vertical (v) axis of its own plane. The profile's u values are radii and MUST be >= 0 — this is how you make anything round in cross-section: pistons, shafts, domes, rings, bottles.
- "boolean" always references two EARLIER feature ids (sketches don't count — only primitive/extrude/revolve/boolean/pattern produce solids). Use "subtract" to cut holes/pockets/counterbores, "union" to fuse parts into one body, "intersect" for the overlap of two solids.
- "pattern" clones an earlier solid feature: "linear" repeats it along a straight axis (spacing in meters between copies), "circular" repeats it rotated around an axis/center (angleDeg is the total spread — use 360 for a full bolt circle, less for a partial fan). Use this for repeated features: cylinders on a crankshaft, teeth on a gear, bolt holes, fins, spokes.
- Build the real mechanism, don't approximate with a single primitive when the description implies internal structure (holes, teeth, ribs, multiple cylinders, etc.) — use booleans and patterns to actually produce that structure.
- Keep to ${MAX_FEATURES} features or fewer. Simple asks need far fewer — most builds should use 6-20 features.
- Respond with raw JSON only. No \`\`\`json fences, no explanation before or after.`;

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(v, lo, hi, fallback) {
  const n = num(v, fallback);
  return Math.min(hi, Math.max(lo, n));
}
function str(v, fallback) {
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 60) : fallback;
}
function hexColor(v, fallback) {
  return typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v.trim())
    ? (v.trim().startsWith("#") ? v.trim() : "#" + v.trim())
    : fallback;
}
function vec3(v, fallback) {
  if (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(Number(n)))) return v.map(Number);
  return fallback;
}
function material(m) {
  if (!m || typeof m !== "object") return undefined;
  return {
    color: hexColor(m.color, "#9fb4c4"),
    metalness: clamp(m.metalness, 0, 1, 0.6),
    roughness: clamp(m.roughness, 0, 1, 0.4),
  };
}
function sanitizePoints(pts) {
  if (!Array.isArray(pts)) return null;
  const clean = pts
    .filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
    .slice(0, 40)
    .map((p) => [clamp(p[0], -8, 8, 0), clamp(p[1], -8, 8, 0)]);
  return clean.length >= 3 ? clean : null;
}

function sanitizeFeature(raw, idSet, idx) {
  if (!raw || typeof raw !== "object" || !FEATURE_TYPES.has(raw.type)) return null;
  let id = str(raw.id, `f_${idx}`).replace(/[^a-zA-Z0-9_]/g, "_");
  while (idSet.has(id)) id = `${id}_${idx}`;
  idSet.add(id);

  if (raw.type === "sketch") {
    const plane = PLANES.has(raw.plane) ? raw.plane : "XY";
    const shape = SKETCH_SHAPES.has(raw.shape) ? raw.shape : "circle";
    const f = { id, type: "sketch", plane, origin: vec3(raw.origin, [0, 0, 0]), shape };
    if (shape === "rect") f.rect = { w: clamp(raw.rect?.w, 0.02, 10, 1), h: clamp(raw.rect?.h, 0.02, 10, 1) };
    else if (shape === "circle") f.circle = { r: clamp(raw.circle?.r, 0.01, 5, 0.5) };
    else {
      const pts = sanitizePoints(raw.polygon?.points);
      if (!pts) return null;
      f.polygon = { points: pts };
    }
    return f;
  }
  if (raw.type === "primitive") {
    const shape = PRIM_SHAPES.has(raw.shape) ? raw.shape : "box";
    const d = raw.dims || {};
    const dims =
      shape === "box" ? { w: clamp(d.w, 0.01, 10, 1), h: clamp(d.h, 0.01, 10, 1), d: clamp(d.d, 0.01, 10, 1) } :
      shape === "cylinder" ? { r: clamp(d.r, 0.005, 5, 0.5), h: clamp(d.h, 0.01, 10, 1), segments: Math.round(clamp(d.segments, 6, 64, 32)) } :
      shape === "cone" ? { r: clamp(d.r, 0.005, 5, 0.5), h: clamp(d.h, 0.01, 10, 1), segments: Math.round(clamp(d.segments, 6, 64, 32)) } :
      shape === "sphere" ? { r: clamp(d.r, 0.005, 5, 0.5) } :
      { r: clamp(d.r, 0.01, 5, 0.6), tube: clamp(d.tube, 0.005, 2, 0.15) };
    return {
      id, type: "primitive", shape, dims,
      position: vec3(raw.position, [0, 0, 0]),
      rotationDeg: vec3(raw.rotationDeg, [0, 0, 0]),
      ...(material(raw.material) ? { material: material(raw.material) } : {}),
    };
  }
  if (raw.type === "extrude") {
    if (typeof raw.sketch !== "string") return null;
    return {
      id, type: "extrude", sketch: raw.sketch,
      depth: clamp(raw.depth, 0.005, 10, 1),
      symmetric: !!raw.symmetric,
      ...(material(raw.material) ? { material: material(raw.material) } : {}),
    };
  }
  if (raw.type === "revolve") {
    if (typeof raw.sketch !== "string") return null;
    return {
      id, type: "revolve", sketch: raw.sketch,
      angleDeg: clamp(raw.angleDeg, 1, 360, 360),
      segments: Math.round(clamp(raw.segments, 8, 96, 32)),
      ...(material(raw.material) ? { material: material(raw.material) } : {}),
    };
  }
  if (raw.type === "boolean") {
    if (typeof raw.a !== "string" || typeof raw.b !== "string" || raw.a === raw.b) return null;
    return { id, type: "boolean", a: raw.a, b: raw.b, op: BOOL_OPS.has(raw.op) ? raw.op : "union" };
  }
  if (raw.type === "pattern") {
    if (typeof raw.source !== "string") return null;
    const mode = PATTERN_MODES.has(raw.mode) ? raw.mode : "linear";
    const f = {
      id, type: "pattern", source: raw.source, mode,
      count: Math.round(clamp(raw.count, 1, 64, 4)),
      hideSource: raw.hideSource !== false,
    };
    if (mode === "linear") f.linear = { axis: vec3(raw.linear?.axis, [1, 0, 0]), spacing: clamp(raw.linear?.spacing, 0.005, 10, 1) };
    else f.circular = { axis: vec3(raw.circular?.axis, [0, 1, 0]), center: vec3(raw.circular?.center, [0, 0, 0]), angleDeg: clamp(raw.circular?.angleDeg, 1, 360, 360) };
    return f;
  }
  return null;
}

// References must point at ids that occur EARLIER in the list (the
// engine builds top-to-bottom, same as a real CAD timeline) — drop
// any feature whose reference isn't satisfiable instead of letting
// the client crash on a dangling id.
function sanitizeFeatureList(rawFeatures) {
  const idSet = new Set();
  const seenIds = new Set();
  const out = [];
  for (let i = 0; i < Math.min(rawFeatures.length, MAX_FEATURES); i++) {
    const f = sanitizeFeature(rawFeatures[i], idSet, i);
    if (!f) continue;
    const refs = [f.sketch, f.a, f.b, f.source].filter(Boolean);
    if (refs.some((r) => !seenIds.has(r))) continue;
    seenIds.add(f.id);
    out.push(f);
  }
  return out;
}

function sanitizePlan(raw, fallbackName) {
  const features = sanitizeFeatureList(Array.isArray(raw?.features) ? raw.features : []);
  return { name: str(raw?.name, fallbackName), features };
}

function extractJson(text) {
  const trimmed = (text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("Model did not return JSON");
  return JSON.parse(stripTrailingCommas(trimmed.slice(start, end + 1)));
}

// Strips trailing commas before ] or } — the single most common way
// these models produce technically-invalid JSON.
function stripTrailingCommas(text) {
  return text.replace(/,(\s*[\]}])/g, "$1");
}

// If generation got cut off mid-array/object (hit max_tokens), the tail
// of the string is a dangling partial element. Walk backward from the
// end, dropping one trailing top-level-ish chunk at a time and
// re-closing all open brackets, until something parses. Recovers a
// truncated but otherwise well-formed plan instead of failing outright.
function tryRepairTruncated(text) {
  for (let cut = text.length; cut > 0; ) {
    const lastComma = text.lastIndexOf(",", cut - 1);
    const lastOpen = Math.max(text.lastIndexOf("{", cut - 1), text.lastIndexOf("[", cut - 1));
    const splitAt = Math.max(lastComma, lastOpen);
    if (splitAt <= 0) break;
    let candidate = text.slice(0, splitAt);
    candidate = candidate.replace(/[,{[\s]*$/, (m) => (m.includes(",") ? "" : m.replace(/,/, "")));
    let depthCurly = 0, depthSquare = 0, inStr = false, esc = false;
    for (const ch of candidate) {
      if (esc) { esc = false; continue; }
      if (ch === "\\") { esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === "{") depthCurly++; else if (ch === "}") depthCurly--;
      else if (ch === "[") depthSquare++; else if (ch === "]") depthSquare--;
    }
    let closers = "";
    while (depthSquare-- > 0) closers += "]";
    while (depthCurly-- > 0) closers += "}";
    try {
      return JSON.parse(stripTrailingCommas(candidate + closers));
    } catch {
      cut = splitAt;
    }
  }
  return null;
}

async function generateBuildPlan(prompt) {
  if (!Hermes || !Hermes.isConfigured()) {
    throw new Error("Build AI isn't configured — set GROQ_API_KEY in .env to let Jarvis design builds.");
  }
  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `Build this: ${prompt}` },
  ];
  const raw = await Hermes.groqFetch(messages, Hermes.MODELS.smart, 0.5, 5000);
  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (firstErr) {
    const trimmed = (raw || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "");
    const start = trimmed.indexOf("{");
    const repaired = start !== -1 ? tryRepairTruncated(trimmed.slice(start)) : null;
    if (!repaired) {
      throw new Error(`Couldn't parse a build plan from the model: ${firstErr.message}`);
    }
    parsed = repaired;
  }
  const plan = sanitizePlan(parsed, prompt.slice(0, 40));
  if (!plan.features.length) throw new Error("The model returned an empty build — try describing it differently.");
  return plan;
}

module.exports = { generateBuildPlan, sanitizePlan, FEATURE_TYPES, PRIM_SHAPES };
