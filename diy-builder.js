"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — DIY Project Builder
// Searches Reddit · Hackaday · Instructables · DuckDuckGo
// Returns real parts lists, steps, images at your exact budget
// ═══════════════════════════════════════════════════════════════

const cache = new Map();
const CACHE_TTL = 30 * 60 * 1000;
function getCached(k) { const e=cache.get(k); if(!e)return null; if(Date.now()-e.ts>CACHE_TTL){cache.delete(k);return null;} return e.data; }
function setCache(k,d) { cache.set(k,{data:d,ts:Date.now()}); }

// ── BUDGET EXTRACTOR ─────────────────────────────────────────
function extractBudget(text) {
  const patterns = [
    /(?:under|less than|below|for|around|about|max|maximum|budget|cheap|only)?\s*\$?\s*(\d+(?:\.\d+)?)\s*(?:dollars?|bucks?|usd)?/gi,
    /(\d+(?:\.\d+)?)\s*(?:dollars?|bucks?|usd)/gi,
  ];
  const nums = [];
  for (const p of patterns) {
    let m;
    while ((m = p.exec(text)) !== null) {
      const n = parseFloat(m[1]);
      if (n >= 5 && n <= 5000) nums.push(n);
    }
  }
  return nums.length ? Math.min(...nums) : null;
}

// ── PROJECT TYPE EXTRACTOR ────────────────────────────────────
function extractProject(text) {
  return text
    .toLowerCase()
    .replace(/(?:build|make|design|create|construct|fabricate|diy|i want|can you|help me|jarvis)\s*/gi, "")
    .replace(/(?:for|under|less than|below|around|about|with|using|budget|cheap|only)\s*\$?\d+\s*(?:dollars?|bucks?)?/gi, "")
    .replace(/\?+$/, "")
    .trim() || "electronics project";
}

// ── IMAGE SEARCH (DuckDuckGo — no key needed) ─────────────────
async function searchImages(query, count = 3) {
  try {
    const tokenRes = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(query)}&iax=images&ia=images`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) }
    );
    const html = await tokenRes.text();
    const vqdMatch = html.match(/vqd=([^&"]+)/);
    if (!vqdMatch) return [];
    const vqd = vqdMatch[1];

    const imgRes = await fetch(
      `https://duckduckgo.com/i.js?q=${encodeURIComponent(query)}&vqd=${vqd}&f=,,,,,&p=1`,
      { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://duckduckgo.com/" }, signal: AbortSignal.timeout(5000) }
    );
    const data = await imgRes.json();
    return (data.results || []).slice(0, count).map(r => ({
      url:       r.image,
      thumbnail: r.thumbnail,
      title:     r.title,
      source:    r.url,
    }));
  } catch { return []; }
}

// ── REDDIT SEARCH ─────────────────────────────────────────────
async function searchReddit(project, budget) {
  const subs = ["DIY","electronics","arduino","raspberry_pi","robotics","engineering","Makemeaproject","led","3Dprinting","hackernews"];
  const query = `${project} diy build tutorial`;
  const cacheKey = `rdiy:${query}:${budget}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=relevance&limit=8&type=link`,
      { headers:{ "User-Agent":"JARVIS-DIY/1.0" }, signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const posts = (data?.data?.children||[])
      .filter(p => p.data?.title && !p.data?.over_18)
      .slice(0, 5)
      .map(p => ({
        title:     p.data.title,
        url:       `https://reddit.com${p.data.permalink}`,
        subreddit: p.data.subreddit,
        score:     p.data.score,
        body:      (p.data.selftext||"").slice(0, 400),
      }));
    setCache(cacheKey, posts);
    return posts;
  } catch { return []; }
}

// ── HACKADAY RSS ──────────────────────────────────────────────
async function searchHackaday(project) {
  const cacheKey = `hkdy:${project}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://hackaday.com/blog/feed/?s=${encodeURIComponent(project)}`,
      { headers:{ "User-Agent":"JARVIS-DIY/1.0" }, signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) return [];
    const xml  = await res.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 4);
    const results = items.map(m => {
      const block = m[1];
      const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/)||block.match(/<title>(.*?)<\/title>/))?.[1]||"";
      const link  = (block.match(/<link>(.*?)<\/link>/))?.[1]||"";
      const desc  = (block.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>/)||block.match(/<description>(.*?)<\/description>/))?.[1]||"";
      return { title: title.trim(), url: link.trim(), description: desc.replace(/<[^>]+>/g,"").slice(0,300).trim() };
    }).filter(r => r.title && r.url);
    setCache(cacheKey, results);
    return results;
  } catch { return []; }
}

