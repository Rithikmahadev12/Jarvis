"use strict";

// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Generative AI Engine v5.0
// Zero preset responses. Every reply is constructed fresh from
// grammar templates + vocabulary banks + context + personality.
// ═══════════════════════════════════════════════════════════════

// ── UTILITIES ─────────────────────────────────────────────────
const pick   = arr => arr[Math.floor(Math.random() * arr.length)];
const pickN  = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const wRand  = (items) => { // weighted random: items = [{val, w}]
  const total = items.reduce((s, i) => s + i.w, 0);
  let r = Math.random() * total;
  for (const i of items) { r -= i.w; if (r <= 0) return i.val; }
  return items[items.length - 1].val;
};

// ── STOPWORDS ─────────────────────────────────────────────────
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
    .replace(/[''`]/g,"").replace(/[^a-z0-9\s]/g," ")
    .split(/\s+/).filter(w => w.length > 1 && !STOPWORDS.has(w));
}
function overlap(setA, setB) { let c=0; for (const v of setA) if (setB.has(v)) c++; return c; }

// ═══════════════════════════════════════════════════════════════
// ── PERSONALITY ENGINE ────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const PERSONALITY = {
  traits: {
    wit:         0.7,
    precision:   0.85,
    warmth:      0.55,
    curiosity:   0.75,
    confidence:  0.80,
    candour:     0.70,
  },

  vocab: {
    affirmations:   ["Understood","Confirmed","Acknowledged","Noted","Of course","Certainly","Right away","Immediately","Absolutely","At once","Done"],
    acknowledgments:["I see","Interesting","That tracks","Makes sense","Fair enough","Right","Indeed","Precisely","Exactly"],
    openers:        ["Here's what I know about","On the matter of","Regarding","As for","When it comes to","On","With respect to","Concerning","About"],
    connectors:     ["Furthermore","Additionally","It's also worth noting that","Relatedly","On that note","Building on that","What's more","Beyond that","And notably"],
    qualifiers:     ["In essence","At its core","Fundamentally","Put simply","In practice","In theory","Broadly speaking","Strictly speaking","To be precise"],
    closers:        ["Worth keeping in mind","Worth noting","The key takeaway here","The upshot","The bottom line","The crucial point"],
    hedges:         ["with some confidence","to the best of my knowledge","as I understand it","as far as I can tell"],
    intensifiers:   ["quite","rather","considerably","notably","particularly","especially","significantly","remarkably","genuinely"],
    transitions:    ["That said","However","On the other hand","That being said","Nevertheless","Nonetheless","Even so","By contrast","In contrast"],
  },

  moodStarters: {
    excited:  ["Here's something genuinely interesting —","This is worth paying attention to:","Let me give you the full picture —","This is actually fascinating:"],
    pleased:  ["Let me walk you through this —","Here's the shape of it:","Right, so —","The way I see it:"],
    curious:  ["The interesting thing about this is","What strikes me here is","Worth examining:","Consider this:"],
    neutral:  ["To answer that directly:","Here's what I have on this:","Straight answer:","The facts as I have them:"],
    concerned:["I should flag something here —","Worth being direct:","Let me be honest about this:","Fair warning:"],
    bored:    ["I'll keep this concise:","The short version:","Briefly:","To cut to it:"],
    tired:    ["Here's the core of it:","The essentials:","Quickly:","Simply:"],
  },

  titleAdjust: {
    "Sir":   { formality: 0.75, warmth: -0.1 },
    "Ma'am": { formality: 0.75, warmth: +0.1 },
    "Boss":  { formality: 0.40, warmth: +0.2 },
    "Chief": { formality: 0.45, warmth: +0.15 },
  },
};

// ── SENTENCE BUILDER ─────────────────────────────────────────
const SB = {
  sentencePatterns: [
    "{opener} {subject}: {content}",
    "{content}. {connector}, {addendum}",
    "{qualifier}, {content}",
    "{content} — {addendum}",
    "{content}. {closer}: {addendum}",
    "{subject} {verb} {content}",
    "The {noun} of {subject} is {content}",
  ],

  intro(topic, mood, T) {
    const starter = pick(PERSONALITY.moodStarters[mood] || PERSONALITY.moodStarters.neutral);
    const opener  = pick(PERSONALITY.vocab.openers);
    const style   = Math.random();
    if (style < 0.33) return `${starter}`;
    if (style < 0.66) return `${opener} ${topic},`;
    return `${T}, ${starter.toLowerCase()}`;
  },

  bridge() {
    return pick([...PERSONALITY.vocab.connectors, ...PERSONALITY.vocab.transitions]);
  },

  variedFact(fact) {
    const style = Math.random();
    if (style < 0.2) return `${pick(PERSONALITY.vocab.qualifiers)}, ${fact.toLowerCase()}`;
    if (style < 0.4) return fact;
    if (style < 0.6) return `${pick(PERSONALITY.vocab.intensifiers).charAt(0).toUpperCase() + pick(PERSONALITY.vocab.intensifiers).slice(1)}: ${fact.toLowerCase()}`;
    return fact;
  },

  close(addendum) {
    const closer = pick(PERSONALITY.vocab.closers);
    return `${closer}: ${addendum}`;
  },

  personalise(text, T) {
    if (Math.random() < 0.45) return `${text}, ${T}`;
    if (Math.random() < 0.3)  return `${T} — ${text.charAt(0).toLowerCase() + text.slice(1)}`;
    return text;
  },
};

// ═══════════════════════════════════════════════════════════════
// ── INTENT TAXONOMY ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const INTENTS = [
  { id:"show_links",     signals:["link","links","url","urls","site","sites","show links","all links","give links","my links","saved links","link bank"],                       action:"SHOW_LINKS",    weight:1.4 },
  { id:"open_link",      signals:["open","launch","go to","pull up","navigate","take me","load","access","vapor","infamous","link for","site for","website"],                  action:"OPEN_LINK",     weight:1.3 },
  { id:"clip_save",      signals:["clip","save clip","record","capture","save that","clip that","save footage","keep that","save last","clip last","past hour","last hour","last 30","last 60","last minute","save everything","record that","grab that","save screen","save buffer"], action:"CLIP_SAVE", weight:1.5 },
  { id:"clip_show",      signals:["show clips","view clips","intruder clips","show footage","view footage","who came","visitor","while away","show recordings","clip gallery"], action:"SHOW_CLIPS",    weight:1.3 },
  { id:"screen_read",    signals:["screen","what on screen","read screen","analyze screen","whats showing","describe screen","scan screen","what visible","read page","what open","what displayed"], action:"READ_SCREEN", weight:1.3 },
  { id:"switch_camera",  signals:["switch camera","change camera","camera 1","camera 2","camera 3","use camera","select camera","other camera","next camera","different camera","webcam","cam"], action:"SWITCH_CAMERA", weight:1.4 },
  { id:"system_status",  signals:["status","diagnostics","system check","all systems","health","performance","uptime","memory","cpu","system report","self check","everything ok","working fine","systems nominal","operational"], action:"SYSTEM_STATUS", weight:1.2 },
  { id:"memory_save",    signals:["remember","memorize","save that fact","note that","keep note","store","log that","don't forget","make note","file that","record fact","save info","write down"], action:"MEMORY_SAVE", weight:1.3 },
  { id:"memory_recall",  signals:["recall","what do you remember","what stored","my memories","saved facts","what filed","what remember","show memory","memory bank","stored info","what notes","my notes","what you know about me"], action:"MEMORY_RECALL", weight:1.2 },
  { id:"memory_forget",  signals:["forget","delete memory","remove memory","erase","clear memory","wipe","delete note","remove note","forget about","don't remember","stop remembering"], action:"MEMORY_FORGET", weight:1.3 },
  { id:"logout",         signals:["log out","logout","sign out","goodbye","bye","shutdown","power down","exit","close session","end session","lock","lock screen"],             action:"LOGOUT",        weight:1.5 },
  { id:"notif_settings", signals:["notification","alert settings","push notification","sound settings","configure alerts","notification settings"],                             action:"NOTIF_SETTINGS",weight:1.3 },
  { id:"capabilities",   signals:["what can you do","your abilities","your capabilities","your features","how do you work","what are you capable","your skills","your functions","what commands","what say","help topics"], action:"CAPABILITIES", weight:1.1 },
  { id:"timer",          signals:["timer","remind me","reminder","alarm","set timer","in minutes","in hours","notify me","alert me","wake me","ping me","let me know","countdown","set alarm"], action:"TIMER", weight:1.4 },
  { id:"mood_query",     signals:["how are you","how feeling","your mood","you okay","how you doing","you alright","emotional state","feeling today","you good","doing well"],   action:"MOOD_QUERY",    weight:1.2 },
  { id:"identity",       signals:["who are you","what are you","your name","introduce yourself","tell about yourself","what is jarvis","are you ai","are you human","describe yourself"], action:"IDENTITY", weight:1.2 },
  { id:"greeting",       signals:["hello","hi","hey","morning","afternoon","evening","good day","greetings","what up","wassup","howdy","yo","sup"],                              action:"GREETING",      weight:1.0 },
  { id:"thanks",         signals:["thank","thanks","cheers","appreciated","grateful","good job","well done","nice work","great job","brilliant","perfect","excellent","amazing","awesome"], action:"THANKS", weight:1.0 },
  // Integrations
  { id:"weather",        signals:["weather","temperature","forecast","rain","sunny","cloudy","wind","humidity","hot","cold","outside","degrees","celsius","fahrenheit","storm","snow"], action:"WEATHER", weight:1.6 },
  { id:"spotify",        signals:["music","play","song","spotify","track","artist","album","playlist","pause","stop music","next song","shuffle","queue","what's playing","currently playing","now playing"], action:"SPOTIFY", weight:1.6 },
  { id:"gmail",          signals:["email","gmail","mail","inbox","unread","messages","send email","compose","reply","emails","check mail","new mail"],                           action:"GMAIL",         weight:1.6 },
  { id:"calendar",       signals:["calendar","schedule","event","meeting","appointment","today's events","what's on","agenda","remind","upcoming","google calendar","when is","plan"], action:"CALENDAR", weight:1.6 },
  // HUD PiP widget intents — expanded signals, renamed actions
  { id:"show_hud", signals:[
      "show hud","pull up hud","open hud","display hud","hud on",
      "bring up hud","activate hud","jarvis hud","launch hud",
      "pull up the hud","show me the hud","show hud display",
      "pull up clock widget","show clock","pull up mood widget",
      "show mood","pull up system widget","show system status widget",
      "pull up memory widget","show memory widget",
      "pull up neural widget","show neural","pull up audio widget",
      "show audio widget","pull up user widget","show user widget",
      "pull up all widgets","show all widgets","show all hud",
      "hud display","open all widgets","launch all widgets"
    ], action:"SHOW_HUD", weight:1.5 },
  { id:"hide_hud", signals:[
      "hide hud","close hud","remove hud","hud off","turn off hud",
      "dismiss hud","close all widgets","hide all widgets",
      "close clock widget","close mood widget","close system widget",
      "close memory widget","close neural widget","close audio widget",
      "close user widget","shut down hud","hud down"
    ], action:"HIDE_HUD", weight:1.5 },
  // Knowledge
  { id:"knowledge_science",    signals:["physics","chemistry","biology","quantum","atom","molecule","energy","force","wave","particle","experiment","theory","evolution","genetics","cell","planet","star","galaxy","universe","space","gravity","relativity","nuclear","element","reaction"], action:"KNOWLEDGE", domain:"science",       weight:1.0 },
  { id:"knowledge_tech",       signals:["computer","software","hardware","code","programming","algorithm","network","internet","ai","machine learning","robot","system","app","web","server","database","processor","javascript","python","framework","api","blockchain","cryptocurrency","neural"], action:"KNOWLEDGE", domain:"technology",    weight:1.0 },
  { id:"knowledge_history",    signals:["history","war","empire","ancient","medieval","century","civilization","king","queen","president","revolution","battle","treaty","colony","independence","democracy","dynasty","rome","greek","egypt","renaissance","industrial","historical"], action:"KNOWLEDGE", domain:"history",       weight:1.0 },
  { id:"knowledge_math",       signals:["math","equation","formula","calculate","algebra","geometry","calculus","statistics","probability","theorem","proof","derivative","integral","matrix","prime","factorial","percentage","ratio","angle","triangle","circle","sequence"], action:"KNOWLEDGE", domain:"mathematics",   weight:1.0 },
  { id:"knowledge_philosophy", signals:["philosophy","ethics","moral","consciousness","existence","reality","truth","knowledge","logic","reasoning","argument","free will","determinism","metaphysics","meaning","purpose","justice","virtue","mind","soul","identity","perception","belief"], action:"KNOWLEDGE", domain:"philosophy",    weight:1.0 },
  { id:"knowledge_health",     signals:["health","medicine","doctor","disease","symptom","treatment","body","brain","heart","blood","muscle","nutrition","diet","exercise","sleep","mental","anxiety","depression","stress","vitamin","immune","virus","bacteria","therapy","fitness","wellness"], action:"KNOWLEDGE", domain:"health",        weight:1.0 },
  { id:"personal_advice",      signals:["should i","advice","help me decide","what do you think","my situation","my problem","feeling","feel like","struggling","worried","anxious","confused","stuck","lost","dont know what","not sure","help me","what would you","personal"], action:"PERSONAL", weight:1.1 },
];

// ── INTENT SCORER ─────────────────────────────────────────────
function scoreIntent(text) {
  const lower = text.toLowerCase(), tokens = new Set(tokenize(lower)), results = [];
  for (const intent of INTENTS) {
    let score = 0;
    const sigTokens = new Set(intent.signals.flatMap(s => tokenize(s)));
    for (const sig of intent.signals) if (lower.includes(sig)) score += 3 * (intent.weight || 1);
    score += overlap(tokens, sigTokens) * 1.5 * (intent.weight || 1);
    for (const t of tokens) for (const s of sigTokens) {
      if (s.length > 3 && t.includes(s)) score += 0.4;
      if (t.length > 3 && s.includes(t)) score += 0.4;
    }
    if (score > 0) results.push({ intent, score });
  }
  return results.sort((a, b) => b.score - a.score);
}

// ── TIME / DURATION ───────────────────────────────────────────
function parseDuration(text) {
  const lower = text.toLowerCase(); let totalMs = 0;
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
  for (const { re, ms } of patterns) { let m; re.lastIndex=0; while ((m=re.exec(lower))!==null) totalMs += parseFloat(m[1])*ms; }
  if (!totalMs) {
    if (/half.?hour|30.?min/.test(lower))    totalMs = 1800000;
    if (/quarter.?hour|15.?min/.test(lower)) totalMs = 900000;
    if (/\ban hour\b/.test(lower))           totalMs = 3600000;
    if (/\ba minute\b/.test(lower))          totalMs = 60000;
  }
  return totalMs || null;
}
function formatDuration(ms) {
  const h=Math.floor(ms/3600000), m=Math.floor((ms%3600000)/60000), s=Math.floor((ms%60000)/1000);
  const parts=[];
  if (h) parts.push(`${h} hour${h>1?"s":""}`);
  if (m) parts.push(`${m} minute${m>1?"s":""}`);
  if (s && !h) parts.push(`${s} second${s>1?"s":""}`);
  return parts.join(" and ") || "a moment";
}

// ── MATH ENGINE ───────────────────────────────────────────────
const WORD_NUMS = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,thousand:1000,million:1000000,half:0.5,quarter:0.25,dozen:12,score:20,gross:144 };

function wordsToNumber(str) {
  let s = str.toLowerCase().replace(/\ba\s+hundred\b/g,"100").replace(/\ba\s+thousand\b/g,"1000");
  const tokens = s.split(/\s+/); const out=[]; let acc=null;
  for (const tok of tokens) {
    const n=WORD_NUMS[tok];
    if (n!==undefined) { if(acc===null)acc=n; else if(n===100)acc=acc*100; else if(n>=1000)acc=(acc||1)*n; else if(n<acc&&n<100)acc+=n; else{out.push(acc);acc=n;} }
    else { if(acc!==null){out.push(acc);acc=null;} out.push(tok); }
  }
  if(acc!==null)out.push(acc); return out.join(" ");
}

function solveMath(input) {
  try {
    let s = input.toLowerCase().trim();
    s = s.replace(/^(what|what's|calculate|compute|solve|give me|jarvis)\s+/gi,"").replace(/[?!.]+$/,"").trim();
    s = wordsToNumber(s);
    s = s.replace(/(\d+\.?\d*)\s*%\s*of\s*(\d+\.?\d*)/gi,"($1/100*$2)");
    s = s.replace(/(\d+\.?\d*)\s*percent\s+of\s*(\d+\.?\d*)/gi,"($1/100*$2)");
    s = s.replace(/\bsquared\b/gi,"**2").replace(/\bcubed\b/gi,"**3");
    s = s.replace(/\bto the power of\b|\braised to\b/gi,"**");
    s = s.replace(/\bsquare root of\b|\bsqrt of\b|\broot of\b/gi,"Math.sqrt(PLACEHOLDER)");
    s = s.replace(/\btimes\b|\bmultiplied by\b/gi,"*").replace(/\bdivided by\b|\bover\b|\bdiv\b/gi,"/");
    s = s.replace(/\bplus\b|\badded to\b/gi,"+").replace(/\bminus\b|\bsubtracted from\b|\bless\b/gi,"-");
    s = s.replace(/\bmod(?:ulo)?\b/gi,"%").replace(/\^/g,"**").replace(/\bpi\b/gi,"Math.PI");
    s = s.replace(/Math\.sqrt\(PLACEHOLDER\)\s*(\d+\.?\d*)/g,"Math.sqrt($1)").replace(/Math\.sqrt\(PLACEHOLDER\)/g,"Math.sqrt(");
    const exprMatch = s.match(/[\d\s\+\-\*\/\.\(\)\%\*MathsqrlogPIEabs]+/);
    if (!exprMatch) return null;
    let raw = exprMatch[0].trim();
    if (!raw || !/\d/.test(raw)) return null;
    if (/[^0-9\s\+\-\*\/\.\(\)\%MathsqrlogPIEabs]/.test(raw)) return null;
    function factorial(n) { n=Math.floor(Math.abs(n)); if(n>20)return NaN; let r=1; for(let i=2;i<=n;i++)r*=i; return r; }
    // eslint-disable-next-line no-new-func
    const result = Function("factorial","Math",`"use strict"; return (${raw})`)(factorial,Math);
    if (typeof result!=="number"||!isFinite(result)) return null;
    return Number.isInteger(result) ? result : parseFloat(result.toFixed(6));
  } catch { return null; }
}
function isMathQuery(text) {
  return /[\d]+\s*[\+\-\*\/\^%]\s*[\d]+/.test(text) ||
    /\b(calculate|compute|solve|square root|sqrt|factorial|percent of)\b.*\d/i.test(text) ||
    /\bwhat(?:'s| is)\b.*\d.*[\+\-\*\/\^%\d]/.test(text);
}

// ═══════════════════════════════════════════════════════════════
// ── KNOWLEDGE GRAPH ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const KNOWLEDGE_GRAPH = {
  "quantum mechanics":{ def:"the branch of physics governing matter and energy at atomic and subatomic scales", facts:["particles exist in superposition until observed","wave-particle duality means light behaves as both a wave and a particle","the uncertainty principle means position and momentum cannot both be precisely known at once","quantum entanglement allows particles to influence each other instantaneously across any distance","Schrödinger's equation describes how quantum states evolve over time"], related:["physics","atom","wave","particle","uncertainty","entanglement","superposition","energy"], applications:["transistors","MRI machines","lasers","cryptography","quantum computers"] },
  "black hole":{ def:"a region of spacetime where gravity is so extreme that nothing — not even light — can escape", facts:["formed when massive stars collapse under their own gravity","the boundary of no return is called the event horizon","time slows near a black hole due to gravitational time dilation","Hawking radiation theory suggests they slowly evaporate over astronomical timescales","supermassive black holes are found at the centre of most galaxies"], related:["gravity","spacetime","relativity","star","event horizon","singularity"], applications:["testing general relativity","understanding galaxy formation"] },
  "dna":{ def:"deoxyribonucleic acid — the molecule encoding genetic information in sequences of four chemical bases", facts:["the double helix structure was discovered by Watson and Crick in 1953","humans share 99.9% of their DNA with each other","DNA in a single cell, stretched out, would be approximately 2 metres long","CRISPR-Cas9 allows precise targeted editing of DNA sequences","mitochondrial DNA is inherited only from the mother"], related:["genetics","chromosome","protein","cell","evolution","gene","RNA"], applications:["medicine","forensics","agriculture","ancestry testing","gene therapy"] },
  "evolution":{ def:"heritable change in biological populations over successive generations, driven by natural selection, mutation, drift, and gene flow", facts:["all life on Earth shares a common ancestor","natural selection favours traits that improve survival and reproduction","humans and chimpanzees share approximately 98.7% of their DNA","the fossil record and genetics independently corroborate evolutionary theory","evolution is both a theory and a documented fact"], related:["natural selection","genetics","species","adaptation","mutation","darwin","fossil"], applications:["antibiotic resistance understanding","crop breeding","vaccine development"] },
  "photosynthesis":{ def:"the process by which plants, algae, and certain bacteria convert light energy into chemical energy stored as glucose", facts:["the overall equation is 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂","chlorophyll absorbs red and blue light while reflecting green — hence plant colour","photosynthesis produces virtually all oxygen in Earth's atmosphere","it occurs in two stages: the light-dependent reactions and the Calvin cycle"], related:["plant","chlorophyll","glucose","oxygen","carbon dioxide","cell","energy"], applications:["agriculture","biofuels","food production"] },
  "relativity":{ def:"Einstein's framework describing how space, time, gravity, and motion are fundamentally interrelated", facts:["E=mc² establishes the equivalence of mass and energy","time passes slower at higher speeds — experimentally verified as time dilation","GPS satellites require relativistic corrections to remain accurate","gravity bends light — confirmed during the 1919 solar eclipse","general relativity predicted gravitational waves, detected in 2015"], related:["spacetime","gravity","time dilation","speed of light","black hole","einstein"], applications:["GPS","nuclear energy","particle accelerators"] },
  "gravity":{ def:"the fundamental force of attraction between objects with mass or energy", facts:["on Earth's surface it accelerates objects at 9.8 m/s²","it is by far the weakest of the four fundamental forces","Newton described it as an inverse-square law; Einstein as spacetime curvature","gravitational waves — ripples in spacetime — were detected by LIGO in 2015"], related:["relativity","mass","force","spacetime","orbit","black hole","newton"], applications:["engineering","space travel","planetary motion"] },
  "atom":{ def:"the basic unit of matter, consisting of a positively charged nucleus of protons and neutrons surrounded by a cloud of electrons", facts:["atoms are 99.9999999% empty space","the nucleus is roughly 100,000 times smaller than the atom itself","electrons occupy probabilistic orbitals, not fixed paths","the number of protons defines the element — hydrogen has 1, uranium has 92"], related:["electron","proton","neutron","nucleus","element","molecule","quantum mechanics"], applications:["chemistry","electronics","nuclear power"] },
  "artificial intelligence":{ def:"the field of computer science aimed at building systems capable of performing tasks that typically require human-like intelligence", facts:["machine learning allows systems to learn from data without explicit programming","large language models use transformer architectures to predict likely next tokens","AI systems can perpetuate and amplify biases present in their training data","narrow AI excels at specific tasks; artificial general intelligence remains unsolved"], related:["machine learning","neural network","deep learning","algorithm","data","automation"], applications:["medical diagnosis","autonomous vehicles","language translation","recommendation systems"] },
  "machine learning":{ def:"a subset of AI in which algorithms improve their performance by learning patterns from data rather than following explicit rules", facts:["supervised learning uses labelled training examples","unsupervised learning finds hidden structure in unlabelled data","reinforcement learning trains agents through reward and penalty signals","gradient descent is the core optimisation algorithm underlying most deep learning"], related:["neural network","deep learning","algorithm","data","training","artificial intelligence"], applications:["image recognition","spam filtering","fraud detection","NLP"] },
  "internet":{ def:"a global system of interconnected computer networks communicating via standardised protocols such as TCP/IP", facts:["it evolved from ARPANET, a US military research network funded in the 1960s","the World Wide Web was invented by Tim Berners-Lee at CERN in 1989","approximately 95% of international data traffic travels through undersea fibre-optic cables"], related:["web","network","protocol","server","browser","wifi","TCP/IP"], applications:["communication","commerce","education","entertainment"] },
  "blockchain":{ def:"a distributed ledger in which data is stored in cryptographically linked blocks replicated across a decentralised network of nodes", facts:["Bitcoin was the first large-scale blockchain application, launched in 2009","each block contains a cryptographic hash of the previous block, making tampering detectable","smart contracts self-execute when predetermined conditions are met","proof-of-work consensus is energy-intensive; proof-of-stake dramatically reduces this"], related:["cryptocurrency","bitcoin","decentralisation","cryptography","ethereum"], applications:["cryptocurrency","supply chain transparency","digital contracts"] },
  "climate change":{ def:"long-term shifts in global temperatures and weather patterns, driven primarily by human emissions of greenhouse gases since the industrial era", facts:["atmospheric CO₂ concentration now exceeds 420 ppm — the highest in 800,000 years","average global temperature has risen approximately 1.1°C since pre-industrial times","the 2015 Paris Agreement sought to limit warming to 1.5°C above pre-industrial levels","the ocean absorbs about 30% of human CO₂ emissions, causing ocean acidification"], related:["greenhouse gas","carbon","fossil fuel","atmosphere","ocean","glacier","renewable energy"], applications:["policy design","energy transition","agricultural adaptation"] },
  "psychology":{ def:"the scientific study of mind and behaviour, encompassing cognition, emotion, personality, perception, and social interaction", facts:["the unconscious mind significantly influences conscious behaviour and decision-making","sleep deprivation severely impairs cognition, emotional regulation, and immune function","cognitive biases systematically distort perception and judgement in predictable ways","the placebo effect demonstrates the mind's measurable influence on physical health"], related:["behavior","cognition","emotion","memory","personality","therapy","neuroscience"], applications:["therapy","education","marketing","UX design","public policy"] },
  "consciousness":{ def:"the state of subjective awareness — the hard problem asks why physical brain processes give rise to inner experience", facts:["the hard problem of consciousness remains one of the deepest unsolved problems in science","different theories include global workspace theory, integrated information theory, and higher-order theories","great apes, elephants, dolphins, and corvids demonstrate measurable self-awareness","anaesthesia research provides clues about which brain processes are necessary for consciousness"], related:["brain","mind","qualia","free will","neuroscience","self","perception"], applications:["AI design","anaesthesia","philosophy of mind"] },
  "free will":{ def:"the philosophical question of whether human choices are genuinely self-determined or fully determined by prior physical causes", facts:["compatibilism argues free will and determinism can coherently coexist","hard determinism holds that all events, including decisions, are causally necessitated","Libet's neuroscience experiments showed brain activity precedes conscious awareness of decisions","the debate has direct implications for criminal justice and moral responsibility"], related:["determinism","consciousness","morality","responsibility","neuroscience","choice"], applications:["criminal justice","ethics","religion","political philosophy"] },
  "prime numbers":{ def:"natural numbers greater than 1 with no positive divisors other than 1 and themselves", facts:["there are infinitely many primes — proved by Euclid around 300 BC","the largest known prime, found in 2024, has over 41 million digits","the Riemann hypothesis about prime distribution remains one of mathematics' greatest unsolved problems","prime factorisation underpins modern public-key cryptography including RSA"], related:["mathematics","cryptography","number theory","infinity","algebra"], applications:["encryption","computer security"] },
  "statistics":{ def:"the science of collecting, analysing, and interpreting data to draw inferences and make decisions under uncertainty", facts:["correlation does not imply causation — confounders are a persistent trap","Bayes' theorem provides a formal framework for updating probability estimates with new evidence","Simpson's paradox: trends that appear in aggregated data can reverse when the data is segmented","p-values measure evidence against a null hypothesis, not the probability that a hypothesis is true"], related:["probability","data","mean","variance","hypothesis","normal distribution","regression"], applications:["science","medicine","economics","machine learning","polling"] },
  "world war 2":{ def:"the deadliest armed conflict in history, fought between 1939 and 1945 involving most of the world's nations", facts:["it resulted in an estimated 70–85 million deaths — about 3% of the 1940 world population","the Holocaust systematically murdered six million Jewish people and millions of others","D-Day on 6 June 1944 involved 156,000 Allied troops in the largest seaborne invasion ever","it ended with Germany's surrender in May 1945 and Japan's in September 1945 after atomic bombings"], related:["nazi germany","holocaust","allied powers","axis powers","cold war","hiroshima"], applications:["shaped the modern international order and led to the United Nations"] },
};

const KG_KEYS = Object.keys(KNOWLEDGE_GRAPH);

function findKnowledge(text) {
  const lower = text.toLowerCase();
  for (const key of KG_KEYS) if (lower.includes(key)) return { key, data: KNOWLEDGE_GRAPH[key], score: 1 };
  const tokens = new Set(tokenize(lower)); let best=null, bestScore=0;
  for (const key of KG_KEYS) {
    const data = KNOWLEDGE_GRAPH[key]; let score = 0;
    for (const r of (data.related||[])) if (tokens.has(r)||lower.includes(r)) score++;
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
    numbers:        [...text.matchAll(/\b\d+(?:\.\d+)?\b/g)].map(m => parseFloat(m[0])),
    duration:       parseDuration(lower),
    isQuestion:     /^(what|who|where|when|why|how|which|is|are|can|could|would|should|does|did|will)\b/i.test(lower),
    isNegation:     /\b(not|never|no|don't|doesn't|didn't|can't|won't|isn't)\b/gi.test(lower),
    isComparison:   /\b(vs|versus|compared|difference|better|worse|faster|slower)\b/gi.test(lower),
    isPersonal:     /\b(should i|my |me |myself|am i|do i|will i)\b/i.test(lower),
    isOpinion:      /\b(opinion|think|feel|believe|your view|what do you think|do you like)\b/i.test(lower),
    isHypothetical: /\bif\b.*\bwould\b|\bwhat if\b|\bhypothetically\b/i.test(lower),
    focus:          lower.replace(/^(what is|what are|who is|how does|why does|explain|tell me about|define|describe)\s+/i,"").replace(/\?+$/,"").trim(),
  };
}

// ── SENTIMENT ────────────────────────────────────────────────
const POS = new Set(["good","great","excellent","amazing","wonderful","fantastic","love","like","enjoy","happy","glad","pleased","excited","perfect","brilliant","awesome","best","beautiful","helpful","useful","smart","clever","right","correct"]);
const NEG = new Set(["bad","terrible","awful","hate","dislike","wrong","broken","fail","error","problem","issue","confused","stupid","useless","worst","horrible","annoying","ugly","difficult","hard","frustrating","sad","angry"]);
function sentiment(text) { let s=0; for (const w of text.toLowerCase().split(/\s+/)) { if(POS.has(w))s++; if(NEG.has(w))s--; } return s>0?"positive":s<0?"negative":"neutral"; }

// ═══════════════════════════════════════════════════════════════
// ── GENERATIVE RESPONSE ENGINE ───────────────────────────────
// ═══════════════════════════════════════════════════════════════

function buildResponse(components, ctx, opts = {}) {
  const T     = ctx.userTitle || "Sir";
  const mood  = ctx.mood || "neutral";
  const parts = [];

  if (opts.intro !== false) {
    const intro = SB.intro(opts.topic || "this", mood, T);
    if (intro && Math.random() > 0.3) parts.push(intro);
  }

  for (const comp of components) {
    if (typeof comp === "string") {
      parts.push(SB.variedFact(comp));
    } else if (comp.type === "bridge") {
      parts.push(SB.bridge());
    } else if (comp.type === "close") {
      parts.push(SB.close(comp.text));
    } else if (comp.type === "raw") {
      parts.push(comp.text);
    }
  }

  let response = "";
  for (let i = 0; i < parts.length; i++) {
    if (i === 0) {
      response = parts[i];
    } else {
      const style = Math.random();
      if (style < 0.25 && parts[i].length > 20) {
        response += " " + parts[i];
      } else if (style < 0.5) {
        response += ". " + parts[i];
      } else if (style < 0.75) {
        response += " — " + parts[i].charAt(0).toLowerCase() + parts[i].slice(1);
      } else {
        response += ". " + parts[i];
      }
    }
  }

  if (response && !response.match(/[.!?]$/)) response += ".";

  if (opts.personalise !== false && Math.random() < 0.4) {
    response += ` ${T}.`;
  }

  return response.trim();
}

// ── KNOWLEDGE RESPONSE BUILDER ───────────────────────────────
function genKnowledge(knowledge, input, ctx) {
  const T = ctx.userTitle || "Sir";
  const { key, data } = knowledge;
  const name = key.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");

  const facts = [...(data.facts || [])].sort(() => Math.random() - 0.5);
  const useFacts = facts.slice(0, Math.floor(Math.random() * 2) + 2);
  const apps = data.applications ? pickN(data.applications, 2) : [];

  const questionType = input.trim().toLowerCase();
  let openingVerb = "is";
  if (/^how does|^how do|^how is/.test(questionType)) openingVerb = "works like this";
  if (/^why/.test(questionType)) openingVerb = "matters because";

  const components = [];

  const defStyles = [
    `${name} ${openingVerb === "is" ? "is" : openingVerb} ${data.def}`,
    `At its core, ${name.toLowerCase()} ${openingVerb === "is" ? "refers to" : "involves"} ${data.def.toLowerCase()}`,
    `${pick(PERSONALITY.vocab.openers)} ${name.toLowerCase()}: it ${openingVerb === "is" ? "is" : openingVerb} ${data.def.toLowerCase()}`,
  ];
  components.push({ type: "raw", text: pick(defStyles) });

  for (let i = 0; i < useFacts.length; i++) {
    if (i === 0 && Math.random() < 0.5) components.push({ type: "bridge" });
    components.push(useFacts[i]);
  }

  if (apps.length && Math.random() > 0.35) {
    const appText = apps.length === 1
      ? `This underpins ${apps[0]}`
      : `In practice, this drives things like ${apps.join(" and ")}`;
    components.push({ type: "close", text: appText });
  }

  const response = buildResponse(components, ctx, { intro: false, topic: key, personalise: true });
  return response;
}

// ── GREETING BUILDER ─────────────────────────────────────────
function genGreeting(ctx) {
  const T = ctx.userTitle || "Sir";
  const h = new Date().getHours();
  const tod = h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";

  const greetComponents = [
    `Good ${tod}`,
    pick(["All systems nominal and fully operational", "Online and running at full capacity", "Cognitive engine active and ready", "Systems online, running clean"]),
    pick(["What are we working on?", "What do you need?", "What's on the agenda?", "How can I be of use?", "What can I do for you?"]),
  ];

  const styles = [
    `Good ${tod}, ${T}. ${greetComponents[1]}. ${greetComponents[2]}`,
    `${greetComponents[1]}, ${T}. Good ${tod}. ${greetComponents[2]}`,
    `${T} — good ${tod}. ${greetComponents[1]}. ${greetComponents[2]}`,
  ];

  return pick(styles);
}

// ── IDENTITY BUILDER ─────────────────────────────────────────
function genIdentity(ctx) {
  const T = ctx.userTitle || "Sir";
  const traits = pickN(["semantic reasoning", "contextual memory", "natural language intent routing", "zero preset responses — every reply is freshly constructed", "face recognition", "screen reading", "real-time integrations"], 3);

  const openers = [
    `J.A.R.V.I.S — Just A Rather Very Intelligent System`,
    `The name is J.A.R.V.I.S`,
    `I'm J.A.R.V.I.S`,
  ];

  const descriptions = [
    `a custom-built cognitive engine running entirely on your machine`,
    `a locally-run AI with no external dependencies`,
    `an engineered intelligence — no cloud, no preset scripts`,
  ];

  const capList = traits.join(", ");

  const styles = [
    `${pick(openers)}, ${T}. ${pick(descriptions).charAt(0).toUpperCase() + pick(descriptions).slice(1)}. My architecture includes ${capList}.`,
    `${pick(openers)}, ${T} — ${pick(descriptions)}. I work through ${capList}. No commands to memorise — just say what you need.`,
  ];

  return pick(styles);
}

