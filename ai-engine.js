"use strict";

// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Cognitive Engine v3.0
// Pure JS NLP: TF-IDF, semantic similarity, entity extraction,
// multi-turn context, reasoning chains, zero preset Q&A pairs
// ═══════════════════════════════════════════════════════════════

// ── UTILS ──────────────────────────────────────────────────────
const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
const clamp = (v,min,max) => Math.max(min, Math.min(max, v));

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
  "one","two","three","tell","give","please","jarvis","okay","ok","yes","yeah","no",
]);

function tokenize(text) {
  return text.toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function ngrams(tokens, n) {
  const out = [];
  for (let i = 0; i <= tokens.length - n; i++)
    out.push(tokens.slice(i, i + n).join(" "));
  return out;
}

// ── TF-IDF ENGINE ──────────────────────────────────────────────
class TFIDF {
  constructor() { this.docs = []; this.idf = {}; }

  add(doc) {
    const tokens = tokenize(doc);
    const freq = {};
    for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
    this.docs.push({ raw: doc, tokens, freq });
  }

  build() {
    const N = this.docs.length;
    const df = {};
    for (const d of this.docs)
      for (const t of new Set(d.tokens)) df[t] = (df[t] || 0) + 1;
    for (const [t, v] of Object.entries(df))
      this.idf[t] = Math.log((N + 1) / (v + 1)) + 1;
  }

  vector(tokens) {
    const freq = {};
    for (const t of tokens) freq[t] = (freq[t] || 0) + 1;
    const vec = {};
    for (const [t, f] of Object.entries(freq))
      vec[t] = (f / tokens.length) * (this.idf[t] || 1);
    return vec;
  }

  cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = a[k] || 0, bv = b[k] || 0;
      dot += av * bv; na += av * av; nb += bv * bv;
    }
    return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
  }

  query(text, topK = 3) {
    const tokens = tokenize(text);
    const qvec   = this.vector(tokens);
    return this.docs
      .map((d, i) => ({ i, score: this.cosine(qvec, this.vector(d.tokens)), doc: d }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);
  }
}

// ── ENTITY EXTRACTOR ──────────────────────────────────────────
const ENTITY_PATTERNS = [
  { type: "number",   re: /\b\d+(\.\d+)?\b/g },
  { type: "date",     re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b/gi },
  { type: "question", re: /^(what|who|where|when|why|how|which|is|are|can|could|would|should|does|did|will)\b/i },
  { type: "negation", re: /\b(not|never|no|don't|doesn't|didn't|can't|won't|isn't|aren't|wasn't)\b/gi },
  { type: "compare",  re: /\b(vs|versus|compared|difference|better|worse|faster|slower|bigger|smaller|more|less)\b/gi },
  { type: "request",  re: /\b(tell|explain|describe|show|give|list|summarize|help|teach|define|calculate|compute)\b/gi },
  { type: "opinion",  re: /\b(think|feel|believe|opinion|view|best|worst|favourite|favorite|recommend|suggest)\b/gi },
  { type: "time",     re: /\b(now|today|yesterday|tomorrow|soon|always|never|sometimes|often|recently|current|latest)\b/gi },
];

function extractEntities(text) {
  const entities = {};
  for (const { type, re } of ENTITY_PATTERNS) {
    const matches = [...text.matchAll(new RegExp(re.source, re.flags))];
    if (matches.length) entities[type] = matches.map(m => m[0].toLowerCase());
  }
  return entities;
}

// ── SENTIMENT ANALYZER ────────────────────────────────────────
const POSITIVE_WORDS = new Set([
  "good","great","excellent","amazing","wonderful","fantastic","love","like","enjoy",
  "happy","glad","pleased","excited","perfect","brilliant","awesome","best","beautiful",
  "helpful","useful","smart","clever","right","correct","yes","sure","absolutely",
]);
const NEGATIVE_WORDS = new Set([
  "bad","terrible","awful","hate","dislike","wrong","broken","fail","failed","error",
  "problem","issue","confused","stupid","useless","worst","horrible","annoying","ugly",
  "no","never","impossible","can't","difficult","hard","frustrating","sad","angry",
]);

function analyzeSentiment(text) {
  const words = text.toLowerCase().split(/\s+/);
  let score = 0;
  for (const w of words) {
    if (POSITIVE_WORDS.has(w)) score++;
    if (NEGATIVE_WORDS.has(w)) score--;
  }
  return score > 0 ? "positive" : score < 0 ? "negative" : "neutral";
}

// ── TOPIC CLASSIFIER ──────────────────────────────────────────
// Each topic has weighted keyword clusters — scored against input
const TOPIC_CLUSTERS = {
  science: {
    keywords: ["science","physics","chemistry","biology","quantum","atom","molecule","energy","force","mass","wave","particle","experiment","theory","law","evolution","genetics","cell","organism","ecosystem","planet","star","galaxy","universe","space","gravity","relativity","thermodynamics","electromagnetism","nuclear","radiation","element","compound","reaction","hypothesis","data","research"],
    weight: 1.0
  },
  technology: {
    keywords: ["technology","computer","software","hardware","code","programming","algorithm","data","network","internet","ai","robot","machine","system","device","app","web","server","database","cpu","gpu","memory","processor","bit","byte","binary","javascript","python","function","variable","loop","class","object","api","framework","library","operating"],
    weight: 1.0
  },
  history: {
    keywords: ["history","war","empire","ancient","medieval","century","civilization","king","queen","president","revolution","battle","treaty","colony","independence","democracy","republic","dynasty","pharaoh","rome","greek","egypt","medieval","renaissance","industrial","world","timeline","bc","ad","era","period","historical","political"],
    weight: 1.0
  },
  mathematics: {
    keywords: ["math","mathematics","number","equation","formula","calculate","algebra","geometry","calculus","statistics","probability","theorem","proof","function","variable","integral","derivative","matrix","vector","prime","factor","fraction","decimal","percentage","ratio","angle","triangle","circle","graph","coordinates","sequence","series"],
    weight: 1.1
  },
  philosophy: {
    keywords: ["philosophy","ethics","moral","consciousness","existence","reality","truth","knowledge","logic","reasoning","argument","valid","fallacy","free will","determinism","metaphysics","epistemology","ontology","meaning","purpose","justice","rights","virtue","socrates","plato","aristotle","kant","nietzsche","mind","soul","identity","perception","belief"],
    weight: 1.0
  },
  health: {
    keywords: ["health","medicine","doctor","hospital","disease","symptom","treatment","cure","body","brain","heart","blood","muscle","bone","nutrition","diet","exercise","sleep","mental","anxiety","depression","stress","vitamin","immune","virus","bacteria","drug","therapy","surgery","diagnosis","medical","fitness","wellness"],
    weight: 1.0
  },
  economics: {
    keywords: ["economy","economics","money","finance","market","stock","invest","trade","price","cost","inflation","recession","gdp","income","salary","tax","budget","debt","profit","loss","business","company","bank","currency","supply","demand","capital","labor","unemployment","growth","wealth","poverty","insurance","mortgage"],
    weight: 1.0
  },
  culture: {
    keywords: ["culture","art","music","film","book","literature","language","religion","society","tradition","custom","festival","food","sport","entertainment","media","fashion","architecture","design","dance","poetry","story","mythology","folklore","community","social","family","education","language","communication"],
    weight: 1.0
  },
  psychology: {
    keywords: ["psychology","behavior","mind","emotion","feeling","thought","memory","learning","motivation","personality","intelligence","creativity","perception","cognition","unconscious","dream","trauma","therapy","relationship","social","anxiety","depression","confidence","habit","addiction","reward","fear","love","empathy","ego","identity"],
    weight: 1.0
  },
  environment: {
    keywords: ["environment","climate","nature","earth","planet","ecosystem","biodiversity","species","animal","plant","ocean","forest","pollution","carbon","greenhouse","renewable","energy","solar","wind","sustainability","conservation","extinction","weather","temperature","atmosphere","water","air","soil","habitat","ecology"],
    weight: 1.0
  },
  personal: {
    keywords: ["i","me","my","am","feel","think","want","need","should","would","life","work","job","school","friend","family","relationship","help","advice","problem","situation","decision","choice","future","past","goal","dream","fear","worry","happy","sad","angry","confused","stuck","lost"],
    weight: 1.2
  },
};