// ── INSTRUCTABLES SEARCH ──────────────────────────────────────
async function searchInstructables(project, budget) {
  const cacheKey = `inst:${project}:${budget}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  try {
    const res = await fetch(
      `https://www.instructables.com/sitemap/projects/search/?q=${encodeURIComponent(project)}&limit=6`,
      { headers:{ "User-Agent":"Mozilla/5.0" }, signal: AbortSignal.timeout(7000) }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const results = (data.hits||[]).slice(0,4).map(h => ({
      title:       h.title||"",
      url:         `https://www.instructables.com${h.urlString||""}`,
      description: (h.description||"").slice(0,300),
      difficulty:  h.difficulty||"",
      materials:   h.materials||[],
    })).filter(r => r.title && r.url);
    setCache(cacheKey, results);
    return results;
  } catch { return []; }
}

// ── DDGO SEARCH ───────────────────────────────────────────────
async function searchDDG(project, budget) {
  try {
    const query = `${project} DIY build tutorial under $${budget} components list`;
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1`,
      { headers:{ "User-Agent":"JARVIS-DIY/1.0" }, signal: AbortSignal.timeout(6000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return {
      abstract:  data.Abstract||"",
      answer:    data.Answer||"",
      related:   (data.RelatedTopics||[]).slice(0,3).map(t=>t.Text||"").filter(Boolean),
    };
  } catch { return null; }
}

// ── PARTS GENERATOR ───────────────────────────────────────────
// Generates a realistic parts list based on project type + budget
function generatePartsList(project, budget) {
  const p = project.toLowerCase();
  const b = budget;

  // Smart glasses
  if (/smart\s*glass|ar\s*glass|hud|head.?up/.test(p)) {
    const cheap = b <= 30;
    return {
      category: "Smart Glasses / AR HUD",
      parts: [
        { name: cheap ? "Arduino Nano"       : "ESP32 Dev Board",      est: cheap ? "$3-5"   : "$7-10",  link: "https://www.aliexpress.com/w/wholesale-esp32.html" },
        { name: "0.96\" OLED Display",                                  est: "$2-4",  link: "https://www.aliexpress.com/w/wholesale-oled-0.96.html" },
        { name: cheap ? "Old glasses frame"  : "3D printed frame",     est: cheap ? "$0-5"   : "$3-8",   link: "https://www.thingiverse.com/search?q=smart+glasses" },
        { name: "Micro LiPo battery 500mAh",                            est: "$4-7",  link: "https://www.aliexpress.com/w/wholesale-lipo-500mah.html" },
        { name: "TP4056 charge module",                                  est: "$1",    link: "https://www.aliexpress.com/w/wholesale-tp4056.html" },
        { name: cheap ? "NRF24L01 wireless"  : "Bluetooth module",     est: "$2-4",  link: "https://www.aliexpress.com/w/wholesale-nrf24l01.html" },
        { name: "Half-mirror / beam splitter lens",                     est: "$5-10", link: "https://www.aliexpress.com/w/wholesale-beam-splitter.html" },
        { name: "Wires, solder, shrink tube",                           est: "$2-3",  link: "" },
      ],
      totalEst: cheap ? "$20-35" : "$30-50",
      notes: [
        "OLED display output reflects off the half-mirror lens into your eye",
        "ESP32 runs WiFi — pull notifications, weather, time",
        "Battery lasts ~4-6 hours depending on brightness",
        "3D print the frame or gut cheap sunglasses",
      ],
      links: [
        "https://www.instructables.com/Smart-Glasses/",
        "https://hackaday.io/search?term=smart+glasses",
        "https://reddit.com/r/arduino/search/?q=smart+glasses+diy",
      ],
    };
  }

  // Plasma repulsor / Iron Man repulsor
  if (/plasma|repulsor|iron.?man|rocket|thruster/.test(p)) {
    return {
      category: "Plasma Repulsor (LED prop / EL wire version)",
      parts: [
        { name: "High power LED 10W (white/blue)", est: "$3-6",  link: "https://www.aliexpress.com/w/wholesale-10w-led-high-power.html" },
        { name: "LED driver module",                est: "$2-4",  link: "https://www.aliexpress.com/w/wholesale-led-driver-700ma.html" },
        { name: "EL wire (blue/white, 1m)",         est: "$3-5",  link: "https://www.aliexpress.com/w/wholesale-el-wire-blue.html" },
        { name: "EL wire inverter",                 est: "$3-5",  link: "https://www.aliexpress.com/w/wholesale-el-wire-inverter.html" },
        { name: "3D printed repulsor shell",        est: "$5-10", link: "https://www.thingiverse.com/search?q=iron+man+repulsor" },
        { name: "9V battery + holder",              est: "$2-3",  link: "" },
        { name: "Momentary push button",            est: "$1",    link: "" },
        { name: "Resistors + small capacitors",     est: "$1-2",  link: "" },
      ],
      totalEst: "$20-36",
      notes: [
        "This is a prop/wearable — real plasma at home is extremely dangerous",
        "High power LED behind a diffuser looks incredibly realistic",
        "EL wire around the edges gives the glowing ring effect",
        "Add a vibration motor for rumble effect when activated",
        "Optional: hook Arduino to pulse the brightness for an 'energy charge' animation",
      ],
      links: [
        "https://www.instructables.com/Iron-Man-Repulsor-Glove/",
        "https://hackaday.io/search?term=repulsor",
        "https://www.thingiverse.com/search?q=iron+man+repulsor",
        "https://reddit.com/r/IronManSuits",
      ],
    };
  }

  // Laser
  if (/laser/.test(p)) {
    return {
      category: "DIY Laser System",
      parts: [
        { name: b < 30 ? "5mW laser diode module" : "1W laser diode (450nm blue)", est: b < 30 ? "$2-4" : "$8-15", link: "https://www.aliexpress.com/w/wholesale-laser-diode-module.html" },
        { name: "Arduino Nano",                   est: "$3-5",  link: "https://www.aliexpress.com/w/wholesale-arduino-nano.html" },
        { name: "Laser driver circuit",           est: "$2-5",  link: "https://www.aliexpress.com/w/wholesale-laser-driver.html" },
        { name: "Laser safety goggles",           est: "$8-12", link: "https://www.aliexpress.com/w/wholesale-laser-safety-goggles.html" },
        { name: "Heatsink + thermal paste",       est: "$2-4",  link: "" },
        { name: "12V power supply",               est: "$4-8",  link: "" },
        { name: "Enclosure / case",               est: "$3-8",  link: "" },
      ],
      totalEst: b < 30 ? "$24-46" : "$30-57",
      notes: [
        "ALWAYS use appropriate laser safety goggles — this is not optional",
        "For cutting/engraving: 1W+ diode inside a DIY gantry",
        "For pointer/comm: 5mW is plenty and legally safer",
        "Add a TTL input to the driver for Arduino PWM control",
      ],
      links: [
        "https://hackaday.io/search?term=laser",
        "https://www.instructables.com/search/?q=diy+laser",
      ],
    };
  }

  // Exoskeleton / servo arm
  if (/exo|servo arm|robot arm|powered arm|strength/.test(p)) {
    return {
      category: "Powered Exo-Arm / Servo Limb",
      parts: [
        { name: "MG996R servo motors x4", est: "$10-16", link: "https://www.aliexpress.com/w/wholesale-mg996r.html" },
        { name: "Arduino Mega",           est: "$8-12",  link: "https://www.aliexpress.com/w/wholesale-arduino-mega.html" },
        { name: "PCA9685 servo driver",   est: "$3-5",   link: "https://www.aliexpress.com/w/wholesale-pca9685.html" },
        { name: "7.4V 2S LiPo battery",   est: "$8-12",  link: "https://www.aliexpress.com/w/wholesale-2s-lipo.html" },
        { name: "Flex sensors x3",        est: "$6-10",  link: "https://www.aliexpress.com/w/wholesale-flex-sensor.html" },
        { name: "PLA filament (arm frame)",est: "$5-10", link: "https://www.aliexpress.com/w/wholesale-pla-filament.html" },
        { name: "Velcro straps + hardware",est: "$3-5",  link: "" },
      ],
      totalEst: "$43-70",
      notes: [
        "Flex sensors on glove detect finger bend → servo mirrors movement",
        "MG996R can handle ~10kg/cm torque — enough for light lifting assist",
        "Print the arm segments in PETG for strength",
        "Use slip ring if you want full rotation",
      ],
      links: [
        "https://hackaday.io/search?term=exoskeleton",
        "https://www.instructables.com/search/?q=servo+arm+wearable",
      ],
    };
  }

  // Drone / quadcopter
  if (/drone|quadcopter|uav/.test(p)) {
    return {
      category: "DIY Micro Drone",
      parts: [
        { name: b < 40 ? "Coreless motors 8520 x4" : "Brushless 2204 2300kv x4", est: b < 40 ? "$4-8" : "$16-24",  link: "https://www.aliexpress.com/w/wholesale-brushless-motor-2204.html" },
        { name: b < 40 ? "F3 flight controller"    : "F4 flight controller",      est: b < 40 ? "$8-12" : "$15-25", link: "https://www.aliexpress.com/w/wholesale-f4-flight-controller.html" },
        { name: b < 40 ? "3 inch props x8"         : "5 inch props x8",           est: "$3-6",  link: "https://www.aliexpress.com/w/wholesale-drone-propellers.html" },
        { name: "3S 1300mAh LiPo",                                                  est: "$8-12", link: "https://www.aliexpress.com/w/wholesale-3s-lipo-1300.html" },
        { name: "ESC 4-in-1 20A",                                                   est: "$8-15", link: "https://www.aliexpress.com/w/wholesale-4in1-esc.html" },
        { name: "Carbon fiber frame",                                                est: "$5-12", link: "https://www.aliexpress.com/w/wholesale-carbon-fiber-drone-frame.html" },
        { name: "FS-i6 radio + receiver",                                           est: b<60 ? "$20-25":"$20-25", link: "https://www.aliexpress.com/w/wholesale-flysky-fs-i6.html" },
      ],
      totalEst: b < 40 ? "$56-90 (radio is the cost)" : "$75-120",
      notes: [
        "Radio is usually the biggest cost — buy once, reuse forever",
        "Betaflight firmware is free and runs on most F3/F4 boards",
        "Build micro (3 inch) first — cheaper crashes",
        "LiPo charger needed ($8-15 extra if you don't have one)",
      ],
      links: [
        "https://www.reddit.com/r/Multicopter/",
        "https://oscarliang.com/build-a-quadcopter-beginners-tutorial-1/",
        "https://hackaday.io/search?term=quadcopter",
      ],
    };
  }

  // Generic electronics project fallback
  const budgetTier = b <= 20 ? "micro" : b <= 50 ? "standard" : "advanced";
  return {
    category: `DIY Electronics: ${project}`,
    parts: [
      { name: budgetTier === "micro" ? "Arduino Nano" : budgetTier === "standard" ? "ESP32 Dev Board" : "Raspberry Pi Zero 2W", est: budgetTier==="micro"?"$3-5":budgetTier==="standard"?"$7-10":"$15-18", link:"https://www.aliexpress.com/w/wholesale-esp32.html" },
      { name: "Relevant sensors (project-specific)", est: "$3-10", link: "https://www.aliexpress.com/w/wholesale-sensor-module.html" },
      { name: "Small OLED display",                  est: "$2-4",  link: "https://www.aliexpress.com/w/wholesale-oled.html" },
      { name: "Power supply / battery",              est: "$4-8",  link: "" },
      { name: "Project enclosure / 3D print",        est: "$3-8",  link: "https://www.thingiverse.com" },
      { name: "Wires, PCB, solder",                  est: "$2-4",  link: "" },
    ],
    totalEst: `$${Math.round(b*0.7)}-${b}`,
    notes: [
      `Designed for under $${b} budget`,
      "AliExpress is cheapest — 2-4 week shipping",
      "Amazon for faster but costs 2-3x more",
      "Search Thingiverse for free 3D printable enclosures",
      "r/arduino and r/esp32 are great for help",
    ],
    links: [
      `https://www.instructables.com/search/?q=${encodeURIComponent(project)}`,
      `https://hackaday.io/search?term=${encodeURIComponent(project)}`,
      `https://www.reddit.com/search/?q=${encodeURIComponent(project+' diy build')}`,
    ],
  };
}

