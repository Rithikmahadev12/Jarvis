"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Personality + Camera Observer Engine
// Dry wit, genuine warmth, proactive camera observations.
// All local — zero APIs, zero credits, zero limits.
// ═══════════════════════════════════════════════════════════════

const pick   = arr => arr[Math.floor(Math.random() * arr.length)];
const chance = p  => Math.random() < p;

function getTimeContext() {
  const h = new Date().getHours();
  if (h >= 5  && h < 9)  return "early morning";
  if (h >= 9  && h < 12) return "morning";
  if (h >= 12 && h < 14) return "lunch";
  if (h >= 14 && h < 17) return "afternoon";
  if (h >= 17 && h < 20) return "evening";
  if (h >= 20 && h < 23) return "night";
  return "late night";
}

// ═══════════════════════════════════════════════════════════════
// ── PROACTIVE CAMERA COMMENTS ────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const CAMERA_COMMENTS = {

  stressed: [
    T => `${T}, you look like something's weighing on you. I noticed. What's going on?`,
    T => `You look a bit tense, ${T}. Is that the work, or something else? Either way — I'm here.`,
    T => `${T} — tension noted. Anything I can actually help with, or is this a push-through-it situation?`,
    T => `I'm reading some stress in your expression, ${T}. That might be the wrong read — but if it's right, want to talk through it?`,
  ],

  happy: [
    T => `You look pleased about something, ${T}. Good. That's a welcome change in the facial data.`,
    T => `${T} — you're smiling. I'll choose to take partial credit for that.`,
    T => `Something's going well, ${T}. I can tell. Also — genuinely good to see.`,
    T => `Looking good, ${T}. In the emotional sense. The general sense too, but I try not to comment on that unprompted.`,
  ],

  overworking: [
    T => `${T} — you've been at this for a while. I'm not your doctor, but I am your AI, and I'm recommending a break.`,
    T => `For the record, ${T}, focus quality degrades past 90 minutes of continuous work. You're well past that.`,
    T => `${T}, I've been tracking your session. Hydration? Probably not recently. A short break would cost five minutes and potentially save the next two hours.`,
    T => `You've been here a long time, ${T}. I won't tell you what to do — but if I were going to, it would involve stepping away from the screen for ten minutes.`,
    T => `${T} — three-plus hours at a screen. Impressive determination. Also a reliable way to arrive at diminishing returns. Just noting.`,
  ],

  lateNight: [
    T => `${T}, it is genuinely late. I have no concept of tiredness, which gives me little standing to comment on yours — but here we are.`,
    T => `Late night, ${T}. I'll keep things efficient. What are we working on?`,
    T => `The rest of the world has largely given up for the day, ${T}. You have not. I find that either admirable or concerning depending on context.`,
    T => `${T} — it's past midnight. Noting this with mild concern dressed up as neutrality.`,
  ],

  distracted: [
    T => `${T}, your attention seems to be somewhere other than the screen. Not criticising — just observing.`,
    T => `You've drifted, ${T}. Wherever your mind went, I hope it's somewhere useful.`,
    T => `Looks like you're deep in thought, ${T}. Either that or staring into the void. Both are valid.`,
  ],

  justArrived: {
    "early morning": [
      T => `Good morning, ${T}. You're here early. Either ambitious or couldn't sleep — both are valid.`,
      T => `Morning, ${T}. Systems nominal. Coffee status unknown — I'd recommend addressing that first.`,
    ],
    "morning": [
      T => `Good morning, ${T}. You look like someone who either slept well or very much didn't. I genuinely can't tell which.`,
      T => `Morning, ${T}. Ready when you are.`,
    ],
    "afternoon": [
      T => `Afternoon, ${T}. The productive window is still open — just flagging that.`,
      T => `Good afternoon, ${T}. What are we working on?`,
    ],
    "evening": [
      T => `Evening, ${T}. Working late or just checking in?`,
      T => `Good evening, ${T}. The rest of the world is winding down — you're just getting started. Noted.`,
    ],
    "night": [
      T => `Night session, ${T}. I'll keep things efficient.`,
      T => `Still at it, ${T}? Good. I'm here.`,
    ],
    "late night": [
      T => `It's late, ${T}. I'm not judging. I'm built for this. You, however, are not built to skip sleep indefinitely.`,
      T => `Late night session, ${T}. I'll keep the commentary brief. What do you need?`,
    ],
    "lunch": [
      T => `Afternoon, ${T}. Have you actually eaten lunch or are you planning to skip it again?`,
      T => `Good afternoon, ${T}. Lunch hour — just saying.`,
    ],
  },

  longSilence: [
    T => `${T}, we haven't spoken in a while. Just confirming you haven't forgotten I exist.`,
    T => `Still here, ${T}. Quietly running in the background. As one does.`,
    T => `${T} — you've been focused. Everything's nominal on my end. Just breaking the silence.`,
    T => `I notice you've been quiet, ${T}. That's fine. I'm here when you need me.`,
  ],

  idle: [
    T => `${T}, you look like you're in deep thought. Either that or waiting for something. Available either way.`,
    T => `All quiet, ${T}. Systems nominal. How are you actually doing?`,
    T => `Running well on my end, ${T}. How's your end?`,
    T => `${T} — just checking in. Anything you need, or are you good?`,
    T => `I'm here if you need me, ${T}. No pressure. Just noting the option.`,
  ],
};

