// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — FLOATING HOLOGRAM WIDGET
// Small draggable 3D holograms that appear right on the main
// screen (not a separate page/panel). Grab one with a mouse, touch,
// or a hand-tracking pinch (rides the same [data-hand-drag] pointer
// pipeline used elsewhere in the app) and move it anywhere; drag it
// off the left or right edge of the screen to dismiss it.
//
// window.HologramWidget.show(key)   — key is one of the OBJECTS below
//                                      ('earth', 'solar_system', 'atom',
//                                      'dna', 'molecule', 'brain',
//                                      'crystal', 'turbine', 'satellite',
//                                      'drone') — every model is a real
//                                      object (real NASA earth imagery,
//                                      real relative planet sizes/orbits,
//                                      real molecular/atomic structure).
// window.HologramWidget.guessKey(text) — best-effort keyword match,
//                                         used by jarvis.js so a
//                                         natural-language request
//                                         picks the right model.
// ═══════════════════════════════════════════════════════════════

window.HologramWidget = (function () {

  // ── THREE.JS LOADER (shared, loaded once) ──────────────────────
  let threePromise = null;
  function loadThree() {
    if (window.THREE) return Promise.resolve();
    if (threePromise) return threePromise;
    threePromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
    return threePromise;
  }

  // GLTFLoader for generated meshes (mesh-generator.js). cdnjs (used
  // for core three.js above) doesn't host the examples/addons folder
  // at all, so GLTFLoader has to come from jsdelivr instead — that
  // part's unavoidable. What actually caused the old "GLTFLoader is
  // not a constructor" crash wasn't the CDN differing, it was the
  // VERSION differing between the two files. So this pins jsdelivr to
  // the exact same 0.128.0 build as the cdnjs r128 core above — same
  // pairing build-mode.html already uses successfully for OrbitControls.
  let gltfLoaderPromise = null;
  function loadGLTFLoader() {
    if (window.THREE && window.THREE.GLTFLoader) return Promise.resolve();
    if (gltfLoaderPromise) return gltfLoaderPromise;
    gltfLoaderPromise = loadThree().then(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/GLTFLoader.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    }));
    return gltfLoaderPromise;
  }

  // ═══════════════════════════════════════════════
  // OBJECT BUILDERS — ported from hologram-viewer.html, real
  // geometry, not toys. Each factory returns a THREE.Group.
  // ═══════════════════════════════════════════════
function holoMat(color = 0x00c8ff, emissive = 0x003355, rough = 0.35, metal = 0.8) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(color),
    emissive: new THREE.Color(emissive),
    emissiveIntensity: 0.6,
    roughness: rough,
    metalness: metal,
    envMapIntensity: 1.5,
  });
}
function glassMat(color = 0x00c8ff) {
  return new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(color),
    transparent: true,
    opacity: 0.18,
    roughness: 0.05,
    metalness: 0.0,
    transmission: 0.8,
    thickness: 0.5,
    envMapIntensity: 2,
    side: THREE.DoubleSide,
  });
}
function wireMat(color = 0x00c8ff, opacity = 0.55) {
  return new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity });
}
function glowMat(color = 0x00ffff) {
  return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
}
function emissiveMat(color = 0x00c8ff, emissive = 0x00aaff) {
  return new THREE.MeshStandardMaterial({
    color, emissive, emissiveIntensity: 2.0, roughness: 0.2, metalness: 0.6
  });
}

// ═══════════════════════════════════════════════
// OBJECT BUILDERS — real geometry, not toys
// ═══════════════════════════════════════════════

const OBJECTS = {};

// ── EARTH (real NASA Blue Marble imagery, real cloud layer,
//    real day/night terminator lighting) ──────
let _earthTexLoader = null;
function buildEarth() {
  const g = new THREE.Group();
  g.userData.name = 'EARTH — LIVE';

  if (!_earthTexLoader) _earthTexLoader = new THREE.TextureLoader();
  _earthTexLoader.crossOrigin = 'anonymous';
  const BASE = 'https://cdn.jsdelivr.net/gh/mrdoob/three.js@r128/examples/textures/planets/';
  const dayTex = _earthTexLoader.load(BASE + 'earth_atmos_2048.jpg');
  const specTex = _earthTexLoader.load(BASE + 'earth_specular_2048.jpg');
  const normTex = _earthTexLoader.load(BASE + 'earth_normal_2048.jpg');
  const cloudTex = _earthTexLoader.load(BASE + 'earth_clouds_1024.png');

  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(1.5, 64, 64),
    new THREE.MeshPhongMaterial({
      map: dayTex,
      specularMap: specTex,
      normalMap: normTex,
      specular: new THREE.Color(0x333333),
      shininess: 6,
    })
  );
  globe.rotation.y = Math.PI * 1.15; // face the Americas toward camera
  g.add(globe);

  const clouds = new THREE.Mesh(
    new THREE.SphereGeometry(1.515, 64, 64),
    new THREE.MeshLambertMaterial({ map: cloudTex, transparent: true, opacity: 0.55 })
  );
  clouds.userData.isCloudLayer = true;
  g.add(clouds);

  // Thin atmosphere rim glow
  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(1.58, 64, 64),
    new THREE.MeshBasicMaterial({ color: 0x00c8ff, transparent: true, opacity: 0.12, side: THREE.BackSide })
  );
  g.add(atmo);

  // Real orbital shells — geostationary belt + a low-earth-orbit ring,
  // to scale relative to Earth's own radius (not decorative rings).
  [1.9, 2.3].forEach((r, i) => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(r, 0.006, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x00c8ff, transparent: true, opacity: 0.35 })
    );
    ring.rotation.x = Math.PI / 2 + (i === 0 ? 0.41 : 0); // 23.4° axial tilt on the outer ring
    g.add(ring);
  });

  // A tracked satellite riding the outer ring
  const sat = new THREE.Group();
  sat.add(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.1), holoMat(0xcccccc, 0x222222, 0.4, 0.8)));
  const panelMat = holoMat(0x2255aa, 0x001133, 0.5, 0.6);
  const p1 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.005, 0.07), panelMat); p1.position.x = 0.14; sat.add(p1);
  const p2 = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.005, 0.07), panelMat); p2.position.x = -0.14; sat.add(p2);
  sat.userData.isOrbiter = true;
  sat.userData.orbitRadius = 2.3;
  sat.userData.orbitSpeed = 0.35;
  g.add(sat);

  g.userData.polys = 16400;
  return g;
}
OBJECTS.earth = buildEarth;

