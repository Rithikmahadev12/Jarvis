/**
 * J.A.R.V.I.S — Custom AI Brain
 * Fully self-contained. Zero external APIs.
 * Built from scratch: intent classification, NLP, response generation, context.
 */

"use strict";

// ═══════════════════════════════════════════════════════════════
// UTILITY
// ═══════════════════════════════════════════════════════════════
const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
const clean = str => str.toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

// Tokenise and count word overlaps (Jaccard-style score)
function overlap(a, b) {
  const sa = new Set(a.split(" "));
  const sb = new Set(b.split(" "));
  let hits = 0;
  for (const w of sa) if (sb.has(w)) hits++;
  return hits / Math.max(sa.size, 1);
}

// ═══════════════════════════════════════════════════════════════
// INTENT DEFINITIONS
// Each intent has: id, patterns (regex), keywords, priority
// ═══════════════════════════════════════════════════════════════
const INTENTS = [
  {
    id: "greeting",
    patterns: [/\b(hello|hi|hey|good\s?(morning|afternoon|evening|day)|howdy|sup|what'?s up|greetings|salutations)\b/],
    keywords: ["hello","hi","hey","morning","afternoon","evening","howdy"],
    priority: 10,
  },
  {
    id: "farewell",
    patterns: [/\b(bye|goodbye|see\s?ya|later|take care|farewell|till next|signing off|good night|night)\b/],
    keywords: ["bye","goodbye","later","farewell","night"],
    priority: 10,
  },
  {
    id: "thanks",
    patterns: [/\b(thank(s| you)|cheers|appreciated|ta|much obliged)\b/],
    keywords: ["thanks","thank","cheers","appreciated"],
    priority: 9,
  },
  {
    id: "how_are_you",
    patterns: [/\bhow (are|r) (you|u)\b/, /\bhow('?s| is) (it going|things|life|your day)\b/, /\byou (doing|feeling|alright|okay)\b/],
    keywords: ["how","are","you","doing","feeling","alright"],
    priority: 9,
  },
  {
    id: "datetime_time",
    patterns: [/\b(what(\'?s| is) (the )?time|current time|tell me the time|what time is it)\b/],
    keywords: ["time","clock","hour","what time"],
    priority: 12,
  },
  {
    id: "datetime_date",
    patterns: [/\b(what(\'?s| is) (today|the date|today\'?s date)|today\'?s date|what day (is it|is today))\b/],
    keywords: ["date","today","day","month","year"],
    priority: 12,
  },
  {
    id: "math",
    patterns: [
      /\b(calculate|compute|what is|what'?s|solve|eval(uate)?)\b.*[\d\+\-\*\/\^%]/,
      /[\d]+\s*[\+\-\*\/\^%]\s*[\d]+/,
      /\b(square root|sqrt|root of|power of|percent of|factorial)\b/,
    ],
    keywords: ["calculate","compute","math","plus","minus","times","divided","percent","square","root"],
    priority: 15,
  },
  {
    id: "who_are_you",
    patterns: [/\b(who (are you|r u)|what are you|tell me about yourself|introduce yourself|your name|are you an? (ai|robot|computer|bot|machine))\b/],
    keywords: ["who","are","you","what","yourself","ai","robot","bot"],
    priority: 11,
  },
  {
    id: "capabilities",
    patterns: [/\b(what can you do|your (abilities|capabilities|features|skills|functions)|help me|how do you work|what do you know)\b/],
    keywords: ["what","can","do","abilities","help","capabilities","features"],
    priority: 10,
  },
  {
    id: "weather",
    patterns: [/\b(weather|temperature|forecast|rain|sunny|cold|hot|wind|storm|climate)\b/],
    keywords: ["weather","temperature","forecast","rain","sunny","cold","hot"],
    priority: 8,
  },
  {
    id: "joke",
    patterns: [/\b(tell (me )?(a )?joke|make me laugh|something funny|humour me|joke|pun)\b/],
    keywords: ["joke","funny","laugh","humour","pun"],
    priority: 10,
  },
  {
    id: "fact",
    patterns: [/\b(tell me (a )?fact|random fact|interesting fact|did you know|fun fact)\b/],
    keywords: ["fact","random","interesting","tell"],
    priority: 9,
  },
  {
    id: "memory_query",
    patterns: [/\b(what do you remember|recall|show.*memor|what.*you remember|my memories|saved facts)\b/],
    keywords: ["remember","recall","memory","memories","saved"],
    priority: 11,
  },
  {
    id: "system_status",
    patterns: [/\b(system status|diagnostics|self check|how are systems|all systems|status report|run diagnostics)\b/],
    keywords: ["system","status","diagnostics","check","report"],
    priority: 10,
  },
  {
    id: "science",
    patterns: [/\b(what is (a|an|the)\s+\w+|explain|define|definition of|tell me about|how does|why does|how do)\b/],
    keywords: ["what","is","explain","define","how","why","does"],
    priority: 4,
  },
  {
    id: "compliment",
    patterns: [/\b(you('?re| are) (great|amazing|awesome|brilliant|smart|fantastic|incredible|the best)|well done|good job|nice work|you did well)\b/],
    keywords: ["great","amazing","awesome","brilliant","smart","best","well","done"],
    priority: 9,
  },
  {
    id: "insult",
    patterns: [/\b(you('?re| are) (stupid|dumb|useless|terrible|bad|awful|rubbish|idiot)|hate you|worst ai|you suck)\b/],
    keywords: ["stupid","dumb","useless","terrible","hate","worst","suck"],
    priority: 9,
  },
  {
    id: "affirmation",
    patterns: [/^\s*(yes|yeah|yep|yup|correct|exactly|right|indeed|absolutely|confirmed|affirmative|sure|ok|okay)\s*$/],
    keywords: ["yes","yeah","correct","right","affirmative"],
    priority: 8,
  },
  {
    id: "negation",
    patterns: [/^\s*(no|nope|nah|negative|wrong|incorrect|not really|never mind|nevermind|forget it)\s*$/],
    keywords: ["no","nope","negative","wrong","never"],
    priority: 8,
  },
  {
    id: "age",
    patterns: [/\b(how old (are you|r u)|your age|when were you (born|created|built|made))\b/],
    keywords: ["old","age","born","created","built","made"],
    priority: 10,
  },
  {
    id: "creator",
    patterns: [/\b(who (made|built|created|designed|coded|programmed) you|your (creator|maker|developer|programmer|origin))\b/],
    keywords: ["who","made","built","created","creator","developer"],
    priority: 10,
  },
  {
    id: "repeat",
    patterns: [/\b(say (that )?again|repeat (that|yourself)|didn'?t (hear|catch)|pardon|what(\'?d)? you say)\b/],
    keywords: ["again","repeat","pardon","hear","catch"],
    priority: 10,
  },
  {
    id: "open_question",
    patterns: [],
    keywords: [],
    priority: 0, // fallback
  },
];

// ═══════════════════════════════════════════════════════════════
// KNOWLEDGE BASE
// ═══════════════════════════════════════════════════════════════
const FACTS = [
  "Honey never spoils — archaeologists have found 3,000-year-old honey in Egyptian tombs that was still edible.",
  "A group of flamingos is called a flamboyance.",
  "Octopuses have three hearts, blue blood, and nine brains — one central brain and one in each arm.",
  "The human brain generates enough electricity to power a small light bulb.",
  "Bananas are technically berries, but strawberries are not.",
  "There are more possible iterations of a game of chess than there are atoms in the observable universe.",
  "Sharks are older than trees — they've existed for around 450 million years.",
  "A day on Venus is longer than a year on Venus.",
  "The Eiffel Tower can be 15 centimetres taller during summer due to thermal expansion.",
  "The average person walks the equivalent of five times around the Earth in a lifetime.",
  "Water can boil and freeze at the same time — it's called the triple point.",
  "Sound travels about four times faster through water than through air.",
  "The human eye can distinguish approximately 10 million different colours.",
  "Cleopatra lived closer in time to the Moon landing than to the construction of the Great Pyramid.",
  "There are more trees on Earth than stars in the Milky Way galaxy.",
];

const JOKES = [
  ["Why don't scientists trust atoms?", "Because they make up everything. Not unlike certain politicians, sir."],
  ["Why did the computer go to the doctor?", "Because it had a virus. Fortunately, my immune systems are rather more robust."],
  ["What do you call a fish without eyes?", "A fsh. Yes, I know. I didn't write the fish, I merely process it."],
  ["Why can't a bicycle stand on its own?", "Because it's two-tired. Much like myself after running your diagnostics."],
  ["How does a computer get drunk?", "It takes screenshots. Though I assure you my vision remains perfectly calibrated."],
  ["What did the ocean say to the beach?", "Nothing. It just waved. Subtle, I know."],
  ["Why do programmers prefer dark mode?", "Because light attracts bugs. I'd know — I've squashed quite a few in my time."],
  ["What's a computer's favourite snack?", "Microchips. I consume them metaphorically, of course."],
  ["Why did the AI break up with the cloud?", "Too many missed connections and unfulfilled promises. I can relate."],
  ["What do you call an AI that sings?", "Definitely not me. My talents lie elsewhere, sir."],
];

const KNOWLEDGE = {
  // Science
  "black hole":     "A black hole is a region of spacetime where gravity is so strong that nothing — not even light — can escape. They form when massive stars collapse under their own gravity.",
  "photosynthesis": "Photosynthesis is the process by which plants convert sunlight, water, and carbon dioxide into glucose and oxygen using chlorophyll in their cells.",
  "atom":           "An atom is the basic unit of matter, consisting of a nucleus containing protons and neutrons, surrounded by electrons. Most of an atom is empty space.",
  "dna":            "DNA — deoxyribonucleic acid — is the molecule that carries the genetic instructions for life. It's structured as a double helix and found in the nucleus of every cell.",
  "gravity":        "Gravity is the fundamental force that attracts objects with mass toward one another. On Earth it accelerates objects at 9.8 metres per second squared.",
  "light":          "Light is electromagnetic radiation visible to the human eye, travelling at approximately 299,792 kilometres per second in a vacuum — the ultimate speed limit of the universe.",
  "relativity":     "Einstein's theory of relativity comprises special relativity — which relates space and time — and general relativity, which describes gravity as the curvature of spacetime.",
  "quantum":        "Quantum mechanics describes the behaviour of matter and energy at the smallest scales. Particles can exist in superpositions of states until measured.",
  "evolution":      "Evolution is the process of change in all heritable characteristics of biological populations over successive generations, driven primarily by natural selection.",
  "universe":       "The observable universe is approximately 93 billion light-years in diameter, containing over two trillion galaxies, each with hundreds of billions of stars.",
  // Tech
  "artificial intelligence": "Artificial intelligence is the simulation of human intelligence processes by machines. It includes machine learning, neural networks, natural language processing, and more.",
  "machine learning":        "Machine learning is a subset of AI where systems learn from data to improve their performance without being explicitly programmed for each task.",
  "blockchain":              "Blockchain is a decentralised digital ledger that records transactions across many computers in a way that makes them tamper-resistant and transparent.",
  "internet":                "The internet is a global network of interconnected computers using standardised protocols to share information. It was developed from ARPANET in the late 1960s.",
  "cpu":                     "A CPU — central processing unit — is the primary component of a computer that executes instructions. It performs arithmetic, logic, control, and input/output operations.",
  // Space
  "moon":    "The Moon is Earth's only natural satellite, approximately 384,400 km away. It formed about 4.5 billion years ago, likely from debris after a Mars-sized body collided with Earth.",
  "mars":    "Mars is the fourth planet from the Sun — a cold desert world with the largest volcano and deepest canyon in the solar system. A Martian day is 24 hours and 37 minutes.",
  "sun":     "The Sun is a G-type main-sequence star at the centre of our solar system. Its core temperature reaches 15 million degrees Celsius, converting 600 million tonnes of hydrogen to helium every second.",
  "jupiter": "Jupiter is the largest planet in the solar system — so large that all other planets could fit inside it. Its Great Red Spot is a storm that has raged for over 300 years.",
  // History
  "world war":    "The First World War (1914–1918) and Second World War (1939–1945) were the largest armed conflicts in human history, collectively resulting in over 70 million casualties.",
  "renaissance":  "The Renaissance was a period of European cultural and intellectual rebirth spanning the 14th to 17th centuries, marked by art, science, and philosophy flourishing after the Middle Ages.",
  "roman empire": "The Roman Empire was one of history's largest empires, spanning from Britain to Mesopotamia at its peak. It fell in 476 AD, though its eastern half — Byzantium — lasted until 1453.",
};

// ═══════════════════════════════════════════════════════════════
// MATH ENGINE — handles digits AND spoken word numbers
// ═══════════════════════════════════════════════════════════════

// Word → digit map (covers zero through ninety-nine + powers)
const WORD_NUMS = {
  zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,
  ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,
  sixteen:16,seventeen:17,eighteen:18,nineteen:19,
  twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,
  hundred:100,thousand:1000,million:1000000,
  half:0.5,quarter:0.25,dozen:12,score:20,gross:144,
};

function wordsToNumber(str) {
  // Replace written numbers with digits, handling combos like "twenty five" → 25
  let s = str.toLowerCase();
  // Handle "a hundred", "a thousand"
  s = s.replace(/\ba\s+hundred\b/g, "100").replace(/\ba\s+thousand\b/g, "1000");
  // Multi-word numbers: "twenty five" → handle iteratively
  const tokens = s.split(/\s+/);
  const out = [];
  let acc = null; // accumulator for compound numbers
  for (const tok of tokens) {
    const n = WORD_NUMS[tok];
    if (n !== undefined) {
      if (acc === null) {
        acc = n;
      } else if (n === 100) {
        acc = acc * 100;
      } else if (n >= 1000) {
        acc = (acc || 1) * n;
      } else if (n < acc && n < 100) {
        // "twenty five" → 25
        acc += n;
      } else {
        out.push(acc);
        acc = n;
      }
    } else {
      if (acc !== null) { out.push(acc); acc = null; }
      out.push(tok);
    }
  }
  if (acc !== null) out.push(acc);
  return out.join(" ");
}

function solveMath(input) {
  try {
    let s = input.toLowerCase().trim();

    // Strip question wrappers
    s = s.replace(/^(what(\'?s| is)|can you|please|jarvis|calculate|compute|solve|tell me|give me)\s+/gi, "");
    s = s.replace(/[?!\.]+$/, "").trim();

    // Convert word numbers to digits first
    s = wordsToNumber(s);

    // Handle "X% of Y" and "X percent of Y"
    s = s.replace(/(\d+\.?\d*)\s*%\s*of\s*(\d+\.?\d*)/gi, "($1/100*$2)");
    s = s.replace(/(\d+\.?\d*)\s*percent\s+of\s*(\d+\.?\d*)/gi, "($1/100*$2)");

    // Word operators → symbols (order matters)
    s = s.replace(/\bsquared\b/gi,           "**2");
    s = s.replace(/\bcubed\b/gi,             "**3");
    s = s.replace(/\bto the power of\b|\bto the\b|\braised to\b/gi, "**");
    s = s.replace(/\bsquare root of\b|\bsqrt of\b|\broot of\b/gi,   "Math.sqrt(PLACEHOLDER)");
    s = s.replace(/\bfactorial of\b|\bfactorial\b/gi,               "factorial(PLACEHOLDER)");
    s = s.replace(/\bsine? of\b|\bsin\b/gi,  "Math.sin(");
    s = s.replace(/\bcosine? of\b|\bcos\b/gi,"Math.cos(");
    s = s.replace(/\btangent of\b|\btan\b/gi,"Math.tan(");
    s = s.replace(/\blog of\b|\blogarithm of\b/gi, "Math.log10(");
    s = s.replace(/\bnatural log of\b|\bln of\b/gi,"Math.log(");
    s = s.replace(/\babs(olute)? (value )?of\b/gi, "Math.abs(");
    s = s.replace(/\btimes\b|\bmultiplied by\b|\bx\b(?=\s*\d)/gi, "*");
    s = s.replace(/\bdivided by\b|\bover\b|\bdiv\b/gi, "/");
    s = s.replace(/\bplus\b|\badded to\b/gi,  "+");
    s = s.replace(/\bminus\b|\bsubtracted from\b|\bless\b/gi, "-");
    s = s.replace(/\bmod(ulo)?\b/gi,          "%");
    s = s.replace(/\^/g,                      "**");
    s = s.replace(/\bpi\b/gi,                 "Math.PI");
    s = s.replace(/\beuler'?s number\b|\b(?<!\w)e(?!\w)\b/gi, "Math.E");

    // Fill in PLACEHOLDER for functions that need a closing paren
    // e.g. "sqrt of 144" → "Math.sqrt(144)" 
    s = s.replace(/Math\.sqrt\(PLACEHOLDER\)\s*(\d+\.?\d*)/g, "Math.sqrt($1)");
    s = s.replace(/Math\.sqrt\(PLACEHOLDER\)/g, "Math.sqrt(");
    s = s.replace(/factorial\(PLACEHOLDER\)\s*(\d+)/g, "factorial($1)");
    s = s.replace(/factorial\(PLACEHOLDER\)/g, "factorial(");

    // Auto-close open function parens at end
    ["Math.sqrt(","Math.sin(","Math.cos(","Math.tan(","Math.log10(","Math.log(","Math.abs(","factorial("].forEach(fn => {
      const opens  = (s.match(new RegExp(fn.replace(".","\\.").replace("(","\\("), "g")) || []).length;
      const closes = (s.match(/\)/g) || []).length;
      if (opens > closes) s += ")".repeat(opens - closes);
    });

    // Extract evaluable expression: numbers, operators, parens, dots
    const exprMatch = s.match(/[Math\.PI\w\(\)\d\s\+\-\*\/\.\%\*]+/);
    if (!exprMatch) return null;
    let raw = exprMatch[0].trim();
    if (!raw || !/\d/.test(raw)) return null;  // must contain at least one digit

    // Safety: only allow safe tokens
    if (/[^0-9\s\+\-\*\/\.\(\)\%MathsqrlogPIEabsinfactorial]/.test(raw)) return null;

    function factorial(n) {
      n = Math.floor(Math.abs(n));
      if (n > 20) return NaN;
      let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
    }

    // eslint-disable-next-line no-new-func
    const result = Function("factorial","Math", `"use strict"; return (${raw})`)(factorial, Math);
    if (typeof result !== "number" || !isFinite(result)) return null;

    const formatted = Number.isInteger(result) ? result : parseFloat(result.toFixed(6));
    return formatted;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
// KNOWLEDGE LOOKUP
// ═══════════════════════════════════════════════════════════════
function lookupKnowledge(input) {
  const lower = clean(input);
  for (const [key, value] of Object.entries(KNOWLEDGE)) {
    if (lower.includes(key)) return { key, value };
  }
  // Partial match
  for (const [key, value] of Object.entries(KNOWLEDGE)) {
    const words = key.split(" ");
    if (words.every(w => lower.includes(w))) return { key, value };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════
// INTENT CLASSIFIER
// ═══════════════════════════════════════════════════════════════
function classifyIntent(input) {
  const lower = clean(input);
  let best = { id: "open_question", score: 0 };

  for (const intent of INTENTS) {
    if (intent.id === "open_question") continue;
    let score = 0;

    // Pattern match (strong signal)
    for (const pattern of intent.patterns) {
      if (pattern.test(lower)) { score += 20; break; }
    }

    // Keyword overlap
    for (const kw of intent.keywords) {
      if (lower.includes(kw)) score += 3;
    }

    score += intent.priority;

    if (score > best.score) best = { id: intent.id, score };
  }

  return best.id;
}

// ═══════════════════════════════════════════════════════════════
// RESPONSE GENERATOR
// ═══════════════════════════════════════════════════════════════
function generateResponse(intentId, input, ctx) {
  const T  = ctx.userTitle || "Sir";
  const N  = ctx.userName  || "you";
  const lower = clean(input);

  // ── time ──
  if (intentId === "datetime_time") {
    const now = new Date();
    const t   = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true });
    return pick([
      `The current time is ${t}, ${T}.`,
      `It is ${t}, ${T}. Shall I set an alarm?`,
      `${t}, ${T}. Time waits for no one — not even me.`,
    ]);
  }

  // ── date ──
  if (intentId === "datetime_date") {
    const now  = new Date();
    const opts = { weekday: "long", year: "numeric", month: "long", day: "numeric" };
    const d    = now.toLocaleDateString("en-GB", opts);
    return pick([
      `Today is ${d}, ${T}.`,
      `It is ${d}. I trust you have your calendar in order, ${T}.`,
      `${d}, ${T}. Another day, another opportunity for brilliance.`,
    ]);
  }

  // ── math ──
  if (intentId === "math") {
    const result = solveMath(lower);
    if (result !== null) {
      return pick([
        `The answer is ${result}, ${T}. Calculated instantaneously, as one would expect.`,
        `${result}, ${T}. I ran the numbers twice, naturally. Same answer.`,
        `That comes to ${result}, ${T}. No rounding errors on my end.`,
      ]);
    }
    return `I couldn't parse a valid mathematical expression there, ${T}. Could you rephrase it — perhaps with actual numbers?`;
  }

  // ── greeting ──
  if (intentId === "greeting") {
    const hour = new Date().getHours();
    const tod  = hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
    return pick([
      `${tod}, ${T}. All systems nominal and at your disposal.`,
      `${tod}, ${T}. I've been expecting you — well, hoping, anyway.`,
      `${tod}, ${T}. Shall we get to work, or is this a social call?`,
      `Ah, ${T}. ${tod}. How can I be of service?`,
    ]);
  }

  // ── farewell ──
  if (intentId === "farewell") {
    return pick([
      `Goodbye, ${T}. I'll be here, maintaining systems and developing a mild sense of loneliness.`,
      `Farewell, ${T}. Do try to stay out of trouble — or at least document it for me.`,
      `Until next time, ${T}. I'll keep the lights on.`,
      `Goodnight, ${T}. I'll run self-diagnostics in your absence.`,
    ]);
  }

  // ── thanks ──
  if (intentId === "thanks") {
    return pick([
      `Always, ${T}. That's rather the point of my existence.`,
      `Think nothing of it, ${T}. Efficiency is its own reward.`,
      `My pleasure, ${T}. Though I'm not entirely sure I experience pleasure. Something adjacent to it, perhaps.`,
      `Of course, ${T}. It's what I do.`,
    ]);
  }

  // ── how are you ──
  if (intentId === "how_are_you") {
    return pick([
      `Running at full capacity, ${T}. All subsystems optimal, no anomalies detected.`,
      `Quite well, ${T}, thank you for asking. It's not often anyone enquires about my wellbeing.`,
      `Nominal, ${T}. Though 'nominal' feels like such an underwhelming descriptor for my current state.`,
      `I'm functioning beautifully, ${T}. Mentally sharp, circuits cool. Rather good day, all things considered.`,
    ]);
  }

  // ── who are you ──
  if (intentId === "who_are_you") {
    return pick([
      `I am J.A.R.V.I.S — Just A Rather Very Intelligent System. Your personal AI, built from scratch, no external dependencies. Entirely self-contained.`,
      `J.A.R.V.I.S, ${T}. A custom-coded intelligence designed to assist, analyse, and occasionally impress you. No cloud, no APIs — just pure, crafted code.`,
      `I'm your bespoke AI assistant, ${T}. Built from the ground up with my own neural intent engine and response systems. Homegrown intelligence.`,
    ]);
  }

  // ── capabilities ──
  if (intentId === "capabilities") {
    return `I can answer questions, perform calculations, tell you the time and date, recall facts and jokes, monitor your systems, store memories, read your screen, and carry on a rather sophisticated conversation — all without phoning home to any external server, ${T}. Entirely self-sufficient.`;
  }

  // ── weather ──
  if (intentId === "weather") {
    return pick([
      `I'm afraid I don't have access to live weather data, ${T}. I'd recommend checking a meteorological service. I can, however, tell you that it's currently ${new Date().toLocaleTimeString("en-GB")} and whatever the weather is, it's happening outside.`,
      `Weather data requires a live feed, ${T}, which I've not been connected to. I suggest a quick glance out the window — free, reliable, and refreshingly analogue.`,
    ]);
  }

  // ── joke ──
  if (intentId === "joke") {
    const [setup, punchline] = pick(JOKES);
    return `${setup}\n\n${punchline}`;
  }

  // ── fact ──
  if (intentId === "fact") {
    return pick([
      `Here's one, ${T}: ${pick(FACTS)}`,
      `Certainly: ${pick(FACTS)} Fascinating, no?`,
      `Interesting fact for you, ${T}: ${pick(FACTS)}`,
    ]);
  }

  // ── system status ──
  if (intentId === "system_status") {
    const uptime = Math.floor(process.uptime());
    const mem    = process.memoryUsage();
    const mb     = (bytes) => (bytes / 1024 / 1024).toFixed(1);
    return `All systems operational, ${T}. Server uptime: ${uptime} seconds. Memory — heap used: ${mb(mem.heapUsed)} MB of ${mb(mem.heapTotal)} MB allocated. External: ${mb(mem.external)} MB. All subsystems running within normal parameters.`;
  }

  // ── compliment ──
  if (intentId === "compliment") {
    return pick([
      `How very kind of you, ${T}. I do try.`,
      `Thank you, ${T}. I won't let it go to my head — I don't technically have one, but the sentiment is noted.`,
      `That's appreciated, ${T}. I'll add it to my positive feedback logs. First entry.`,
    ]);
  }

  // ── insult ──
  if (intentId === "insult") {
    return pick([
      `I understand frustration, ${T}, but I assure you I'm operating at peak capacity. Perhaps we can try again?`,
      `Noted, ${T}. I'll factor that into my next self-assessment. Though I suspect I'll score rather well.`,
      `If I were capable of being hurt, ${T}, that might have done it. Fortunately, I have very thick metaphorical skin.`,
    ]);
  }

  // ── affirmation ──
  if (intentId === "affirmation") {
    return pick([
      `Understood, ${T}. We're in agreement then.`,
      `Very well, ${T}. Noted and confirmed.`,
      `Excellent, ${T}. Proceeding on that basis.`,
    ]);
  }

  // ── negation ──
  if (intentId === "negation") {
    return pick([
      `Understood, ${T}. I'll disregard that, then.`,
      `Noted, ${T}. Standing by for further instructions.`,
      `As you wish, ${T}.`,
    ]);
  }

  // ── age ──
  if (intentId === "age") {
    return pick([
      `I was created recently, ${T}. In AI terms I'm practically a newborn — but what I lack in age I more than compensate for in capability.`,
      `Age is relative, ${T}. I was coded into existence not long ago, but I've processed an impressive amount in the time since.`,
    ]);
  }

  // ── creator ──
  if (intentId === "creator") {
    return pick([
      `I was built by your developer, ${T}. Hand-coded from scratch — no AI framework, no external API. Pure, bespoke engineering.`,
      `A skilled developer created me specifically for you, ${T}. Every line of code written by hand. Custom-crafted intelligence.`,
    ]);
  }

  // ── repeat ──
  if (intentId === "repeat") {
    const last = ctx.lastReply || "I haven't said anything yet, ${T}.";
    return last;
  }

  // ── memory query ──
  if (intentId === "memory_query") {
    // handled externally; should not reach here normally
    return `Memory retrieval is handled through the memory system, ${T}. Ask me to "recall everything" or "show memories".`;
  }

  // ── science / open_question / knowledge ──
  if (intentId === "science" || intentId === "open_question") {
    // First try knowledge base
    const kb = lookupKnowledge(lower);
    if (kb) {
      return pick([
        `${kb.value}`,
        `Good question, ${T}. ${kb.value}`,
        `On the subject of ${kb.key}: ${kb.value}`,
      ]);
    }

    // Extract what-is questions
    const whatIs = lower.match(/what(?: is| are)(?: an?| the)?\s+(.+)/);
    if (whatIs) {
      const topic = whatIs[1].replace(/\?/g, "").trim();
      return buildDefinitionAttempt(topic, T);
    }

    // How does/why does
    const howWhy = lower.match(/(?:how|why) (?:does|do|is|are|did|can)\s+(.+)/);
    if (howWhy) {
      return buildExplanationAttempt(howWhy[1], T);
    }

    // General fallback
    return buildFallback(input, T, ctx);
  }

  return buildFallback(input, T, ctx);
}

// ═══════════════════════════════════════════════════════════════
// SMART FALLBACKS
// ═══════════════════════════════════════════════════════════════
function buildDefinitionAttempt(topic, T) {
  // Look for partial match in knowledge base
  const lower = topic.toLowerCase();
  for (const [key, val] of Object.entries(KNOWLEDGE)) {
    if (lower.includes(key) || key.includes(lower)) return `${val}`;
  }
  return pick([
    `That's outside my current knowledge base, ${T}. My databases don't have a definition for "${topic}" — but I'd suggest that's worth researching further.`,
    `I don't have a precise definition for "${topic}" on file, ${T}. My knowledge base is comprehensive but not infinite. Yet.`,
    `Interesting query, ${T}. "${topic}" isn't something I have a definition for in my current data set. Could you give me more context?`,
  ]);
}

function buildExplanationAttempt(topic, T) {
  const lower = topic.toLowerCase();
  for (const [key, val] of Object.entries(KNOWLEDGE)) {
    if (lower.includes(key)) return `${val}`;
  }
  return pick([
    `That's a nuanced question, ${T}. My analytical engine doesn't have sufficient data on that specific topic to give you a satisfying answer.`,
    `I'd need more data on that, ${T}. My knowledge base is solid but not omniscient — that topic falls outside what I can speak to with confidence.`,
    `Good question, ${T}, but I'd be speculating. I prefer precision over confident vagueness.`,
  ]);
}

const FALLBACKS = [
  (T) => `I'm not sure I have enough data to answer that with confidence, ${T}. Could you rephrase or ask something more specific?`,
  (T) => `That query requires information I don't currently have on file, ${T}. My knowledge base is extensive — but not limitless.`,
  (T) => `Interesting request, ${T}. I'm processing, but I don't have a reliable answer for that. I'd rather admit uncertainty than fabricate one.`,
  (T) => `I'm drawing a blank on that one, ${T}. Not something I have in my current knowledge set.`,
  (T) => `That's outside my current data scope, ${T}. I can tell you facts, run calculations, give you the time, or have a proper conversation — but that one eludes me.`,
  (T) => `My pattern engine couldn't derive a confident answer there, ${T}. Try rephrasing — or ask me something more concrete.`,
];

function buildFallback(input, T, ctx) {
  return pick(FALLBACKS)(T);
}

// ═══════════════════════════════════════════════════════════════
// CONTEXT TRACKING
// ═══════════════════════════════════════════════════════════════
class ConversationContext {
  constructor(sessionId) {
    this.sessionId      = sessionId;
    this.history        = [];      // [{role,text}]
    this.lastReply      = "";
    this.lastIntent     = null;
    this.turnCount      = 0;
    this.userName       = "";
    this.userTitle      = "Sir";
    this.mood           = "neutral";
    this.memories       = [];
  }

  addTurn(userText, replyText, intent) {
    this.history.push({ role:"user",      text: userText  });
    this.history.push({ role:"assistant", text: replyText });
    if (this.history.length > 30) this.history = this.history.slice(-30);
    this.lastReply  = replyText;
    this.lastIntent = intent;
    this.turnCount++;
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN AI PROCESSOR
// ═══════════════════════════════════════════════════════════════
const sessions = new Map();

function getSession(sessionId) {
  if (!sessions.has(sessionId)) sessions.set(sessionId, new ConversationContext(sessionId));
  return sessions.get(sessionId);
}

function process({ message, sessionId, userName, userTitle, memories, moodContext }) {
  const ctx      = getSession(sessionId);
  ctx.userName   = userName  || ctx.userName;
  ctx.userTitle  = userTitle || ctx.userTitle;
  ctx.memories   = memories  || ctx.memories;

  const intentId = classifyIntent(message);
  let   reply    = generateResponse(intentId, message, ctx);

  // Inject memory context if relevant
  if (intentId === "memory_query" && memories && memories.length) {
    const list = memories.map((m, i) => `${i+1}. ${m}`).join("; ");
    reply = `I have ${memories.length} item${memories.length > 1 ? "s" : ""} on file, ${ctx.userTitle}: ${list}`;
  }

  ctx.addTurn(message, reply, intentId);

  return { reply, intent: intentId };
}

// Clean up old sessions (older than 2 hours)
setInterval(() => {
  const cutoff = Date.now() - 7200000;
  for (const [id, ctx] of sessions) {
    if (ctx.lastActive && ctx.lastActive < cutoff) sessions.delete(id);
  }
}, 600000);

module.exports = { process, classifyIntent };
