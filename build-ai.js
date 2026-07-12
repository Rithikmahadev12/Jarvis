"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — BUILD MODE AI GENERATOR
// Turns "build a hydrogen tank with a repulsor that jets flame out
// the back" into a structured JSON scene plan that the client
// (public/build-mode.html) can spawn using its existing shape/weld/
// physics primitives — no new geometry code needed client-side,
// just a data-driven layer on top of what's already there.
//
// Uses the same Groq connection as the rest of Jarvis (hermes-engine).
// If Groq isn't configured, callers get a clear error so the UI can
// tell the user why nothing happened instead of failing silently.
// ═══════════════════════════════════════════════════════════════

let Hermes = null;
try { Hermes = require("./hermes-engine"); } catch { Hermes = null; }

const SHAPE_TYPES = new Set(["box", "sphere", "cylinder", "cone", "torus", "wedge"]);
const EFFECT_TYPES = new Set(["flame", "sparks", "smoke", "glow"]);

const MAX_PARTS = 24;
const MAX_WELDS = 40;
const MAX_EFFECTS = 8;

const SYSTEM_PROMPT = `You are the scene-planning brain for J.A.R.V.I.S's "Build Mode" — a 3D CAD workshop built from simple primitive shapes (like building something out of blocky parts, not photoreal models).

Given a description of something to build, output ONLY a single JSON object (no markdown fences, no prose, no commentary) describing how to assemble it from primitives. Schema:

{
  "name": "short name for the build",
  "parts": [
    {
      "id": "short_unique_id",
      "shapeType": "box" | "sphere" | "cylinder" | "cone" | "torus" | "wedge",
      "params": { /* box/wedge: w,h,d (meters, ~0.05-2 each). sphere: r. cylinder/cone: r,h. torus: r,tube */ },
      "position": { "x": 0, "y": 0, "z": 0 },
      "rotationDeg": { "axis": "x" | "y" | "z", "deg": 0 },
      "color": "#rrggbb",
      "metal": 0.0-1.0,
      "rough": 0.0-1.0,
      "sizeScale": 0.2-2.0,
      "physics": false
    }
  ],
  "welds": [ ["part_id_a", "part_id_b"] ],
  "effects": [
    {
      "attachTo": "part_id",
      "type": "flame" | "sparks" | "smoke" | "glow",
      "color": "#rrggbb",
      "direction": { "x": 0, "y": 0, "z": 1 },
      "rate": 10-80,
      "speed": 0.5-4.0,
      "size": 0.02-0.12,
      "lifetime": 0.2-1.2
    }
  ]
}

Rules:
- Build with ${MAX_PARTS} parts or fewer. Simple asks ("a helmet") should use far fewer — maybe 4-10 parts. Only complex multi-system builds need to approach the limit.
- position is the WORLD position of that part's center, in meters, roughly within -1.5..1.5 on x/z and 0..2 on y (floor is y=0). Lay parts out so they actually touch/overlap where they should connect — "position" is absolute, not relative to a parent.
- "welds" pairs of part ids that should be physically joined so they move together as one assembly. Every part that's meant to be attached to the build should appear in at least one weld pair — otherwise it's a separate floating object.
- "effects" are for things that shoot/glow/vent — like a thruster, repulsor, exhaust, or flame jet. "direction" is the local direction (unit-ish vector) the effect fires, in the attached part's own orientation. Use "flame" for fire/thrust/combustion, "sparks" for welding/electrical, "smoke" for exhaust/steam, "glow" for a steady light (like an arc reactor or LED).
- Only use effects when the description actually implies something emitting/venting/firing — don't add them to plain structural parts.
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
  return typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : fallback;
}
function hexColor(v, fallback) {
  return typeof v === "string" && /^#?[0-9a-f]{6}$/i.test(v.trim())
    ? (v.trim().startsWith("#") ? v.trim() : "#" + v.trim())
    : fallback;
}

function sanitizeParams(shapeType, raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  switch (shapeType) {
    case "box":
    case "wedge":
      return { w: clamp(p.w, 0.05, 2.2, 0.4), h: clamp(p.h, 0.05, 2.2, 0.4), d: clamp(p.d, 0.05, 2.2, 0.4) };
    case "sphere":
      return { r: clamp(p.r, 0.03, 1.2, 0.3) };
    case "cylinder":
    case "cone":
      return { r: clamp(p.r, 0.03, 1.2, 0.25), h: clamp(p.h, 0.05, 2.2, 0.5) };
    case "torus":
      return { r: clamp(p.r, 0.05, 1.2, 0.3), tube: clamp(p.tube, 0.01, 0.5, 0.08) };
    default:
      return { w: 0.4, h: 0.4, d: 0.4 };
  }
}

function sanitizePlan(raw, fallbackName) {
  const partIds = new Set();
  const parts = (Array.isArray(raw?.parts) ? raw.parts : []).slice(0, MAX_PARTS).map((p, i) => {
    const shapeType = SHAPE_TYPES.has(p?.shapeType) ? p.shapeType : "box";
    let id = str(p?.id, `part_${i}`).replace(/[^a-z0-9_]/gi, "_");
    while (partIds.has(id)) id = `${id}_${i}`;
    partIds.add(id);
    return {
      id,
      shapeType,
      params: sanitizeParams(shapeType, p?.params),
      position: {
        x: clamp(p?.position?.x, -3, 3, 0),
        y: clamp(p?.position?.y, 0, 3, 0.4),
        z: clamp(p?.position?.z, -3, 3, 0),
      },
      rotationDeg: {
        axis: ["x", "y", "z"].includes(p?.rotationDeg?.axis) ? p.rotationDeg.axis : "y",
        deg: clamp(p?.rotationDeg?.deg, -360, 360, 0),
      },
      color: hexColor(p?.color, "#9fb4c4"),
      metal: clamp(p?.metal, 0, 1, 0.5),
      rough: clamp(p?.rough, 0, 1, 0.4),
      sizeScale: clamp(p?.sizeScale, 0.2, 2, 1),
      physics: !!p?.physics,
    };
  });

  const welds = (Array.isArray(raw?.welds) ? raw.welds : [])
    .filter((w) => Array.isArray(w) && w.length === 2 && partIds.has(w[0]) && partIds.has(w[1]) && w[0] !== w[1])
    .slice(0, MAX_WELDS);

  const effects = (Array.isArray(raw?.effects) ? raw.effects : [])
    .filter((e) => e && partIds.has(e.attachTo))
    .slice(0, MAX_EFFECTS)
    .map((e) => ({
      attachTo: e.attachTo,
      type: EFFECT_TYPES.has(e.type) ? e.type : "flame",
      color: hexColor(e.color, e.type === "smoke" ? "#8a97a0" : "#ff7b00"),
      direction: {
        x: clamp(e?.direction?.x, -1, 1, 0),
        y: clamp(e?.direction?.y, -1, 1, 0),
        z: clamp(e?.direction?.z, -1, 1, 1),
      },
      rate: clamp(e.rate, 5, 100, 30),
      speed: clamp(e.speed, 0.2, 5, 1.6),
      size: clamp(e.size, 0.01, 0.2, 0.05),
      lifetime: clamp(e.lifetime, 0.1, 2, 0.6),
    }));

  return {
    name: str(raw?.name, fallbackName),
    parts,
    welds,
    effects,
  };
}

function extractJson(text) {
  const trimmed = (text || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new Error("Model did not return JSON");
  return JSON.parse(stripTrailingCommas(trimmed.slice(start, end + 1)));
}

// ── MAIN ENTRY POINT ───────────────────────────────────────────
// Strips trailing commas before ] or } — the single most common way
// these models produce technically-invalid JSON ("...cone" ]}" with a
// stray comma before the closing bracket).
function stripTrailingCommas(text) {
  return text.replace(/,(\s*[\]}])/g, "$1");
}

// If generation got cut off mid-array/object (hit max_tokens), the tail
// of the string is a dangling partial element. Walk backward from the
// end, dropping one trailing top-level-ish chunk at a time (back to the
// last comma/opening bracket at each nesting depth) and re-closing all
// open brackets, until something parses. This recovers a truncated but
// otherwise well-formed plan instead of failing outright.
function tryRepairTruncated(text) {
  for (let cut = text.length; cut > 0; ) {
    // find the last comma or opening bracket before `cut`
    const lastComma = text.lastIndexOf(",", cut - 1);
    const lastOpen = Math.max(text.lastIndexOf("{", cut - 1), text.lastIndexOf("[", cut - 1));
    const splitAt = Math.max(lastComma, lastOpen);
    if (splitAt <= 0) break;
    let candidate = text.slice(0, splitAt);
    // if we split right after an opening bracket, drop the bracket itself
    // only if nothing was written inside it yet (would leave "{" dangling)
    candidate = candidate.replace(/[,{[\s]*$/, (m) => (m.includes(",") ? "" : m.replace(/,/, "")));
    // balance remaining open brackets
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
      cut = splitAt; // try cutting further back
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
  const raw = await Hermes.groqFetch(messages, Hermes.MODELS.smart, 0.6, 4000);
  let parsed;
  try {
    parsed = extractJson(raw);
  } catch (firstErr) {
    // Fall back to truncation repair before giving up entirely.
    const trimmed = (raw || "").trim().replace(/^```json\s*/i, "").replace(/^```\s*/, "");
    const start = trimmed.indexOf("{");
    const repaired = start !== -1 ? tryRepairTruncated(trimmed.slice(start)) : null;
    if (!repaired) {
      throw new Error(`Couldn't parse a build plan from the model: ${firstErr.message}`);
    }
    parsed = repaired;
  }
  const plan = sanitizePlan(parsed, prompt.slice(0, 40));
  if (!plan.parts.length) throw new Error("The model returned an empty build — try describing it differently.");
  return plan;
}

module.exports = { generateBuildPlan, sanitizePlan, SHAPE_TYPES, EFFECT_TYPES };