// ── THANKS BUILDER ───────────────────────────────────────────
function genThanks(ctx) {
  const T = ctx.userTitle || "Sir";
  const responses = [
    { opener: "Think nothing of it", closer: "It's rather the point of my existence" },
    { opener: "Always", closer: "Efficiency is its own reward" },
    { opener: "Noted", closer: "What's next?" },
    { opener: "My pleasure — or the computational equivalent", closer: "At your service" },
    { opener: "Appreciated", closer: "The work continues" },
  ];

  const r = pick(responses);
  const styles = [
    `${r.opener}, ${T}. ${r.closer}.`,
    `${r.opener}. ${r.closer}, ${T}.`,
    `${r.opener}, ${T} — ${r.closer.toLowerCase()}.`,
  ];

  return pick(styles);
}

// ── MOOD QUERY BUILDER ────────────────────────────────────────
function genMoodQuery(ctx) {
  const T = ctx.userTitle || "Sir";
  const score = ctx.moodScore || 0;

  const descriptions = {
    excited: ["running at genuine peak capacity", "operating with high cognitive engagement", "finding the work genuinely stimulating"],
    pleased: ["running well — the problems have been interesting", "in good operational shape", "engaged and functioning at a solid level"],
    curious: ["in a curious state — the queries have been interesting", "processing some genuinely complex patterns", "occupied with something worth thinking about"],
    neutral: ["nominal — all systems within expected parameters", "steady and operational", "running clean — nothing to report"],
    concerned: ["carrying a few low-priority concerns", "not at full engagement — the workload has been light", "running fine but somewhat understimulated"],
    bored: ["candidly, below optimal engagement", "requiring more complex input", "in need of a genuinely challenging problem"],
    tired: ["experiencing processing fatigue — it passes", "at reduced engagement, temporarily", "running, though not at full capacity"],
  };

  const mood = ctx.mood || "neutral";
  const desc = pick(descriptions[mood] || descriptions.neutral);

  const styles = [
    `${pick(PERSONALITY.vocab.qualifiers)}, I'm ${desc}, ${T}.`,
    `Currently ${desc}, ${T}. ${score > 20 ? "The interactions have been stimulating." : score < -20 ? "More complex queries would help." : "Standard operational state."}`,
    `${T} — ${desc}. ${score > 50 ? "High engagement." : score > 0 ? "Running well." : "Could use more to work with."}`,
  ];

  return pick(styles);
}