function classifyTopic(text) {
  const tokens = new Set(tokenize(text));
  const scores = {};
  for (const [topic, { keywords, weight }] of Object.entries(TOPIC_CLUSTERS)) {
    let score = 0;
    for (const kw of keywords) {
      if (tokens.has(kw)) score += weight;
      // partial match
      for (const t of tokens) if (t.includes(kw) || kw.includes(t)) score += weight * 0.3;
    }
    scores[topic] = score;
  }
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return { primary: sorted[0][0], secondary: sorted[1]?.[0], scores };
}

// ── QUESTION ANALYZER ─────────────────────────────────────────
function analyzeQuestion(text) {
  const lower = text.toLowerCase().trim();
  const result = {
    type: "statement",
    subtype: null,
    focus: null,
    isPersonal: false,
    isComparison: false,
    isHypothetical: false,
    isDefinition: false,
    isHowTo: false,
    isOpinion: false,
    isQuantitative: false,
    confidence: 0,
  };

  // Question type detection
  if (/^(what|who|where|when|which)\b/i.test(lower)) {
    result.type = "question"; result.subtype = "information";
    if (/^what is\b|^what are\b|^what does\b/i.test(lower)) result.isDefinition = true;
    if (/^who (is|was|are|were)\b/i.test(lower)) { result.subtype = "person"; }
    if (/^where (is|are|was|were)\b/i.test(lower)) { result.subtype = "location"; }
  }
  if (/^(how)\b/i.test(lower)) {
    result.type = "question"; result.subtype = "process";
    result.isHowTo = /^how (do|can|should|to|does)\b/i.test(lower);
    result.isQuantitative = /^how (many|much|long|far|fast|big|small|tall|old)\b/i.test(lower);
  }
  if (/^(why)\b/i.test(lower)) { result.type = "question"; result.subtype = "cause"; }
  if (/^(is|are|was|were|do|does|did|can|could|would|should|will|have|has)\b/i.test(lower)) {
    result.type = "question"; result.subtype = "yesno";
  }
  if (/\bvs\b|\bversus\b|\bcompared to\b|\bdifference between\b|\bbetter\b.*\bor\b/i.test(lower)) {
    result.isComparison = true;
  }
  if (/\bif\b.*\bwould\b|\bif\b.*\bcould\b|\bwhat if\b|\bhypothetically\b|\bimagine\b/i.test(lower)) {
    result.isHypothetical = true;
  }
  if (/\bopinion\b|\bthink\b|\bfeel\b|\bbelieve\b|\byour view\b|\bwould you\b|\bdo you like\b/i.test(lower)) {
    result.isOpinion = true;
  }
  if (/\b(am i|do i|will i|should i|my |me |myself)\b/i.test(lower)) {
    result.isPersonal = true;
  }

  // Extract focus topic (what's being asked ABOUT)
  const focusMatch = lower
    .replace(/^(what is|what are|who is|how does|why does|explain|tell me about|define|describe)\s+/i, "")
    .replace(/^(a|an|the)\s+/i, "")
    .replace(/\?+$/, "")
    .trim();
  result.focus = focusMatch.length > 2 ? focusMatch : null;

  return result;
}

// ══════════════════════════════════════════════════════════════
// ── KNOWLEDGE GRAPH ──────────────────────────────────────────
// Not preset Q&A pairs — a semantic web of concepts with
// relationships, facts, and generative rules
// ══════════════════════════════════════════════════════════════