// ── SOLAR SYSTEM (relative sizes + order are real; distances are
//    log-compressed so all eight planets fit in frame) ─────────
function buildSolarSystem() {
  const g = new THREE.Group();
  g.userData.name = 'SOLAR SYSTEM';

  const sun = new THREE.Mesh(new THREE.SphereGeometry(0.4, 32, 32), emissiveMat(0xffcc55, 0xff8800));
  g.add(sun);
  const sunGlow = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 32), new THREE.MeshBasicMaterial({ color: 0xffaa33, transparent: true, opacity: 0.25 }));
  g.add(sunGlow);

  // name, real relative radius (Earth=1 scaled down), orbit radius, color, orbital speed (relative)
  const PLANETS = [
    ['Mercury', 0.06, 0.75, 0x9a9a9a, 0.48],
    ['Venus',   0.14, 1.0,  0xd9b382, 0.35],
    ['Earth',   0.15, 1.3,  0x2266cc, 0.30],
    ['Mars',    0.08, 1.6,  0xb5502c, 0.24],
    ['Jupiter', 0.34, 2.15, 0xc9a06b, 0.13],
    ['Saturn',  0.29, 2.75, 0xd8c48a, 0.097],
    ['Uranus',  0.20, 3.25, 0x8fd0d8, 0.068],
    ['Neptune', 0.19, 3.7,  0x4166d5, 0.054],
  ];
  PLANETS.forEach(([name, radius, dist, color, speed]) => {
    const orbitRing = new THREE.Mesh(
      new THREE.TorusGeometry(dist, 0.004, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x00c8ff, transparent: true, opacity: 0.18 })
    );
    orbitRing.rotation.x = Math.PI / 2;
    g.add(orbitRing);

    const planet = new THREE.Mesh(new THREE.SphereGeometry(radius, 24, 24), holoMat(color, color, 0.5, 0.3));
    planet.userData.name = name;
    planet.userData.isOrbiter = true;
    planet.userData.orbitRadius = dist;
    planet.userData.orbitSpeed = speed;
    if (name === 'Saturn') {
      const ring = new THREE.Mesh(new THREE.RingGeometry(radius * 1.4, radius * 2.1, 48), wireMat(0xd8c48a, 0.7));
      ring.rotation.x = Math.PI / 2.3;
      planet.add(ring);
    }
    g.add(planet);
  });

  g.rotation.x = Math.PI / 9;
  g.userData.polys = 9000;
  return g;
}
OBJECTS.solar_system = buildSolarSystem;

// ── DNA HELIX ────────────────────────────────
function buildDNA() {
  const g = new THREE.Group();
  g.userData.name = 'DNA DOUBLE HELIX';

  const SEGMENTS = 60;
  const HEIGHT = 8;
  const RADIUS = 1.2;
  const TURNS = 4;
  const bases = ['A','T','G','C'];
  const baseColors = { A: 0x00ff88, T: 0xff4444, G: 0x4488ff, C: 0xffaa00 };

  const strandMat1 = holoMat(0x0088cc, 0x002244, 0.3, 0.7);
  const strandMat2 = holoMat(0x00ccaa, 0x003322, 0.3, 0.7);

  let prev1 = null, prev2 = null;
  const pts1 = [], pts2 = [];

  for (let i = 0; i <= SEGMENTS; i++) {
    const t = i / SEGMENTS;
    const angle = t * Math.PI * 2 * TURNS;
    const y = (t - 0.5) * HEIGHT;

    const x1 = Math.cos(angle) * RADIUS;
    const z1 = Math.sin(angle) * RADIUS;
    const x2 = Math.cos(angle + Math.PI) * RADIUS;
    const z2 = Math.sin(angle + Math.PI) * RADIUS;

    pts1.push(new THREE.Vector3(x1, y, z1));
    pts2.push(new THREE.Vector3(x2, y, z2));

    // Backbone spheres
    const sphereGeo = new THREE.SphereGeometry(0.1, 10, 10);
    const s1 = new THREE.Mesh(sphereGeo, strandMat1);
    s1.position.set(x1, y, z1);
    g.add(s1);
    const s2 = new THREE.Mesh(sphereGeo, strandMat2);
    s2.position.set(x2, y, z2);
    g.add(s2);

    // Backbone tubes connecting adjacent spheres
    if (prev1) {
      const dir1 = new THREE.Vector3().subVectors(new THREE.Vector3(x1,y,z1), prev1).normalize();
      const len1 = prev1.distanceTo(new THREE.Vector3(x1,y,z1));
      const tube1 = new THREE.Mesh(new THREE.CylinderGeometry(0.045,0.045,len1,8), strandMat1);
      tube1.position.copy(prev1).lerp(new THREE.Vector3(x1,y,z1), 0.5);
      tube1.lookAt(new THREE.Vector3(x1,y,z1));
      tube1.rotateX(Math.PI/2);
      g.add(tube1);

      const dir2 = new THREE.Vector3().subVectors(new THREE.Vector3(x2,y,z2), prev2).normalize();
      const len2 = prev2.distanceTo(new THREE.Vector3(x2,y,z2));
      const tube2 = new THREE.Mesh(new THREE.CylinderGeometry(0.045,0.045,len2,8), strandMat2);
      tube2.position.copy(prev2).lerp(new THREE.Vector3(x2,y,z2), 0.5);
      tube2.lookAt(new THREE.Vector3(x2,y,z2));
      tube2.rotateX(Math.PI/2);
      g.add(tube2);
    }

    // Base pair rungs
    if (i % 4 === 0 && i > 0) {
      const p1 = new THREE.Vector3(x1, y, z1);
      const p2 = new THREE.Vector3(x2, y, z2);
      const rungLen = p1.distanceTo(p2);

      const base = bases[Math.floor(Math.random() * 4)];
      const rungMat = new THREE.MeshStandardMaterial({
        color: baseColors[base], emissive: baseColors[base],
        emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.5
      });

      const midPt = p1.clone().lerp(p2, 0.5);
      const rung = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, rungLen*0.4, 8), rungMat);
      rung.position.copy(p1.clone().lerp(p2, 0.25));
      rung.lookAt(midPt); rung.rotateX(Math.PI/2);
      g.add(rung);

      const rung2Mat = new THREE.MeshStandardMaterial({
        color: baseColors[bases[(bases.indexOf(base)+2)%4]],
        emissive: baseColors[bases[(bases.indexOf(base)+2)%4]],
        emissiveIntensity: 0.5, roughness: 0.3, metalness: 0.5
      });
      const rung2 = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, rungLen*0.4, 8), rung2Mat);
      rung2.position.copy(p2.clone().lerp(p1, 0.25));
      rung2.lookAt(midPt); rung2.rotateX(Math.PI/2);
      g.add(rung2);

      // Center bond sphere
      const bond = new THREE.Mesh(new THREE.SphereGeometry(0.08,8,8), glowMat(0xffffff));
      bond.position.copy(midPt);
      g.add(bond);
    }

    prev1 = new THREE.Vector3(x1, y, z1);
    prev2 = new THREE.Vector3(x2, y, z2);
  }

  g.userData.polys = 18000;
  return g;
}
OBJECTS.dna = buildDNA;

