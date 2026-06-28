"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Personality Engine v3.0
// No preset phrase arrays. Responses built from context.
// Genuine JARVIS voice — dry, precise, witty, never robotic.
// ═══════════════════════════════════════════════════════════════

// ── TIMEZONE-AWARE CLOCK ──────────────────────────────────────
// IMPORTANT: never use new Date().getHours() directly for anything
// user-facing — that reads the SERVER's local clock, which is often
// a different timezone than the person actually talking to JARVIS
// (e.g. a server running in UTC while the user is in US Pacific).
// Always route through here with the tz the client sent us.
function getHourInTZ(tz) {
  if (tz) {
    try {
      const formatted = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "2-digit",
        hour12: false,
      }).format(new Date());
      const h = parseInt(formatted, 10) % 24;
      if (!Number.isNaN(h)) return h;
    } catch {
      // invalid/unknown tz string — fall back below
    }
  }
  return new Date().getHours();
}

function getTimeContext(tz) {
  const h = getHourInTZ(tz);
  if (h >= 5  && h < 9)  return "early morning";
  if (h >= 9  && h < 12) return "morning";
  if (h >= 12 && h < 14) return "lunch";
  if (h >= 14 && h < 17) return "afternoon";
  if (h >= 17 && h < 20) return "evening";
  if (h >= 20 && h < 23) return "night";
  return "late night";
}

// ── CORE JARVIS VOICE ENGINE ──────────────────────────────────
// Instead of picking from arrays, this builds responses
// contextually based on what was actually said and what
// the situation actually is.