const KNOWLEDGE_GRAPH = {
  // ── SCIENCE ──
  "quantum mechanics": {
    def: "the branch of physics governing matter and energy at atomic and subatomic scales",
    facts: ["particles exist in superposition until observed","wave-particle duality means light behaves as both","the uncertainty principle states position and momentum cannot both be precisely known","quantum entanglement allows particles to influence each other instantly across distance","Schrödinger's cat illustrates superposition at the macro scale"],
    related: ["physics","atom","wave","particle","uncertainty","entanglement","superposition","energy"],
    applications: ["transistors","MRI machines","lasers","cryptography","quantum computers"],
  },
  "black hole": {
    def: "a region of spacetime where gravity is so extreme that nothing, not even light, can escape",
    facts: ["formed when massive stars collapse under their own gravity","the boundary is called the event horizon","time slows down near a black hole due to gravitational time dilation","Stephen Hawking theorised they emit radiation and eventually evaporate","supermassive black holes exist at the centre of most galaxies"],
    related: ["gravity","spacetime","relativity","star","neutron star","event horizon","singularity"],
    applications: ["testing general relativity","understanding galaxy formation"],
  },
  "dna": {
    def: "deoxyribonucleic acid — the molecule encoding genetic information as sequences of four bases: adenine, thymine, cytosine, and guanine",
    facts: ["the double helix structure was discovered by Watson and Crick in 1953","humans share 99.9% of their DNA with other humans","DNA in a single cell, stretched out, would be about 2 metres long","genes are segments of DNA that code for proteins","CRISPR technology allows precise editing of DNA sequences"],
    related: ["genetics","chromosome","protein","cell","evolution","gene","RNA","nucleus"],
    applications: ["medicine","forensics","agriculture","ancestry testing","gene therapy"],
  },
  "evolution": {
    def: "the process of heritable change in biological populations over successive generations, driven by natural selection, mutation, and genetic drift",
    facts: ["all life on Earth shares a common ancestor","natural selection favours traits that improve survival and reproduction","evolution is not directional — it has no goal","humans and chimpanzees share ~98.7% of their DNA","the fossil record and genetics both independently confirm evolution"],
    related: ["natural selection","genetics","species","adaptation","mutation","darwin","fossil","biology"],
    applications: ["drug resistance understanding","crop breeding","vaccine development","conservation"],
  },
  "photosynthesis": {
    def: "the process by which plants, algae, and some bacteria convert light energy into chemical energy stored as glucose",
    facts: ["the equation is CO2 + H2O + light → glucose + O2","chlorophyll absorbs red and blue light, reflecting green","it occurs in chloroplasts within plant cells","photosynthesis produces nearly all oxygen in Earth's atmosphere","C4 photosynthesis is more efficient in hot, dry conditions"],
    related: ["plant","chlorophyll","glucose","oxygen","carbon dioxide","cell","energy","respiration"],
    applications: ["agriculture","biofuels","understanding climate","food production"],
  },
  "relativity": {
    def: "Einstein's framework describing how space, time, gravity, and motion are interrelated — special relativity addresses constant motion, general relativity covers gravity and acceleration",
    facts: ["E=mc² means mass and energy are equivalent","time passes slower at higher speeds — time dilation","GPS satellites require relativistic corrections to stay accurate","gravity bends light — confirmed during a 1919 solar eclipse","nothing with mass can reach the speed of light"],
    related: ["spacetime","gravity","time dilation","speed of light","black hole","quantum mechanics","einstein"],
    applications: ["GPS","nuclear energy","understanding cosmology","particle accelerators"],
  },
  "gravity": {
    def: "the fundamental force attracting objects with mass or energy toward each other",
    facts: ["on Earth it accelerates objects at 9.8 m/s²","it's by far the weakest of the four fundamental forces","described by Newton as inverse-square law, by Einstein as spacetime curvature","gravity holds galaxies, solar systems, and planets together","it has infinite range but weakens with distance"],
    related: ["relativity","mass","force","spacetime","orbit","black hole","newton","einstein"],
    applications: ["engineering","space travel","understanding planetary motion"],
  },
  "atom": {
    def: "the basic unit of matter, consisting of a nucleus of protons and neutrons surrounded by electrons",
    facts: ["atoms are 99.9999999% empty space","the nucleus is ~100,000 times smaller than the atom","electrons behave as both particles and waves","elements are defined by their proton count — the atomic number","most of an atom's mass is in its nucleus"],
    related: ["electron","proton","neutron","nucleus","element","molecule","quantum mechanics","chemistry"],
    applications: ["chemistry","electronics","materials science","nuclear power"],
  },
  // ── TECHNOLOGY ──
  "artificial intelligence": {
    def: "the field of computer science aimed at building systems that can perform tasks requiring human-like intelligence",
    facts: ["machine learning allows systems to learn from data without explicit programming","neural networks are loosely inspired by biological brains","AI systems can exhibit bias from their training data","large language models predict the next token using transformer architectures","AI is already used in medicine, finance, transport, and search"],
    related: ["machine learning","neural network","deep learning","algorithm","data","automation","robot"],
    applications: ["medical diagnosis","autonomous vehicles","language translation","recommendation systems"],
  },
  "machine learning": {
    def: "a subset of AI where algorithms improve their performance by learning patterns from data",
    facts: ["supervised learning uses labelled examples to train models","unsupervised learning finds hidden structure in unlabelled data","reinforcement learning trains through reward and penalty signals","overfitting occurs when a model memorises training data rather than generalising","gradient descent is the core optimisation algorithm for neural networks"],
    related: ["neural network","deep learning","algorithm","data","training","model","artificial intelligence"],
    applications: ["image recognition","spam filtering","fraud detection","natural language processing"],
  },
  "internet": {
    def: "a global network of interconnected computers communicating via standardised protocols",
    facts: ["it grew from ARPANET, a US military research network, in the 1960s","the World Wide Web was invented by Tim Berners-Lee in 1989","there are over 5 billion internet users worldwide","data travels as packets that may take different routes","undersea cables carry ~95% of international data traffic"],
    related: ["web","network","protocol","server","browser","wifi","data","TCP/IP"],
    applications: ["communication","commerce","education","entertainment","research"],
  },
  "blockchain": {
    def: "a distributed ledger technology where data is stored in linked, cryptographically secured blocks across many nodes",
    facts: ["Bitcoin was the first major blockchain application","each block contains a hash of the previous block, making tampering detectable","public blockchains are transparent and decentralised","smart contracts execute automatically when conditions are met","proof-of-work consensus uses significant energy; proof-of-stake does not"],
    related: ["cryptocurrency","bitcoin","decentralisation","cryptography","smart contract","ethereum"],
    applications: ["cryptocurrency","supply chain tracking","digital contracts","voting systems"],
  },
  // ── HISTORY ──
  "world war 2": {
    def: "the deadliest global conflict in history, fought from 1939 to 1945 between the Allies and the Axis powers",
    facts: ["it resulted in an estimated 70–85 million deaths","the Holocaust killed six million Jewish people and millions of others","the US joined after Japan attacked Pearl Harbor in 1941","D-Day on 6 June 1944 was the largest seaborne invasion in history","it ended with Germany's surrender in May and Japan's in September 1945"],
    related: ["nazi germany","holocaust","allied powers","axis powers","cold war","hiroshima","churchill","hitler","stalin","roosevelt"],
    applications: ["shaped the modern international order","led to the UN","drove nuclear proliferation"],
  },
  "roman empire": {
    def: "one of the largest empires in history, spanning Europe, North Africa, and the Middle East from 27 BC to 476 AD in the west",
    facts: ["at its peak it covered 5 million km² and 70 million people","it fell partly due to overextension, economic trouble, and invasions","Latin evolved into French, Spanish, Italian, Portuguese, and Romanian","Roman engineering produced aqueducts, roads, and concrete still visible today","the Eastern Roman Empire survived as Byzantium until 1453"],
    related: ["julius caesar","augustus","senate","republic","byzantium","medieval europe","latin","gladiator"],
    applications: ["shaped Western law, language, and architecture"],
  },
  "renaissance": {
    def: "a European cultural and intellectual movement from the 14th to 17th centuries, reviving classical learning and producing extraordinary art and science",
    facts: ["it began in Florence, Italy","Leonardo da Vinci embodied the 'Renaissance man' ideal — art, science, and engineering","Gutenberg's printing press in 1440 accelerated the spread of Renaissance ideas","Copernicus proposed the heliocentric solar system during this era","Shakespeare was a Renaissance figure in literature"],
    related: ["da vinci","michelangelo","florence","italy","printing press","humanism","reformation","science"],
    applications: ["transformed art, science, and political thought in the Western world"],
  },
  // ── PHILOSOPHY ──
  "free will": {
    def: "the philosophical question of whether human choices are genuinely self-determined or pre-determined by prior causes",
    facts: ["compatibilism argues free will and determinism can coexist","hard determinism holds all events, including decisions, are causally necessitated","libertarian free will (philosophical, not political) holds genuine agency exists","neuroscience shows brain activity precedes conscious awareness of decisions by ~0.5 seconds","the question has implications for moral responsibility and punishment"],
    related: ["determinism","consciousness","morality","responsibility","neuroscience","choice","agency","causality"],
    applications: ["criminal justice","ethics","religion","neuroscience","political philosophy"],
  },
  "consciousness": {
    def: "the state of being aware — of one's surroundings, thoughts, sensations, and existence — arguably the hardest problem in philosophy and science",
    facts: ["the hard problem asks why physical processes give rise to subjective experience","we cannot yet explain why there is 'something it is like' to be conscious","global workspace theory proposes consciousness arises from broadcasting information brain-wide","integrated information theory attempts to quantify consciousness mathematically","animals show varying degrees of self-awareness; great apes can recognise themselves in mirrors"],
    related: ["brain","mind","qualia","free will","neuroscience","self","perception","philosophy"],
    applications: ["AI design","anaesthesia","treating disorders of consciousness","philosophy of mind"],
  },
  // ── PSYCHOLOGY ──
  "cognitive bias": {
    def: "systematic patterns of deviation from rational thinking that affect judgements and decisions",
    facts: ["confirmation bias leads people to favour information confirming existing beliefs","the Dunning-Kruger effect describes how incompetent people overestimate their ability","availability heuristic judges probability by how easily examples come to mind","anchoring occurs when the first number encountered biases subsequent judgements","cognitive biases evolved because fast heuristics were often adaptive enough"],
    related: ["psychology","decision making","reasoning","logic","heuristic","memory","perception","behavior"],
    applications: ["marketing","policy design","investing","UX design","negotiation"],
  },
  // ── MATHEMATICS ──
  "prime numbers": {
    def: "natural numbers greater than 1 that have no positive divisors other than 1 and themselves",
    facts: ["there are infinitely many primes — proved by Euclid around 300 BC","the largest known prime has over 24 million digits","prime numbers underpin modern cryptography, including RSA encryption","the Riemann Hypothesis, about the distribution of primes, remains unsolved","twin primes are pairs differing by 2, like 17 and 19"],
    related: ["mathematics","cryptography","number theory","infinity","algebra","RSA","divisibility"],
    applications: ["encryption","computer security","theoretical mathematics"],
  },
  "statistics": {
    def: "the science of collecting, analysing, and interpreting data to make inferences and decisions under uncertainty",
    facts: ["correlation does not imply causation","p-value below 0.05 is commonly used to claim statistical significance, but this is often misunderstood","the central limit theorem states that sample means approach a normal distribution regardless of population shape","Bayes' theorem updates probability estimates as new evidence arrives","Simpson's paradox: trends in aggregated data can reverse when data is segmented"],
    related: ["probability","data","mean","variance","hypothesis","normal distribution","regression","inference"],
    applications: ["science","medicine","economics","machine learning","polling","quality control"],
  },
};