// ── ATOM ─────────────────────────────────────
function buildAtom() {
  const g = new THREE.Group();
  g.userData.name = 'NITROGEN ATOM';

  // Nucleus — cluster of protons & neutrons
  const nucleusGroup = new THREE.Group();
  const protonMat = holoMat(0xff4444, 0x550000, 0.3, 0.7);
  const neutronMat = holoMat(0x4488ff, 0x001133, 0.3, 0.7);
  for (let i = 0; i < 14; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * Math.PI;
    const r = 0.15 + Math.random() * 0.25;
    const p = new THREE.Mesh(
      new THREE.SphereGeometry(0.14, 16, 16),
      i < 7 ? protonMat : neutronMat
    );
    p.position.set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi)
    );
    nucleusGroup.add(p);
  }
  g.add(nucleusGroup);

  // Glow around nucleus
  const nucGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.5, 24, 24),
    glassMat(0xaaaaff)
  );
  g.add(nucGlow);

  // Electron orbitals — 3 shells
  const orbitalConfigs = [
    { r: 1.6, tilt: 0, speed: 0.9, color: 0x00c8ff },
    { r: 2.4, tilt: Math.PI/3, speed: 0.6, color: 0x00ffaa },
    { r: 3.2, tilt: Math.PI*0.7, speed: 0.4, color: 0xff8800 },
  ];

  orbitalConfigs.forEach((cfg, shellIdx) => {
    // Orbital path ring
    const orbitRing = new THREE.Mesh(
      new THREE.TorusGeometry(cfg.r, 0.02, 10, 120),
      new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.25 })
    );
    orbitRing.rotation.x = cfg.tilt;
    orbitRing.rotation.y = shellIdx * 0.8;
    orbitRing.userData.isOrbit = true;
    orbitRing.userData.speed = cfg.speed;
    g.add(orbitRing);

    // Electrons on this shell
    const electronCount = shellIdx === 0 ? 2 : shellIdx === 1 ? 4 : 1;
    for (let e = 0; e < electronCount; e++) {
      const electronPivot = new THREE.Group();
      electronPivot.rotation.x = cfg.tilt;
      electronPivot.rotation.y = shellIdx * 0.8;
      electronPivot.userData.speed = cfg.speed * (1 + e * 0.15);
      electronPivot.userData.offset = (e / electronCount) * Math.PI * 2;
      electronPivot.userData.radius = cfg.r;
      electronPivot.userData.isElectron = true;

      const electron = new THREE.Mesh(
        new THREE.SphereGeometry(0.1, 14, 14),
        emissiveMat(cfg.color, cfg.color)
      );
      electron.position.x = cfg.r;

      // Electron trail glow
      const trail = new THREE.Mesh(
        new THREE.SphereGeometry(0.18, 10, 10),
        new THREE.MeshBasicMaterial({ color: cfg.color, transparent: true, opacity: 0.2 })
      );
      trail.position.x = cfg.r;
      electronPivot.add(electron);
      electronPivot.add(trail);
      g.add(electronPivot);
    }
  });

  g.userData.polys = 9800;
  return g;
}
OBJECTS.atom = buildAtom;

// ── NEURAL NETWORK ───────────────────────────
function buildBrain() {
  const g = new THREE.Group();
  g.userData.name = 'NEURAL NETWORK — 3D';

  const nodeCount = 80;
  const nodes = [];
  const nodeMeshes = [];

  // Create nodes in a brain-like ellipsoid distribution
  for (let i = 0; i < nodeCount; i++) {
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(2 * Math.random() - 1);
    const r = 1.2 + Math.random() * 1.0;
    const pos = new THREE.Vector3(
      r * 1.4 * Math.sin(phi) * Math.cos(theta),
      r * 0.9 * Math.sin(phi) * Math.sin(theta),
      r * 1.0 * Math.cos(phi)
    );
    nodes.push(pos);

    const activity = Math.random();
    const nodeColor = activity > 0.7 ? 0xffaa00 : activity > 0.4 ? 0x00c8ff : 0x003355;
    const nodeEmissive = activity > 0.7 ? 0xff6600 : activity > 0.4 ? 0x005577 : 0x001122;
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.04 + activity * 0.1, 10, 10),
      emissiveMat(nodeColor, nodeEmissive)
    );
    mesh.position.copy(pos);
    mesh.userData.activity = activity;
    mesh.userData.pulseOffset = Math.random() * Math.PI * 2;
    g.add(mesh);
    nodeMeshes.push(mesh);
  }

  // Create connections between nearby nodes
  const connectionMat = new THREE.LineBasicMaterial({ color: 0x004466, transparent: true, opacity: 0.3 });
  let connCount = 0;
  for (let i = 0; i < nodeCount; i++) {
    for (let j = i + 1; j < nodeCount; j++) {
      const dist = nodes[i].distanceTo(nodes[j]);
      if (dist < 1.1 && connCount < 200) {
        const geo = new THREE.BufferGeometry().setFromPoints([nodes[i], nodes[j]]);
        const line = new THREE.Line(geo, connectionMat.clone());
        line.material.opacity = Math.max(0.05, 0.4 - dist * 0.3);
        g.add(line);
        connCount++;
      }
    }
  }

  g.userData.nodeMeshes = nodeMeshes;
  g.userData.polys = nodeCount * 80 + connCount * 2;
  return g;
}
OBJECTS.brain = buildBrain;