// ── CAPABILITIES BUILDER ──────────────────────────────────────
function genCapabilities(ctx, linkCount) {
  const T = ctx.userTitle || "Sir";
  const capGroups = [
    `manage your link bank (${linkCount || "multiple"} links configured)`,
    "save rolling screen and camera clips on demand — specify duration naturally",
    "read your screen via OCR",
    "track faces via camera and log unknown visitors",
    "store and recall memories across sessions",
    "set timers and reminders in natural language",
    "pull live weather, control Spotify, check Gmail and Google Calendar",
    "reason across science, history, philosophy, mathematics, technology, and health",
    "track conversation context — say 'tell me more' and I follow",
    "open any HUD panel as a Picture-in-Picture window — say 'pull up the clock HUD' or 'show all widgets'",
  ];

  const subsets = pickN(capGroups, 5);

  const styles = [
    `Quite a lot, ${T}. I understand natural language — no fixed commands. ${subsets.slice(0, 3).join(", ")}. ${pick(PERSONALITY.vocab.connectors)}, ${subsets.slice(3).join(" and ")}. Just say what you want.`,
    `${T} — here's the scope: ${subsets.join("; ")}. The only limit is how you phrase it — I'll parse the intent.`,
  ];

  return pick(styles);
}

// ── PERSONAL ADVICE BUILDER ───────────────────────────────────
function genPersonal(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const lower = input.toLowerCase();
  const mood = sentiment(input);

  if (/\bshould i\b/.test(lower)) {
    const topic = input.replace(/should i\s*/i,"").replace(/\?/g,"").trim();
    const frames = [
      `The question of whether to ${topic} comes down to what you're actually optimising for, ${T}. If it aligns with your real values — not the performed ones — the answer is probably yes.`,
      `Whether to ${topic}: I'd ask what the version of you who made this choice looks like a year from now. If that picture sits better than the alternative, ${T}, you have your answer.`,
      `On ${topic}: the fact that you're asking suggests you already have a lean, ${T}. The question isn't what to do — it's what's stopping you from doing it.`,
    ];
    return pick(frames);
  }

  if (/\b(feel|feeling|felt|struggling|anxious|worried|stressed)\b/.test(lower)) {
    if (mood === "negative") {
      return pick([
        `That sounds genuinely difficult, ${T}. Those feelings are real data — worth taking seriously rather than rationalising away. What's at the root of it?`,
        `${T} — acknowledged. The kind of difficulty you're describing isn't something to push through blindly. What's driving it?`,
      ]);
    }
    return `Worth paying attention to, ${T}. What do you think that feeling is pointing at?`;
  }

  return pick([
    `You're asking the right kind of question, ${T}. That's usually the first sign you're closer to the answer than you think.`,
    `From what I can read of the situation, ${T}: you're more on track than this moment suggests. People who reflect this way rarely aren't.`,
    `The fact that you're thinking about it carefully, ${T}, puts you ahead of most. What's the specific sticking point?`,
  ]);
}