// ── BUILD GUIDE GENERATOR ─────────────────────────────────────
function generateBuildGuide(project, budget, parts) {
  const steps = [
    `Order all parts — AliExpress is cheapest for most components. Budget: $${budget}.`,
    "While waiting for delivery: watch build videos on YouTube, read the Instructables/Hackaday links below.",
    "Once parts arrive: test each component individually before combining.",
    "Wire up the microcontroller first — confirm it powers on and you can upload code.",
    "Add components one at a time, testing after each addition.",
    "Write/flash the firmware (start with example code from GitHub, then modify).",
    "Mount everything in an enclosure — 3D print or repurpose a box.",
    "Test, debug, iterate.",
  ];
  return steps;
}

// ── MAIN FUNCTION ─────────────────────────────────────────────
async function buildDIYProject(message, userTitle) {
  const T       = userTitle || "Sir";
  const budget  = extractBudget(message) || 50;
  const project = extractProject(message);

  // Run searches in parallel
  const [reddit, hackaday, instructables, ddg, images] = await Promise.allSettled([
    searchReddit(project, budget),
    searchHackaday(project),
    searchInstructables(project, budget),
    searchDDG(project, budget),
    searchImages(`${project} DIY build electronics`, 4),
  ]);

  const parts     = generatePartsList(project, budget);
  const guide     = generateBuildGuide(project, budget, parts);
  const imgResults = images.status === "fulfilled" ? images.value : [];
  const rdResults  = reddit.status === "fulfilled" ? reddit.value : [];
  const hkResults  = hackaday.status === "fulfilled" ? hackaday.value : [];
  const instResults= instructables.status === "fulfilled" ? instructables.value : [];

  // Build response
  let reply = `DIY project locked in, ${T}. Here's your full build plan for **${parts.category}** under $${budget}.\n\n`;

  reply += `**PARTS LIST (estimated total: ${parts.totalEst})**\n`;
  for (const p of parts.parts) {
    reply += `• ${p.name} — ${p.est}${p.link ? ` → ${p.link}` : ""}\n`;
  }

  reply += `\n**BUILD NOTES**\n`;
  for (const note of parts.notes) reply += `• ${note}\n`;

  reply += `\n**BUILD STEPS**\n`;
  guide.forEach((s, i) => { reply += `${i+1}. ${s}\n`; });

  reply += `\n**REAL BUILDS TO REFERENCE**\n`;
  for (const link of parts.links) reply += `• ${link}\n`;

  if (rdResults.length) {
    reply += `\n**COMMUNITY BUILDS (Reddit)**\n`;
    rdResults.slice(0, 3).forEach(r => { reply += `• ${r.title} → ${r.url}\n`; });
  }
  if (hkResults.length) {
    reply += `\n**HACKADAY PROJECTS**\n`;
    hkResults.slice(0, 2).forEach(r => { reply += `• ${r.title} → ${r.url}\n`; });
  }

  return {
    reply,
    parts: parts.parts,
    totalEst: parts.totalEst,
    budget,
    project,
    images: imgResults,
    links: [
      ...parts.links,
      ...rdResults.slice(0,3).map(r=>r.url),
      ...hkResults.slice(0,2).map(r=>r.url),
    ],
    buildGuide: guide,
    notes: parts.notes,
  };
}

// ── INTENT DETECTION ─────────────────────────────────────────
function isDIYRequest(text) {
  const lower = text.toLowerCase();
  const hasBuildWord = /\b(build|make|design|create|construct|fabricate|diy|how to make|how do i make|can you make)\b/.test(lower);
  const hasProject   = /\b(glasses|goggles|drone|laser|robot|arm|exo|repulsor|plasma|gadget|device|circuit|arduino|raspberry|wearable|helmet|suit|glove|gauntlet|shield|sensor|camera|scanner|printer|motor|engine|turbine|coil|tesla|rail.?gun|speaker|amp|synth|watch|band|tracker|detector)\b/.test(lower);
  const hasBudget    = /\$\d+|\d+\s*(?:dollars?|bucks?)|\b(cheap|budget|affordable|free|inexpensive)\b/.test(lower);
  return (hasBuildWord && hasProject) || (hasBuildWord && hasBudget) || (hasProject && hasBudget);
}

module.exports = { buildDIYProject, isDIYRequest, extractBudget, extractProject, searchImages };