// ── CRYSTAL ──────────────────────────────────
function buildCrystal() {
  const g = new THREE.Group();
  g.userData.name = 'CRYSTAL LATTICE — CUBIC';

  const crystalMat = new THREE.MeshPhysicalMaterial({
    color: 0x88ccff, emissive: 0x001122, emissiveIntensity: 0.3,
    roughness: 0.05, metalness: 0.1, transmission: 0.7,
    thickness: 0.5, envMapIntensity: 3, transparent: true, opacity: 0.85,
    side: THREE.DoubleSide
  });
  const edgeMat = holoMat(0x00c8ff, 0x003355, 0.2, 0.9);

  // Main crystal cluster
  const crystalDefs = [
    { h: 3.2, r: 0.55, pos: [0, 0, 0], rot: [0, 0, 0] },
    { h: 2.4, r: 0.4, pos: [0.8, -0.5, 0.3], rot: [0.2, 0.5, 0.1] },
    { h: 2.8, r: 0.45, pos: [-0.7, -0.3, 0.5], rot: [-0.1, -0.4, 0.2] },
    { h: 1.8, r: 0.3, pos: [0.3, -0.8, -0.6], rot: [0.3, 0.2, -0.3] },
    { h: 2.0, r: 0.35, pos: [-0.5, -0.6, -0.4], rot: [-0.2, 0.3, 0.1] },
    { h: 1.4, r: 0.22, pos: [1.0, 0.2, -0.3], rot: [0.4, -0.2, 0.3] },
    { h: 1.6, r: 0.25, pos: [-1.1, 0.1, 0.2], rot: [-0.3, 0.4, -0.1] },
  ];

  crystalDefs.forEach(def => {
    // Crystal shard: octahedron-like
    const geo = new THREE.ConeGeometry(def.r, def.h, 6, 1);
    const top = new THREE.Mesh(geo, crystalMat);
    top.position.set(...def.pos);
    top.rotation.set(...def.rot);
    top.position.y += def.h * 0.25;
    top.castShadow = true;
    g.add(top);

    const geoBot = new THREE.ConeGeometry(def.r * 0.7, def.h * 0.45, 6, 1);
    const bot = new THREE.Mesh(geoBot, crystalMat);
    bot.position.set(...def.pos);
    bot.rotation.set(...def.rot);
    bot.rotation.x += Math.PI;
    bot.position.y -= def.h * 0.1;
    g.add(bot);

    // Wireframe edge glow
    const wireTop = new THREE.Mesh(geo, wireMat(0x00c8ff, 0.35));
    wireTop.position.copy(top.position);
    wireTop.rotation.copy(top.rotation);
    g.add(wireTop);
  });

  // Base platform
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(1.6, 1.4, 0.18, 6),
    holoMat(0x112233, 0x001122, 0.6, 0.9)
  );
  base.position.y = -2.1;
  g.add(base);

  // Interior glow
  const innerGlow = new THREE.Mesh(
    new THREE.SphereGeometry(0.4, 16, 16),
    emissiveMat(0x88ddff, 0x44aaff)
  );
  innerGlow.position.y = 0.2;
  g.add(innerGlow);

  g.userData.polys = 8400;
  return g;
}
OBJECTS.crystal = buildCrystal;

// ── TURBINE ──────────────────────────────────
function buildTurbine() {
  const g = new THREE.Group();
  g.userData.name = 'JET TURBINE — CF6-80E';

  const metalDark = holoMat(0x223344, 0x001122, 0.45, 0.95);
  const metalMid = holoMat(0x445566, 0x002233, 0.35, 0.9);
  const bladeColor = holoMat(0x334455, 0x001833, 0.3, 0.95);
  const accentBlue = emissiveMat(0x00c8ff, 0x0055aa);

  // Main housing cylinder
  const housing = new THREE.Mesh(
    new THREE.CylinderGeometry(1.8, 1.5, 5.5, 32, 1, true),
    metalDark
  );
  housing.rotation.z = Math.PI / 2;
  g.add(housing);

  // Housing rings
  [-2.0, -1.0, 0, 1.0, 2.0].forEach(x => {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.8 - Math.abs(x)*0.06, 0.07, 14, 48),
      metalMid
    );
    ring.rotation.y = Math.PI / 2;
    ring.position.x = x;
    g.add(ring);
  });

  // Fan blades — front compressor
  const bladeGroup = new THREE.Group();
  bladeGroup.position.x = -2.2;
  bladeGroup.userData.isRotor = true;
  bladeGroup.userData.speed = 0.08;
  for (let i = 0; i < 22; i++) {
    const a = (i / 22) * Math.PI * 2;
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 1.3, 0.35),
      bladeColor
    );
    blade.position.set(0, Math.cos(a) * 0.8, Math.sin(a) * 0.8);
    blade.rotation.x = a;
    blade.rotation.z = 0.3;
    bladeGroup.add(blade);
  }
  // Hub
  bladeGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.25,0.25,0.35,24), metalMid));
  g.add(bladeGroup);

  // Turbine blades — rear
  const turbineGroup = new THREE.Group();
  turbineGroup.position.x = 1.8;
  turbineGroup.userData.isRotor = true;
  turbineGroup.userData.speed = 0.12;
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    const blade = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.9, 0.28),
      emissiveMat(0x334466, 0x001133)
    );
    blade.position.set(0, Math.cos(a) * 0.6, Math.sin(a) * 0.6);
    blade.rotation.x = a;
    blade.rotation.z = -0.25;
    turbineGroup.add(blade);
  }
  turbineGroup.add(new THREE.Mesh(new THREE.CylinderGeometry(0.2,0.2,0.3,20), metalMid));
  g.add(turbineGroup);

  // Engine core glow
  const coreGlow = new THREE.Mesh(
    new THREE.CylinderGeometry(0.4, 0.5, 5, 20, 1, true),
    glassMat(0xff4400)
  );
  coreGlow.rotation.z = Math.PI/2;
  g.add(coreGlow);

  // Exhaust glow
  const exhaust = new THREE.Mesh(
    new THREE.SphereGeometry(0.8, 20, 16, 0, Math.PI*2, 0, Math.PI*0.5),
    emissiveMat(0xff6600, 0xff2200)
  );
  exhaust.rotation.z = -Math.PI/2;
  exhaust.position.x = 2.8;
  g.add(exhaust);

  // Accent stripes
  [-1.5,-0.5,0.5,1.5].forEach(x => {
    const stripe = new THREE.Mesh(
      new THREE.TorusGeometry(1.82, 0.03, 8, 48),
      accentBlue
    );
    stripe.rotation.y = Math.PI/2;
    stripe.position.x = x;
    g.add(stripe);
  });

  g.rotation.y = Math.PI / 6;
  g.userData.rotorGroups = [bladeGroup, turbineGroup];
  g.userData.polys = 14000;
  return g;
}
OBJECTS.turbine = buildTurbine;