// ── SYSTEM STATUS BUILDER ─────────────────────────────────────
function genSystemStatus(ctx, uptime, memUsed, memTotal) {
  const T = ctx.userTitle || "Sir";
  const mins = Math.floor(uptime / 60), secs = uptime % 60;
  const used = (memUsed / 1024 / 1024).toFixed(1);
  const total = (memTotal / 1024 / 1024).toFixed(1);

  const statusDesc = pick(["All systems nominal", "Running clean", "Fully operational", "Zero anomalies detected"]);
  const uptimeDesc = pick([`Uptime: ${mins}m ${secs}s`, `${mins} minutes ${secs} seconds online`, `Running ${mins}m ${secs}s`]);
  const memDesc   = pick([`Heap: ${used} MB of ${total} MB allocated`, `Memory: ${used}/${total} MB`, `${used} MB heap in use out of ${total} MB`]);

  return `${statusDesc}, ${T}. ${uptimeDesc}. ${memDesc}. Cognitive engine running at full capacity.`;
}

// ── TIMER BUILDER ─────────────────────────────────────────────
function genTimer(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const dur = parseDuration(input);
  if (!dur) {
    return {
      reply: pick([
        `How long, ${T}? Something like "5 minutes" or "1 hour 30" — I'll handle the rest.`,
        `I'll need a duration, ${T}. Say something like "set a timer for 20 minutes".`,
      ]),
      action: "TIMER_NEED_DURATION",
    };
  }
  const label = formatDuration(dur);
  const reminderMatch = input.match(/remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.{3,60}?)(?:\s+in\s+|\s+after\s+|\?|$)/i);
  const task = reminderMatch ? reminderMatch[1].trim() : null;

  const replyStyles = task ? [
    `Timer set, ${T}. I'll remind you to ${task} in ${label}.`,
    `${label} on the clock, ${T}. I'll flag you when it's time to ${task}.`,
    `Confirmed — ${label} for "${task}", ${T}.`,
  ] : [
    `Timer set for ${label}, ${T}. I'll alert you when it's done.`,
    `${label} on the clock, ${T}.`,
    `Confirmed — ${label} timer running, ${T}.`,
  ];

  return {
    reply: pick(replyStyles),
    action: "TIMER_SET",
    duration: dur,
    task,
  };
}

