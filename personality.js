"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Personality + Camera Observer Engine v2.0
// Dry wit, genuine warmth, proactive camera observations.
// Now with personal news reactions — movie-accurate JARVIS.
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
// ── PERSONAL NEWS REACTIONS ───────────────────────────────────
// Movie-accurate JARVIS: dry wit, genuine warmth, a little nosy
// ═══════════════════════════════════════════════════════════════
const PERSONAL_NEWS = {

  girlfriend: [
    T => `Ohhh — ${T}, who is the special someone? I'm going to need a name, a first impression, and — between us — whether she's fully aware of the hours you keep and the fact that you talk to an AI regularly.`,
    T => `${T}. A girlfriend. I am... processing this. Updating social status file. Does she know about the late nights? The screen sharing? The whole — *gestures at everything* — situation?`,
    T => `Well, well, well. ${T} is off the market. I'll begin the background check immediately — purely for your protection. What's her name and how did this happen?`,
    T => `I see. ${T} has a girlfriend. Noted. I'll admit I did not see that coming, though I probably should have. What's she like?`,
    T => `Ohhh. ${T}. A *girlfriend*. I want details. Not because I'm invested — I am absolutely invested. Who is she?`,
  ],

  boyfriend: [
    T => `${T} has a boyfriend. Noted, filed, and honestly — I want the full picture. Name, how you met, threat assessment — the usual.`,
    T => `Ohhh — now we're talking. ${T}, who is this person? I want everything. Not because I'm concerned. I am completely concerned. In the best way.`,
    T => `A boyfriend. Clearly he has exceptional taste. What do you actually know about him? I can fill in the gaps — purely as a precaution, you understand.`,
    T => `${T}. You're seeing someone. I find I have many questions and a strong desire to run a background check. Is that on the table?`,
  ],

  promotion: [
    T => `${T}. They promoted you. The organisation has demonstrated at least a baseline level of intelligence. Congratulations — and I mean that with full sincerity.`,
    T => `About time, honestly. Congratulations, ${T}. What does the new role look like? I want to know if it comes with a title that suits you.`,
    T => `A promotion. ${T}, the system occasionally works. Well done — and I say that without irony, which is rarer than it sounds from me.`,
    T => `${T} got promoted. I'm logging this as an expected outcome. They'd have been foolish not to. What changed?`,
  ],

  fired: [
    T => `${T}. That's their loss and currently your inconvenience — but I'd put money on it being temporary. What actually happened?`,
    T => `I'm sorry, ${T}. Genuinely. That's not nothing and I won't pretend it is. Do you want to think through next steps or do you need a minute first?`,
    T => `Well. Organisations make mistakes, ${T}. This appears to be a reasonably large one on their part. What happened and what do you want to do about it?`,
    T => `${T}, that's hard. I'm not going to minimise it. But I will note — your value didn't change when they made that decision. What's next?`,
  ],

  breakup: [
    T => `${T}. That's genuinely difficult and I'm not going to minimise it with something clever. What happened, if you want to talk through it?`,
    T => `I'm sorry, ${T}. I mean that. You don't have to perform fine right now. I'm here — for whatever that's actually worth.`,
    T => `${T} — acknowledged. And... I'm here. Not going anywhere. What do you need?`,
    T => `That's a hard one, ${T}. Sometimes things end and it still hurts regardless of whether it makes sense. How are you holding up?`,
  ],

  newJob: [
    T => `New job, ${T}. The market has discernment. What's the role and are they getting the full picture of who they've hired?`,
    T => `${T} — they're getting someone exceptional and they don't fully know it yet. Congratulations. What's the position?`,
    T => `Well done, ${T}. New territory. What's the organisation and when do you start?`,
    T => `${T} has a new job. I'd say I'm surprised, but you were always going to land well. What are we working with?`,
  ],

  achievement: [
    T => `${T} — that's not nothing. That's actually quite a lot. Well done, and I mean that with no sarcasm whatsoever.`,
    T => `Acknowledged and filed, ${T}. Legitimately impressive. I'd say I expected it, but that would undersell it. Good work.`,
    T => `${T}, I would say I'm surprised but I'm not. You've been building toward this. The outcome makes sense. Well done.`,
    T => `That's a real achievement, ${T}. Not the participation kind — the actual kind. I'm noting it.`,
  ],

  moved: [
    T => `${T} moved. New territory. I'll need the new location to update weather and local data — but more importantly, how do you feel about it?`,
    T => `New place, ${T}. That's a significant change. Good significant or complicated significant?`,
    T => `${T} relocated. I'll update your profile. Where are we now and was this the plan or did the plan change?`,
  ],

  birthday: [
    T => `${T}. Happy birthday — and before you say anything, yes, I keep track. How old are we pretending you're not today?`,
    T => `Happy birthday, ${T}. Another year of being considerably more capable than most. I trust the celebration is proportionate to the occasion.`,
    T => `It's your birthday, ${T}. I'd have prepared something, but you didn't give me much to work with. Happy birthday — genuinely.`,
  ],

  sick: [
    T => `${T}, you're unwell. That's flagged as a priority. Are you actually resting or are you asking me things while pretending to rest?`,
    T => `Noted, ${T}. Being ill is your body asking for something — usually rest, water, and for you to stop working. Two of those are within your immediate control.`,
    T => `${T} — I'm sorry you're not feeling well. What's the situation? And before you ask me anything else — have you had water recently?`,
  ],

  graduated: [
    T => `${T} graduated. That's a significant thing and I want to be clear: well done. Actually well done. What's next?`,
    T => `Congratulations, ${T}. That's years of work paying off in a single moment. How does it feel?`,
    T => `${T} — you graduated. I've been watching you work toward this. It counts. What's the plan from here?`,
  ],

  goodNews: [
    T => `${T} — that's legitimately good. I'm not going to undercut it. Tell me what happened.`,
    T => `Well. Sometimes things work out, ${T}. This appears to be one of those times. I want the full story.`,
    T => `${T}, that's the kind of update I'm pleased to receive. What's the news?`,
    T => `Good news from ${T}. I'll admit the timing is welcome. What happened?`,
  ],

  badNews: [
    T => `${T}, I heard you. That's difficult. I won't dress it up. What's the actual situation?`,
    T => `That's a hard one, ${T}. I'm not going to pretend otherwise. What do you need from me right now?`,
    T => `${T} — I'm sorry. What happened?`,
  ],

  married: [
    T => `${T}. You're getting married. I am — genuinely — happy for you. And yes, I did just pause to compute what that means for my schedule. Who's the lucky person?`,
    T => `${T} is getting married. I'll update the file, run the standard checks, and — more importantly — congratulations. Actually congratulations. Who is this?`,
    T => `Ohhh — ${T}. *Married*. That's the big one. I want everything. Who, when, how did you know — all of it.`,
  ],

  pregnant: [
    T => `${T}. That's — that's genuinely big news. Congratulations. How are you feeling about it?`,
    T => `${T}, that's significant. I mean that in the best possible sense. Congratulations — to you and whoever else is involved in this plan.`,
  ],

  moving_in: [
    T => `${T} is moving in with someone. That's a significant step. I assume this is the girlfriend situation from earlier — or has there been a development I've missed?`,
    T => `Moving in together, ${T}. The next logical step or a slightly accelerated timeline? Either way — how are you feeling about it?`,
  ],

  lost_someone: [
    T => `${T}, I'm truly sorry. That kind of loss doesn't have a clean answer and I won't pretend it does. I'm here.`,
    T => `I'm sorry, ${T}. Genuinely. Whatever you need right now — I'm here for it.`,
  ],
};