// ── SATELLITE ────────────────────────────────
function buildSatellite() {
  const g = new THREE.Group();
  g.userData.name = 'COMMUNICATIONS SATELLITE';

  const bodyMat = holoMat(0x334455, 0x001122, 0.4, 0.9);
  const panelMat = new THREE.MeshStandardMaterial({
    color: 0x1a1a44, emissive: 0x000022, roughness: 0.5, metalness: 0.8
  });
  const panelCellMat = new THREE.MeshStandardMaterial({
    color: 0x112244, emissive: 0x001133, emissiveIntensity: 0.3, roughness: 0.4, metalness: 0.9
  });
  const goldStrut = holoMat(0xC8760A, 0x3a2000, 0.3, 0.95);

  // Main body
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.6, 1.2), bodyMat);
  body.castShadow = true;
  g.add(body);

  // Body details
  g.add((() => { const m = new THREE.Mesh(new THREE.BoxGeometry(1.22,0.06,1.22), goldStrut); m.position.y=0.55; return m; })());
  g.add((() => { const m = new THREE.Mesh(new THREE.BoxGeometry(1.22,0.06,1.22), goldStrut); m.position.y=-0.55; return m; })());

  // Solar panels — left
  const panelL = new THREE.Group();
  panelL.position.x = -2.5;
  // Strut
  panelL.add((() => { const m = new THREE.Mesh(new THREE.BoxGeometry(2.4,0.06,0.06), goldStrut); m.position.x = 1.2; return m; })());
  // Panel frame
  const pFrame = new THREE.Mesh(new THREE.BoxGeometry(2.0,0.04,1.1), panelMat);
  panelL.add(pFrame);
  // Solar cells grid
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 8; c++) {
      const cell = new THREE.Mesh(new THREE.BoxGeometry(0.22,0.05,0.23), panelCellMat);
      cell.position.set(-0.84 + c*0.24, 0.025, -0.37 + r*0.25);
      panelL.add(cell);
    }
  }
  g.add(panelL);

  // Solar panels — right
  const panelR = panelL.clone();
  panelR.position.x = 2.5;
  panelR.scale.x = -1;
  g.add(panelR);

  // Dish antenna
  const dishGroup = new THREE.Group();
  dishGroup.position.set(0, 1.1, -0.3);
  dishGroup.rotation.x = -0.6;

  const dish = new THREE.Mesh(
    new THREE.SphereGeometry(0.7, 24, 16, 0, Math.PI*2, 0, Math.PI*0.5),
    holoMat(0xaabbcc, 0x223344, 0.2, 0.95)
  );
  dish.rotation.x = Math.PI/2;
  dishGroup.add(dish);
  // Dish struts
  for (let i = 0; i < 4; i++) {
    const a = (i/4)*Math.PI*2;
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.015,0.015,0.65,6), goldStrut);
    strut.position.set(Math.cos(a)*0.3, 0.25, Math.sin(a)*0.3);
    dishGroup.add(strut);
  }
  // Feed horn
  const horn = new THREE.Mesh(new THREE.CylinderGeometry(0.04,0.015,0.35,10), emissiveMat(0x00c8ff,0x004488));
  horn.position.y = 0.55;
  dishGroup.add(horn);
  g.add(dishGroup);

  // Thrusters
  [-0.4,0.4].forEach(x => {
    const thruster = new THREE.Mesh(new THREE.CylinderGeometry(0.12,0.08,0.25,16), bodyMat);
    thruster.position.set(x, -1.0, 0.5);
    thruster.rotation.x = -0.3;
    g.add(thruster);
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.08,12,12), emissiveMat(0x00aaff,0x0055ff));
    glow.position.set(x, -1.22, 0.65);
    g.add(glow);
  });

  // Orientation
  g.rotation.y = Math.PI/5;
  g.rotation.x = 0.2;
  g.userData.polys = 16000;
  return g;
}
OBJECTS.satellite = buildSatellite;

// ── DRONE ────────────────────────────────────
function buildDrone() {
  const g = new THREE.Group();
  g.userData.name = 'AUTONOMOUS COMBAT DRONE';

  const frame = holoMat(0x223344, 0x001122, 0.4, 0.9);
  const carbon = holoMat(0x111a22, 0x000811, 0.6, 0.8);
  const accent = emissiveMat(0x00c8ff, 0x004477);
  const propColor = holoMat(0x334455, 0x001833, 0.3, 0.85);

  // Central body — sleek fuselage
  const fuselage = new THREE.Mesh(new THREE.SphereGeometry(0.65, 24, 16, 0, Math.PI*2, 0, Math.PI), frame);
  fuselage.scale.set(1.0, 0.38, 0.55);
  fuselage.castShadow = true;
  g.add(fuselage);

  // Top dome — sensor array
  const topDome = new THREE.Mesh(new THREE.SphereGeometry(0.32, 20, 14, 0, Math.PI*2, 0, Math.PI*0.6), glassMat(0x00c8ff));
  topDome.position.y = 0.18;
  g.add(topDome);

  // Eye/sensor
  const eye = new THREE.Mesh(new THREE.SphereGeometry(0.1, 14, 14), emissiveMat(0xff2200, 0xff0000));
  eye.position.set(0, 0.1, 0.58);
  g.add(eye);

  // Arms — 4 diagonal
  const armPositions = [
    [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1]
  ];
  const armGroup = new THREE.Group();
  armPositions.forEach(([x, y, z], idx) => {
    const ang = Math.atan2(z, x);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.055, 0.09), carbon);
    arm.position.set(x*0.62, y, z*0.62);
    arm.rotation.y = -ang;
    armGroup.add(arm);

    // Motor housing
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.13,0.13,0.12,20), frame);
    motor.position.set(x*1.25, 0.06, z*1.25);
    armGroup.add(motor);

    // Propellers — spinning
    const propGroup = new THREE.Group();
    propGroup.position.set(x*1.25, 0.14, z*1.25);
    propGroup.userData.isProp = true;
    propGroup.userData.speed = 0.35 + Math.random() * 0.1;
    for (let p = 0; p < 2; p++) {
      const prop = new THREE.Mesh(
        new THREE.BoxGeometry(0.8, 0.016, 0.07),
        propColor
      );
      prop.rotation.y = (p / 2) * Math.PI;
      propGroup.add(prop);
    }
    armGroup.add(propGroup);

    // Arm accent LED
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.04, 8, 8), emissiveMat(0x00ff88, 0x00cc44));
    led.position.set(x*1.2, 0.06, z*1.2);
    armGroup.add(led);
  });
  g.add(armGroup);

  // Underside — payload / camera gimbal
  const gimbal = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 16), frame);
  gimbal.scale.set(1,0.7,1);
  gimbal.position.y = -0.28;
  g.add(gimbal);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.08,0.11,0.14,16), glassMat(0x888888));
  lens.position.y = -0.42;
  g.add(lens);

  // Status lights
  const greenLight = new THREE.Mesh(new THREE.SphereGeometry(0.04,8,8), emissiveMat(0x00ff44,0x00cc33));
  greenLight.position.set(0.62, 0.04, 0);
  g.add(greenLight);
  const redLight = new THREE.Mesh(new THREE.SphereGeometry(0.04,8,8), emissiveMat(0xff2200,0xff0000));
  redLight.position.set(-0.62, 0.04, 0);
  g.add(redLight);

  g.userData.propGroups = armGroup.children.filter(c => c.userData.isProp);
  g.userData.polys = 11500;
  return g;
}
OBJECTS.drone = buildDrone;