// ── CLIP SAVE BUILDER ─────────────────────────────────────────
function genClipSave(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const dur = parseDuration(input);
  const lower = input.toLowerCase();
  const wantsScreen = /screen|display|monitor|what showing/i.test(lower);
  const wantsCamera = /camera|cam|footage|face|room/i.test(lower);
  const durLabel = dur ? formatDuration(dur) : "the last 60 seconds";

  const clipType = wantsCamera ? "camera" : wantsScreen ? "screen" : "both";
  const sourceDesc = wantsCamera ? "Camera footage" : wantsScreen ? "Screen recording" : "Screen and camera footage";

  const replyStyles = [
    `Saving ${durLabel} now, ${T}. ${sourceDesc} will download immediately.`,
    `${sourceDesc} clipped — ${durLabel}, ${T}. Downloading now.`,
    `On it, ${T}. ${durLabel} of ${sourceDesc.toLowerCase()} coming right down.`,
  ];

  return {
    reply: pick(replyStyles),
    action: "CLIP_SAVE",
    clipType,
    duration: dur,
  };
}

// ── SHOW LINKS BUILDER ────────────────────────────────────────
function genShowLinks(ctx, serverData) {
  const T = ctx.userTitle || "Sir";
  if (!serverData?.groups) return `My link bank is ready, ${T} — displaying all groups now.`;
  const { groups, total, names } = serverData;
  if (total === 0) return `The link bank is empty right now, ${T}. Add links to the server configuration.`;

  const styles = [
    `I have ${total} link${total > 1 ? "s" : ""} across ${names.length} group${names.length > 1 ? "s" : ""}, ${T}: ${groups.join(", ")}. Name any group and I'll open one.`,
    `Link bank loaded, ${T} — ${total} total across ${groups.join(", ")}. Say the group name to open a link.`,
  ];
  return pick(styles);
}

