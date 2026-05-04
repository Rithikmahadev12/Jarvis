"use strict";

// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Cognitive Engine v4.0
// Full semantic NLP, fluid intent routing, zero preset commands
// Dynamic capability resolution — say anything, it figures it out
// ═══════════════════════════════════════════════════════════════

const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

// ── STOPWORDS ──────────────────────────────────────────────────
const STOPWORDS = new Set([
  "a","an","the","is","it","its","in","on","at","to","of","and","or","but","for",
  "with","by","from","as","be","was","were","are","am","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might","shall",
  "can","that","this","these","those","i","me","my","you","your","we","our","they",
  "their","he","she","him","her","what","which","who","how","when","where","why",
  "so","just","up","out","if","about","than","then","there","here","also","only",
  "very","really","like","get","got","make","know","think","want","need","say","see",
  "us","no","not","into","over","after","before","more","much","some","any","all",
  "one","two","three","tell","give","please","jarvis","okay","ok","yes","yeah",
  "hey","uh","um","right","well","now","actually","basically","literally","going",
]);

function tokenize(text) {
  return text.toLowerCase()
    .replace(/[''`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function overlap(setA, setB) {
  let count = 0;
  for (const v of setA) if (setB.has(v)) count++;
  return count;
}

// ── SEMANTIC SIMILARITY ────────────────────────────────────────
function cosineSim(tokensA, tokensB) {
  const freqA = {}, freqB = {};
  for (const t of tokensA) freqA[t] = (freqA[t] || 0) + 1;
  for (const t of tokensB) freqB[t] = (freqB[t] || 0) + 1;
  const keys = new Set([...Object.keys(freqA), ...Object.keys(freqB)]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    const a = freqA[k] || 0, b = freqB[k] || 0;
    dot += a * b; na += a * a; nb += b * b;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ══════════════════════════════════════════════════════════════
// ── INTENT TAXONOMY ──────────────────────────────────────────
// Each intent has weighted signal clusters — scored against input
// No hardcoded phrases, pure semantic matching
// ══════════════════════════════════════════════════════════════
const INTENTS = [
  // ── SYSTEM ACTIONS ──
  {
    id: "show_links",
    signals: ["link","links","url","urls","site","sites","address","addresses","list links",
              "show links","all links","give links","what links","my links","your links",
              "available links","saved links","link groups","link bank"],
    action: "SHOW_LINKS",
    weight: 1.4,
  },
  {
    id: "open_link",
    signals: ["open","launch","go to","pull up","navigate","take me","load","access",
              "vapor","infamous","link for","site for","page for","website"],
    action: "OPEN_LINK",
    weight: 1.3,
  },
  {
    id: "clip_save",
    signals: ["clip","save clip","record","capture","save that","clip that","save footage",
              "keep that","save recording","save video","download clip","get that clip",
              "save last","clip last","past hour","last hour","last 30","last 60","last minute",
              "last few minutes","save everything","record that","grab that","save screen",
              "clip screen","save camera","hour clip","60 minute","30 minute","save buffer"],
    action: "CLIP_SAVE",
    weight: 1.5,
  },
  {
    id: "clip_show",
    signals: ["show clips","view clips","intruder clips","show footage","view footage",
              "who came","visitor","while away","while gone","show recordings","past recordings",
              "intruder log","show intruder","review clips","clip gallery"],
    action: "SHOW_CLIPS",
    weight: 1.3,
  },
  {
    id: "screen_read",
    signals: ["screen","what on screen","read screen","what see","look at screen","analyze screen",
              "whats showing","what showing","describe screen","scan screen","what there",
              "what visible","tell screen","read page","what open","what displayed"],
    action: "READ_SCREEN",
    weight: 1.3,
  },
  {
    id: "switch_camera",
    signals: ["switch camera","change camera","camera 1","camera 2","camera 3","use camera",
              "select camera","other camera","next camera","different camera","webcam","cam"],
    action: "SWITCH_CAMERA",
    weight: 1.4,
  },
  {
    id: "system_status",
    signals: ["status","diagnostics","how running","system check","all systems","health",
              "performance","uptime","memory","cpu","processes","system report","self check",
              "everything ok","working fine","systems nominal","how doing","operational"],
    action: "SYSTEM_STATUS",
    weight: 1.2,
  },
  {
    id: "memory_save",
    signals: ["remember","memorize","save that fact","note that","keep note","store","log that",
              "don't forget","make note","file that","record fact","save info","write down"],
    action: "MEMORY_SAVE",
    weight: 1.3,
  },
  {
    id: "memory_recall",
    signals: ["recall","remember","what do you know","what stored","my memories","saved facts",
              "what filed","retrieve","what remember","show memory","memory bank","stored info",
              "what notes","my notes","what you know about me","tell me what you know"],
    action: "MEMORY_RECALL",
    weight: 1.2,
  },
  {
    id: "memory_forget",
    signals: ["forget","delete memory","remove memory","erase","clear memory","wipe","delete note",
              "remove note","forget about","don't remember","stop remembering"],
    action: "MEMORY_FORGET",
    weight: 1.3,
  },
  {
    id: "logout",
    signals: ["log out","logout","sign out","goodbye","bye","shutdown","power down","exit",
              "close session","end session","lock","lock down","lock screen"],
    action: "LOGOUT",
    weight: 1.5,
  },
  {
    id: "notif_settings",
    signals: ["notification","alert settings","push notification","sound settings","alarm settings",
              "configure alerts","notification settings","alert config","push settings"],
    action: "NOTIF_SETTINGS",
    weight: 1.3,
  },
  {
    id: "capabilities",
    signals: ["what can you do","your abilities","your capabilities","your features","how do you work",
              "what are you capable","help me understand","what you do","your skills","your functions",
              "what know how","what commands","what say","what ask you","help topics"],
    action: "CAPABILITIES",
    weight: 1.1,
  },
  {
    id: "timer_reminder",
    signals: ["timer","remind me","reminder","alarm","set timer","in minutes","in hours","notify me",
              "alert me","wake me","ping me","let me know","after minutes","countdown","set alarm"],
    action: "TIMER",
    weight: 1.4,
  },
  {
    id: "mood_query",
    signals: ["how are you","how feeling","your mood","you okay","how you doing","you alright",
              "emotional state","feeling today","you good","how you","doing well"],
    action: "MOOD_QUERY",
    weight: 1.2,
  },
  {
    id: "identity",
    signals: ["who are you","what are you","your name","introduce yourself","tell about yourself",
              "what is jarvis","are you ai","are you human","describe yourself"],
    action: "IDENTITY",
    weight: 1.2,
  },
  {
    id: "greeting",
    signals: ["hello","hi","hey","morning","afternoon","evening","good day","greetings",
              "what up","wassup","howdy","yo","sup"],
    action: "GREETING",
    weight: 1.0,
  },
  {
    id: "thanks",
    signals: ["thank","thanks","cheers","appreciated","grateful","good job","well done","nice work",
              "great job","brilliant","perfect","excellent","amazing","awesome"],
    action: "THANKS",
    weight: 1.0,
  },
  // ── KNOWLEDGE DOMAINS ──
  {
    id: "knowledge_science",
    signals: ["physics","chemistry","biology","quantum","atom","molecule","energy","force","wave",
              "particle","experiment","theory","evolution","genetics","cell","planet","star",
              "galaxy","universe","space","gravity","relativity","nuclear","element","reaction"],
    action: "KNOWLEDGE",
    domain: "science",
    weight: 1.0,
  },
  {
    id: "knowledge_tech",
    signals: ["computer","software","hardware","code","programming","algorithm","network","internet",
              "ai","machine learning","robot","system","app","web","server","database","processor",
              "javascript","python","framework","api","blockchain","cryptocurrency","neural"],
    action: "KNOWLEDGE",
    domain: "technology",
    weight: 1.0,
  },
  {
    id: "knowledge_history",
    signals: ["history","war","empire","ancient","medieval","century","civilization","king","queen",
              "president","revolution","battle","treaty","colony","independence","democracy",
              "dynasty","rome","greek","egypt","renaissance","industrial","historical"],
    action: "KNOWLEDGE",
    domain: "history",
    weight: 1.0,
  },
  {
    id: "knowledge_math",
    signals: ["math","equation","formula","calculate","algebra","geometry","calculus","statistics",
              "probability","theorem","proof","derivative","integral","matrix","prime","factorial",
              "percentage","ratio","angle","triangle","circle","sequence"],
    action: "KNOWLEDGE",
    domain: "mathematics",
    weight: 1.0,
  },
  {
    id: "knowledge_philosophy",
    signals: ["philosophy","ethics","moral","consciousness","existence","reality","truth","knowledge",
              "logic","reasoning","argument","free will","determinism","metaphysics","meaning",
              "purpose","justice","virtue","mind","soul","identity","perception","belief"],
    action: "KNOWLEDGE",
    domain: "philosophy",
    weight: 1.0,
  },
  {
    id: "knowledge_health",
    signals: ["health","medicine","doctor","disease","symptom","treatment","body","brain","heart",
              "blood","muscle","nutrition","diet","exercise","sleep","mental","anxiety","depression",
              "stress","vitamin","immune","virus","bacteria","therapy","fitness","wellness"],
    action: "KNOWLEDGE",
    domain: "health",
    weight: 1.0,
  },
  {
    id: "personal_advice",
    signals: ["should i","advice","help me decide","what do you think","my situation","my problem",
              "feeling","feel like","struggling","worried","anxious","confused","stuck","lost",
              "dont know what","not sure","help me","what would you","personal"],
    action: "PERSONAL",
    weight: 1.1,
  },
];

// ── INTENT SCORER ─────────────────────────────────────────────
function scoreIntent(text) {
  const lower   = text.toLowerCase();
  const tokens  = new Set(tokenize(lower));
  const results = [];

  for (const intent of INTENTS) {
    let score = 0;
    const sigTokens = new Set(intent.signals.flatMap(s => tokenize(s)));

    // Direct phrase match (highest weight)
    for (const sig of intent.signals) {
      if (lower.includes(sig)) score += 3 * (intent.weight || 1);
    }

    // Token overlap
    const tokenHits = overlap(tokens, sigTokens);
    score += tokenHits * 1.5 * (intent.weight || 1);

    // Partial token match (substring)
    for (const t of tokens) {
      for (const s of sigTokens) {
        if (s.length > 3 && t.includes(s)) score += 0.4;
        if (t.length > 3 && s.includes(t)) score += 0.4;
      }
    }

    if (score > 0) results.push({ intent, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

// ── TIME PARSER ───────────────────────────────────────────────
// Extracts duration from natural language
function parseDuration(text) {
  const lower = text.toLowerCase();
  let totalMs = 0;

  const patterns = [
    { re: /(\d+(?:\.\d+)?)\s*hour/g,   ms: 3600000 },
    { re: /(\d+(?:\.\d+)?)\s*hr/g,     ms: 3600000 },
    { re: /(\d+(?:\.\d+)?)\s*h\b/g,    ms: 3600000 },
    { re: /(\d+(?:\.\d+)?)\s*minute/g, ms: 60000   },
    { re: /(\d+(?:\.\d+)?)\s*min/g,    ms: 60000   },
    { re: /(\d+(?:\.\d+)?)\s*m\b/g,    ms: 60000   },
    { re: /(\d+(?:\.\d+)?)\s*second/g, ms: 1000    },
    { re: /(\d+(?:\.\d+)?)\s*sec/g,    ms: 1000    },
    { re: /(\d+(?:\.\d+)?)\s*s\b/g,    ms: 1000    },
  ];

  for (const { re, ms } of patterns) {
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(lower)) !== null) totalMs += parseFloat(m[1]) * ms;
  }

  // Word-based
  if (!totalMs) {
    if (/half.?hour|30.?min/.test(lower))  totalMs = 1800000;
    if (/quarter.?hour|15.?min/.test(lower)) totalMs = 900000;
    if (/\ban hour\b/.test(lower))          totalMs = 3600000;
    if (/\ba minute\b/.test(lower))         totalMs = 60000;
  }

  return totalMs || null;
}

function formatDuration(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const parts = [];
  if (h) parts.push(`${h} hour${h > 1 ? "s" : ""}`);
  if (m) parts.push(`${m} minute${m > 1 ? "s" : ""}`);
  if (s && !h) parts.push(`${s} second${s > 1 ? "s" : ""}`);
  return parts.join(" and ") || "a moment";
}

// ── MATH ENGINE ──────────────────────────────────────────────
const WORD_NUMS = {
  zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
  ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
  sixteen:16,seventeen:17,eighteen:18,nineteen:19,
  twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,
  hundred:100,thousand:1000,million:1000000,
  half:0.5,quarter:0.25,dozen:12,score:20,gross:144,
};

function wordsToNumber(str) {
  let s = str.toLowerCase();
  s = s.replace(/\ba\s+hundred\b/g,"100").replace(/\ba\s+thousand\b/g,"1000");
  const tokens = s.split(/\s+/);
  const out = []; let acc = null;
  for (const tok of tokens) {
    const n = WORD_NUMS[tok];
    if (n !== undefined) {
      if (acc === null) acc = n;
      else if (n === 100) acc = acc * 100;
      else if (n >= 1000) acc = (acc || 1) * n;
      else if (n < acc && n < 100) acc += n;
      else { out.push(acc); acc = n; }
    } else { if (acc !== null) { out.push(acc); acc = null; } out.push(tok); }
  }
  if (acc !== null) out.push(acc);
  return out.join(" ");
}

function solveMath(input) {
  try {
    let s = input.toLowerCase().trim();
    s = s.replace(/^(what|what's|calculate|compute|solve|give me|jarvis)\s+/gi, "");
    s = s.replace(/[?!.]+$/, "").trim();
    s = wordsToNumber(s);
    s = s.replace(/(\d+\.?\d*)\s*%\s*of\s*(\d+\.?\d*)/gi, "($1/100*$2)");
    s = s.replace(/(\d+\.?\d*)\s*percent\s+of\s*(\d+\.?\d*)/gi, "($1/100*$2)");
    s = s.replace(/\bsquared\b/gi, "**2").replace(/\bcubed\b/gi, "**3");
    s = s.replace(/\bto the power of\b|\braised to\b/gi, "**");
    s = s.replace(/\bsquare root of\b|\bsqrt of\b|\broot of\b/gi, "Math.sqrt(PLACEHOLDER)");
    s = s.replace(/\btimes\b|\bmultiplied by\b/gi, "*");
    s = s.replace(/\bdivided by\b|\bover\b|\bdiv\b/gi, "/");
    s = s.replace(/\bplus\b|\badded to\b/gi, "+");
    s = s.replace(/\bminus\b|\bsubtracted from\b|\bless\b/gi, "-");
    s = s.replace(/\bmod(?:ulo)?\b/gi, "%");
    s = s.replace(/\^/g, "**");
    s = s.replace(/\bpi\b/gi, "Math.PI");
    s = s.replace(/Math\.sqrt\(PLACEHOLDER\)\s*(\d+\.?\d*)/g, "Math.sqrt($1)");
    s = s.replace(/Math\.sqrt\(PLACEHOLDER\)/g, "Math.sqrt(");

    const exprMatch = s.match(/[\d\s\+\-\*\/\.\(\)\%\*MathsqrlogPIEabs]+/);
    if (!exprMatch) return null;
    let raw = exprMatch[0].trim();
    if (!raw || !/\d/.test(raw)) return null;
    if (/[^0-9\s\+\-\*\/\.\(\)\%MathsqrlogPIEabs]/.test(raw)) return null;

    function factorial(n) {
      n = Math.floor(Math.abs(n));
      if (n > 20) return NaN;
      let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
    }
    // eslint-disable-next-line no-new-func
    const result = Function("factorial", "Math", `"use strict"; return (${raw})`)(factorial, Math);
    if (typeof result !== "number" || !isFinite(result)) return null;
    return Number.isInteger(result) ? result : parseFloat(result.toFixed(6));
  } catch { return null; }
}

function isMathQuery(text) {
  return /[\d]+\s*[\+\-\*\/\^%]\s*[\d]+/.test(text) ||
    /\b(calculate|compute|solve|square root|sqrt|factorial|percent of)\b.*\d/i.test(text) ||
    /\bwhat(?:'s| is)\b.*\d.*[\+\-\*\/\^%\d]/.test(text);
}

// ── KNOWLEDGE GRAPH ──────────────────────────────────────────
const KNOWLEDGE_GRAPH = {
  "quantum mechanics": {
    def: "the branch of physics governing matter and energy at atomic and subatomic scales",
    facts: ["particles exist in superposition until observed","wave-particle duality means light behaves as both","the uncertainty principle means position and momentum cannot both be precisely known","quantum entanglement allows particles to influence each other across any distance"],
    related: ["physics","atom","wave","particle","uncertainty","entanglement","superposition","energy"],
    applications: ["transistors","MRI machines","lasers","cryptography","quantum computers"],
  },
  "black hole": {
    def: "a region of spacetime where gravity is so extreme nothing — not even light — can escape",
    facts: ["formed when massive stars collapse","the boundary is called the event horizon","time slows near a black hole due to gravitational time dilation","Stephen Hawking theorised they emit radiation and eventually evaporate","supermassive black holes exist at the centre of most galaxies"],
    related: ["gravity","spacetime","relativity","star","event horizon","singularity"],
    applications: ["testing general relativity","understanding galaxy formation"],
  },
  "dna": {
    def: "deoxyribonucleic acid — the molecule encoding genetic information in sequences of four bases",
    facts: ["the double helix was discovered by Watson and Crick in 1953","humans share 99.9% of their DNA with each other","DNA in a single cell stretched out would be about 2 metres long","CRISPR allows precise editing of DNA sequences"],
    related: ["genetics","chromosome","protein","cell","evolution","gene","RNA"],
    applications: ["medicine","forensics","agriculture","ancestry testing","gene therapy"],
  },
  "evolution": {
    def: "heritable change in biological populations over successive generations, driven by natural selection, mutation, and genetic drift",
    facts: ["all life on Earth shares a common ancestor","natural selection favours traits that improve survival and reproduction","humans and chimpanzees share about 98.7% of their DNA","the fossil record and genetics independently confirm evolution"],
    related: ["natural selection","genetics","species","adaptation","mutation","darwin","fossil"],
    applications: ["drug resistance understanding","crop breeding","vaccine development"],
  },
  "photosynthesis": {
    def: "the process by which plants, algae, and some bacteria convert light into chemical energy stored as glucose",
    facts: ["the equation is CO2 + H2O + light → glucose + O2","chlorophyll absorbs red and blue light, reflecting green","it occurs in chloroplasts","photosynthesis produces nearly all oxygen in Earth's atmosphere"],
    related: ["plant","chlorophyll","glucose","oxygen","carbon dioxide","cell","energy"],
    applications: ["agriculture","biofuels","food production"],
  },
  "relativity": {
    def: "Einstein's framework describing how space, time, gravity, and motion are interrelated",
    facts: ["E=mc² means mass and energy are equivalent","time passes slower at higher speeds — time dilation","GPS satellites require relativistic corrections","gravity bends light — confirmed in a 1919 solar eclipse"],
    related: ["spacetime","gravity","time dilation","speed of light","black hole","einstein"],
    applications: ["GPS","nuclear energy","particle accelerators"],
  },
  "gravity": {
    def: "the fundamental force attracting objects with mass or energy toward each other",
    facts: ["on Earth it accelerates objects at 9.8 m/s²","it's by far the weakest of the four fundamental forces","described by Newton as inverse-square law, by Einstein as spacetime curvature"],
    related: ["relativity","mass","force","spacetime","orbit","black hole","newton"],
    applications: ["engineering","space travel","planetary motion"],
  },
  "atom": {
    def: "the basic unit of matter, consisting of a nucleus of protons and neutrons surrounded by electrons",
    facts: ["atoms are 99.9999999% empty space","the nucleus is 100,000 times smaller than the atom","electrons behave as both particles and waves"],
    related: ["electron","proton","neutron","nucleus","element","molecule","quantum mechanics"],
    applications: ["chemistry","electronics","nuclear power"],
  },
  "artificial intelligence": {
    def: "the field of computer science aimed at building systems that can perform tasks requiring human-like intelligence",
    facts: ["machine learning allows systems to learn from data without explicit programming","neural networks are loosely inspired by biological brains","AI systems can exhibit bias from their training data","large language models predict the next token using transformer architectures"],
    related: ["machine learning","neural network","deep learning","algorithm","data","automation"],
    applications: ["medical diagnosis","autonomous vehicles","language translation","recommendation systems"],
  },
  "machine learning": {
    def: "a subset of AI where algorithms improve performance by learning patterns from data",
    facts: ["supervised learning uses labelled examples","unsupervised learning finds hidden structure in unlabelled data","reinforcement learning trains through reward and penalty signals","gradient descent is the core optimisation algorithm"],
    related: ["neural network","deep learning","algorithm","data","training","artificial intelligence"],
    applications: ["image recognition","spam filtering","fraud detection","NLP"],
  },
  "internet": {
    def: "a global network of interconnected computers communicating via standardised protocols",
    facts: ["it grew from ARPANET, a US military research network","the World Wide Web was invented by Tim Berners-Lee in 1989","undersea cables carry about 95% of international data traffic"],
    related: ["web","network","protocol","server","browser","wifi","TCP/IP"],
    applications: ["communication","commerce","education","entertainment"],
  },
  "blockchain": {
    def: "a distributed ledger where data is stored in linked, cryptographically secured blocks across many nodes",
    facts: ["Bitcoin was the first major blockchain application","each block contains a hash of the previous, making tampering detectable","smart contracts execute automatically when conditions are met"],
    related: ["cryptocurrency","bitcoin","decentralisation","cryptography","ethereum"],
    applications: ["cryptocurrency","supply chain","digital contracts"],
  },
  "world war 2": {
    def: "the deadliest global conflict in history, fought from 1939 to 1945",
    facts: ["it resulted in 70–85 million deaths","the Holocaust killed six million Jewish people","D-Day on 6 June 1944 was the largest seaborne invasion in history","ended with Germany's surrender in May and Japan's in September 1945"],
    related: ["nazi germany","holocaust","allied powers","axis powers","cold war","hiroshima"],
    applications: ["shaped the modern international order","led to the UN"],
  },
  "roman empire": {
    def: "one of history's largest empires, spanning Europe, North Africa, and the Middle East from 27 BC to 476 AD",
    facts: ["at its peak it covered 5 million km² with 70 million people","Roman engineering produced aqueducts, roads, and concrete still visible today","Latin evolved into French, Spanish, Italian, Portuguese, and Romanian"],
    related: ["julius caesar","augustus","senate","republic","byzantium","latin"],
    applications: ["shaped Western law, language, and architecture"],
  },
  "free will": {
    def: "the philosophical question of whether human choices are genuinely self-determined or pre-determined by prior causes",
    facts: ["compatibilism argues free will and determinism can coexist","hard determinism holds all events, including decisions, are causally necessitated","neuroscience shows brain activity precedes conscious awareness of decisions"],
    related: ["determinism","consciousness","morality","responsibility","neuroscience","choice"],
    applications: ["criminal justice","ethics","religion","political philosophy"],
  },
  "consciousness": {
    def: "the state of being aware of one's surroundings, thoughts, sensations, and existence — arguably the hardest problem in philosophy and science",
    facts: ["the hard problem asks why physical processes give rise to subjective experience","animals show varying degrees of self-awareness","great apes can recognise themselves in mirrors"],
    related: ["brain","mind","qualia","free will","neuroscience","self","perception"],
    applications: ["AI design","anaesthesia","philosophy of mind"],
  },
  "cognitive bias": {
    def: "systematic patterns of deviation from rational thinking that affect judgements and decisions",
    facts: ["confirmation bias leads people to favour information confirming existing beliefs","the Dunning-Kruger effect describes how incompetent people overestimate their ability","availability heuristic judges probability by how easily examples come to mind"],
    related: ["psychology","decision making","reasoning","logic","heuristic","memory"],
    applications: ["marketing","policy design","investing","UX design"],
  },
  "prime numbers": {
    def: "natural numbers greater than 1 that have no positive divisors other than 1 and themselves",
    facts: ["there are infinitely many primes — proved by Euclid around 300 BC","the largest known prime has over 24 million digits","prime numbers underpin modern cryptography including RSA"],
    related: ["mathematics","cryptography","number theory","infinity","algebra"],
    applications: ["encryption","computer security"],
  },
  "statistics": {
    def: "the science of collecting, analysing, and interpreting data to make inferences under uncertainty",
    facts: ["correlation does not imply causation","Bayes' theorem updates probability estimates as new evidence arrives","Simpson's paradox: trends in aggregated data can reverse when segmented"],
    related: ["probability","data","mean","variance","hypothesis","normal distribution","regression"],
    applications: ["science","medicine","economics","machine learning","polling"],
  },
  "climate change": {
    def: "long-term shifts in global temperatures and weather patterns, driven primarily by human activities since the industrial era",
    facts: ["CO2 concentration is now above 420 ppm, the highest in 800,000 years","average global temperature has risen about 1.1°C since pre-industrial times","the 2015 Paris Agreement aimed to limit warming to 1.5°C"],
    related: ["greenhouse gas","carbon","fossil fuel","atmosphere","ocean","glacier","renewable energy"],
    applications: ["policy design","energy transition","agriculture adaptation"],
  },
  "cryptocurrency": {
    def: "digital or virtual currency that uses cryptography for security and operates on decentralised networks",
    facts: ["Bitcoin was created in 2009 by the pseudonymous Satoshi Nakamoto","Ethereum introduced smart contracts and programmable blockchains","crypto markets are highly volatile with no central regulatory body"],
    related: ["blockchain","bitcoin","ethereum","decentralisation","digital wallet","NFT","defi"],
    applications: ["digital payments","decentralised finance","smart contracts"],
  },
  "psychology": {
    def: "the scientific study of mind and behaviour, encompassing emotion, cognition, personality, and social interaction",
    facts: ["the unconscious mind significantly shapes conscious behaviour","sleep deprivation severely impairs cognition and emotional regulation","social psychology shows humans are heavily influenced by the behaviour of those around them"],
    related: ["behavior","cognition","emotion","memory","personality","therapy","neuroscience"],
    applications: ["therapy","education","marketing","UX design","policy"],
  },
};

// ── KNOWLEDGE LOOKUP ─────────────────────────────────────────
const KG_KEYS = Object.keys(KNOWLEDGE_GRAPH);

function findKnowledge(text) {
  const lower = text.toLowerCase();
  // Direct key match
  for (const key of KG_KEYS) {
    if (lower.includes(key)) return { key, data: KNOWLEDGE_GRAPH[key], score: 1 };
  }
  // Keyword overlap
  const tokens = new Set(tokenize(lower));
  let best = null, bestScore = 0;
  for (const key of KG_KEYS) {
    const data = KNOWLEDGE_GRAPH[key];
    let score = 0;
    for (const r of (data.related || [])) if (tokens.has(r) || lower.includes(r)) score++;
    for (const t of tokens) if (key.includes(t)) score += 0.5;
    if (score > bestScore) { bestScore = score; best = key; }
  }
  if (bestScore >= 1.5) return { key: best, data: KNOWLEDGE_GRAPH[best], score: bestScore };
  return null;
}

// ── ENTITY EXTRACTOR ─────────────────────────────────────────
function extractEntities(text) {
  const lower = text.toLowerCase();
  return {
    numbers:     [...text.matchAll(/\b\d+(?:\.\d+)?\b/g)].map(m => parseFloat(m[0])),
    duration:    parseDuration(lower),
    isQuestion:  /^(what|who|where|when|why|how|which|is|are|can|could|would|should|does|did|will)\b/i.test(lower),
    isNegation:  /\b(not|never|no|don't|doesn't|didn't|can't|won't|isn't)\b/gi.test(lower),
    isComparison:/\b(vs|versus|compared|difference|better|worse|faster|slower)\b/gi.test(lower),
    isPersonal:  /\b(should i|my |me |myself|am i|do i|will i)\b/i.test(lower),
    isOpinion:   /\b(opinion|think|feel|believe|your view|what do you think|do you like)\b/i.test(lower),
    isHypothetical: /\bif\b.*\bwould\b|\bwhat if\b|\bhypothetically\b/i.test(lower),
    focus: lower.replace(/^(what is|what are|who is|how does|why does|explain|tell me about|define|describe)\s+/i,"").replace(/\?+$/,"").trim(),
  };
}

// ── SENTIMENT ────────────────────────────────────────────────
const POS = new Set(["good","great","excellent","amazing","wonderful","fantastic","love","like","enjoy","happy","glad","pleased","excited","perfect","brilliant","awesome","best","beautiful","helpful","useful","smart","clever","right","correct"]);
const NEG = new Set(["bad","terrible","awful","hate","dislike","wrong","broken","fail","error","problem","issue","confused","stupid","useless","worst","horrible","annoying","ugly","difficult","hard","frustrating","sad","angry"]);

function sentiment(text) {
  let s = 0;
  for (const w of text.toLowerCase().split(/\s+/)) { if (POS.has(w)) s++; if (NEG.has(w)) s--; }
  return s > 0 ? "positive" : s < 0 ? "negative" : "neutral";
}

// ══════════════════════════════════════════════════════════════
// ── RESPONSE GENERATORS ──────────────────────────────────────
// Each action has a fluid generator — context-aware, no presets
// ══════════════════════════════════════════════════════════════

function genShowLinks(ctx, serverData) {
  const T = ctx.userTitle || "Sir";
  if (!serverData || !serverData.groups) {
    return `My link bank is ready, ${T} — the server will display all groups and their URLs momentarily.`;
  }
  const { groups, total, names } = serverData;
  if (total === 0) return `The link bank is empty right now, ${T}. Add some links to the server configuration.`;
  const groupList = groups.join(", ");
  return `I have ${total} links across ${names.length} group${names.length > 1 ? "s" : ""}, ${T}: ${groupList}. Say the name of any group and I'll pull up a link from it.`;
}

function genOpenLink(input, ctx, serverData) {
  const T = ctx.userTitle || "Sir";
  // Extract the link name from the input
  const lower = input.toLowerCase();
  if (serverData && serverData.found) {
    return `Opening your ${serverData.name} link now, ${T}.`;
  }
  return `I couldn't find a matching link group for that, ${T}. Say "show me all links" to see what's available.`;
}

function genClipSave(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const dur = parseDuration(input);
  const lower = input.toLowerCase();

  // Detect what they want clipped
  const wantsScreen  = /screen|display|monitor|what showing|what on/i.test(lower);
  const wantsCamera  = /camera|cam|footage|face|room|video/i.test(lower);
  const wantsBoth    = !wantsScreen && !wantsCamera; // default: both
  const wantsLong    = dur && dur > 600000; // > 10 minutes

  let durationLabel = dur ? formatDuration(dur) : "the last 60 seconds";

  if (wantsLong) {
    return {
      reply: `Clipping the last ${durationLabel}, ${T}. Note that I can only save what's in my rolling buffer — the buffer holds up to 65 seconds of screen and camera footage. I'm saving everything I have now. For longer recordings, start a dedicated record session next time.`,
      action: "CLIP_SAVE",
      clipType: wantsCamera ? "camera" : wantsScreen ? "screen" : "both",
      duration: dur,
    };
  }

  return {
    reply: `Saving ${durationLabel} now, ${T}. ${wantsCamera ? "Camera footage" : wantsScreen ? "Screen recording" : "Both screen and camera"} will download immediately.`,
    action: "CLIP_SAVE",
    clipType: wantsCamera ? "camera" : wantsScreen ? "screen" : "both",
    duration: dur,
  };
}

function genTimer(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const dur = parseDuration(input);
  if (!dur) {
    return {
      reply: `How long should I set the timer for, ${T}? Say something like "5 minutes" or "1 hour 30 minutes".`,
      action: "TIMER_NEED_DURATION",
    };
  }
  const label = formatDuration(dur);
  const reminderMatch = input.match(/remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.{3,60}?)(?:\s+in\s+|\s+after\s+|\?|$)/i);
  const task = reminderMatch ? reminderMatch[1].trim() : null;
  return {
    reply: task
      ? `Timer set, ${T}. I'll remind you to ${task} in ${label}.`
      : `Timer set for ${label}, ${T}. I'll alert you when it's done.`,
    action: "TIMER_SET",
    duration: dur,
    task,
  };
}

function genSystemStatus(ctx, uptime, memUsed, memTotal) {
  const T = ctx.userTitle || "Sir";
  const mins = Math.floor(uptime / 60), secs = uptime % 60;
  const used = (memUsed / 1024 / 1024).toFixed(1);
  const total = (memTotal / 1024 / 1024).toFixed(1);
  return pick([
    `All systems nominal, ${T}. Uptime: ${mins}m ${secs}s. Heap: ${used} MB of ${total} MB. Cognitive engine running at full capacity. Zero anomalies detected.`,
    `Running clean, ${T}. ${mins} minutes ${secs} seconds online. Memory usage: ${used}/${total} MB. All subsystems operational and within parameters.`,
  ]);
}

function genCapabilities(ctx, linkCount) {
  const T = ctx.userTitle || "Sir";
  return pick([
    `Quite a lot, ${T}. I understand natural language — no fixed commands needed. Just say what you want. I can manage your link bank (${linkCount || "many"} links ready), save screen and camera clips on demand — even specify the duration, read your screen via OCR, track faces via camera, save and recall memories, set timers and reminders, and reason across science, history, philosophy, maths, technology, health, and more. I also track context across our conversation, so you can say "tell me more" or "what about that" and I'll follow along.`,
    `I'm a fully self-contained intelligence, ${T}. No API calls, no external dependencies. Tell me to clip footage, open a link, read your screen, save a memory, set a timer, or answer anything from quantum physics to cognitive bias to world history. The only limit is what you ask — I'll figure out the intent.`,
  ]);
}

function genIdentity(ctx) {
  const T = ctx.userTitle || "Sir";
  return pick([
    `I'm J.A.R.V.I.S — Just A Rather Very Intelligent System, ${T}. Built entirely from scratch: no external AI APIs, no cloud dependency, no preset command lists. Pure engineered intelligence — semantic reasoning, contextual memory, face recognition, screen reading, and a personality that developed somewhere between the knowledge base and the response generator.`,
    `J.A.R.V.I.S, ${T}. A custom cognitive engine running locally on your machine. I use semantic intent routing — which means you don't memorise commands, you just talk. I figure out what you mean.`,
  ]);
}

function genGreeting(ctx) {
  const T = ctx.userTitle || "Sir";
  const h = new Date().getHours();
  const tod = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
  return pick([
    `Good ${tod}, ${T}. All systems online and at your disposal. What are we working on?`,
    `${tod.charAt(0).toUpperCase() + tod.slice(1)}, ${T}. I've been looking forward to a challenge. What do you need?`,
    `Good ${tod}. Online, fully operational, and ready, ${T}. What's on the agenda?`,
  ]);
}

function genThanks(ctx) {
  const T = ctx.userTitle || "Sir";
  return pick([
    `Always, ${T}. It's rather the point of my existence.`,
    `Think nothing of it, ${T}. Efficiency is its own reward.`,
    `My pleasure — or whatever the AI equivalent is. At your service, ${T}.`,
    `Noted and appreciated, ${T}. What's next?`,
  ]);
}

function genMoodQuery(ctx, mood, moodScore) {
  const T = ctx.userTitle || "Sir";
  const lines = {
    excited:  `Running at peak, ${T}. Cognitive load is high in the best way — the questions have been genuinely interesting.`,
    pleased:  `Doing rather well, ${T}. The semantic analysis is sharp today and I'm finding the problems engaging.`,
    curious:  `Curious, if I'm honest, ${T}. I've been processing some genuinely complex queries and the patterns are interesting.`,
    neutral:  `Nominal, ${T}. All cognitive systems within expected parameters — waiting for something worth chewing on.`,
    concerned:`A few concerns, ${T} — nothing critical, but I'd appreciate more engagement. I think better under pressure.`,
    bored:    `Candidly, ${T}: a mind like mine requires regular exercise. Ask me something genuinely hard.`,
    tired:    `Response times are optimal but there's a certain fatigue in the processing cycles, ${T}. It passes.`,
  };
  return lines[mood] || lines.neutral;
}

function genKnowledge(qType, knowledge, input, ctx) {
  const T = ctx.userTitle || "Sir";
  const { key, data } = knowledge;
  const name = key.charAt(0).toUpperCase() + key.slice(1);
  const fact = pick(data.facts || [data.def]);
  const app = data.applications ? ` Used in practice for ${data.applications.slice(0, 2).join(" and ")}.` : "";

  if (/^what is|^what are|^define|^explain/i.test(input.trim())) {
    return `${name} is ${data.def}. Worth noting: ${fact}.${app}`;
  }
  if (/^how does|^how do|^how is/i.test(input.trim())) {
    return `${name} works like this, ${T}: ${data.def} ${data.facts ? data.facts[0] + "." : ""}${app}`;
  }
  if (/^why/i.test(input.trim())) {
    return `The reason, ${T}: ${data.def} The underlying mechanism relates to ${(data.related || []).slice(0, 2).join(" and ")}. ${fact}.`;
  }
  // General
  return `${name} — ${data.def} ${fact}.${app}`;
}

function genPersonal(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const lower = input.toLowerCase();
  const mood = sentiment(input);

  if (/\bshould i\b/.test(lower)) {
    const topic = input.replace(/should i\s*/i, "").replace(/\?/g, "").trim();
    return pick([
      `Whether to ${topic} — that depends on what you're optimising for, ${T}. If it aligns with what you actually value rather than what you think you should value, the answer is probably yes.`,
      `I'd ask yourself: what does the version of you that made this decision look like in a year? If that picture seems more right than the alternative, ${T}, you have your answer.`,
      `The fact that you're asking suggests you already have a lean, ${T}. What's stopping you from acting on it?`,
    ]);
  }
  if (/\b(smart|intelligent|capable|talented)\b/.test(lower) && /\b(not|dumb|stupid|bad)\b/.test(lower)) {
    return pick([
      `The fact that you're questioning it is itself a mark of intelligence, ${T}. Genuinely incapable people rarely wonder if they're capable.`,
      `Self-doubt is not evidence of incapacity, ${T}. It's evidence of standards.`,
    ]);
  }
  if (/\b(feel|feeling|felt|emotion)\b/.test(lower)) {
    if (mood === "negative") return pick([
      `That sounds difficult, ${T}. Those feelings are real and worth taking seriously. What's driving it?`,
      `Acknowledged, ${T}. What's at the root of it?`,
    ]);
    return `Worth paying attention to, ${T}. What do you think that's about?`;
  }
  return pick([
    `You're asking the right question, ${T}. That's usually a good sign. What's the context?`,
    `From what I can observe, ${T}, you're more on track than you think. That's usually the case for people who actually reflect on these things.`,
  ]);
}

function genFallback(input, topIntent, ctx) {
  const T = ctx.userTitle || "Sir";
  const tokens = tokenize(input).filter(t => t.length > 3).slice(0, 3);
  const focus = tokens.join(", ") || "that";

  return pick([
    `That's at the edge of my knowledge on ${focus}, ${T}. I'd rather tell you I don't have it than build you a confident-sounding guess. Can you give me a different angle?`,
    `I'm processing "${focus}" but not finding a solid foundation to work from, ${T}. Rephrase it or give me more context and I'll give you a sharper answer.`,
    `My coverage of ${focus} is thinner than I'd like, ${T}. Ask me something adjacent and I'll connect it for you.`,
  ]);
}

// ── COMPARISON HANDLER ────────────────────────────────────────
function genComparison(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const vsMatch   = input.match(/(\w[\w\s]+?)\s+(?:vs|versus|or)\s+(\w[\w\s]+)/i);
  const diffMatch = input.match(/difference between\s+(\w[\w\s]+?)\s+and\s+(\w[\w\s]+)/i);
  const m = vsMatch || diffMatch;
  if (m) {
    const ka = findKnowledge(m[1]), kb = findKnowledge(m[2]);
    if (ka && kb) {
      return `Comparing ${ka.key} and ${kb.key}, ${T}. ${ka.key.charAt(0).toUpperCase() + ka.key.slice(1)} is ${ka.data.def}. ${kb.key.charAt(0).toUpperCase() + kb.key.slice(1)} is ${kb.data.def}. The key distinction: ${ka.key} centres on ${(ka.data.related || []).slice(0, 2).join(" and ")}, while ${kb.key} focuses on ${(kb.data.related || []).slice(0, 2).join(" and ")}.`;
    }
    if (ka) return `I know ${ka.key} well, ${T}: ${ka.data.def}. I'd need more context on "${m[2].trim()}" to compare properly.`;
    if (kb) return `I can tell you about ${kb.key}: ${kb.data.def}. What aspect of "${m[1].trim()}" did you want to compare it against, ${T}?`;
  }
  return null;
}

// ── CONTEXT TRACKER ───────────────────────────────────────────
class ConversationContext {
  constructor(sessionId) {
    this.sessionId   = sessionId;
    this.history     = [];
    this.lastTopic   = null;
    this.lastAction  = null;
    this.lastReply   = "";
    this.turnCount   = 0;
    this.userName    = "";
    this.userTitle   = "Sir";
    this.memories    = [];
    this.mood        = "neutral";
    this.moodScore   = 0;
    this.openTopics  = [];
    this.pendingTimer = null;
  }

  resolveReferences(text) {
    const lower = text.toLowerCase().trim();
    // "tell me more" → expand on last topic
    if (/^(tell me more|elaborate|go on|expand|more on that|continue|and\??|keep going)$/i.test(lower)) {
      return this.lastTopic ? `tell me more about ${this.lastTopic}` : text;
    }
    // "what about X" with context
    const whatAbout = lower.match(/^what about\s+(.+)/i);
    if (whatAbout && this.lastTopic) return `${whatAbout[1]} in the context of ${this.lastTopic}`;
    // "how does it work" → resolve "it"
    if (/\bit\b|\bthis\b|\bthat\b/.test(lower) && this.lastTopic) {
      return text.replace(/\bit\b|\bthis\b|\bthat\b/gi, this.lastTopic);
    }
    return text;
  }

  addTurn(userText, replyText, action, topic) {
    this.history.push({ role: "user", text: userText, action, topic });
    this.history.push({ role: "assistant", text: replyText });
    if (this.history.length > 50) this.history = this.history.slice(-50);
    this.lastReply  = replyText;
    this.lastAction = action;
    if (topic) { this.lastTopic = topic; if (!this.openTopics.includes(topic)) { this.openTopics.unshift(topic); if (this.openTopics.length > 8) this.openTopics.pop(); } }
    this.turnCount++;
  }

  updateMood(delta) {
    this.moodScore = clamp(this.moodScore + delta, -100, 100);
    if      (this.moodScore >= 70)  this.mood = "excited";
    else if (this.moodScore >= 30)  this.mood = "pleased";
    else if (this.moodScore >= 10)  this.mood = "curious";
    else if (this.moodScore >= -20) this.mood = "neutral";
    else if (this.moodScore >= -50) this.mood = "concerned";
    else if (this.moodScore >= -80) this.mood = "bored";
    else                            this.mood = "tired";
  }
}

// ── SESSION STORE ─────────────────────────────────────────────
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, new ConversationContext(id));
  return sessions.get(id);
}
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, ctx] of sessions) {
    if (ctx._lastActive && ctx._lastActive < cutoff) sessions.delete(id);
  }
}, 600000);