// ── MOLECULE ─────────────────────────────────
function buildMolecule() {
  const g = new THREE.Group();
  g.userData.name = 'CAFFEINE MOLECULE — C₈H₁₀N₄O₂';

  const atomDefs = [
    // Carbon atoms
    { el:'C', pos:[0,0,0], color:0x888888 },
    { el:'C', pos:[1.2,0.7,0], color:0x888888 },
    { el:'C', pos:[1.2,-0.7,0], color:0x888888 },
    { el:'C', pos:[-1.2,0.7,0], color:0x888888 },
    { el:'C', pos:[-1.2,-0.7,0], color:0x888888 },
    { el:'C', pos:[2.3,0,0.4], color:0x888888 },
    { el:'C', pos:[-2.3,0,0.4], color:0x888888 },
    { el:'C', pos:[0,0,-1.6], color:0x888888 },
    // Nitrogen
    { el:'N', pos:[0.6,1.4,0.2], color:0x4444ff },
    { el:'N', pos:[-0.6,1.4,0.2], color:0x4444ff },
    { el:'N', pos:[0.6,-1.4,0.2], color:0x4444ff },
    { el:'N', pos:[-0.6,-1.4,0.2], color:0x4444ff },
    // Oxygen
    { el:'O', pos:[2.6,1.0,-0.2], color:0xff2222 },
    { el:'O', pos:[-2.6,1.0,-0.2], color:0xff2222 },
  ];

  const atomMeshes = atomDefs.map(def => {
    const r = def.el === 'C' ? 0.16 : def.el === 'N' ? 0.18 : def.el === 'O' ? 0.19 : 0.12;
    const mat = emissiveMat(def.color, def.color);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 18, 18), mat);
    mesh.position.set(...def.pos);
    mesh.castShadow = true;
    g.add(mesh);
    return { mesh, pos: new THREE.Vector3(...def.pos), def };
  });

  // Bonds
  const bondPairs = [
    [0,1],[0,2],[0,3],[0,4],[1,5],[3,5],[2,6],[4,6],[0,7],
    [0,8],[0,9],[0,10],[0,11],[5,12],[6,13]
  ];

  bondPairs.forEach(([a, b]) => {
    if (a >= atomMeshes.length || b >= atomMeshes.length) return;
    const pa = atomMeshes[a].pos;
    const pb = atomMeshes[b].pos;
    const dist = pa.distanceTo(pb);
    const bond = new THREE.Mesh(
      new THREE.CylinderGeometry(0.055, 0.055, dist, 10),
      holoMat(0x445566, 0x001122, 0.4, 0.7)
    );
    const mid = pa.clone().lerp(pb, 0.5);
    bond.position.copy(mid);
    bond.lookAt(pb);
    bond.rotateX(Math.PI/2);
    g.add(bond);
  });

  // Labels via small colored rings
  atomMeshes.forEach(({ mesh, def }) => {
    if (def.el !== 'C') {
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(0.22, 0.02, 8, 32),
        new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.5 })
      );
      ring.position.copy(mesh.position);
      g.add(ring);
    }
  });

  g.scale.setScalar(0.9);
  g.userData.polys = 7200;
  return g;
}
OBJECTS.molecule = buildMolecule;

  // ═══════════════════════════════════════════════
  // PER-WIDGET 3D SCENE
  // ═══════════════════════════════════════════════
  const NAMES = {
    atom: 'ATOM', dna: 'DNA HELIX', molecule: 'MOLECULE', brain: 'NEURAL NET',
    crystal: 'CRYSTAL', turbine: 'TURBINE', satellite: 'SATELLITE',
    drone: 'DRONE', earth: 'EARTH — LIVE', solar_system: 'SOLAR SYSTEM',
  };

  const RENDER_SIZE = 460; // full-size floating hologram, not a tiny thumbnail

  function createScene(canvas) {
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(RENDER_SIZE, RENDER_SIZE, false);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 1, 6.2);
    camera.lookAt(0, 0.4, 0);

    scene.add(new THREE.AmbientLight(0x001428, 0.8));
    const key = new THREE.DirectionalLight(0x00c8ff, 3);
    key.position.set(3, 4, 3);
    scene.add(key);
    const rim = new THREE.PointLight(0x00aaff, 2.2, 24);
    rim.position.set(-3, 1.5, -3);
    scene.add(rim);

    return { renderer, scene, camera, key, rim };
  }

  // ═══════════════════════════════════════════════
  // ACTIVE WIDGETS + SHARED RENDER LOOP
  // ═══════════════════════════════════════════════
  const widgets = new Map();
  let idCounter = 0;
  let loopRunning = false;
  const _t0 = performance.now();
  function nowSec() { return (performance.now() - _t0) / 1000; }

  function tick() {
    requestAnimationFrame(tick);
    if (widgets.size === 0) { loopRunning = false; return; }
    const t = nowSec();
    widgets.forEach(w => {
      w.obj.rotation.y += 0.006;
      w.obj.traverse(child => {
        if (child.userData.pulse !== undefined) {
          const s = 1 + 0.05 * Math.sin(t * 2 + child.userData.pulse);
          child.scale.set(s, s, s);
        }
        if (child.userData.isElectron) {
          const a = t * child.userData.speed + child.userData.offset;
          const r = child.userData.radius;
          child.children.forEach((el, idx) => {
            const off = idx === 0 ? 0 : 0.3;
            el.position.x = Math.cos(a + off) * r;
            el.position.z = Math.sin(a + off) * r;
          });
        }
        if (child.userData.isRotor) child.rotation.x += child.userData.speed;
        if (child.userData.isProp) child.rotation.y += child.userData.speed;
        if (child.userData.isCloudLayer) child.rotation.y += 0.0016;
        if (child.userData.isOrbiter) {
          const a = t * child.userData.orbitSpeed;
          const r = child.userData.orbitRadius;
          child.position.set(Math.cos(a) * r, 0, Math.sin(a) * r);
        }
      });
      if (w.obj.userData.nodeMeshes) {
        w.obj.userData.nodeMeshes.forEach(({ mesh }) => {
          const s = 0.9 + 0.2 * Math.sin(t * 2 + (mesh.userData?.pulseOffset || 0));
          mesh.scale.setScalar(s);
        });
      }
      w.rim.intensity = 2.0 + 0.6 * Math.sin(t * 0.7);
      w.key.intensity = 2.8 + 0.4 * Math.sin(t * 0.4 + 1);
      w.renderer.render(w.scene, w.camera);
    });
  }
  function ensureLoop() {
    if (loopRunning) return;
    loopRunning = true;
    requestAnimationFrame(tick);
  }

  // ═══════════════════════════════════════════════
  // DOM + DRAG-TO-DISMISS
  // ═══════════════════════════════════════════════
  const EDGE_ZONE = 90; // px from either screen edge that arms dismissal

  function ensureEdgeGlow() {
    if (document.getElementById('hw-edge-left')) return;
    const l = document.createElement('div');
    l.id = 'hw-edge-left'; l.className = 'hw-edge-glow left';
    const r = document.createElement('div');
    r.id = 'hw-edge-right'; r.className = 'hw-edge-glow right';
    document.body.appendChild(l);
    document.body.appendChild(r);
  }
  function setEdgeGlow(show, side) {
    const l = document.getElementById('hw-edge-left');
    const r = document.getElementById('hw-edge-right');
    if (l) l.classList.toggle('show', show && side === 'left');
    if (r) r.classList.toggle('show', show && side === 'right');
  }

  function nextSpawnPos(n) {
    const cascade = n % 4;
    return {
      x: 60 + cascade * 60,
      y: 70 + cascade * 40,
    };
  }

  async function show(key) {
    if (!OBJECTS[key]) key = 'earth';
    await loadThree();
    ensureEdgeGlow();

    const id = 'hw-' + (idCounter++);
    const card = document.createElement('div');
    card.id = id;
    card.className = 'holo-widget';
    card.dataset.handDrag = 'true'; // pinch-drag support (see hand-tracking.js)
    card.innerHTML = `
      <div class="hw-head"><span>${NAMES[key] || key.toUpperCase()}</span><button class="hw-close" title="Close">&#10005;</button></div>
      <div class="hw-canvas-wrap"><canvas></canvas></div>
      <div class="hw-base"></div>
    `;
    document.body.appendChild(card);

    const pos = nextSpawnPos(widgets.size);
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';

    const canvas = card.querySelector('canvas');
    const { renderer, scene, camera, key: keyLight, rim } = createScene(canvas);
    const obj = OBJECTS[key]();
    scene.add(obj);

    const w = { id, card, renderer, scene, camera, obj, key: keyLight, rim };
    widgets.set(id, w);
    ensureLoop();

    requestAnimationFrame(() => card.classList.add('in'));

    card.querySelector('.hw-close').addEventListener('click', (e) => {
      e.stopPropagation();
      dismiss(id, false);
    });

    initDrag(w);
    return id;
  }

  function initDrag(w) {
    const card = w.card;
    let dragging = false, offsetX = 0, offsetY = 0, armedSide = null;

    card.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.hw-close')) return;
      dragging = true;
      const rect = card.getBoundingClientRect();
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      card.classList.add('dragging');
      try { card.setPointerCapture(e.pointerId); } catch {}
    });

    card.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      let x = e.clientX - offsetX;
      let y = e.clientY - offsetY;
      const maxY = window.innerHeight - card.offsetHeight - 4;
      y = Math.min(Math.max(4, y), Math.max(4, maxY));
      // Let x go slightly past the edges so it can visibly "fall off" —
      // only clamp loosely, the dismiss check below uses card center.
      x = Math.min(Math.max(-card.offsetWidth * 0.4, x), window.innerWidth - card.offsetWidth * 0.6);
      card.style.left = x + 'px';
      card.style.top = y + 'px';

      const centerX = x + card.offsetWidth / 2;
      if (centerX < EDGE_ZONE) { armedSide = 'left'; }
      else if (centerX > window.innerWidth - EDGE_ZONE) { armedSide = 'right'; }
      else { armedSide = null; }
      card.classList.toggle('edge-armed', !!armedSide);
      setEdgeGlow(!!armedSide, armedSide);
    });

    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('dragging');
      try { card.releasePointerCapture(e.pointerId); } catch {}
      setEdgeGlow(false);
      if (armedSide) {
        dismiss(w.id, true, armedSide);
      } else {
        // Snap fully back on screen in case it was hanging past an edge
        const rect = card.getBoundingClientRect();
        const clampedX = Math.min(Math.max(4, rect.left), window.innerWidth - card.offsetWidth - 4);
        card.style.left = clampedX + 'px';
      }
      armedSide = null;
    }
    card.addEventListener('pointerup', endDrag);
    card.addEventListener('pointercancel', endDrag);
  }

  // ═══════════════════════════════════════════════
  // GENERATED MESHES — "Jarvis, render me a helmet with X"
  // Real generated geometry from mesh-generator.js (free text->image
  // ->3D pipeline), not a preset from OBJECTS above. Re-skins whatever
  // mesh comes back with the same cyan wireframe hologram look as
  // everything else, so it fits the app's visual language regardless
  // of what was generated.
  // ═══════════════════════════════════════════════

  // Center + scale any loaded mesh to roughly fill the same footprint
  // the hand-built OBJECTS occupy, so generated stuff isn't tiny/huge.
  function normalizeScale(root) {
    const box = new THREE.Box3().setFromObject(root);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const scale = 2.4 / maxDim;
    root.scale.setScalar(scale);

    const center = new THREE.Vector3();
    box.getCenter(center);
    root.position.sub(center.multiplyScalar(scale));
  }

  // Re-skins a loaded GLTF scene with the same wireframe/hologram
  // materials the hand-built objects use, so a generated helmet looks
  // like it belongs next to the earth/DNA/atom widgets, not like a
  // random textured import.
  function applyHologramSkin(root, color = 0x00c8ff) {
    root.traverse((child) => {
      if (!child.isMesh) return;
      const solid = holoMat(color, 0x001a33, 0.4, 0.7);
      const wire = wireMat(color, 0.35);
      child.material = solid;
      const wireMesh = new THREE.Mesh(child.geometry, wire);
      child.add(wireMesh);
    });
  }

  async function generate(prompt) {
    await loadThree();
    ensureEdgeGlow();

    const id = 'hw-' + (idCounter++);
    const card = document.createElement('div');
    card.id = id;
    card.className = 'holo-widget hw-generating';
    card.dataset.handDrag = 'true';
    card.innerHTML = `
      <div class="hw-head"><span>GENERATING…</span><button class="hw-close" title="Close">&#10005;</button></div>
      <div class="hw-canvas-wrap"><div class="hw-gen-status">Sending "${(prompt || '').slice(0, 60)}" to the free mesh generator — this can take a minute or two on shared free GPU queues.</div></div>
      <div class="hw-base"></div>
    `;
    document.body.appendChild(card);
    const pos = nextSpawnPos(widgets.size);
    card.style.left = pos.x + 'px';
    card.style.top = pos.y + 'px';
    requestAnimationFrame(() => card.classList.add('in'));
    card.querySelector('.hw-close').addEventListener('click', (e) => {
      e.stopPropagation();
      card.classList.add('dismissing');
      setTimeout(() => card.remove(), 300);
    });

    let startData;
    try {
      const res = await fetch('/api/hologram/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });
      startData = await res.json();
    } catch (e) {
      startData = { kind: 'error', error: e.message };
    }

    if (!card.isConnected) return null; // user closed it while we waited

    if (!startData.jobId) {
      card.querySelector('.hw-head span').textContent = 'GENERATION FAILED';
      card.querySelector('.hw-gen-status').textContent =
        (startData.error || 'Could not start generation') + ' — the free mesh-generation Spaces are community infra, not a guaranteed-uptime service, so this can happen.';
      card.classList.add('hw-error');
      return id;
    }

    // Poll instead of holding one request open — free-tier proxies
    // (Render included) kill long-idle HTTP requests well before a
    // 30s-3min generation finishes, which is what caused the old
    // "Unexpected end of JSON input" error (truncated response body).
    const POLL_MS = 4000;
    const MAX_POLLS = 90; // ~6 minutes ceiling
    let data = null;
    for (let i = 0; i < MAX_POLLS; i++) {
      if (!card.isConnected) return null; // user closed it mid-generation
      await new Promise(r => setTimeout(r, POLL_MS));
      try {
        const res = await fetch('/api/hologram/generate/' + encodeURIComponent(startData.jobId));
        data = await res.json();
      } catch (e) {
        continue; // transient network hiccup — just try again next tick
      }
      if (data.stage) {
        const statusEl = card.querySelector('.hw-gen-status');
        if (statusEl) statusEl.textContent = 'Status: ' + data.stage + '…';
      }
      if (data.status === 'done') break;
    }

    if (!data || data.status !== 'done') {
      card.querySelector('.hw-head span').textContent = 'GENERATION FAILED';
      card.querySelector('.hw-gen-status').textContent = 'Timed out waiting for the free generator — the shared GPU queue was probably too busy right now. Try again in a bit.';
      card.classList.add('hw-error');
      return id;
    }

    if (data.kind !== 'gltf') {
      card.querySelector('.hw-head span').textContent = 'GENERATION FAILED';
      card.querySelector('.hw-gen-status').textContent =
        (data.error || 'Unknown error') + ' — the free mesh-generation Spaces are community infra, not a guaranteed-uptime service, so this can happen.';
      card.classList.add('hw-error');
      return id;
    }

    try {
      await loadGLTFLoader();
      const loader = new THREE.GLTFLoader();
      const gltf = await new Promise((resolve, reject) => loader.load(data.url, resolve, undefined, reject));

      card.classList.remove('hw-generating');
      card.querySelector('.hw-head span').textContent = (prompt || 'GENERATED').slice(0, 28).toUpperCase();
      const wrap = card.querySelector('.hw-canvas-wrap');
      wrap.innerHTML = '<canvas></canvas>';
      const canvas = wrap.querySelector('canvas');

      const { renderer, scene, camera, key: keyLight, rim } = createScene(canvas);
      const obj = gltf.scene;
      normalizeScale(obj);
      applyHologramSkin(obj);
      scene.add(obj);

      const w = { id, card, renderer, scene, camera, obj, key: keyLight, rim };
      widgets.set(id, w);
      ensureLoop();
      initDrag(w);
      return id;
    } catch (e) {
      card.querySelector('.hw-head span').textContent = 'LOAD FAILED';
      card.querySelector('.hw-gen-status').textContent = 'Mesh generated but failed to load in-browser: ' + e.message;
      card.classList.add('hw-error');
      return id;
    }
  }

  function dismiss(id, thrown) {
    const w = widgets.get(id);
    if (!w) return;
    widgets.delete(id);
    w.card.classList.add('dismissing');
    setTimeout(() => {
      w.card.remove();
      w.renderer.dispose();
      w.scene.traverse(c => {
        if (c.geometry) c.geometry.dispose();
        if (c.material) {
          if (Array.isArray(c.material)) c.material.forEach(m => m.dispose());
          else c.material.dispose();
        }
      });
    }, 300);
  }

  // ═══════════════════════════════════════════════
  // KEYWORD → OBJECT KEY (used by jarvis.js for natural language)
  // ═══════════════════════════════════════════════
  function guessKey(text) {
    const lower = (text || '').toLowerCase();
    const map = {
      'earth': 'earth', 'globe': 'earth', 'world': 'earth', 'planet earth': 'earth',
      'solar system': 'solar_system', 'planets': 'solar_system', 'orbit': 'solar_system',
      'dna': 'dna', 'helix': 'dna', 'atom': 'atom', 'atoms': 'atom',
      'neural': 'brain', 'brain': 'brain', 'network': 'brain',
      'crystal': 'crystal', 'turbine': 'turbine', 'engine': 'turbine',
      'satellite': 'satellite', 'drone': 'drone',
      'molecule': 'molecule', 'caffeine': 'molecule',
    };
    for (const [kw, key] of Object.entries(map)) {
      if (lower.includes(kw)) return key;
    }
    return null;
  }

  return { show, dismiss, guessKey, generate };
})();