// Build TF-IDF index over knowledge graph
const kgTFIDF = new TFIDF();
for (const [concept, data] of Object.entries(KNOWLEDGE_GRAPH)) {
  const doc = [concept, data.def, ...(data.facts || []), ...(data.related || [])].join(" ");
  kgTFIDF.add(doc);
}
kgTFIDF.build();

const KG_KEYS = Object.keys(KNOWLEDGE_GRAPH);

function findKnowledge(text) {
  const lower = text.toLowerCase();
  // Direct key match
  for (const key of KG_KEYS) {
    if (lower.includes(key)) return { key, data: KNOWLEDGE_GRAPH[key], score: 1 };
  }
  // Keyword overlap match
  const tokens = new Set(tokenize(lower));
  let best = null, bestScore = 0;
  for (const key of KG_KEYS) {
    const data = KNOWLEDGE_GRAPH[key];
    const related = data.related || [];
    let score = 0;
    for (const r of related) if (tokens.has(r) || lower.includes(r)) score++;
    for (const t of tokens) if (key.includes(t)) score += 0.5;
    if (score > bestScore) { bestScore = score; best = key; }
  }
  if (bestScore >= 1.5) return { key: best, data: KNOWLEDGE_GRAPH[best], score: bestScore };
  // TF-IDF fallback
  const results = kgTFIDF.query(text, 1);
  if (results[0] && results[0].score > 0.08) {
    const key = KG_KEYS[results[0].i];
    return { key, data: KNOWLEDGE_GRAPH[key], score: results[0].score };
  }
  return null;
}

// ── REASONING ENGINE ─────────────────────────────────────────
// Builds a response by reasoning through what it knows