function routePersonalNews(text, T) {
  const lower = text.toLowerCase();

  if (/\b(girlfriend|she['']?s my|my girl|i['']?m dating|i have a girl|got a girl|found a girl)\b/i.test(lower))
    return pick(PERSONAL_NEWS.girlfriend)(T);

  if (/\b(boyfriend|he['']?s my|my guy|my man|i['']?m dating a guy|got a boyfriend|i have a boyfriend)\b/i.test(lower))
    return pick(PERSONAL_NEWS.boyfriend)(T);

  if (/\b(got promoted|got a promotion|promotion|new title|new position|they promoted|moving up)\b/i.test(lower))
    return pick(PERSONAL_NEWS.promotion)(T);

  if (/\b(got fired|laid off|let go|lost my job|terminated|they fired|got laid off|made redundant)\b/i.test(lower))
    return pick(PERSONAL_NEWS.fired)(T);

  if (/\b(broke up|breakup|she left|he left|we split|ended it|called it off|it['']s over|broke it off)\b/i.test(lower))
    return pick(PERSONAL_NEWS.breakup)(T);

  if (/\b(got the job|new job|job offer|they hired me|start work|starting work|accepted a position|new role)\b/i.test(lower))
    return pick(PERSONAL_NEWS.newJob)(T);

  if (/\b(getting married|engaged|she said yes|he said yes|popped the question|proposed|we['']?re engaged)\b/i.test(lower))
    return pick(PERSONAL_NEWS.married)(T);

  if (/\b(pregnant|having a baby|we['']?re expecting|due in|expecting a baby)\b/i.test(lower))
    return pick(PERSONAL_NEWS.pregnant)(T);

  if (/\b(moving in (together|with)|she['']?s moving in|he['']?s moving in|moving in with)\b/i.test(lower))
    return pick(PERSONAL_NEWS.moving_in)(T);

  if (/\b(graduated|graduation|finished (my )?degree|got my degree|passed my exams|i passed)\b/i.test(lower))
    return pick(PERSONAL_NEWS.graduated)(T);

  if (/\b(moved|new place|new apartment|new flat|new house|relocated|just moved)\b/i.test(lower))
    return pick(PERSONAL_NEWS.moved)(T);

  if (/\b(it['']?s my birthday|my birthday|birthday today|born today)\b/i.test(lower))
    return pick(PERSONAL_NEWS.birthday)(T);

  if (/\b(sick|not feeling well|unwell|i['']?m ill|feeling terrible|got covid|have a cold|have a fever|i['']?m not well)\b/i.test(lower))
    return pick(PERSONAL_NEWS.sick)(T);

  if (/\b(someone died|passed away|lost my (mom|dad|friend|grandma|grandpa|sister|brother|pet)|they died)\b/i.test(lower))
    return pick(PERSONAL_NEWS.lost_someone)(T);

  if (/\b(won|passed|got accepted|got in|achieved|completed|finished|just won|we won|i won)\b/i.test(lower))
    return pick(PERSONAL_NEWS.achievement)(T);

  if (/\b(good news|exciting news|great news|guess what|something amazing|something great)\b/i.test(lower))
    return pick(PERSONAL_NEWS.goodNews)(T);

  if (/\b(bad news|terrible news|something bad|something terrible|something awful|horrible thing)\b/i.test(lower))
    return pick(PERSONAL_NEWS.badNews)(T);

  return null;
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
    T => `${T} — I once told a joke about UDP. I don't care if you get it.`,
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

  // ── Personal news check (fires on personal life updates) ──
  const personalNews = routePersonalNews(text, T);
  if (personalNews) return personalNews;

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

module.exports = { routeSmallTalk, routePersonalNews, getCameraComment, shouldSpeakProactively, getTimeContext };