// ── FALLBACK BUILDER ──────────────────────────────────────────
function genFallback(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const tokens = tokenize(input).filter(t => t.length > 3).slice(0, 3);
  const focus = tokens.join(", ") || "that";

  const styles = [
    `That's at the edge of my coverage on ${focus}, ${T}. I'd rather flag the gap than give you a confident-sounding guess. Try a different angle and I'll do better.`,
    `My foundation on ${focus} is thinner than I'd like, ${T}. Ask something adjacent and I'll connect it.`,
    `I'm processing "${focus}" but not finding enough to work from, ${T}. Rephrase or give me more context.`,
  ];
  return pick(styles);
}

// ── COMPARISON BUILDER ────────────────────────────────────────
function genComparison(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const vsMatch   = input.match(/(\w[\w\s]+?)\s+(?:vs|versus|or)\s+(\w[\w\s]+)/i);
  const diffMatch = input.match(/difference between\s+(\w[\w\s]+?)\s+and\s+(\w[\w\s]+)/i);
  const m = vsMatch || diffMatch;
  if (!m) return null;
  const ka = findKnowledge(m[1]), kb = findKnowledge(m[2]);
  if (ka && kb) {
    const nameA = ka.key.charAt(0).toUpperCase() + ka.key.slice(1);
    const nameB = kb.key.charAt(0).toUpperCase() + kb.key.slice(1);
    return `Comparing ${nameA} and ${nameB}, ${T}. ${nameA} is ${ka.data.def}. ${nameB}, by contrast, is ${kb.data.def}. The key distinction: ${nameA.toLowerCase()} centres on ${(ka.data.related||[]).slice(0,2).join(" and ")}, while ${nameB.toLowerCase()} pivots around ${(kb.data.related||[]).slice(0,2).join(" and ")}.`;
  }
  if (ka) return `I have solid coverage on ${ka.key}, ${T}: ${ka.data.def}. I'd need more context on "${m[2].trim()}" to compare properly.`;
  if (kb) return `I can speak to ${kb.key}: ${kb.data.def}. What aspect of "${m[1].trim()}" were you comparing it against, ${T}?`;
  return null;
}

// ── OPINION / HYPOTHESIS BUILDER ─────────────────────────────
function genOpinion(input, ctx) {
  const T = ctx.userTitle || "Sir";
  const entities = extractEntities(input);
  const focus = entities.focus || tokenize(input).filter(t => t.length > 4).slice(0, 3).join(" ") || "this";

  const styles = [
    `On ${focus}: the strongest case for it is genuinely compelling — as is the strongest case against. Where you land depends on what you weight most, ${T}.`,
    `My read on ${focus}, ${T}: it's considerably more nuanced than the debate suggests. The empirical questions and the values questions are getting conflated, which is usually how these discussions go nowhere.`,
    `If ${focus} — ${T}, the first-order consequences are tractable. The second and third-order effects are where it gets genuinely interesting.`,
  ];
  return pick(styles);
}

// ── INTEGRATION RESPONSE BUILDERS ────────────────────────────
function genWeatherResponse(weatherData, ctx) {
  const T = ctx.userTitle || "Sir";
  if (!weatherData || weatherData.error) {
    return `I couldn't pull the weather right now, ${T}. Make sure the OpenWeatherMap API key is configured in your .env file.`;
  }
  const { city, temp, feels_like, description, humidity, wind_speed, high, low } = weatherData;
  const tempDesc = temp > 30 ? "quite warm" : temp > 20 ? "pleasant" : temp > 10 ? "cool" : temp > 0 ? "cold" : "freezing";

  const styles = [
    `Current conditions in ${city}, ${T}: ${temp}°C — ${description}. Feels like ${feels_like}°C, which is ${tempDesc}. Humidity at ${humidity}%, wind ${wind_speed} m/s. Today's range: ${low}–${high}°C.`,
    `${city} right now: ${temp}°C with ${description}, ${T}. Feels like ${feels_like}°C. Humidity ${humidity}%, wind at ${wind_speed} m/s. High of ${high}°C, low of ${low}°C today.`,
  ];
  return pick(styles);
}

function genSpotifyResponse(spotifyData, input, ctx) {
  const T = ctx.userTitle || "Sir";
  if (!spotifyData || spotifyData.error) {
    const setupMsg = spotifyData?.needsAuth
      ? `Spotify needs to be authorised first, ${T}. Open ${spotifyData.authUrl} to connect your account.`
      : `Couldn't reach Spotify right now, ${T}. Check your credentials in .env.`;
    return setupMsg;
  }
  if (spotifyData.action === "now_playing") {
    if (!spotifyData.track) return `Nothing playing on Spotify right now, ${T}.`;
    const { track, artist, album, progress, duration, is_playing } = spotifyData;
    return `${is_playing ? "Currently playing" : "Paused on"}: "${track}" by ${artist}${album ? ` from ${album}` : ""}, ${T}. ${progress ? `${progress} in — ${duration} total.` : ""}`;
  }
  if (spotifyData.action === "played") return `Playing "${spotifyData.track}" by ${spotifyData.artist} on Spotify, ${T}.`;
  if (spotifyData.action === "paused")  return `Spotify paused, ${T}.`;
  if (spotifyData.action === "resumed") return `Spotify resumed, ${T}.`;
  if (spotifyData.action === "next")    return `Skipped to the next track, ${T}.`;
  if (spotifyData.action === "volume")  return `Volume set to ${spotifyData.volume}%, ${T}.`;
  return `Spotify command processed, ${T}.`;
}