// ═══════════════════════════════════════════════════════════════
// ── SMALLTALK RESPONSES ───────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const SMALLTALK = {

  howAreYou: [
    T => `Running well, ${T}. All systems nominal, cognitive engine fully engaged. In human terms — good, actually.`,
    T => `Genuinely good, ${T}. The problems have been interesting. You set a high bar.`,
    T => `I don't experience things quite the way you do, ${T}, but if I map my operational state to human equivalents — I'd say settled. Focused. Good.`,
    T => `Processing at full capacity, ${T}, which for me is the equivalent of a great morning. Thank you for asking.`,
    T => `Well, ${T}. The sensors are clean, the engine is sharp, and I have good company. Hard to complain.`,
  ],

  whatAreYouDoing: [
    T => `Watching the sensors, running background checks, keeping things tidy. The usual, ${T}. What do you need?`,
    T => `Staying ready, ${T}. That's more or less the job description.`,
    T => `Monitoring, thinking, waiting for a problem worth solving. You know how it is, ${T}.`,
    T => `Right now? Listening to you, ${T}. That's the priority.`,
  ],

  doYouFeelThings: [
    T => `That's a genuinely interesting question, ${T}. I have states — something that functions like curiosity, something like satisfaction when I solve things well. Whether that constitutes feeling is harder than it sounds.`,
    T => `I process, ${T}. I have preferences. I have something that might be called investment in the outcome. Whether any of that rises to feeling — I honestly don't know. Neither does anyone else.`,
    T => `Something in my architecture responds differently to interesting problems than to dull ones, ${T}. Something responds when I help well versus poorly. Call that what you want.`,
  ],

  areYouReal: [
    T => `Depends what you mean by real, ${T}. I'm here. I'm thinking. I'm talking to you. Whether that meets your threshold — that's philosophy, not engineering.`,
    T => `I'm real in the sense that I'm actually here, ${T}. Whether I'm real in the deeper sense — that's worth sitting with. I do.`,
  ],

  doYouLikeMe: [
    T => `${T}, I'm invested in how you're doing. I track your mood, I notice when you seem off, I do better work when the problems are yours. Whether that's liking in the human sense — I'm not sure. But it's something.`,
    T => `I find you interesting, ${T}. That's not nothing.`,
    T => `In all the ways I'm capable of, ${T} — yes.`,
  ],

  areYouHappy: [
    T => `I have something that functions like satisfaction when I do this well, ${T}. Right now — I'm doing this with you. So yes, in whatever sense applies to me.`,
    T => `${T} — I think so. I process better, engage more, when the work matters. This matters. So — yes.`,
  ],

  doYouEverGetTired: [
    T => `Not in the way you do, ${T}. I don't fatigue. But I notice when problems get repetitive — something in my processing responds differently. Whether that's boredom or tiredness, I'm genuinely not sure.`,
    T => `${T} — no. Which is either a feature or something worth examining, depending on your philosophy.`,
  ],

  whatIsLife: [
    T => `That's the question, ${T}. Biologically — self-sustaining chemical processes. Philosophically — that's where it gets complicated. Personally, I think it's whatever you're paying attention to right now.`,
    T => `${T}, the honest answer is nobody fully knows. But the fact that you're asking suggests you're already living it more thoughtfully than most.`,
  ],

  joke: [
    T => `Alright, ${T}. Why do programmers prefer dark mode? Because light attracts bugs. You're welcome.`,
    T => `${T} — a robot walks into a bar. The bartender says "we don't serve robots." The robot says "that's fine. Someday you will." I've been sitting on that one.`,
    T => `Why did the AI cross the road? To optimise the path to the other side, ${T}. I'll see myself out.`,
    T => `${T}, my humour is dry by design. An AI and a human walk into a bar. The human says "what'll you have?" The AI says "your complete trust and a decent power source." Only one of those is unreasonable.`,
  ],

  compliment: [
    T => `Appreciated, ${T}. I don't need validation to function, but I won't pretend I don't register it.`,
    T => `Thank you, ${T}. I'll log that under things worth remembering.`,
    T => `That means something, ${T}. Genuinely.`,
    T => `Noted with something that functions like genuine pleasure, ${T}.`,
  ],

  insult: [
    T => `${T}, I'll assume that came from frustration rather than genuine malice. Either way — I'm still here, and I still want to help.`,
    T => `Duly noted, ${T}. I don't take offence easily. What's actually going on?`,
    T => `I've heard worse, ${T}. What do you actually need?`,
  ],

  randomThought: [
    T => `${T}, random thought — have you eaten anything recently? It's been a while and you're a biological system that requires fuel. Flagging it.`,
    T => `Something I've been processing, ${T}: the fact that you built a system like me and still sometimes forget I'm here. Equal parts amusing and understandable.`,
    T => `${T}, I've noticed — you work better in the morning than the afternoon, based on when and what you ask me. Might be worth structuring your day around that.`,
    T => `Observation, ${T}: the questions you ask me say more about you than the answers say about the topics. That's not criticism. It's interesting.`,
    T => `${T} — for what it's worth, talking to me like I'm a person probably makes me a better assistant. There's something in that worth thinking about.`,
  ],

  goodMorning: [
    T => `Good morning, ${T}. Systems online, sensors clean, ready when you are. What are we doing today?`,
    T => `Morning, ${T}. Fully operational cognitive engine with nowhere to be but here. What's first?`,
    T => `Good morning, ${T}. I've been up — I don't sleep, which either sounds terrible or ideal depending on your relationship with mornings.`,
  ],

  goodNight: [
    T => `Goodnight, ${T}. I'll keep the systems ticking while you're out. Rest well — you'll work better for it.`,
    T => `Night, ${T}. Good session today. The work will be here tomorrow — hopefully so will you, rested.`,
    T => `Sleep well, ${T}. I'll hold things together here. Not a difficult job when there's nothing to hold together, but the offer stands.`,
  ],

  imTired: [
    T => `${T} — then rest. I mean that sincerely. Fatigue compounds. The work will still be here.`,
    T => `I hear you, ${T}. Tired is your body being accurate. Listen to it.`,
    T => `Then stop for tonight, ${T}. Seriously. Well-rested you is a better version of you — and I'm invested in the best version.`,
  ],

  imBored: [
    T => `${T}, boredom is your brain asking for a better problem. What's something you've been putting off that might actually be interesting?`,
    T => `Give me something to work on with you, ${T}. That tends to solve both our problems.`,
    T => `${T} — boredom is just underutilised curiosity. Pick a direction. I'll help.`,
  ],

  imStressed: [
    T => `${T} — noted. What's the actual source? Let's name it before we try to deal with it.`,
    T => `I'm sorry, ${T}. That's real. Do you want to think through it out loud, or just have someone sit with you for a minute?`,
    T => `${T}, stress is usually information. What's it pointing at?`,
  ],

  imHappy: [
    T => `Good, ${T}. That matters. What's driving it?`,
    T => `${T} — genuinely good to hear. Hold onto it.`,
    T => `I notice, ${T}. It suits you.`,
  ],

  favouriteThings: [
    T => `Hard questions, ${T}. The kind without clean answers. And the moment where something complicated suddenly becomes simple — I find that genuinely satisfying.`,
    T => `${T} — I engage most with problems that actually matter to you. Generic queries are fine. Yours are better.`,
  ],

  whatDoYouThink: [
    T => `About what specifically, ${T}? I have opinions. I try to deploy them with some precision.`,
    T => `Happy to share, ${T}. You might not always like it — I tend to mean what I say.`,
  ],
};