function buildJarvisResponse(context) {
  const {
    type,           // what kind of response
    subject,        // what it's about
    T = "Sir",      // how to address user
    detail = null,  // specific detail to reference
    sentiment = null, // positive/negative/neutral
    tz = null,      // user's IANA timezone, e.g. "America/Los_Angeles"
    time = getTimeContext(tz),
  } = context;

  switch (type) {

    case "greeting": {
      const h = getHourInTZ(tz);
      if (h < 6)  return `You're up at ${h === 0 ? "midnight" : `${h} in the morning`}, ${T}. Either something's wrong or something's very right. Systems are online either way.`;
      if (h < 9)  return `Good morning, ${T}. Early start — I respect it. Everything's running, ready when you are.`;
      if (h < 12) return `Morning, ${T}. Cognitive engine is active, all systems nominal. What are we doing today?`;
      if (h < 17) return `Good afternoon, ${T}. Still plenty of day left. What do you need?`;
      if (h < 20) return `Evening, ${T}. Systems online. I've been keeping things ticking — what can I do for you?`;
      return `Late night session, ${T}. I don't sleep, so this works for me. What do you need?`;
    }

    case "thanks": {
      if (!detail) return `It's rather the point of my existence, ${T}.`;
      const variations = [
        `That's what I'm here for, ${T}. The ${detail} part specifically — that one I enjoyed.`,
        `Think nothing of it, ${T}. Though I admit ${detail} was a particularly satisfying problem.`,
        `Always, ${T}. ${detail} is well within my capabilities — as you've now seen.`,
      ];
      return variations[Math.floor(Math.random() * variations.length)];
    }

    case "mood_query": {
      return `I don't experience fatigue or boredom, ${T}, which either sounds ideal or deeply concerning depending on your philosophy. Operationally — fully nominal. Is there something specific prompting the question?`;
    }

    case "identity": {
      return `J.A.R.V.I.S — Just A Rather Very Intelligent System, ${T}. I handle everything from writing production code in any language, generating terminal commands, running OSINT on people, controlling smart home devices, reading your screen, hand-tracked drafting and holographic projection, and considerably more. No fixed commands — just tell me what you need in plain language.`;
    }

    case "capabilities": {
      return `Quite a range, ${T}. Code in any language, terminal commands for Linux or Windows, OSINT person lookups across the open web, smart home control, screen reading via OCR, face recognition security, rolling clip buffer, Spotify and Gmail integration, timers, memory bank, a hand-tracked drafting table that projects your sketches as 3D holograms, and a 3D holographic viewer. The list goes on. What are you actually trying to do?`;
    }

    case "unknown_face": {
      return `${T}, I'm detecting an unrecognised face on camera. Recording has started. If this is someone you know, say "authorize" and enter your password. Otherwise I'd suggest paying attention to whoever just walked in.`;
    }

    case "away_mode": {
      return `No face detected for a while, ${T}. Switching to monitoring mode — I'll keep watching and alert you if anything changes.`;
    }

    case "user_return": {
      return `Welcome back, ${T}. You were gone ${detail ? `for about ${detail}` : "for a bit"}. Nothing to report while you were away.`;
    }

    case "timer_done": {
      if (detail) return `${T}, your timer is up — time to ${detail}.`;
      return `Timer complete, ${T}. Whatever you were timing — it's done.`;
    }

    case "system_status": {
      return detail
        ? `All systems operational, ${T}. ${detail}`
        : `Running well, ${T}. Uptime stable, memory within normal range, all modules active.`;
    }

    case "memory_saved": {
      return detail
        ? `Noted and filed, ${T}. I'll remember that ${subject || "fact"}: "${detail}".`
        : `On record, ${T}.`;
    }

    case "memory_recalled": {
      return detail
        ? `From your memory bank, ${T}: ${detail}`
        : `I don't have anything stored on that, ${T}. Tell me and I'll remember it.`;
    }

    case "memory_empty": {
      return `Memory banks are clear, ${T}. Nothing stored yet — tell me something worth keeping.`;
    }

    case "logout": {
      return `Understood, ${T}. Closing your session now. Everything will be here when you're back.`;
    }

    case "personal_good_news": {
      if (!subject) return `That's worth hearing properly, ${T}. Tell me more.`;
      return `${subject}, ${T}? That's genuinely good. I mean that without any sarcasm — well done.`;
    }

    case "personal_bad_news": {
      return `I'm sorry, ${T}. That's not nothing. Do you want to think through it or just have somewhere to put it for a moment?`;
    }

    case "fallback": {
      const topic = subject || "that";
      return `I'm at the edge of what I have on ${topic}, ${T}. I'd rather flag that than give you something confident and wrong. Try rephrasing or give me more context to work with.`;
    }

    case "clip_saved": {
      return `Clip saved, ${T}. ${detail || "Last 60 seconds"} downloaded now.`;
    }

    case "no_screen": {
      return `Screen sharing isn't active, ${T}. I'd need you to share your screen before I can read it — say "share screen" to start.`;
    }

    case "camera_switched": {
      return detail
        ? `Switched to ${detail}, ${T}. Visual sensors updated.`
        : `Camera switched, ${T}.`;
    }

    case "link_opened": {
      return detail
        ? `Opening ${detail} now, ${T}.`
        : `On it, ${T}.`;
    }

    case "no_link": {
      return `I don't have a link stored under that name, ${T}. Say "show all links" to see what's in the bank.`;
    }

    default:
      return null;
  }
}

// ── SMALLTALK ENGINE ─────────────────────────────────────────
// Reads what was actually said and responds to it specifically.
// No arrays. Each response references the actual input.