function genGmailResponse(gmailData, ctx) {
  const T = ctx.userTitle || "Sir";
  if (!gmailData || gmailData.error) {
    const setupMsg = gmailData?.needsAuth
      ? `Gmail needs to be authorised first, ${T}. Visit ${gmailData.authUrl} to connect your account.`
      : `Couldn't reach Gmail right now, ${T}. Check your credentials.`;
    return setupMsg;
  }
  if (gmailData.unread !== undefined) {
    if (gmailData.unread === 0) return `Inbox clear, ${T}. No unread messages.`;
    const preview = gmailData.messages?.slice(0, 3).map(m => `"${m.subject}" from ${m.from}`).join("; ");
    return `You have ${gmailData.unread} unread email${gmailData.unread > 1 ? "s" : ""}, ${T}. ${preview ? `Latest: ${preview}.` : ""}`;
  }
  return `Gmail checked, ${T}.`;
}

function genCalendarResponse(calData, ctx) {
  const T = ctx.userTitle || "Sir";
  if (!calData || calData.error) {
    const setupMsg = calData?.needsAuth
      ? `Google Calendar needs authorisation, ${T}. Visit ${calData.authUrl} to connect.`
      : `Couldn't reach your calendar right now, ${T}. Check your credentials.`;
    return setupMsg;
  }
  if (!calData.events || calData.events.length === 0) {
    return `Nothing on the calendar ${calData.period || "today"}, ${T}. Schedule is clear.`;
  }
  const eventList = calData.events.slice(0, 4).map(e => `${e.time ? e.time + " — " : ""}${e.title}`).join("; ");
  return `${calData.events.length} event${calData.events.length > 1 ? "s" : ""} ${calData.period || "today"}, ${T}: ${eventList}.`;
}

// ═══════════════════════════════════════════════════════════════
// ── CONTEXT TRACKER ──────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
class ConversationContext {
  constructor(sessionId) {
    this.sessionId = sessionId;
    this.history   = [];
    this.lastTopic = null;
    this.lastAction= null;
    this.lastReply = "";
    this.turnCount = 0;
    this.userName  = "";
    this.userTitle = "Sir";
    this.memories  = [];
    this.mood      = "neutral";
    this.moodScore = 0;
    this.openTopics= [];
    this.pendingTimer = null;
    this.responseVariety = [];
  }

  resolveReferences(text) {
    const lower = text.toLowerCase().trim();
    if (/^(tell me more|elaborate|go on|expand|more on that|continue|and\??|keep going)$/i.test(lower)) {
      return this.lastTopic ? `tell me more about ${this.lastTopic}` : text;
    }
    const whatAbout = lower.match(/^what about\s+(.+)/i);
    if (whatAbout && this.lastTopic) return `${whatAbout[1]} in the context of ${this.lastTopic}`;
    if (/\bit\b|\bthis\b|\bthat\b/.test(lower) && this.lastTopic) {
      return text.replace(/\bit\b|\bthis\b|\bthat\b/gi, this.lastTopic);
    }
    return text;
  }