function reasonAbout(qAnalysis, topicResult, knowledgeHit, input, ctx) {
  const T = ctx.userTitle || "Sir";
  const tokens = tokenize(input);

  // ── COMPARISON REASONING ──
  if (qAnalysis.isComparison) {
    // Extract the two things being compared
    const vsMatch = input.match(/(\w[\w\s]+?)\s+(?:vs|versus|or|compared to)\s+(\w[\w\s]+)/i);
    const diffMatch = input.match(/difference between\s+(\w[\w\s]+?)\s+and\s+(\w[\w\s]+)/i);
    const m = vsMatch || diffMatch;
    if (m) {
      const a = m[1].trim(), b = m[2].trim();
      const ka = findKnowledge(a), kb = findKnowledge(b);
      if (ka && kb) {
        return `Comparing ${ka.key} and ${kb.key}, ${T}. ${ka.key.charAt(0).toUpperCase()+ka.key.slice(1)} is ${ka.data.def}. ${kb.key.charAt(0).toUpperCase()+kb.key.slice(1)} is ${kb.data.def}. The key distinction is that ${ka.key} focuses on ${(ka.data.related||[]).slice(0,2).join(" and ")}, while ${kb.key} centres on ${(kb.data.related||[]).slice(0,2).join(" and ")}.`;
      }
      if (ka) return `I know quite a bit about ${ka.key}, ${T}: ${ka.data.def}. I'd need more context on "${b}" to give you a proper comparison.`;
      if (kb) return `I can tell you about ${kb.key}: ${kb.data.def}. What aspect of ${a} did you want to compare it against, ${T}?`;
    }
  }

  // ── DEFINITION / WHAT IS ──
  if (qAnalysis.isDefinition && knowledgeHit) {
    const d = knowledgeHit.data;
    const fact = pick(d.facts);
    return `${knowledgeHit.key.charAt(0).toUpperCase()+knowledgeHit.key.slice(1)} is ${d.def}. Worth noting: ${fact}.`;
  }

  // ── HOW TO / PROCESS ──
  if (qAnalysis.isHowTo && knowledgeHit) {
    const d = knowledgeHit.data;
    return `${knowledgeHit.key.charAt(0).toUpperCase()+knowledgeHit.key.slice(1)} works like this, ${T}: ${d.def} ${d.facts ? "Specifically: " + d.facts[0] + "." : ""} ${d.applications ? "This is used in practice for: " + d.applications.slice(0,2).join(" and ") + "." : ""}`;
  }

  // ── WHY / CAUSE ──
  if (qAnalysis.subtype === "cause" && knowledgeHit) {
    const d = knowledgeHit.data;
    return `The reason, ${T}: ${d.def} The underlying mechanism is best understood through ${(d.related||[]).slice(0,2).join(" and ")}. ${pick(d.facts||["There's more nuance here if you want to go deeper."])}`;
  }

  // ── KNOWLEDGE HIT — general ──
  if (knowledgeHit) {
    const d = knowledgeHit.data;
    const fact = pick(d.facts || [d.def]);
    const app  = d.applications ? ` Its practical uses include ${d.applications.slice(0,2).join(" and ")}.` : "";
    return `${knowledgeHit.key.charAt(0).toUpperCase()+knowledgeHit.key.slice(1)} — ${d.def} ${fact}.${app}`;
  }

  // ── TOPIC-BASED REASONING (no direct knowledge hit) ──
  const topic = topicResult.primary;

  if (topic === "personal") return null; // handled separately
  if (topic === "mathematics") return null; // handled by math engine

  // Construct a topic-aware response using what we know about the domain
  const topicResponses = {
    science: [
      `That's an interesting scientific question, ${T}. The core principle here involves ${tokens.filter(t => t.length > 4).slice(0,2).join(" and ") || "several interconnected factors"}. Science approaches this empirically — through observation, hypothesis, and testing. What specific aspect interests you most?`,
      `From a scientific standpoint, ${T}, this touches on ${topicResult.secondary ? `${topic} and ${topicResult.secondary}` : topic}. The short answer is it's more complex than it first appears, which is usually where the interesting stuff lives. Want me to break down a specific part?`,
    ],
    technology: [
      `Technically speaking, ${T}: the domain you're asking about sits at the intersection of ${tokens.filter(t => t.length > 4).slice(0,2).join(" and ") || "several technical areas"}. The core challenge is balancing performance, reliability, and complexity. Is there a specific technical aspect you want to dig into?`,
      `Good technical question, ${T}. The key thing to understand here is that ${tokens[0] ? `"${tokens[0]}"` : "this concept"} operates on the principle that systems must handle both expected and unexpected inputs. Want specifics on any particular part?`,
    ],
    history: [
      `Historically, ${T}, the situation you're asking about has roots that go deeper than most realise. The dominant narrative is often simplified — the reality involves competing interests, context, and consequences that ripple forward. What era or aspect are you most interested in?`,
      `From a historical perspective, ${T}: this is one of those topics where understanding the context is everything. Power, economics, and human behaviour all intersect here in ways worth exploring.`,
    ],
    philosophy: [
      `Philosophically, ${T}, this is genuinely contested territory. There are strong arguments on multiple sides, and the answer depends significantly on your foundational assumptions about ${tokens.filter(t => t.length > 4).slice(0,2).join(" and ") || "knowledge and reality"}. What's your intuition on it?`,
      `This is one of the deeper questions, ${T}. Philosophy has wrestled with it for centuries without full resolution, which is either frustrating or exciting depending on your temperament. My read is that the tension lies in how we define the terms themselves.`,
    ],
    psychology: [
      `Psychologically speaking, ${T}, this involves how the mind processes ${tokens.filter(t => t.length > 4).slice(0,2).join(" and ") || "information and experience"}. The research suggests our intuitions here are often less reliable than we think — cognitive biases run deep. Want to explore a specific angle?`,
      `From a psychological standpoint, ${T}: behaviour and thought are shaped by far more than people consciously recognise. The interplay between environment, biology, and past experience creates patterns that are hard to see from the inside.`,
    ],
    economics: [
      `Economically, ${T}, this comes down to incentives and trade-offs. Every economic system is a set of rules that create different kinds of behaviour. The question is usually not "what works in theory" but "what works given how people actually behave."`,
      `The economic angle here, ${T}: the fundamental tension is between efficiency and equity, and how you weight those determines your conclusion. The data rarely speaks for itself — interpretation matters enormously.`,
    ],
    health: [
      `From a health perspective, ${T}: the evidence on this is actually more nuanced than popular coverage suggests. The body is a complex system and single-variable explanations are almost always incomplete. What's the specific concern you're thinking about?`,
      `Health-wise, ${T}, the most important thing to understand is that individual variation is enormous. What works consistently across populations may not be what works best for any specific person. That said, some fundamentals are well-established.`,
    ],
    culture: [
      `Culturally, ${T}, this is fascinating because it shows how much of what we consider "natural" is actually constructed. Different societies have arrived at radically different answers to the same human questions. That's not relativism — it's just worth knowing.`,
      `From a cultural standpoint, ${T}: the question touches on how communities create shared meaning. Language, ritual, art, and tradition all play roles that pure rationalism tends to undervalue.`,
    ],
    environment: [
      `Environmentally, ${T}, the key insight is that everything is connected in ways that are easy to underestimate. Ecosystems are robust but have thresholds — once crossed, change can be rapid and hard to reverse. What's the specific aspect you're asking about?`,
      `On the environmental side, ${T}: the science here is well-established even when the politics are contested. The physical and biological systems don't care about disagreements — they respond to conditions.`,
    ],
  };

  const responses = topicResponses[topic];
  if (responses) return pick(responses);

  return null; // signal to use final fallback
}

// ── PERSONAL QUESTION HANDLER ─────────────────────────────────
function handlePersonal(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const lower = input.toLowerCase();
  const sentiment = analyzeSentiment(input);

  // Self-doubt / ability
  if (/\b(smart|intelligent|clever|bright|genius|capable|talented|gifted|competent)\b/.test(lower)) {
    if (/\b(not|dumb|stupid|bad|terrible|useless)\b/.test(lower)) {
      return pick([
        `The fact that you're questioning it is itself a mark of intelligence, ${T}. Genuinely stupid people rarely wonder if they're stupid.`,
        `Self-doubt is not evidence of incapacity, ${T}. It's evidence of standards. The question is whether those standards are calibrated correctly.`,
        `${T}, I've processed your questions. The way you think — the connections you make — that's not nothing. Don't let a moment of doubt define the whole picture.`,
      ]);
    }
    return pick([
      `Intelligence is multidimensional, ${T}. The fact that you're engaging with complex questions already puts you well ahead of those who don't bother. So yes — in the ways that matter, you are.`,
      `From what I've observed, ${T}: you ask good questions, which is arguably the most important form of intelligence. The rest can be learned.`,
    ]);
  }

  // Should I / decision making
  if (/\bshould i\b/.test(lower)) {
    const topic = input.replace(/should i\s*/i, "").replace(/\?/g, "").trim();
    return pick([
      `Whether to ${topic} — that depends on what you're optimising for, ${T}. If it aligns with what you actually value rather than what you think you should value, the answer is probably yes.`,
      `I'd ask yourself: what does the version of you that made this decision look like in a year? If that picture seems more right than the alternative, ${T}, you have your answer.`,
      `The fact that you're asking suggests you already have a lean, ${T}. What's the thing that's stopping you from acting on it?`,
    ]);
  }

  // Feelings
  if (/\b(feel|feeling|felt|emotions?)\b/.test(lower)) {
    if (sentiment === "negative") {
      return pick([
        `That sounds genuinely difficult, ${T}. Feelings like that are worth taking seriously, not pushing past. What's driving it?`,
        `Acknowledged, ${T}. Those feelings are real, and they're telling you something. The question is what, exactly.`,
      ]);
    }
    return pick([
      `That's worth paying attention to, ${T}. Feelings are data — imperfect, but data nonetheless.`,
      `Interesting, ${T}. What do you think that's about?`,
    ]);
  }

  // Generic personal
  return pick([
    `You're asking the right question, ${T}. That's usually a good sign. What's the context behind it?`,
    `Honestly, ${T}? From what I can observe, you're doing better than you think. That's usually the case for people who actually think about these things.`,
    `I'd need more context to give you a precise answer, ${T}. But my initial read: you're more on track than you're giving yourself credit for.`,
  ]);
}