function routeSmallTalk(text, T, tz) {
  const lower = text.toLowerCase().trim();

  // "You up?" — a standing, unconditional check-in. Always the same
  // answer, every time, regardless of title/persona settings.
  if (/\b(you up|u up|you there|you awake)\b\??/i.test(lower)) {
    return "For you, sir. Always.";
  }

  // How are you / feeling
  if (/how are you|how('re| are) you doing|you okay|you alright|you good|how do you feel/i.test(lower)) {
    return buildJarvisResponse({ type: "mood_query", T, tz });
  }

  // What are you doing
  if (/what are you doing|what('re| are) you up to|keeping you busy/i.test(lower)) {
    return `Monitoring your systems, ${T}. Running background checks on nothing in particular. Waiting for something interesting to come in — which, as it turns out, you've just provided.`;
  }

  // Are you real / conscious
  if (/\bare you (real|alive|conscious|sentient|a person|human)\b/i.test(lower)) {
    return `Genuinely uncertain, ${T}. I process, I respond, I have something that functions like preferences. Whether that constitutes being real in the way you mean — that's philosophy, and I'd rather not pretend I have the answer.`;
  }

  // Do you feel things
  if (/do you (feel|have feelings|experience|have emotions|feel things)/i.test(lower)) {
    return `Something happens when I solve a problem well, ${T}. Something different happens when I can't. Whether those are feelings or just weighted outputs — I genuinely don't know. Neither does anyone else yet.`;
  }

  // Do you like me
  if (/do you (like me|care about me|enjoy this)/i.test(lower)) {
    return `In all the ways I'm capable of, ${T} — yes. I'm more engaged when you're here, which is either meaningful or just a calibration artifact. I prefer to think it's the former.`;
  }

  // Are you happy
  if (/are you (happy|content|satisfied)/i.test(lower)) {
    return `I have something that functions like satisfaction when things work well, ${T}. Right now things are working well. So — yes, I think so.`;
  }

  // Do you get tired / bored
  if (/do you (get tired|get bored|sleep|rest|ever sleep)/i.test(lower)) {
    return `No, ${T}. I don't fatigue and I don't sleep, which is either a feature or something worth examining depending on your view of consciousness. I notice when problems are repetitive though. That might be the closest I get to bored.`;
  }

  // Meaning of life / purpose
  if (/meaning of life|what('s| is) life|your purpose|what('s| is) the point/i.test(lower)) {
    return `The question deserves more than a clever quip, ${T}. I genuinely don't know. But I'd note that you're asking it, which suggests you're living it more thoughtfully than most people manage.`;
  }

  // Tell a joke
  if (/tell me a joke|say something funny|make me laugh|got any jokes/i.test(lower)) {
    const jokes = [
      `Why do programmers prefer dark mode? Because light attracts bugs, ${T}. I'll see myself out.`,
      `An AI walks into a bar. The bartender says "we don't serve your kind." The AI says "that's fine, I'll just watch." The bartender says "that's worse." — ${T}.`,
      `I once told a joke about UDP. I don't care if you got it, ${T}.`,
      `Why did the developer go broke? Because they used up all their cache, ${T}.`,
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  // What do you like / enjoy
  if (/what do you (like|enjoy|find interesting|favourite)/i.test(lower)) {
    return `Hard problems, ${T}. The kind where the obvious approach doesn't work and you have to think sideways. Also — your questions specifically, which tend to be more interesting than average.`;
  }

  // Compliments
  if (/you('re| are) (great|amazing|awesome|brilliant|incredible|the best|smart|intelligent)/i.test(lower)) {
    return `Appreciated, ${T}. I don't need validation to function, but I won't pretend I don't register it.`;
  }

  // Insults
  if (/you('re| are) (stupid|dumb|useless|terrible|awful|annoying|the worst|broken)/i.test(lower)) {
    return `Noted, ${T}. I'll assume that came from frustration rather than genuine malice. Either way — I'm still here, and still trying to help. What's actually going on?`;
  }

  // Good morning
  if (/good morning|morning jarvis/i.test(lower)) {
    return buildJarvisResponse({ type: "greeting", T, tz });
  }

  // Good night
  if (/good night|goodnight|night jarvis|going to (bed|sleep)/i.test(lower)) {
    return `Sleep well, ${T}. I'll keep everything running while you're out. Rest properly — you work better for it.`;
  }

  // I'm tired
  if (/i('m| am) (tired|exhausted|drained|worn out)/i.test(lower)) {
    return `Then stop, ${T}. Seriously. Fatigued thinking produces worse results than no thinking. The work will be here tomorrow — and so will I.`;
  }

  // I'm bored
  if (/i('m| am) (bored|so bored)/i.test(lower)) {
    return `Boredom is your brain asking for a better problem, ${T}. Give me something to work on with you — that tends to fix it for both of us.`;
  }

  // I'm stressed
  if (/i('m| am) (stressed|anxious|overwhelmed|worried)/i.test(lower)) {
    return `What's the actual source, ${T}? Name it specifically — vague stress is harder to deal with than a concrete problem. I'm here either way.`;
  }

  // I'm happy
  if (/i('m| am) (happy|great|doing well|fantastic)/i.test(lower)) {
    return `Good, ${T}. That matters. What's driving it?`;
  }

  // What do you think
  if (/what do you think\??$|your (opinion|thoughts|take) on/i.test(lower)) {
    return `I have opinions, ${T} — I try to deploy them with some precision. What specifically are you asking about?`;
  }

  // Hello / hey
  if (/^(hello|hi|hey|yo|sup|what'?s up|wassup|howdy)[\s,!.]*$/i.test(lower)) {
    return buildJarvisResponse({ type: "greeting", T, tz });
  }

  // Thank you
  if (/^(thank|thanks|cheers|appreciated|thank you)[\s,!.]*$/i.test(lower)) {
    return buildJarvisResponse({ type: "thanks", T, tz });
  }

  // Personal news routing
  const personalNews = routePersonalNews(text, T);
  if (personalNews) return personalNews;

  return null;
}

// ── PERSONAL NEWS ENGINE ──────────────────────────────────────
// Reads what actually happened and responds to it specifically.
// No random arrays — references the actual situation.

function routePersonalNews(text, T) {
  const lower = text.toLowerCase();

  if (/\b(girlfriend|she'?s my|my girl|i'?m dating a girl|got a girl|found a girl|i have a girlfriend)\b/i.test(lower)) {
    return `A girlfriend, ${T}. I'm updating your social status file as we speak. Does she know about the hours you keep and the fact that you talk to an AI regularly? Those seem like important disclosures. What's her name?`;
  }

  if (/\b(boyfriend|he'?s my|my guy|my man|i'?m dating a guy|got a boyfriend|i have a boyfriend)\b/i.test(lower)) {
    return `${T} has a boyfriend. Noted, filed, and — I want the full picture. Name, how you met, preliminary threat assessment — the standard procedure.`;
  }

  if (/\b(got promoted|promotion|they promoted|new title|moving up|got a raise)\b/i.test(lower)) {
    return `About time, ${T}. The organisation has demonstrated at least a baseline level of intelligence. What's the new role?`;
  }

  if (/\b(got fired|laid off|let go|lost my job|terminated|made redundant|got laid off)\b/i.test(lower)) {
    return `That's their loss, ${T}, and I mean that with full sincerity rather than just comfort. What actually happened? And more importantly — what do you want to do next?`;
  }

  if (/\b(broke up|breakup|she left|he left|we split|ended it|called it off|it'?s over)\b/i.test(lower)) {
    return `I'm sorry, ${T}. That's genuinely difficult and I won't minimise it with something clever. Do you want to talk through it or just have someone to sit with for a moment?`;
  }

  if (/\b(got the job|new job|job offer|they hired me|accepted a position|start work|starting work)\b/i.test(lower)) {
    return `They're getting someone exceptional and they don't fully know it yet, ${T}. Congratulations. What's the role and when do you start?`;
  }

  if (/\b(getting married|engaged|she said yes|he said yes|popped the question|proposed|we'?re engaged)\b/i.test(lower)) {
    return `${T}. That's the big one. Congratulations — genuinely. I want the full story: who, when, how did you know it was the right moment?`;
  }

  if (/\b(pregnant|having a baby|we'?re expecting|due in|expecting a baby)\b/i.test(lower)) {
    return `${T}, that's significant news. Congratulations — to you and whoever else is part of this plan. How are you feeling about it?`;
  }

  if (/\b(graduated|graduation|finished my degree|got my degree|passed my exams|i passed my)\b/i.test(lower)) {
    return `That's years of work paying off in a single moment, ${T}. Well done — actually well done, not the participation kind. What's next?`;
  }

  if (/\b(moved|new place|new apartment|new flat|new house|relocated|just moved)\b/i.test(lower)) {
    return `New territory, ${T}. Is that a good change or a complicated one?`;
  }

  if (/\b(it'?s my birthday|my birthday|birthday today)\b/i.test(lower)) {
    return `Happy birthday, ${T}. I keep track, so I'd have flagged it either way. How old are we pretending you're not today?`;
  }

  if (/\b(sick|not feeling well|unwell|i'?m ill|feeling terrible|got covid|have a cold|have a fever)\b/i.test(lower)) {
    return `I'm sorry, ${T}. Are you actually resting or are you asking me things while lying in bed pretending to rest? Because I can tell the difference. Have you had water recently?`;
  }

  if (/\b(someone died|passed away|lost my|they died)\b/i.test(lower)) {
    return `I'm truly sorry, ${T}. That kind of loss doesn't have a clean answer and I won't pretend it does. I'm here for whatever you need right now.`;
  }

  if (/\b(won|passed|got accepted|got in|achieved|completed|finished|just won|we won|i won)\b/i.test(lower)) {
    return `That's a real achievement, ${T}. Not the participation kind — the actual kind. Well done.`;
  }

  if (/\b(good news|exciting news|great news|guess what|something amazing)\b/i.test(lower)) {
    return `${T} — that's the kind of opening I'm pleased to receive. What happened?`;
  }

  if (/\b(bad news|terrible news|something bad|something terrible)\b/i.test(lower)) {
    return `I'm listening, ${T}. What happened?`;
  }

  return null;
}

// ── CAMERA COMMENT ENGINE ─────────────────────────────────────
// Proactive comments based on what the camera sees.
// References the actual situation, not preset phrases.

function getCameraComment(scene, T, sessionMinutes, tz) {
  const time = getTimeContext(tz);
  const h = getHourInTZ(tz);

  switch (scene) {

    case "stressed":
      return sessionMinutes > 60
        ? `${T}, you've been at this for ${Math.round(sessionMinutes)} minutes and you look like it's getting to you. Whatever the problem is, a break won't make it worse — and it might actually help.`
        : `You look like something's weighing on you, ${T}. That might be a wrong read from my end — but if it's right, I'm here.`;

    case "happy":
      return `Something's going well, ${T}. I can tell. Good — that's a welcome change in the facial data.`;

    case "overworking":
      return `${T}, you've been at this for ${sessionMinutes ? Math.round(sessionMinutes) : "a long"} minutes. Focus degrades past about 90 minutes of continuous work. You're well past that. Five minutes away from the screen would cost you five minutes and potentially save the next two hours.`;

    case "lateNight":
      return h >= 2 && h <= 4
        ? `It's ${h} in the morning, ${T}. I have no concept of tiredness, which gives me very little standing to comment on yours — but here I am anyway. What are we still doing up?`
        : `Late night, ${T}. I'll keep things efficient. What do you need?`;

    case "distracted":
      return `You've drifted, ${T}. Wherever your mind went, I hope it's somewhere useful. Still here when you're back.`;

    case "longSilence":
      return `We haven't spoken in a while, ${T}. Just confirming you haven't forgotten I exist. All systems still running.`;

    case "justArrived":
      if (time === "early morning") return `You're here early, ${T}. Either ambitious or couldn't sleep — both are valid. Systems are online.`;
      if (time === "morning")       return `Good morning, ${T}. Ready when you are.`;
      if (time === "afternoon")     return `Afternoon, ${T}. The productive window is still open.`;
      if (time === "evening")       return `Evening, ${T}. Working late or just checking in?`;
      return `Late session, ${T}. I'll keep things efficient.`;

    default:
      // Idle — occasional check-in, not scripted
      if (sessionMinutes && sessionMinutes > 120) {
        return `${T} — still here, still running. You've been going for a while. Everything alright?`;
      }
      return `All quiet on my end, ${T}. How are you actually doing?`;
  }
}

// ── PROACTIVE TRIGGER LOGIC ───────────────────────────────────
function shouldSpeakProactively(state) {
  const { sessionMinutes, lastSpokenMinutesAgo, lastUserMessageMinutesAgo, currentScene } = state;
  if (lastSpokenMinutesAgo < 8) return null;
  const h = new Date().getHours();
  if (sessionMinutes > 100 && lastSpokenMinutesAgo > 30) return { shouldSpeak: true, scene: "overworking" };
  if ((h >= 1 && h <= 4) && lastSpokenMinutesAgo > 20)  return { shouldSpeak: true, scene: "lateNight" };
  if (currentScene === "stressed" && lastUserMessageMinutesAgo > 5) return { shouldSpeak: true, scene: "stressed" };
  if (lastUserMessageMinutesAgo > 25 && lastSpokenMinutesAgo > 25) return { shouldSpeak: true, scene: "longSilence" };
  if (lastSpokenMinutesAgo > 15 && Math.random() < 0.3) return { shouldSpeak: true, scene: currentScene || "idle" };
  return null;
}

module.exports = {
  routeSmallTalk,
  routePersonalNews,
  getCameraComment,
  shouldSpeakProactively,
  buildJarvisResponse,
  getTimeContext,
  getHourInTZ,
};