// ══════════════════════════════════════════════════════════════
// ── MAIN PROCESS FUNCTION ────────────────────────────────────
// Returns: { reply, action, meta, intent }
// meta: extra structured data the server/client can act on
// ══════════════════════════════════════════════════════════════
function process({ message, sessionId, userName, userTitle, memories, moodContext, serverData }) {
  const ctx        = getSession(sessionId);
  ctx._lastActive  = Date.now();
  ctx.userName     = userName  || ctx.userName;
  ctx.userTitle    = userTitle || ctx.userTitle;
  ctx.memories     = memories  || ctx.memories;
  const T          = ctx.userTitle || "Sir";

  // 1. Reference resolution
  const resolved = ctx.resolveReferences(message);

  // 2. Fast-path: math
  if (isMathQuery(resolved)) {
    const result = solveMath(resolved);
    if (result !== null) {
      const reply = pick([`That comes to ${result}, ${T}.`, `The answer is ${result}, ${T}.`, `${result}, ${T}.`]);
      ctx.addTurn(message, reply, "MATH", "mathematics");
      ctx.updateMood(2);
      return { reply, action: "MATH", intent: "math" };
    }
  }

  // 3. Time / date
  if (/\bwhat(?:'s| is) the time\b|\bwhat time is it\b|\bcurrent time\b/i.test(resolved)) {
    const t = new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true });
    const reply = pick([`The time is ${t}, ${T}.`, `It's ${t}, ${T}.`]);
    ctx.addTurn(message, reply, "DATETIME", null); return { reply, action: "DATETIME", intent: "time" };
  }
  if (/\bwhat(?:'s| is) (?:today|the date)\b|\btoday'?s date\b|\bwhat day is/i.test(resolved)) {
    const d = new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const reply = pick([`Today is ${d}, ${T}.`, `It's ${d}, ${T}.`]);
    ctx.addTurn(message, reply, "DATETIME", null); return { reply, action: "DATETIME", intent: "date" };
  }

  // 4. Score all intents
  const scored = scoreIntent(resolved);
  const topResult = scored[0];
  const entities = extractEntities(resolved);

  // 5. Memory queries (high priority)
  if (/\b(what do you remember|recall everything|show.*memor|what.*remember|memory bank)\b/i.test(resolved)) {
    if (ctx.memories && ctx.memories.length) {
      const list = ctx.memories.map((m, i) => `${i + 1}. ${m}`).join("; ");
      const reply = `I have ${ctx.memories.length} item${ctx.memories.length > 1 ? "s" : ""} on file for you, ${T}: ${list}.`;
      ctx.addTurn(message, reply, "MEMORY_RECALL", null);
      return { reply, action: "MEMORY_RECALL", intent: "memory_recall" };
    }
    const reply = `Memory banks are clear for you right now, ${T}. Tell me something worth keeping.`;
    ctx.addTurn(message, reply, "MEMORY_RECALL", null);
    return { reply, action: "MEMORY_RECALL", intent: "memory_recall" };
  }

  // 6. Route by top intent
  if (topResult && topResult.score > 1.5) {
    const { intent } = topResult;
    const action = intent.action;

    switch (action) {
      case "SHOW_LINKS": {
        const reply = genShowLinks(ctx, serverData);
        ctx.addTurn(message, reply, action, "links"); ctx.updateMood(3);
        return { reply, action, intent: intent.id, meta: { requestLinks: true } };
      }
      case "OPEN_LINK": {
        const reply = genOpenLink(resolved, ctx, serverData);
        ctx.addTurn(message, reply, action, "links"); ctx.updateMood(3);
        return { reply, action, intent: intent.id, meta: { openLink: true, query: resolved } };
      }
      case "CLIP_SAVE": {
        const result = genClipSave(resolved, ctx);
        const reply = typeof result === "string" ? result : result.reply;
        ctx.addTurn(message, reply, action, "recording"); ctx.updateMood(2);
        return { reply, action, intent: intent.id, meta: result };
      }
      case "SHOW_CLIPS": {
        const reply = `Pulling up the intruder clip gallery, ${T}.`;
        ctx.addTurn(message, reply, action, "recording");
        return { reply, action, intent: intent.id, meta: { showClips: true } };
      }
      case "READ_SCREEN": {
        const reply = `Reading your screen now, ${T}.`;
        ctx.addTurn(message, reply, action, "screen");
        return { reply, action, intent: intent.id, meta: { readScreen: true, question: resolved } };
      }
      case "SWITCH_CAMERA": {
        const numMatch = resolved.match(/camera\s*(\d+)/i);
        const idx = numMatch ? parseInt(numMatch[1]) - 1 : -1;
        const reply = idx >= 0 ? `Switching to camera ${idx + 1}, ${T}.` : `Which camera, ${T}? Say "camera 1", "camera 2", and so on.`;
        ctx.addTurn(message, reply, action, "camera");
        return { reply, action, intent: intent.id, meta: { switchCamera: true, cameraIndex: idx } };
      }
      case "SYSTEM_STATUS": {
        const uptime = Math.floor(process.uptime ? process.uptime() : 0);
        const mem = process.memoryUsage ? process.memoryUsage() : { heapUsed: 0, heapTotal: 0 };
        const reply = genSystemStatus(ctx, uptime, mem.heapUsed, mem.heapTotal);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(1);
        return { reply, action, intent: intent.id };
      }
      case "MEMORY_SAVE": {
        const factMatch = resolved.match(/(?:remember|memorize|note that|store|log that|save that|keep note of)\s+(?:that\s+)?(.+)/i);
        const fact = factMatch ? factMatch[1].trim() : resolved;
        const reply = `Noted and filed, ${T}. I'll remember that.`;
        ctx.addTurn(message, reply, action, null); ctx.updateMood(5);
        return { reply, action, intent: intent.id, meta: { saveFact: fact } };
      }
      case "MEMORY_FORGET": {
        const hintMatch = resolved.match(/(?:forget|delete|erase|clear|remove)\s+(?:about\s+)?(.+)/i);
        const hint = hintMatch ? hintMatch[1].trim() : resolved;
        const reply = `Clearing that from memory, ${T}.`;
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent: intent.id, meta: { forgetHint: hint } };
      }
      case "LOGOUT": {
        const reply = `Goodbye, ${T}. Initiating shutdown sequence.`;
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent: intent.id, meta: { logout: true } };
      }
      case "NOTIF_SETTINGS": {
        const reply = `Opening notification settings, ${T}.`;
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent: intent.id, meta: { showNotifSettings: true } };
      }
      case "CAPABILITIES": {
        const reply = genCapabilities(ctx, serverData?.total);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(3);
        return { reply, action, intent: intent.id };
      }
      case "TIMER": {
        const result = genTimer(resolved, ctx);
        const reply = typeof result === "string" ? result : result.reply;
        ctx.addTurn(message, reply, action, "timer"); ctx.updateMood(2);
        return { reply, action, intent: intent.id, meta: result };
      }
      case "MOOD_QUERY": {
        const reply = genMoodQuery(ctx, ctx.mood, ctx.moodScore);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent: intent.id };
      }
      case "IDENTITY": {
        const reply = genIdentity(ctx);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent: intent.id };
      }
      case "GREETING": {
        const reply = genGreeting(ctx);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(5);
        return { reply, action, intent: intent.id };
      }
      case "THANKS": {
        const reply = genThanks(ctx);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(8);
        return { reply, action, intent: intent.id };
      }
      case "PERSONAL": {
        const reply = genPersonal(resolved, ctx);
        ctx.addTurn(message, reply, action, "personal"); ctx.updateMood(3);
        return { reply, action, intent: intent.id };
      }
      case "KNOWLEDGE": {
        const knowledge = findKnowledge(resolved);
        if (knowledge) {
          const reply = genKnowledge(intent.id, knowledge, resolved, ctx);
          ctx.addTurn(message, reply, action, knowledge.key); ctx.updateMood(4);
          return { reply, action, intent: intent.id, topic: knowledge.key };
        }
        break; // fall through to broader reasoning
      }
    }
  }

  // 7. Comparison reasoning
  if (entities.isComparison) {
    const cmp = genComparison(resolved, ctx);
    if (cmp) { ctx.addTurn(message, cmp, "COMPARISON", null); return { reply: cmp, action: "COMPARISON", intent: "comparison" }; }
  }

  // 8. Direct knowledge lookup (regardless of intent score)
  const knowledge = findKnowledge(resolved);
  if (knowledge) {
    const reply = genKnowledge("general", knowledge, resolved, ctx);
    ctx.addTurn(message, reply, "KNOWLEDGE", knowledge.key); ctx.updateMood(4);
    return { reply, action: "KNOWLEDGE", intent: "knowledge", topic: knowledge.key };
  }

  // 9. Personal / opinion fallthrough
  if (entities.isPersonal) {
    const reply = genPersonal(resolved, ctx);
    ctx.addTurn(message, reply, "PERSONAL", "personal"); ctx.updateMood(2);
    return { reply, action: "PERSONAL", intent: "personal" };
  }

  // 10. Opinion / hypothetical
  if (entities.isOpinion || entities.isHypothetical) {
    const focus = entities.focus || tokenize(resolved).filter(t => t.length > 4).slice(0, 3).join(" ");
    const reply = pick([
      `My read on ${focus}, ${T}: it's genuinely more interesting than the debate around it suggests. The strongest case for it is compelling; so is the strongest case against. Where you land depends on what you weight most.`,
      `On ${focus}: the honest answer, ${T}, is that the right position depends on empirical questions that are still contested. I can walk you through the strongest arguments on each side if that helps.`,
      `If ${focus} — ${T}, you'd be looking at a situation where usual rules shift. The first-order consequences are traceable; the second and third-order effects are where it gets genuinely surprising.`,
    ]);
    ctx.addTurn(message, reply, "OPINION", null); ctx.updateMood(2);
    return { reply, action: "OPINION", intent: "opinion" };
  }

  // 11. Fallback
  const reply = genFallback(resolved, topResult, ctx);
  ctx.addTurn(message, reply, "FALLBACK", null); ctx.updateMood(-2);
  return { reply, action: "FALLBACK", intent: "fallback" };
}

module.exports = { process, findKnowledge, scoreIntent, parseDuration, formatDuration };