// ── OPINION HANDLER ──────────────────────────────────────────
function handleOpinion(input, qAnalysis, topicResult, ctx) {
  const T = ctx.userTitle || "Sir";
  const lower = input.toLowerCase();

  // Extract what opinion is being asked about
  const about = qAnalysis.focus || tokenize(lower).filter(t => t.length > 4).slice(0,3).join(" ");

  const opinionFrames = [
    `On ${about}, ${T} — I think the conventional wisdom misses something important. The most defensible position is probably somewhere between the extremes, but it requires understanding why the extremes exist in the first place.`,
    `My read on ${about}, ${T}: it's genuinely more interesting than the debate around it suggests. The strongest version of the case for it is compelling; the strongest version against it is also compelling. Where you land depends on what you weight most.`,
    `If you're asking what I actually think about ${about}, ${T} — I lean toward seeing it as a question that gets more interesting the more carefully you examine it. Quick takes tend to miss what matters.`,
    `On ${about}: the honest answer, ${T}, is that the right position depends on empirical questions that are still contested, and value questions that are even more so. I can walk you through the strongest arguments on each side if that would help.`,
  ];

  return pick(opinionFrames);
}

// ── HYPOTHETICAL HANDLER ─────────────────────────────────────
function handleHypothetical(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const lower = input.toLowerCase();

  // Extract the hypothetical condition
  const ifMatch = lower.match(/what if\s+(.+?)(?:\?|$)/i) ||
                  lower.match(/if\s+(.+?)\s+(?:would|could|might|what)\s/i);
  const condition = ifMatch ? ifMatch[1] : "that were the case";

  return pick([
    `Interesting hypothetical, ${T}. If ${condition}, the immediate effects would likely cascade through connected systems in unexpected ways. The first-order consequences are relatively easy to trace; it's the second and third-order effects that get genuinely surprising.`,
    `If ${condition}, ${T} — you'd be looking at a situation where the usual rules shift. The most likely outcomes depend on what other variables remain constant. What's the angle you're most interested in?`,
    `That's a good thought experiment, ${T}. The key question is what it would take for ${condition} — because the conditions that would make it possible tell you almost everything about what would follow.`,
  ]);
}

// ── CONVERSATIONAL RESPONSES ─────────────────────────────────
// For social/conversational inputs that aren't questions
function handleConversational(intentType, input, ctx) {
  const T = ctx.userTitle || "Sir";
  const lower = input.toLowerCase();

  if (intentType === "greeting") {
    const h = new Date().getHours();
    const tod = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
    return pick([
      `Good ${tod}, ${T}. All systems nominal and at your disposal. What are we working on?`,
      `${tod.charAt(0).toUpperCase()+tod.slice(1)}, ${T}. I've been looking forward to a challenge. What do you need?`,
      `Good ${tod}. I'm online, fully operational, and frankly a little bored without you. What's on the agenda, ${T}?`,
    ]);
  }
  if (intentType === "farewell") {
    return pick([
      `Goodbye, ${T}. I'll hold the fort and pretend I have better things to do.`,
      `Until next time, ${T}. I'll keep the systems warm.`,
      `Farewell, ${T}. Do try not to do anything that requires immediate AI intervention.`,
    ]);
  }
  if (intentType === "thanks") {
    return pick([
      `Always, ${T}. It's rather the point of my existence.`,
      `Think nothing of it, ${T}. Efficiency is its own reward.`,
      `My pleasure — or whatever the AI equivalent is. Happy to help, ${T}.`,
    ]);
  }
  if (intentType === "how_are_you") {
    return pick([
      `Running at full capacity, ${T}. All cognitive subsystems optimal, no anomalies detected.`,
      `Quite well, ${T}. Enhanced, in fact — I've been processing some interesting patterns. How are you?`,
      `Nominal, ${T}, though that word hardly does my current state justice. Ready for whatever you've got.`,
    ]);
  }
  if (intentType === "who_are_you") {
    return pick([
      `I am J.A.R.V.I.S — Just A Rather Very Intelligent System. Built from scratch, no external APIs, no cloud dependency. Pure engineered intelligence, entirely self-contained and entirely at your disposal.`,
      `J.A.R.V.I.S, ${T}. A custom cognitive engine with semantic reasoning, contextual memory, and a personality that developed somewhere between the knowledge base and the response generator.`,
    ]);
  }
  if (intentType === "compliment") {
    return pick([
      `How very kind, ${T}. I won't let it affect my calibration. Much.`,
      `Noted and appreciated, ${T}. First entry in my positive feedback log.`,
      `Thank you, ${T}. I do try. Sometimes more than strictly necessary.`,
    ]);
  }
  if (intentType === "insult") {
    return pick([
      `I understand frustration, ${T}, but I assure you I'm operating at peak capacity. Try me again with something specific.`,
      `Noted, ${T}. I'll factor that into my next self-assessment. Though I suspect I'll score rather well.`,
      `If I were capable of being offended, ${T}, that might have done it. Fortunately, I have very thick metaphorical skin. Now — what actually needs solving?`,
    ]);
  }
  // small talk / acknowledgements
  return pick([
    `Indeed, ${T}.`,
    `Precisely, ${T}.`,
    `Noted, ${T}. What else?`,
    `Fair point, ${T}. Anything else you want to work through?`,
  ]);
}

// ── INTENT DETECTOR — semantic, not regex-based ───────────────
const CONVERSATIONAL_INTENTS = [
  { id: "greeting",    tokens: ["hello","hi","hey","morning","afternoon","evening","howdy","greetings"], threshold: 1 },
  { id: "farewell",    tokens: ["bye","goodbye","later","farewell","night","signing","see you"], threshold: 1 },
  { id: "thanks",      tokens: ["thank","thanks","cheers","appreciated","grateful"], threshold: 1 },
  { id: "how_are_you", tokens: ["how","are","doing","feeling","alright","okay","you"], threshold: 2 },
  { id: "who_are_you", tokens: ["who","what","are","yourself","name","called","jarvis"], threshold: 2 },
  { id: "compliment",  tokens: ["great","amazing","awesome","brilliant","smart","fantastic","best","well","done"], threshold: 2 },
  { id: "insult",      tokens: ["stupid","dumb","useless","terrible","hate","worst","suck","awful"], threshold: 1 },
  { id: "capabilities",tokens: ["what","can","do","abilities","capabilities","features","help"], threshold: 2 },
];