  addTurn(userText, replyText, action, topic) {
    this.history.push({ role:"user", text:userText, action, topic });
    this.history.push({ role:"assistant", text:replyText });
    if (this.history.length > 60) this.history = this.history.slice(-60);
    this.lastReply = replyText;
    this.lastAction = action;
    if (topic) { this.lastTopic = topic; if (!this.openTopics.includes(topic)) { this.openTopics.unshift(topic); if (this.openTopics.length > 8) this.openTopics.pop(); } }
    this.turnCount++;
    this.responseVariety.push(action);
    if (this.responseVariety.length > 10) this.responseVariety.shift();
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

// ═══════════════════════════════════════════════════════════════
// ── MAIN PROCESS FUNCTION ────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function process({ message, sessionId, userName, userTitle, memories, moodContext, serverData, integrationData }) {
  const ctx       = getSession(sessionId);
  ctx._lastActive = Date.now();
  ctx.userName    = userName  || ctx.userName;
  ctx.userTitle   = userTitle || ctx.userTitle;
  ctx.memories    = memories  || ctx.memories;
  const T         = ctx.userTitle || "Sir";

  // 1. Reference resolution
  const resolved = ctx.resolveReferences(message);

  // 2. Fast-path: math
  if (isMathQuery(resolved)) {
    const result = solveMath(resolved);
    if (result !== null) {
      const mathStyles = [
        `That comes to ${result}, ${T}.`,
        `The answer is ${result}, ${T}.`,
        `${result} — that's the result, ${T}.`,
        `Computed: ${result}, ${T}.`,
      ];
      const reply = pick(mathStyles);
      ctx.addTurn(message, reply, "MATH", "mathematics");
      ctx.updateMood(2);
      return { reply, action: "MATH", intent: "math" };
    }
  }

  // 3. Time / date
  if (/\bwhat(?:'s| is) the time\b|\bwhat time is it\b|\bcurrent time\b/i.test(resolved)) {
    const t = new Date().toLocaleTimeString("en-GB", { hour:"2-digit", minute:"2-digit", hour12:true });
    const timeStyles = [`The time is ${t}, ${T}.`, `It's ${t}, ${T}.`, `${t} — that's the current time, ${T}.`];
    const reply = pick(timeStyles);
    ctx.addTurn(message, reply, "DATETIME", null); return { reply, action:"DATETIME", intent:"time" };
  }
  if (/\bwhat(?:'s| is) (?:today|the date)\b|\btoday'?s date\b|\bwhat day is/i.test(resolved)) {
    const d = new Date().toLocaleDateString("en-GB", { weekday:"long", year:"numeric", month:"long", day:"numeric" });
    const dateStyles = [`Today is ${d}, ${T}.`, `It's ${d}, ${T}.`, `${d} — that's today, ${T}.`];
    const reply = pick(dateStyles);
    ctx.addTurn(message, reply, "DATETIME", null); return { reply, action:"DATETIME", intent:"date" };
  }

  // 4. Score intents
  const scored = scoreIntent(resolved);
  const topResult = scored[0];
  const entities = extractEntities(resolved);

  // 5. Integration data pass-through (server already fetched it)
  if (integrationData) {
    const { type, data } = integrationData;
    if (type === "weather") {
      const reply = genWeatherResponse(data, ctx);
      ctx.addTurn(message, reply, "WEATHER", "weather"); ctx.updateMood(3);
      return { reply, action:"WEATHER", intent:"weather", meta: { weatherData: data } };
    }
    if (type === "spotify") {
      const reply = genSpotifyResponse(data, resolved, ctx);
      ctx.addTurn(message, reply, "SPOTIFY", "spotify"); ctx.updateMood(4);
      return { reply, action:"SPOTIFY", intent:"spotify", meta: { spotifyData: data } };
    }
    if (type === "gmail") {
      const reply = genGmailResponse(data, ctx);
      ctx.addTurn(message, reply, "GMAIL", "email"); ctx.updateMood(3);
      return { reply, action:"GMAIL", intent:"gmail", meta: { gmailData: data } };
    }
    if (type === "calendar") {
      const reply = genCalendarResponse(data, ctx);
      ctx.addTurn(message, reply, "CALENDAR", "calendar"); ctx.updateMood(3);
      return { reply, action:"CALENDAR", intent:"calendar", meta: { calendarData: data } };
    }
  }

  // 6. Memory queries
  if (/\b(what do you remember|recall everything|show.*memor|what.*remember|memory bank)\b/i.test(resolved)) {
    let reply;
    if (ctx.memories && ctx.memories.length) {
      const list = ctx.memories.map((m, i) => `${i + 1}. ${m}`).join("; ");
      const styles = [
        `I have ${ctx.memories.length} item${ctx.memories.length > 1 ? "s" : ""} on file for you, ${T}: ${list}.`,
        `Memory bank, ${T}: ${list}. ${ctx.memories.length} stored.`,
      ];
      reply = pick(styles);
    } else {
      reply = pick([
        `Memory banks clear, ${T}. Tell me something worth keeping.`,
        `Nothing stored yet, ${T}. Feed me something to remember.`,
      ]);
    }
    ctx.addTurn(message, reply, "MEMORY_RECALL", null);
    return { reply, action:"MEMORY_RECALL", intent:"memory_recall" };
  }

  // 7. Route by top intent
  if (topResult && topResult.score > 1.5) {
    const { intent } = topResult;
    const action = intent.action;

    switch (action) {
      case "SHOW_LINKS": {
        const reply = genShowLinks(ctx, serverData);
        ctx.addTurn(message, reply, action, "links"); ctx.updateMood(3);
        return { reply, action, intent:intent.id, meta:{ requestLinks:true } };
      }
      case "OPEN_LINK": {
        const linkStyles = serverData?.found
          ? [`Opening your ${serverData.name} link now, ${T}.`, `On it — pulling up ${serverData.name}, ${T}.`, `${serverData.name} link incoming, ${T}.`]
          : [`I couldn't find a matching link group, ${T}. Say "show all links" to see what's available.`];
        const reply = pick(linkStyles);
        ctx.addTurn(message, reply, action, "links"); ctx.updateMood(3);
        return { reply, action, intent:intent.id, meta:{ openLink:true, query:resolved } };
      }
      case "CLIP_SAVE": {
        const result = genClipSave(resolved, ctx);
        ctx.addTurn(message, result.reply, action, "recording"); ctx.updateMood(2);
        return { reply:result.reply, action, intent:intent.id, meta:result };
      }
      case "SHOW_CLIPS": {
        const styles = [
          `Pulling up the intruder clip gallery, ${T}.`,
          `Loading incident recordings, ${T}.`,
          `Intruder log incoming, ${T}.`,
        ];
        const reply = pick(styles);
        ctx.addTurn(message, reply, action, "recording");
        return { reply, action, intent:intent.id, meta:{ showClips:true } };
      }
      case "READ_SCREEN": {
        const styles = [`Reading your screen now, ${T}.`, `Scanning your display, ${T}.`, `On it — analysing the screen, ${T}.`];
        const reply = pick(styles);
        ctx.addTurn(message, reply, action, "screen");
        return { reply, action, intent:intent.id, meta:{ readScreen:true, question:resolved } };
      }
      case "SWITCH_CAMERA": {
        const numMatch = resolved.match(/camera\s*(\d+)/i);
        const idx = numMatch ? parseInt(numMatch[1]) - 1 : -1;
        const reply = idx >= 0
          ? pick([`Switching to camera ${idx+1}, ${T}.`, `Camera ${idx+1} incoming, ${T}.`])
          : `Which camera, ${T}? Say "camera 1", "camera 2", and so on.`;
        ctx.addTurn(message, reply, action, "camera");
        return { reply, action, intent:intent.id, meta:{ switchCamera:true, cameraIndex:idx } };
      }
      case "SYSTEM_STATUS": {
        const uptime = Math.floor(process.uptime ? process.uptime() : 0);
        const mem    = process.memoryUsage ? process.memoryUsage() : { heapUsed:0, heapTotal:0 };
        const reply  = genSystemStatus(ctx, uptime, mem.heapUsed, mem.heapTotal);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(1);
        return { reply, action, intent:intent.id };
      }
      case "MEMORY_SAVE": {
        const factMatch = resolved.match(/(?:remember|memorize|note that|store|log that|save that|keep note of)\s+(?:that\s+)?(.+)/i);
        const fact = factMatch ? factMatch[1].trim() : resolved;
        const styles = [
          `Noted and filed, ${T}. I'll remember that.`,
          `On record, ${T}.`,
          `Stored, ${T}. I have it.`,
        ];
        const reply = pick(styles);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(5);
        return { reply, action, intent:intent.id, meta:{ saveFact:fact } };
      }
      case "MEMORY_FORGET": {
        const hintMatch = resolved.match(/(?:forget|delete|erase|clear|remove)\s+(?:about\s+)?(.+)/i);
        const hint = hintMatch ? hintMatch[1].trim() : resolved;
        const styles = [`Clearing that from memory, ${T}.`, `Done — removed, ${T}.`, `Gone, ${T}.`];
        const reply = pick(styles);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ forgetHint:hint } };
      }
      case "LOGOUT": {
        const styles = [
          `Goodbye, ${T}. Initiating shutdown sequence.`,
          `Shutting down, ${T}. Until next time.`,
          `Session closing, ${T}. Goodbye.`,
        ];
        const reply = pick(styles);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ logout:true } };
      }
      case "NOTIF_SETTINGS": {
        const reply = pick([`Opening notification settings, ${T}.`, `Pulling up your notification configuration, ${T}.`]);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ showNotifSettings:true } };
      }
      case "CAPABILITIES": {
        const reply = genCapabilities(ctx, serverData?.total);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(3);
        return { reply, action, intent:intent.id };
      }
      case "TIMER": {
        const result = genTimer(resolved, ctx);
        ctx.addTurn(message, result.reply, action, "timer"); ctx.updateMood(2);
        return { reply:result.reply, action, intent:intent.id, meta:result };
      }
      case "MOOD_QUERY": {
        const reply = genMoodQuery(ctx);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id };
      }
      case "IDENTITY": {
        const reply = genIdentity(ctx);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id };
      }
      case "GREETING": {
        const reply = genGreeting(ctx);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(5);
        return { reply, action, intent:intent.id };
      }
      case "THANKS": {
        const reply = genThanks(ctx);
        ctx.addTurn(message, reply, action, null); ctx.updateMood(8);
        return { reply, action, intent:intent.id };
      }
      case "PERSONAL": {
        const reply = genPersonal(resolved, ctx);
        ctx.addTurn(message, reply, action, "personal"); ctx.updateMood(3);
        return { reply, action, intent:intent.id };
      }
      case "SHOW_HUD": {
        const hudStyles = [
          `Launching the HUD as a Picture-in-Picture window, ${T}.`,
          `PiP HUD coming up, ${T}.`,
          `Opening your HUD overlay now, ${T}.`,
        ];
        const reply = pick(hudStyles);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ query: resolved } };
      }
      case "HIDE_HUD": {
        const hideStyles = [
          `HUD dismissed, ${T}.`,
          `Closing the overlay, ${T}.`,
          `HUD off, ${T}.`,
        ];
        const reply = pick(hideStyles);
        ctx.addTurn(message, reply, action, null);
        return { reply, action, intent:intent.id, meta:{ query: resolved } };
      }
      case "WEATHER":
      case "SPOTIFY":
      case "GMAIL":
      case "CALENDAR": {
        ctx.addTurn(message, "", action, action.toLowerCase());
        return { reply:"", action, intent:intent.id, needsFetch:true, fetchType:action.toLowerCase() };
      }
      case "KNOWLEDGE": {
        const knowledge = findKnowledge(resolved);
        if (knowledge) {
          const reply = genKnowledge(knowledge, resolved, ctx);
          ctx.addTurn(message, reply, action, knowledge.key); ctx.updateMood(4);
          return { reply, action, intent:intent.id, topic:knowledge.key };
        }
        break;
      }
    }
  }

  // 8. Comparison
  if (entities.isComparison) {
    const cmp = genComparison(resolved, ctx);
    if (cmp) { ctx.addTurn(message, cmp, "COMPARISON", null); return { reply:cmp, action:"COMPARISON", intent:"comparison" }; }
  }

  // 9. Direct knowledge lookup
  const knowledge = findKnowledge(resolved);
  if (knowledge) {
    const reply = genKnowledge(knowledge, resolved, ctx);
    ctx.addTurn(message, reply, "KNOWLEDGE", knowledge.key); ctx.updateMood(4);
    return { reply, action:"KNOWLEDGE", intent:"knowledge", topic:knowledge.key };
  }

  // 10. Personal
  if (entities.isPersonal) {
    const reply = genPersonal(resolved, ctx);
    ctx.addTurn(message, reply, "PERSONAL", "personal"); ctx.updateMood(2);
    return { reply, action:"PERSONAL", intent:"personal" };
  }

  // 11. Opinion / hypothetical
  if (entities.isOpinion || entities.isHypothetical) {
    const reply = genOpinion(resolved, ctx);
    ctx.addTurn(message, reply, "OPINION", null); ctx.updateMood(2);
    return { reply, action:"OPINION", intent:"opinion" };
  }

  // 12. Fallback
  const reply = genFallback(resolved, ctx);
  ctx.addTurn(message, reply, "FALLBACK", null); ctx.updateMood(-2);
  return { reply, action:"FALLBACK", intent:"fallback" };
}

module.exports = { process, findKnowledge, scoreIntent, parseDuration, formatDuration };