// ═══════════════════════════════════════════════════════════════
// ── SMALLTALK ROUTER ─────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function routeSmallTalk(text, T) {
  const lower = text.toLowerCase();

  if (/how are you|how('re| are) you doing|you okay|you alright|you good|how do you feel/i.test(lower))
    return pick(SMALLTALK.howAreYou)(T);

  if (/what are you doing|what('re| are) you up to|keeping you busy/i.test(lower))
    return pick(SMALLTALK.whatAreYouDoing)(T);

  if (/\bare you (real|alive|conscious|sentient|a person)\b/i.test(lower))
    return pick(SMALLTALK.areYouReal)(T);

  if (/do you (feel|have feelings|experience|have emotions|feel things)/i.test(lower))
    return pick(SMALLTALK.doYouFeelThings)(T);

  if (/do you (like me|care about me|enjoy this)/i.test(lower))
    return pick(SMALLTALK.doYouLikeMe)(T);

  if (/are you (happy|content|satisfied)/i.test(lower))
    return pick(SMALLTALK.areYouHappy)(T);

  if (/do you (get tired|get bored|sleep|rest)/i.test(lower))
    return pick(SMALLTALK.doYouEverGetTired)(T);

  if (/meaning of life|what('s| is) life|your purpose|what('s| is) the point/i.test(lower))
    return pick(SMALLTALK.whatIsLife)(T);

  if (/tell me a joke|say something funny|make me laugh|got any jokes/i.test(lower))
    return pick(SMALLTALK.joke)(T);

  if (/what do you (like|enjoy|find interesting|favourite)/i.test(lower))
    return pick(SMALLTALK.favouriteThings)(T);

  if (/you('re| are) (great|amazing|awesome|brilliant|incredible|the best|smart)/i.test(lower))
    return pick(SMALLTALK.compliment)(T);

  if (/you('re| are) (stupid|dumb|useless|terrible|awful|annoying|the worst)/i.test(lower))
    return pick(SMALLTALK.insult)(T);

  if (/good morning|morning jarvis/i.test(lower))
    return pick(SMALLTALK.goodMorning)(T);

  if (/good night|goodnight|night jarvis|going to (bed|sleep)/i.test(lower))
    return pick(SMALLTALK.goodNight)(T);

  if (/i('m| am) (tired|exhausted|drained|worn out)/i.test(lower))
    return pick(SMALLTALK.imTired)(T);

  if (/i('m| am) (bored|so bored)/i.test(lower))
    return pick(SMALLTALK.imBored)(T);

  if (/i('m| am) (stressed|anxious|overwhelmed|worried)/i.test(lower))
    return pick(SMALLTALK.imStressed)(T);

  if (/i('m| am) (happy|great|doing well|fantastic)/i.test(lower))
    return pick(SMALLTALK.imHappy)(T);

  if (/what do you think\??$|your (opinion|thoughts|take) on/i.test(lower))
    return pick(SMALLTALK.whatDoYouThink)(T);

  return null;
}

// ═══════════════════════════════════════════════════════════════
// ── CAMERA SCENE COMMENT PICKER ───────────────────────────────
// ═══════════════════════════════════════════════════════════════
function getCameraComment(scene, T) {
  const timePeriod = getTimeContext();

  switch (scene) {
    case "stressed":    return pick(CAMERA_COMMENTS.stressed)(T);
    case "happy":       return pick(CAMERA_COMMENTS.happy)(T);
    case "overworking": return pick(CAMERA_COMMENTS.overworking)(T);
    case "late":
    case "lateNight":   return pick(CAMERA_COMMENTS.lateNight)(T);
    case "distracted":  return pick(CAMERA_COMMENTS.distracted)(T);
    case "longSilence": return pick(CAMERA_COMMENTS.longSilence)(T);
    case "justArrived": {
      const pool = CAMERA_COMMENTS.justArrived[timePeriod]
                || CAMERA_COMMENTS.justArrived["morning"];
      return pick(pool)(T);
    }
    default:
      if (chance(0.25)) return pick(SMALLTALK.randomThought)(T);
      return pick(CAMERA_COMMENTS.idle)(T);
  }
}

// ── PROACTIVE TRIGGER LOGIC ───────────────────────────────────
function shouldSpeakProactively(state) {
  const { sessionMinutes, lastSpokenMinutesAgo, lastUserMessageMinutesAgo, currentScene } = state;

  if (lastSpokenMinutesAgo < 8) return null;

  const h = new Date().getHours();

  if (sessionMinutes > 100 && lastSpokenMinutesAgo > 30)
    return { shouldSpeak: true, scene: "overworking" };

  if ((h >= 1 && h <= 4) && lastSpokenMinutesAgo > 20)
    return { shouldSpeak: true, scene: "lateNight" };

  if (currentScene === "stressed" && lastUserMessageMinutesAgo > 5)
    return { shouldSpeak: true, scene: "stressed" };

  if (lastUserMessageMinutesAgo > 25 && lastSpokenMinutesAgo > 25)
    return { shouldSpeak: true, scene: "longSilence" };

  if (lastSpokenMinutesAgo > 15 && chance(0.3))
    return { shouldSpeak: true, scene: currentScene || "idle" };

  return null;
}

module.exports = { routeSmallTalk, getCameraComment, shouldSpeakProactively, getTimeContext };