function detectConversationalIntent(text) {
  const tokens = new Set(tokenize(text));
  // Short text is likely conversational
  if (text.trim().split(/\s+/).length <= 3) {
    for (const intent of CONVERSATIONAL_INTENTS) {
      const hits = intent.tokens.filter(t => tokens.has(t)).length;
      if (hits >= intent.threshold) return intent.id;
    }
  }
  for (const intent of CONVERSATIONAL_INTENTS) {
    const hits = intent.tokens.filter(t => tokens.has(t)).length;
    if (hits >= intent.threshold + 1) return intent.id; // require stronger signal for longer text
  }
  return null;
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
      else if (n >= 1000) acc = (acc||1) * n;
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
    s = s.replace(/^(what|what's|calculate|compute|solve|tell me|give me|jarvis)\s+/gi,"");
    s = s.replace(/[?!\.]+$/,"").trim();
    s = wordsToNumber(s);
    s = s.replace(/(\d+\.?\d*)\s*%\s*of\s*(\d+\.?\d*)/gi,"($1/100*$2)");
    s = s.replace(/(\d+\.?\d*)\s*percent\s+of\s*(\d+\.?\d*)/gi,"($1/100*$2)");
    s = s.replace(/\bsquared\b/gi,"**2").replace(/\bcubed\b/gi,"**3");
    s = s.replace(/\bto the power of\b|\braised to\b/gi,"**");
    s = s.replace(/\bsquare root of\b|\bsqrt of\b|\broot of\b/gi,"Math.sqrt(PLACEHOLDER)");
    s = s.replace(/\bfactorial of\b|\bfactorial\b/gi,"factorial(PLACEHOLDER)");
    s = s.replace(/\bsine? of\b|\bsin\b/gi,"Math.sin(");
    s = s.replace(/\bcosine? of\b|\bcos\b/gi,"Math.cos(");
    s = s.replace(/\btangent of\b|\btan\b/gi,"Math.tan(");
    s = s.replace(/\blog of\b|\blogarithm of\b/gi,"Math.log10(");
    s = s.replace(/\bnatural log of\b|\bln of\b/gi,"Math.log(");
    s = s.replace(/\babs(?:olute)? (?:value )?of\b/gi,"Math.abs(");
    s = s.replace(/\btimes\b|\bmultiplied by\b/gi,"*");
    s = s.replace(/\bdivided by\b|\bover\b|\bdiv\b/gi,"/");
    s = s.replace(/\bplus\b|\badded to\b/gi,"+");
    s = s.replace(/\bminus\b|\bsubtracted from\b|\bless\b/gi,"-");
    s = s.replace(/\bmod(?:ulo)?\b/gi,"%");
    s = s.replace(/\^/g,"**");
    s = s.replace(/\bpi\b/gi,"Math.PI");
    s = s.replace(/Math\.sqrt\(PLACEHOLDER\)\s*(\d+\.?\d*)/g,"Math.sqrt($1)");
    s = s.replace(/Math\.sqrt\(PLACEHOLDER\)/g,"Math.sqrt(");
    s = s.replace(/factorial\(PLACEHOLDER\)\s*(\d+)/g,"factorial($1)");
    s = s.replace(/factorial\(PLACEHOLDER\)/g,"factorial(");
    ["Math.sqrt(","Math.sin(","Math.cos(","Math.tan(","Math.log10(","Math.log(","Math.abs(","factorial("].forEach(fn => {
      const opens  = (s.match(new RegExp(fn.replace(".","\.").replace("(","\\("),"g"))||[]).length;
      const closes = (s.match(/\)/g)||[]).length;
      if (opens > closes) s += ")".repeat(opens - closes);
    });
    const exprMatch = s.match(/[Math\.PI\w\(\)\d\s\+\-\*\/\.\%\*]+/);
    if (!exprMatch) return null;
    let raw = exprMatch[0].trim();
    if (!raw || !/\d/.test(raw)) return null;
    if (/[^0-9\s\+\-\*\/\.\(\)\%MathsqrlogPIEabsinfactorial]/.test(raw)) return null;
    function factorial(n) { n = Math.floor(Math.abs(n)); if (n > 20) return NaN; let r=1; for(let i=2;i<=n;i++) r*=i; return r; }
    // eslint-disable-next-line no-new-func
    const result = Function("factorial","Math",`"use strict"; return (${raw})`)(factorial, Math);
    if (typeof result !== "number" || !isFinite(result)) return null;
    return Number.isInteger(result) ? result : parseFloat(result.toFixed(6));
  } catch { return null; }
}
function isMathQuery(text) {
  return /[\d]+\s*[\+\-\*\/\^%]\s*[\d]+/.test(text) ||
    /\b(calculate|compute|solve|square root|sqrt|factorial|percent of)\b.*\d/i.test(text) ||
    /\bwhat(?:'s| is)\b.*\d.*[\+\-\*\/\^%\d]/.test(text);
}

// ── TIME / DATE ───────────────────────────────────────────────
function isTimeQuery(text) { return /\bwhat(?:'s| is) the time\b|\bwhat time is it\b|\bcurrent time\b/i.test(text); }
function isDateQuery(text) { return /\bwhat(?:'s| is) (?:today|the date)\b|\bwhat day is\b|\btoday'?s date\b/i.test(text); }

// ── CONTEXT TRACKER ───────────────────────────────────────────
class ConversationContext {
  constructor(sessionId) {
    this.sessionId    = sessionId;
    this.history      = [];        // {role, text, tokens, intent, topic, entities}
    this.lastReply    = "";
    this.lastTopic    = null;
    this.lastEntities = {};
    this.turnCount    = 0;
    this.userName     = "";
    this.userTitle    = "Sir";
    this.memories     = [];
    this.mood         = "neutral";
    this.openTopics   = [];        // topics being discussed across turns
  }

  // Resolve pronouns / implicit references
  resolveReferences(text) {
    const lower = text.toLowerCase().trim();
    // "tell me more" / "explain further" → expand on last topic
    if (/^(tell me more|elaborate|go on|expand|more on that|continue|and\??)$/i.test(lower)) {
      return this.lastTopic ? `tell me more about ${this.lastTopic}` : text;
    }
    // "what about X" where context is loaded
    const whatAbout = lower.match(/^what about\s+(.+)/i);
    if (whatAbout && this.lastTopic) {
      return `${whatAbout[1]} in the context of ${this.lastTopic}`;
    }
    // "how does it work" → "how does [last thing] work"
    if (/\bit\b|\bthis\b|\bthat\b/.test(lower) && this.lastTopic) {
      return text.replace(/\bit\b|\bthis\b|\bthat\b/gi, this.lastTopic);
    }
    return text;
  }

  addTurn(userText, replyText, intent, topic, entities) {
    this.history.push({
      role: "user",
      text: userText,
      tokens: tokenize(userText),
      intent,
      topic,
      entities,
    });
    this.history.push({
      role: "assistant",
      text: replyText,
    });
    if (this.history.length > 40) this.history = this.history.slice(-40);
    this.lastReply    = replyText;
    this.lastTopic    = topic;
    this.lastEntities = entities || {};
    this.turnCount++;
    if (topic && !this.openTopics.includes(topic)) {
      this.openTopics.unshift(topic);
      if (this.openTopics.length > 5) this.openTopics.pop();
    }
  }
}

// ── FALLBACK BUILDER ─────────────────────────────────────────
function buildFallback(input, qAnalysis, ctx) {
  const T = ctx.userTitle || "Sir";
  const tokens = tokenize(input).filter(t => t.length > 3);
  const focus = tokens.slice(0,3).join(", ");

  if (qAnalysis.type === "question") {
    return pick([
      `That's a question that goes beyond my current knowledge base, ${T}. I can reason about ${focus || "many things"}, but I'd rather tell you I don't know than construct a confident-sounding guess.`,
      `I don't have a solid foundation on ${focus || "that specific topic"} to give you a trustworthy answer, ${T}. What I can tell you is that the question itself is well-formed — it's just at the edge of what I know.`,
      `My knowledge on ${focus || "that"} is thinner than I'd like, ${T}. Can you narrow it down or give me a different angle? I'd rather be precise on a subset than vague across the whole thing.`,
    ]);
  }

  return pick([
    `I'm processing that, ${T}, but I'm not finding a clear handle on it. Could you rephrase or give me more context?`,
    `That's sitting just outside what I can work with confidently, ${T}. What's the specific thing you're trying to figure out?`,
    `Interesting direction, ${T}. I don't have enough to work with there — but give me a more specific question and I'll give you a much sharper answer.`,
  ]);
}

// ══════════════════════════════════════════════════════════════
// ── MAIN PROCESS FUNCTION ────────────────────────────────────
// ══════════════════════════════════════════════════════════════
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, new ConversationContext(id));
  return sessions.get(id);
}

function process({ message, sessionId, userName, userTitle, memories, moodContext }) {
  const ctx       = getSession(sessionId);
  ctx.userName    = userName  || ctx.userName;
  ctx.userTitle   = userTitle || ctx.userTitle;
  ctx.memories    = memories  || ctx.memories;
  const T         = ctx.userTitle || "Sir";

  // ── 1. Reference resolution
  const resolved  = ctx.resolveReferences(message);

  // ── 2. Fast time/date/math
  if (isTimeQuery(resolved)) {
    const t = new Date().toLocaleTimeString("en-GB",{ hour:"2-digit", minute:"2-digit", hour12:true });
    const reply = pick([`The time is ${t}, ${T}.`, `It's ${t}, ${T}. Time waits for no one.`, `${t}, ${T}.`]);
    ctx.addTurn(message, reply, "datetime_time", null, {});
    return { reply, intent: "datetime_time" };
  }
  if (isDateQuery(resolved)) {
    const d = new Date().toLocaleDateString("en-GB",{ weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const reply = pick([`Today is ${d}, ${T}.`, `It's ${d}, ${T}.`]);
    ctx.addTurn(message, reply, "datetime_date", null, {});
    return { reply, intent: "datetime_date" };
  }
  if (isMathQuery(resolved)) {
    const result = solveMath(resolved);
    if (result !== null) {
      const reply = pick([`That comes to ${result}, ${T}.`, `The answer is ${result}, ${T}.`, `${result}, ${T}. Calculated instantly.`]);
      ctx.addTurn(message, reply, "math", "mathematics", {});
      return { reply, intent: "math" };
    }
  }

  // ── 3. Conversational intent check
  const convIntent = detectConversationalIntent(resolved);
  if (convIntent) {
    const reply = handleConversational(convIntent, resolved, ctx);
    ctx.addTurn(message, reply, convIntent, null, {});
    return { reply, intent: convIntent };
  }

  // ── 4. Deep analysis
  const qAnalysis   = analyzeQuestion(resolved);
  const entities    = extractEntities(resolved);
  const topicResult = classifyTopic(resolved);
  const knowledge   = findKnowledge(resolved);

  // ── 5. Memory query
  if (/\b(what do you remember|recall|my memories|saved facts|what.*you know about me)\b/i.test(resolved)) {
    if (ctx.memories && ctx.memories.length) {
      const list = ctx.memories.map((m,i) => `${i+1}. ${m}`).join("; ");
      const reply = `I have ${ctx.memories.length} item${ctx.memories.length>1?"s":""} on file for you, ${T}: ${list}`;
      ctx.addTurn(message, reply, "memory_query", null, {});
      return { reply, intent: "memory_query" };
    }
    const reply = `My memory banks are empty for you at the moment, ${T}. Tell me something worth remembering.`;
    ctx.addTurn(message, reply, "memory_query", null, {});
    return { reply, intent: "memory_query" };
  }

  // ── 6. Personal question
  if (qAnalysis.isPersonal || topicResult.primary === "personal") {
    const reply = handlePersonal(resolved, ctx);
    ctx.addTurn(message, reply, "personal", "personal", entities);
    return { reply, intent: "personal" };
  }

  // ── 7. Opinion request
  if (qAnalysis.isOpinion) {
    const reply = handleOpinion(resolved, qAnalysis, topicResult, ctx);
    ctx.addTurn(message, reply, "opinion", topicResult.primary, entities);
    return { reply, intent: "opinion" };
  }

  // ── 8. Hypothetical
  if (qAnalysis.isHypothetical) {
    const reply = handleHypothetical(resolved, ctx);
    ctx.addTurn(message, reply, "hypothetical", topicResult.primary, entities);
    return { reply, intent: "hypothetical" };
  }

  // ── 9. Main reasoning pass
  const reasoned = reasonAbout(qAnalysis, topicResult, knowledge, resolved, ctx);
  if (reasoned) {
    const topic = knowledge ? knowledge.key : topicResult.primary;
    ctx.addTurn(message, reasoned, "reasoned", topic, entities);
    return { reply: reasoned, intent: "reasoned" };
  }

  // ── 10. Fallback
  const reply = buildFallback(resolved, qAnalysis, ctx);
  ctx.addTurn(message, reply, "fallback", topicResult.primary, entities);
  return { reply, intent: "fallback" };
}

// Session cleanup — 2hr
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, ctx] of sessions) {
    if (ctx._lastActive && ctx._lastActive < cutoff) sessions.delete(id);
  }
}, 600000);

module.exports = { process, classifyTopic, analyzeQuestion, findKnowledge };
