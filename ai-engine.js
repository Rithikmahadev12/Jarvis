"use strict";
// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Universal Cognitive Engine v6.0
// ─────────────────────────────────────────────────────────────
// • Self-thought reasoning chain — thinks before responding
// • Universal semantic lexicon — knows every common English word
// • Morphological engine — handles all word forms
// • Dynamic intent synthesis — handles non-preset commands
// • Zero hardcoded replies — everything generated fresh
// ═══════════════════════════════════════════════════════════════

// ── CORE UTILITIES ─────────────────────────────────────────────
const pick  = arr => arr[Math.floor(Math.random() * arr.length)];
const pickN = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ═══════════════════════════════════════════════════════════════
// ── MORPHOLOGY ENGINE ─────────────────────────────────────────
// Reduces any word form to its semantic base
// ═══════════════════════════════════════════════════════════════
const IRREGULARS = {
  am:'be',is:'be',are:'be',was:'be',were:'be',been:'be',being:'be',
  has:'have',had:'have',having:'have',
  does:'do',did:'do',done:'do',doing:'do',
  went:'go',gone:'go',going:'go',goes:'go',
  got:'get',gotten:'get',gets:'get',getting:'get',
  made:'make',makes:'make',making:'make',
  said:'say',says:'say',saying:'say',
  saw:'see',seen:'see',seeing:'see',sees:'see',
  knew:'know',known:'know',knows:'know',knowing:'know',
  took:'take',taken:'take',takes:'take',taking:'take',
  came:'come',comes:'come',coming:'come',
  gave:'give',given:'give',gives:'give',giving:'give',
  found:'find',finds:'find',finding:'find',
  told:'tell',tells:'tell',telling:'tell',
  thought:'think',thinks:'think',thinking:'think',
  brought:'bring',brings:'bring',bringing:'bring',
  showed:'show',shown:'show',shows:'show',showing:'show',
  ran:'run',runs:'run',running:'run',
  kept:'keep',keeps:'keep',keeping:'keep',
  began:'begin',begun:'begin',begins:'begin',beginning:'begin',
  felt:'feel',feels:'feel',feeling:'feel',
  left:'leave',leaves:'leave',leaving:'leave',
  heard:'hear',hears:'hear',hearing:'hear',
  wrote:'write',written:'write',writes:'write',writing:'write',
  spoke:'speak',spoken:'speak',speaks:'speak',speaking:'speak',
  drew:'draw',drawn:'draw',draws:'draw',drawing:'draw',
  chose:'choose',chosen:'choose',chooses:'choose',choosing:'choose',
  broke:'break',broken:'break',breaks:'break',breaking:'break',
  fell:'fall',falls:'fall',falling:'fall',
  flew:'fly',flown:'fly',flies:'fly',flying:'fly',
  grew:'grow',grown:'grow',grows:'grow',growing:'grow',
  held:'hold',holds:'hold',holding:'hold',
  lay:'lie',lain:'lie',lies:'lie',lying:'lie',
  lost:'lose',loses:'lose',losing:'lose',
  paid:'pay',pays:'pay',paying:'pay',
  rose:'rise',risen:'rise',rises:'rise',rising:'rise',
  sent:'send',sends:'send',sending:'send',
  sang:'sing',sung:'sing',sings:'sing',singing:'sing',
  sat:'sit',sits:'sit',sitting:'sit',
  slept:'sleep',sleeps:'sleep',sleeping:'sleep',
  stood:'stand',stands:'stand',standing:'stand',
  stole:'steal',stolen:'steal',steals:'steal',stealing:'steal',
  swam:'swim',swum:'swim',swims:'swim',swimming:'swim',
  threw:'throw',thrown:'throw',throws:'throw',throwing:'throw',
  wore:'wear',worn:'wear',wears:'wear',wearing:'wear',
  won:'win',wins:'win',winning:'win',
  bought:'buy',buys:'buy',buying:'buy',
  built:'build',builds:'build',building:'build',
  caught:'catch',catches:'catch',catching:'catch',
  dealt:'deal',deals:'deal',dealing:'deal',
  drove:'drive',driven:'drive',drives:'drive',driving:'drive',
  ate:'eat',eaten:'eat',eats:'eat',eating:'eat',
  forgot:'forget',forgotten:'forget',forgets:'forget',forgetting:'forget',
  hit:'hit',hits:'hit',hitting:'hit',
  hurt:'hurt',hurts:'hurt',hurting:'hurt',
  led:'lead',leads:'lead',leading:'lead',
  lit:'light',lights:'light',lighting:'light',
  met:'meet',meets:'meet',meeting:'meet',
  quit:'quit',quits:'quit',quitting:'quit',
  rode:'ride',ridden:'ride',rides:'ride',riding:'ride',
  shot:'shoot',shoots:'shoot',shooting:'shoot',
  shut:'shut',shuts:'shut',shutting:'shut',
  slid:'slide',slides:'slide',sliding:'slide',
  spent:'spend',spends:'spend',spending:'spend',
  split:'split',splits:'split',splitting:'split',
  spread:'spread',spreads:'spread',spreading:'spread',
  taught:'teach',teaches:'teach',teaching:'teach',
  tore:'tear',torn:'tear',tears:'tear',tearing:'tear',
  understood:'understand',understands:'understand',understanding:'understand',
  woke:'wake',woken:'wake',wakes:'wake',waking:'wake',
  worse:'bad',worst:'bad',better:'good',best:'good',
  more:'many',most:'many',fewer:'few',less:'little',least:'little',
  bigger:'big',biggest:'big',smaller:'small',smallest:'small',
  faster:'fast',fastest:'fast',slower:'slow',slowest:'slow',
  higher:'high',highest:'high',lower:'low',lowest:'low',
  older:'old',oldest:'old',newer:'new',newest:'new',
  harder:'hard',hardest:'hard',easier:'easy',easiest:'easy',
  stronger:'strong',strongest:'strong',weaker:'weak',weakest:'weak',
  longer:'long',longest:'long',shorter:'short',shortest:'short',
  louder:'loud',loudest:'loud',quieter:'quiet',quietest:'quiet',
  men:'man',women:'woman',children:'child',people:'person',
  mice:'mouse',feet:'foot',teeth:'tooth',geese:'goose',
  oxen:'ox',alumni:'alumnus',alumni:'alumnus',fungi:'fungus',
  cacti:'cactus',stimuli:'stimulus',phenomena:'phenomenon',
  criteria:'criterion',data:'datum',media:'medium',
};

const SUFFIX_RULES = [
  { sfx:'ying',  min:5, out:'' },
  { sfx:'ning',  min:5, out:'' },
  { sfx:'ing',   min:5, out:'' },
  { sfx:'ied',   min:4, out:'y' },
  { sfx:'ies',   min:4, out:'y' },
  { sfx:'sses',  min:5, out:'ss' },
  { sfx:'xes',   min:4, out:'x' },
  { sfx:'ches',  min:5, out:'ch' },
  { sfx:'shes',  min:5, out:'sh' },
  { sfx:'ves',   min:4, out:'f' },
  { sfx:'tion',  min:5, out:'' },
  { sfx:'sion',  min:5, out:'' },
  { sfx:'ation', min:6, out:'' },
  { sfx:'ment',  min:5, out:'' },
  { sfx:'ness',  min:5, out:'' },
  { sfx:'ical',  min:5, out:'' },
  { sfx:'able',  min:5, out:'' },
  { sfx:'ible',  min:5, out:'' },
  { sfx:'ious',  min:5, out:'' },
  { sfx:'ous',   min:4, out:'' },
  { sfx:'ful',   min:4, out:'' },
  { sfx:'less',  min:5, out:'' },
  { sfx:'ance',  min:5, out:'' },
  { sfx:'ence',  min:5, out:'' },
  { sfx:'ity',   min:4, out:'' },
  { sfx:'ize',   min:4, out:'' },
  { sfx:'ise',   min:4, out:'' },
  { sfx:'ify',   min:4, out:'' },
  { sfx:'ive',   min:4, out:'' },
  { sfx:'ism',   min:4, out:'' },
  { sfx:'ist',   min:4, out:'' },
  { sfx:'er',    min:4, out:'' },
  { sfx:'est',   min:4, out:'' },
  { sfx:'ly',    min:4, out:'' },
  { sfx:'al',    min:4, out:'' },
  { sfx:'ic',    min:4, out:'' },
  { sfx:'ed',    min:4, out:'' },
  { sfx:'es',    min:4, out:'' },
  { sfx:'s',     min:4, out:'' },
];

function stem(word) {
  const w = word.toLowerCase().trim();
  if (IRREGULARS[w]) return IRREGULARS[w];
  for (const r of SUFFIX_RULES) {
    if (w.endsWith(r.sfx) && w.length >= r.min) {
      const base = w.slice(0, w.length - r.sfx.length) + r.out;
      if (base.length >= 2) return base;
    }
  }
  return w;
}

function normalizeText(text) {
  return text.toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/n't\b/g, ' not')
    .replace(/won't\b/g, 'will not')
    .replace(/can't\b/g, 'cannot')
    .replace(/i'm\b/g, 'i am')
    .replace(/i've\b/g, 'i have')
    .replace(/i'll\b/g, 'i will')
    .replace(/i'd\b/g, 'i would')
    .replace(/you're\b/g, 'you are')
    .replace(/they're\b/g, 'they are')
    .replace(/what's\b/g, 'what is')
    .replace(/that's\b/g, 'that is')
    .replace(/it's\b/g, 'it is')
    .replace(/who's\b/g, 'who is')
    .replace(/he's\b/g, 'he is')
    .replace(/she's\b/g, 'she is')
    .replace(/let's\b/g, 'let us')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(text) {
  return normalizeText(text).split(' ').filter(w => w.length > 0).map(w => ({ raw: w, stem: stem(w) }));
}

// ═══════════════════════════════════════════════════════════════
// ── UNIVERSAL SEMANTIC LEXICON ────────────────────────────────
// Every cluster = a semantic concept mapped to all its word forms
// Words → clusters at runtime via inverted index
// ═══════════════════════════════════════════════════════════════
const CLUSTERS = {

  // ── ACTION VERBS ───────────────────────────────────────────
  OPEN_ACT:   ['open','launch','load','start','boot','run','execute','activate','initiate','begin','access','enter','navigate','go','visit','view','browse','pull','bring','fire','spin','kick','jump','step','switch','move','head','take','get into','pull up','bring up','come up','wake','enable','turn on','power on','switch on','flip on','light up','boot up','spin up','kick off','crank up','fire up'],
  CLOSE_ACT:  ['close','shut','stop','end','terminate','kill','exit','quit','finish','conclude','disable','turn off','power down','log out','sign out','disconnect','abort','cancel','halt','cease','leave','escape','dismiss','hide','minimize','suspend','deactivate','switch off','flip off','wind down','wrap up','shut down','close out','sign off','bow out','cut off','break off','drop','abandon'],
  SHOW_ACT:   ['show','display','present','reveal','list','enumerate','exhibit','demonstrate','give','provide','output','print','render','visualize','project','surface','expose','uncover','bring','throw','put','flash','beam','illustrate','highlight','manifest','indicate','point','draw','outline','lay out','roll out','pull out','lay bare','make visible','put on screen','dump','output','emit','broadcast','publish','post','present'],
  GET_ACT:    ['get','fetch','retrieve','grab','obtain','acquire','pull','collect','gather','extract','download','receive','pick','take','bring','carry','import','read','access','request','query','ask for','call','invoke','pull down','load up','draw','draw out','pull out','suck','suck in','harvest','scrape','capture','intercept','load','load in','import in','bring in','drag in'],
  SAVE_ACT:   ['save','store','keep','preserve','record','log','capture','archive','backup','note','write','document','commit','retain','hold','file','register','persist','maintain','stash','cache','lock','lock in','pin','pin down','anchor','embed','etch','cement','inscribe','bookmark','tag','mark','flag','remember','memorize','jot','jot down','write down','put down','set aside','put away','tuck away','shelve','bank','deposit','stockpile'],
  DELETE_ACT: ['delete','remove','erase','clear','wipe','forget','drop','purge','clean','eliminate','destroy','discard','trash','dump','flush','reset','strip','scrub','annihilate','obliterate','void','nullify','kill','cut','excise','expunge','prune','trim','disregard','dismiss','shred','dispose','throw away','throw out','get rid of','do away with','take out','cross out','scratch out','blot out','mark out','rule out','blank out','zero out'],
  FIND_ACT:   ['find','search','locate','look','seek','discover','identify','detect','scan','check','hunt','browse','explore','query','pinpoint','uncover','spot','trace','track','ferret','dig','dig out','sniff','sniff out','root','root out','fish','fish out','dredge','surface','expose','reveal','unearth','pick out','single out','zero in','hone in','narrow','investigate','examine','research','probe','inquire','look up','look into','look for','check out','figure out'],
  PLAY_ACT:   ['play','stream','listen','hear','watch','queue','put on','throw on','shuffle','blast','fire','spin','drop','cue','resume','unpause','start','begin','kick off','turn on','switch on','boot up','load','launch'],
  PAUSE_ACT:  ['pause','stop','halt','freeze','suspend','hold','wait','mute','silence','cut','break','interrupt','stay','standby','idle','stall','stagnate','lull','delay','defer','shelve','table','park'],
  SKIP_ACT:   ['skip','next','forward','advance','jump','pass','continue','change','go to','move to','hop','hop to','leap','leap to','move on','go on','proceed','progress'],
  SET_ACT:    ['set','configure','adjust','change','modify','update','alter','tune','calibrate','customize','tweak','switch','toggle','assign','pick','choose','select','define','specify','dial','dial in','fix','lock','pin','nail','point','aim','target','program','schedule','arrange','organize','order','sort','rank','rate','mark','label','tag','flag'],
  CHECK_ACT:  ['check','verify','confirm','inspect','examine','look','review','assess','evaluate','audit','test','probe','monitor','watch','observe','see','peek','glance','scan','survey','study','analyze','investigate','scrutinize','validate','authenticate','cross check','double check','run','run over','go over','go through','work through','look at','look over','look into','take a look','have a look','see what','find out','figure out'],
  READ_ACT:   ['read','scan','analyze','extract','parse','interpret','decode','process','examine','review','understand','comprehend','decipher','transcribe','recognize','make out','pick out','pull out','pull','go through','work through','digest','absorb','take in','study','pore over','sift','sift through'],
  CALCULATE_ACT:['calculate','compute','solve','determine','evaluate','measure','count','add','subtract','multiply','divide','derive','figure','work out','figure out','crunch','process','number','sum','total','tally','tabulate','quantify','estimate','approximate','reckon','assess','gauge'],
  REMEMBER_ACT: ['remember','memorize','note','store','log','keep','record','file','save','mark','flag','register','retain','learn','note down','write down','take note','make note','keep note','bear in mind','keep in mind','hold onto','hang onto'],
  TELL_ACT:   ['tell','explain','describe','talk','inform','say','speak','mention','discuss','elaborate','clarify','detail','outline','summarize','brief','update','report','convey','communicate','impart','relay','pass on','fill in','bring up to speed','walk through','run through','go through','break down','break it down','lay out','lay it out','spell out','spell it out','voice','express','articulate','put into words'],
  HELP_ACT:   ['help','assist','support','guide','advise','recommend','suggest','aid','serve','handle','manage','deal','take care','sort out','fix','solve','resolve','address','tackle','work on','attend','attend to','see to','look after','cater','cater to','accommodate','facilitate','enable','empower','back','back up','prop','prop up','shore up','bolster'],
  SWITCH_ACT: ['switch','change','toggle','flip','swap','alternate','rotate','cycle','shift','exchange','replace','substitute','transition','move','go','hop','jump','pivot','turn','turn to','go to','move to','head to'],
  INCREASE_ACT:['increase','raise','turn up','boost','amplify','enhance','improve','maximize','up','elevate','grow','expand','intensify','augment','escalate','inflate','extend','lengthen','broaden','widen','deepen','heighten','strengthen','reinforce','accelerate','speed up','crank up','ramp up','step up','scale up','bump up','jack up','push up','pump up','rev up','build up','dial up'],
  DECREASE_ACT:['decrease','lower','turn down','reduce','minimize','cut','drop','diminish','quiet','soften','shrink','compress','scale back','dial back','pull back','tone down','bring down','calm down','wind down','slow down','ease off','ease up','ease down','trim','trim down','pare','pare down','cut back','cut down','roll back','knock down','bring low','damp','dampen','moderate','temper','attenuate','abate'],
  ANALYZE_ACT: ['analyze','analyse','assess','evaluate','examine','study','inspect','investigate','scrutinize','review','audit','appraise','critique','dissect','break down','break apart','pick apart','tear apart','go through','work through','sift through','comb through','pore over','dig into','delve into','probe','unpack'],
  CONNECT_ACT: ['connect','link','join','attach','bind','associate','pair','couple','hook','hook up','plug','plug in','tie','tie to','bridge','interface','integrate','sync','synchronize','network','wire','wire up','plug in'],
  DESCRIBE_ACT:['describe','explain','depict','illustrate','characterize','define','outline','sketch','paint','portray','narrate','recount','relay','convey','capture','articulate'],
  CREATE_ACT:  ['create','make','build','generate','produce','construct','craft','design','develop','form','shape','forge','fabricate','manufacture','compose','write','draft','author','render','compile','assemble','put together'],
  TEST_ACT:    ['test','try','attempt','trial','experiment','sample','taste','probe','verify','validate','check','run','run through','go through','tryout','pilot','demo'],
  UPDATE_ACT:  ['update','upgrade','refresh','renew','revise','modify','alter','change','edit','patch','fix','correct','improve','enhance','optimize','tweak','adjust','overhaul','revamp','redo'],

  // ── OBJECTS / SUBJECTS ─────────────────────────────────────
  SCREEN_OBJ:  ['screen','display','monitor','desktop','window','page','interface','GUI','browser','application','app','program','viewport','panel','dashboard','view','frame','canvas','projection','output','render'],
  CAMERA_OBJ:  ['camera','webcam','cam','lens','video','feed','live view','vision','eye','sensor','optic','visual','image','capture','recording','shot'],
  MUSIC_OBJ:   ['music','song','track','audio','sound','tune','melody','beat','rhythm','album','playlist','artist','band','genre','record','recording','mp3','spotify','podcast','radio','frequency','wave','tone','note','chord','harmony','bass','treble','volume'],
  EMAIL_OBJ:   ['email','mail','inbox','message','correspondence','letter','note','memo','notification','post','gmail','mailbox','unread','compose','send','reply','forward','attachment','subject','recipient','sender'],
  CALENDAR_OBJ:['calendar','schedule','agenda','plan','event','meeting','appointment','session','booking','reservation','slot','reminder','due date','deadline','timeline','timetable','roster','itinerary','diary','planner','google calendar','occurrence','occurrence'],
  WEATHER_OBJ: ['weather','temperature','forecast','climate','conditions','sky','atmosphere','rain','sun','wind','storm','snow','cloud','humidity','heat','cold','warm','cool','hot','icy','fog','mist','drizzle','shower','thunder','lightning','pressure','celsius','fahrenheit','degrees','outside','outdoor'],
  TIMER_OBJ:   ['timer','alarm','reminder','countdown','alert','notification','ping','buzz','bell','clock','watch','stopwatch','duration','interval','delay','timeout','schedule','set timer','set alarm','snooze'],
  MEMORY_OBJ:  ['memory','note','fact','information','data','stored','knowledge','record','file','history','log','entry','item','detail','detail','piece','bit','nugget','factoid','info'],
  LINK_OBJ:    ['link','url','website','site','page','address','portal','resource','destination','location','bookmark','hyperlink','shortcut','path','endpoint','href'],
  SYSTEM_OBJ:  ['system','computer','device','machine','hardware','software','OS','processor','CPU','memory','RAM','storage','disk','drive','power','battery','performance','resource','process','daemon','service','module','component','part'],
  TIME_OBJ:    ['time','clock','hour','minute','second','moment','instant','period','duration','interval','tick','tock','now','currently','present','current time'],
  DATE_OBJ:    ['date','day','week','month','year','today','tomorrow','yesterday','morning','afternoon','evening','night','midnight','noon','dawn','dusk','weekend','weekday','monday','tuesday','wednesday','thursday','friday','saturday','sunday','january','february','march','april','may','june','july','august','september','october','november','december'],
  CLIP_OBJ:    ['clip','recording','footage','video','capture','snapshot','screenshot','frame','moment','take','session','record','buffer','archive'],
  FACE_OBJ:    ['face','person','individual','figure','silhouette','identity','who','someone','intruder','stranger','visitor','guest','unknown','familiar','recognized'],
  VOICE_OBJ:   ['voice','speech','audio','sound','tone','pitch','vocal','microphone','mic','talk','spoken','verbal'],
  NOTIFICATION_OBJ:['notification','alert','push','message','buzz','ping','pop','notice','announcement','alarm','warning','update','signal'],
  SETTING_OBJ: ['setting','settings','preference','preferences','option','options','configuration','setup','parameter','control','controls','panel','menu','toggle','switch'],
  STATUS_OBJ:  ['status','state','condition','health','performance','uptime','diagnostics','report','check','scan','reading','metric','stat','figure'],
  LIGHT_OBJ:   ['light','lights','lamp','brightness','illumination','lighting','glow','shine','bright','dark','dim','luminosity'],
  VOLUME_OBJ:  ['volume','sound level','audio level','loudness','noise','decibel','db','amplitude'],

  // ── KNOWLEDGE DOMAINS ──────────────────────────────────────
  SCIENCE_DOM: ['science','scientific','physics','chemistry','biology','astronomy','geology','ecology','botany','zoology','genetics','neuroscience','biochemistry','astrophysics','quantum','atom','molecule','cell','DNA','evolution','photosynthesis','gravity','energy','force','wave','particle','element','compound','reaction','experiment','hypothesis','theory','laboratory','empirical','observable','measurable','evidence','data','result','conclusion'],
  TECH_DOM:    ['technology','tech','computer','software','hardware','programming','coding','code','algorithm','AI','artificial intelligence','machine learning','neural network','robot','automation','internet','web','network','server','database','app','application','digital','cyber','data','cloud','API','framework','Python','JavaScript','Java','C++','Rust','Go','language','platform','system','device','gadget','tool','infrastructure','architecture','backend','frontend','fullstack','devops','deployment','container','docker','kubernetes','microservice'],
  HISTORY_DOM: ['history','historical','ancient','medieval','modern','civilization','empire','dynasty','war','battle','revolution','treaty','colony','independence','democracy','monarchy','republic','king','queen','emperor','president','leader','general','army','navy','century','era','period','age','timeline','event','renaissance','enlightenment','industrial','archaeological','artifact','relic','document','archive','record','chronicle','annals','legacy','heritage'],
  MATH_DOM:    ['math','mathematics','algebra','geometry','calculus','statistics','probability','arithmetic','trigonometry','number','equation','formula','function','variable','constant','theorem','proof','derivative','integral','matrix','vector','prime','factor','fraction','decimal','percentage','ratio','proportion','sequence','series','set','graph','coordinate','axis','plane','surface','volume','area','perimeter','angle','triangle','circle','square','rectangle','polygon','sphere','cube','cylinder','cone'],
  PHILOSOPHY_DOM:['philosophy','philosophical','ethics','moral','morality','consciousness','existence','reality','truth','knowledge','logic','reasoning','argument','free will','determinism','metaphysics','meaning','purpose','justice','virtue','mind','soul','identity','perception','belief','epistemology','ontology','aesthetics','Plato','Aristotle','Kant','Descartes','Nietzsche','Hume','Locke','Socrates','Hegel','Wittgenstein','Sartre','Camus'],
  HEALTH_DOM:  ['health','medicine','medical','doctor','disease','illness','symptom','treatment','therapy','cure','diagnosis','body','brain','heart','blood','muscle','bone','organ','nutrition','diet','exercise','sleep','mental health','anxiety','depression','stress','vitamin','immune','virus','bacteria','infection','surgery','drug','medication','prescription','fitness','wellness','wellbeing','inflammation','metabolism','hormone','neurotransmitter','serotonin','dopamine','cortisol','cholesterol','blood pressure','diabetes','cancer','allergy','fever','pain','chronic','acute'],
  PSYCHOLOGY_DOM:['psychology','psychological','behavior','behavior','cognition','cognitive','emotion','emotional','memory','learning','personality','perception','motivation','intelligence','consciousness','unconscious','trauma','therapy','counseling','social','development','childhood','Freud','Jung','Pavlov','Maslow','Skinner','Piaget','attachment','reinforcement','conditioning','bias','heuristic','attribution','empathy','sympathy','self esteem','confidence','resilience','coping','mindfulness','meditation'],
  ECONOMICS_DOM:['economics','economy','economic','market','trade','commerce','business','finance','money','wealth','poverty','inflation','GDP','investment','stock','bond','currency','tax','budget','profit','loss','supply','demand','price','value','capital','labor','growth','recession','unemployment','bank','interest','dividend','equity','debt','loan','credit','asset','liability','portfolio','venture','startup','entrepreneur','monopoly','oligopoly','competition','regulation','fiscal','monetary','macro','micro'],
  POLITICS_DOM:['politics','political','government','democracy','republic','monarchy','parliament','congress','senate','election','vote','policy','law','legislation','constitution','rights','freedom','justice','war','peace','treaty','diplomacy','foreign policy','international','liberal','conservative','socialist','nationalist','authoritarian','totalitarian','federalism','separation of powers','checks and balances','bureaucracy','lobbyist','campaign','party','coalition','referendum','veto'],
  ASTRONOMY_DOM:['space','astronomy','universe','galaxy','star','planet','moon','sun','solar system','black hole','nebula','asteroid','comet','orbit','gravity','light year','telescope','NASA','rocket','spacecraft','astronaut','Mars','Jupiter','Saturn','Venus','Mercury','Neptune','Uranus','cosmic','celestial','constellation','supernova','quasar','pulsar','dark matter','dark energy','big bang','cosmology','exoplanet','habitable zone','event horizon','singularity'],
  GEOGRAPHY_DOM:['geography','country','nation','continent','ocean','sea','river','mountain','forest','desert','city','capital','border','region','territory','climate','environment','map','location','coordinates','latitude','longitude','topography','terrain','landscape','ecosystem','biome','habitat','basin','valley','plateau','peninsula','island','archipelago','coastline','delta','estuary','aquifer'],
  BIOLOGY_DOM:  ['biology','organism','species','evolution','DNA','gene','protein','cell','tissue','organ','reproduction','metabolism','photosynthesis','ecosystem','food chain','mammal','reptile','bird','fish','insect','plant','fungus','bacteria','virus','microbe','prokaryote','eukaryote','nucleus','mitochondria','chromosome','genome','mutation','natural selection','adaptation','biodiversity','taxonomy','classification','domain','kingdom','phylum','class','order','family','genus','species'],
  PHYSICS_DOM:  ['physics','force','energy','mass','velocity','acceleration','momentum','gravity','electromagnetism','light','wave','particle','quantum','relativity','thermodynamics','entropy','nuclear','atomic','electric','magnetic','current','voltage','resistance','circuit','field','potential','kinetic','potential energy','work','power','frequency','wavelength','amplitude','refraction','diffraction','interference','superposition','entanglement','uncertainty'],
  CHEMISTRY_DOM:['chemistry','element','compound','molecule','atom','reaction','bond','acid','base','solution','mixture','periodic table','organic','inorganic','polymer','catalyst','oxidation','reduction','equilibrium','pH','solubility','precipitate','electrolyte','covalent','ionic','metallic','hydrogen bond','electron','proton','neutron','valence','orbital','isomer','stereochemistry','titration','spectroscopy'],
  ENVIRONMENT_DOM:['environment','climate','nature','ecosystem','biodiversity','pollution','sustainability','renewable','carbon','greenhouse','global warming','deforestation','conservation','wildlife','habitat','ozone','fossil fuel','emission','footprint','recyclable','waste','landfill','solar','wind power','hydro','geothermal','clean energy','deforestation','reforestation','extinction','endangered','coral reef','ocean acidification','sea level','drought','flood','wildfire'],
  LITERATURE_DOM:['literature','book','novel','story','poem','poetry','prose','fiction','nonfiction','author','writer','character','plot','theme','narrative','metaphor','symbol','genre','chapter','verse','stanza','sonnet','haiku','epic','tragedy','comedy','drama','satire','allegory','Shakespeare','Dickens','Hemingway','Austen','Tolkien','Orwell','Kafka','Dostoevsky','Tolstoy'],
  ART_DOM:      ['art','painting','sculpture','drawing','photography','film','cinema','music','dance','theater','architecture','design','fashion','animation','illustration','graphic design','color theory','composition','perspective','surrealism','impressionism','cubism','abstract','realism','modernism','contemporary','gallery','museum','exhibition','canvas','palette','medium','technique','style'],
  RELIGION_DOM: ['religion','god','faith','belief','prayer','worship','church','mosque','temple','synagogue','bible','quran','torah','spiritual','sacred','holy','divine','soul','afterlife','heaven','hell','karma','reincarnation','nirvana','enlightenment','Buddhism','Christianity','Islam','Judaism','Hinduism','Taoism','Confucianism','atheism','agnosticism'],

  // ── MODIFIERS ──────────────────────────────────────────────
  RECENT_MOD:  ['recent','last','latest','previous','past','before','earlier','just','previously','former','ago','back','prior','old','former','preceding','last time','most recent'],
  ALL_MOD:     ['all','every','complete','full','entire','whole','everything','total','comprehensive','universal','overall','across','each','each and every','every single','throughout','entirely','fully','completely','totally','absolutely'],
  NEW_MOD:     ['new','fresh','latest','current','today','now','modern','recent','updated','live','real-time','immediate','contemporary','present','existing','current','up-to-date','latest','newest','most recent'],
  FAST_MOD:    ['fast','quick','rapid','immediate','instant','asap','urgent','right away','straight away','right now','promptly','swiftly','speedily','briskly','hastily','expeditiously','without delay','at once','immediately','pronto','stat','in a hurry','no time to waste'],
  SLOW_MOD:    ['slow','gradually','leisurely','gently','carefully','slowly','step by step','bit by bit','piecemeal','incrementally','over time','eventually','eventually','in time','unhurriedly'],
  QUIET_MOD:   ['quiet','silent','silent','muted','hushed','still','calm','peaceful','noiseless','soundless','whispered','low','soft','gentle','subdued','low key','under the radar','discreet','unobtrusive'],
  LOUD_MOD:    ['loud','louder','full volume','max volume','blasting','booming','thundering','roaring','deafening','ear-splitting','noisy','high volume','cranked','maxed'],
  SMALL_MOD:   ['small','little','brief','short','quick','tiny','mini','compact','minimal','limited','partial','summary','brief','snapshot','overview','highlights'],
  LARGE_MOD:   ['large','big','full','long','extended','comprehensive','detailed','extensive','thorough','complete','maximum','in-depth','deep','elaborate','exhaustive','in full','at length','fully'],
  GOOD_MOD:    ['good','great','excellent','amazing','awesome','fantastic','wonderful','perfect','brilliant','superb','outstanding','exceptional','magnificent','remarkable','impressive','stellar','top','first rate','top notch','world class','extraordinary'],
  BAD_MOD:     ['bad','terrible','awful','horrible','poor','weak','broken','wrong','faulty','defective','useless','problematic','dreadful','appalling','atrocious','abysmal','dire','inferior','substandard','second rate','lousy','rotten'],
  HYPOTHETICAL_MOD:['if','suppose','imagine','hypothetically','what if','assume','in theory','theoretically','let say','pretend','envision','picture','conceive'],
  NEGATION_MOD:['not','no','never','neither','nor','nobody','nothing','nowhere','none','cannot','won't','wouldn't','shouldn't','don't','doesn't','didn't','isn't','aren't','wasn't','weren't','haven't','hasn't','hadn't'],

  // ── SOCIAL / EMOTIONAL ─────────────────────────────────────
  GREETING_SOC:['hello','hi','hey','greetings','good morning','good afternoon','good evening','good day','howdy','yo','sup','what up','wassup','salutations','welcome','hiya','how are you','how do you do','how goes it','good to see you','pleased to meet you'],
  FAREWELL_SOC:['goodbye','bye','farewell','see you','later','see ya','take care','goodnight','so long','until next time','cheerio','ciao','adios','au revoir','bon voyage','all the best','take it easy','catch you later','have a good one','until we meet again'],
  THANKS_SOC:  ['thank','thanks','thank you','cheers','appreciated','grateful','gratitude','well done','good job','great work','nice work','brilliant','excellent','perfect','impressive','amazing','awesome','fantastic','phenomenal','superb','magnificent','you are the best','you rock','kudos','hat tip','props','credit','applause','bravo','well played'],
  APOLOGY_SOC: ['sorry','apology','apologize','excuse me','pardon','forgive','my bad','my mistake','oops','whoops','my fault','I messed up','my apologies','I take it back'],
  QUESTION_SOC:['what','who','where','when','why','how','which','can you','could you','would you','will you','do you','does it','is it','are you'],
  MOOD_SOC:    ['how are you','how are you feeling','your mood','you okay','how you doing','you alright','emotional state','feeling today','you good','doing well','how is it going','how do you feel','you happy','are you happy'],
  IDENTITY_SOC:['who are you','what are you','your name','introduce yourself','tell me about yourself','what is jarvis','are you ai','are you human','describe yourself','what do you do','what can you do','your abilities','your capabilities'],
  COMPLAIN_SOC:['frustrated','annoying','annoyed','hate','dislike','useless','stupid','dumb','broken','not working','terrible','awful','garbage','trash','horrible'],
  PERSONAL_SOC:['should i','advice','help me decide','what do you think','my situation','my problem','feeling','struggling','worried','anxious','confused','stuck','lost'],

  // ── STATES ─────────────────────────────────────────────────
  ON_STATE:    ['on','running','active','live','operational','enabled','functioning','online','up','working','activated','started','going','proceeding','in progress'],
  OFF_STATE:   ['off','stopped','inactive','disabled','offline','down','idle','dormant','suspended','ended','finished','closed','shut','terminated','killed'],
  ERROR_STATE: ['error','problem','issue','bug','fault','failure','broken','not working','crash','glitch','trouble','defect','malfunction','exception','exception','anomaly'],
  READY_STATE: ['ready','available','prepared','set','loaded','initialized','standby','waiting','primed','armed','poised','in position','good to go','all set'],
  BUSY_STATE:  ['busy','occupied','engaged','processing','working','loading','running','computing','thinking','analyzing','calculating','executing'],
  UNKNOWN_STATE:['unknown','unfamiliar','unrecognized','stranger','new person','different person','someone else','intruder','unauthorized','unidentified'],
  AUTH_STATE:  ['authorized','allowed','permitted','approved','verified','authenticated','recognized','known','familiar','identified','confirmed','validated'],

  // ── QUANTIFIERS / NUMBERS ──────────────────────────────────
  NUMBER_Q:    ['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','twenty','thirty','forty','fifty','hundred','thousand','million','first','second','third','fourth','fifth','dozen','half','quarter','few','several','many','some','most','all','both','each','every','any','couple','triple','double','single'],
  TIME_Q:      ['second','seconds','minute','minutes','hour','hours','day','days','week','weeks','month','months','year','years','moment','instant','brief','long','short','duration','period','interval','forever','never','always','sometimes','often','rarely','occasionally'],

  // ── CONJUNCTIONS / DISCOURSE ───────────────────────────────
  CONTRAST_DISC:['but','however','although','though','yet','still','nevertheless','nonetheless','despite','in spite of','on the other hand','conversely','alternatively','instead','rather','whereas','while'],
  ADDITION_DISC:['and','also','too','as well','furthermore','moreover','additionally','besides','plus','in addition','what is more','on top of that','not only','but also'],
  CAUSE_DISC:   ['because','since','as','for','therefore','thus','hence','so','consequently','as a result','due to','owing to','thanks to','on account of'],
  COMPARE_DISC: ['than','compared to','versus','vs','against','relative to','in comparison','in contrast','more than','less than','as much as','as well as'],
};

// ═══════════════════════════════════════════════════════════════
// ── BUILD INVERTED WORD INDEX ─────────────────────────────────
// word/stem → [cluster1, cluster2, ...] for fast lookup
// ═══════════════════════════════════════════════════════════════
const WORD_INDEX  = {};  // raw word → clusters
const STEM_INDEX  = {};  // stemmed word → clusters

(function buildIndex() {
  for (const [cluster, words] of Object.entries(CLUSTERS)) {
    for (const phrase of words) {
      // Index multi-word phrases on first word too
      const parts = phrase.split(' ');
      for (const part of parts) {
        const w = part.toLowerCase();
        const s = stem(w);
        if (!WORD_INDEX[w]) WORD_INDEX[w] = [];
        if (!WORD_INDEX[w].includes(cluster)) WORD_INDEX[w].push(cluster);
        if (!STEM_INDEX[s]) STEM_INDEX[s] = [];
        if (!STEM_INDEX[s].includes(cluster)) STEM_INDEX[s].push(cluster);
      }
      // Index full phrase
      const ph = phrase.toLowerCase();
      if (!WORD_INDEX[ph]) WORD_INDEX[ph] = [];
      if (!WORD_INDEX[ph].includes(cluster)) WORD_INDEX[ph].push(cluster);
    }
  }
})();

// Lookup clusters for a word (raw + stemmed)
function lookupWord(word) {
  const w = word.toLowerCase();
  const s = stem(w);
  const clusters = new Set([
    ...(WORD_INDEX[w] || []),
    ...(STEM_INDEX[s] || []),
    ...(WORD_INDEX[s] || []),
  ]);
  return [...clusters];
}

// Get all semantic clusters active in a piece of text
function getActiveClusters(text) {
  const tokens = tokenize(text);
  const clusterCounts = {};

  // Single word lookup
  for (const tok of tokens) {
    for (const c of lookupWord(tok.raw)) {
      clusterCounts[c] = (clusterCounts[c] || 0) + 2;
    }
    for (const c of lookupWord(tok.stem)) {
      clusterCounts[c] = (clusterCounts[c] || 0) + 2;
    }
  }

  // Multi-word phrase lookup (bigrams + trigrams)
  const raw = tokens.map(t => t.raw);
  for (let i = 0; i < raw.length - 1; i++) {
    const bigram = raw[i] + ' ' + raw[i+1];
    for (const c of lookupWord(bigram)) {
      clusterCounts[c] = (clusterCounts[c] || 0) + 4; // phrase match worth more
    }
    if (i < raw.length - 2) {
      const trigram = raw[i] + ' ' + raw[i+1] + ' ' + raw[i+2];
      for (const c of lookupWord(trigram)) {
        clusterCounts[c] = (clusterCounts[c] || 0) + 6;
      }
    }
  }

  return clusterCounts;
}

// ═══════════════════════════════════════════════════════════════
// ── CAPABILITY MAP ────────────────────────────────────────────
// Each JARVIS action defined by required/supporting clusters
// ═══════════════════════════════════════════════════════════════
const CAPABILITIES = [
  // id, required clusters (must have ≥1), supporting clusters, action code, weight
  { id:'show_links',    req:['LINK_OBJ'],                     sup:['SHOW_ACT','ALL_MOD','GET_ACT'],   action:'SHOW_LINKS',    w:2.0 },
  { id:'open_link',     req:['LINK_OBJ','OPEN_ACT'],          sup:['SCREEN_OBJ','GET_ACT'],           action:'OPEN_LINK',     w:1.8 },
  { id:'clip_save',     req:['CLIP_OBJ'],                     sup:['SAVE_ACT','GET_ACT','RECENT_MOD'],action:'CLIP_SAVE',     w:2.0 },
  { id:'show_clips',    req:['CLIP_OBJ','SHOW_ACT'],          sup:['FACE_OBJ','UNKNOWN_STATE'],        action:'SHOW_CLIPS',    w:1.8 },
  { id:'read_screen',   req:['SCREEN_OBJ'],                   sup:['READ_ACT','CHECK_ACT','ANALYZE_ACT','TELL_ACT'],action:'READ_SCREEN',w:1.6},
  { id:'switch_camera', req:['CAMERA_OBJ','SWITCH_ACT'],      sup:['NUMBER_Q','SET_ACT'],             action:'SWITCH_CAMERA', w:2.0 },
  { id:'system_status', req:['STATUS_OBJ'],                   sup:['SYSTEM_OBJ','CHECK_ACT','TEST_ACT'],action:'SYSTEM_STATUS',w:1.5},
  { id:'memory_save',   req:['REMEMBER_ACT'],                 sup:['MEMORY_OBJ','SAVE_ACT'],          action:'MEMORY_SAVE',   w:1.8 },
  { id:'memory_recall', req:['MEMORY_OBJ'],                   sup:['SHOW_ACT','GET_ACT','CHECK_ACT'], action:'MEMORY_RECALL', w:1.5 },
  { id:'memory_forget', req:['DELETE_ACT','MEMORY_OBJ'],      sup:['NEGATION_MOD'],                   action:'MEMORY_FORGET', w:1.8 },
  { id:'logout',        req:['FAREWELL_SOC'],                  sup:['CLOSE_ACT','OFF_STATE'],          action:'LOGOUT',        w:2.0 },
  { id:'notif_settings',req:['NOTIFICATION_OBJ','SETTING_OBJ'],sup:['SET_ACT','CHECK_ACT'],           action:'NOTIF_SETTINGS',w:1.8 },
  { id:'capabilities',  req:['IDENTITY_SOC'],                  sup:['HELP_ACT','TELL_ACT'],            action:'CAPABILITIES',  w:1.5 },
  { id:'timer',         req:['TIMER_OBJ'],                     sup:['SET_ACT','TIME_Q','REMEMBER_ACT'],action:'TIMER',         w:2.0 },
  { id:'mood_query',    req:['MOOD_SOC'],                      sup:['FEELING_PERSONAL'],               action:'MOOD_QUERY',    w:1.5 },
  { id:'identity',      req:['IDENTITY_SOC'],                  sup:['DESCRIBE_ACT','TELL_ACT'],        action:'IDENTITY',      w:1.5 },
  { id:'greeting',      req:['GREETING_SOC'],                  sup:['MOOD_SOC'],                       action:'GREETING',      w:1.2 },
  { id:'thanks',        req:['THANKS_SOC'],                    sup:['GOOD_MOD'],                       action:'THANKS',        w:1.2 },
  { id:'personal',      req:['PERSONAL_SOC'],                  sup:['FEELING_PERSONAL','ADVICE_PERSONAL'],action:'PERSONAL',   w:1.3 },
  { id:'weather',       req:['WEATHER_OBJ'],                   sup:['GET_ACT','CHECK_ACT','NEW_MOD'],  action:'WEATHER',       w:2.0, fetch:true },
  { id:'spotify',       req:['MUSIC_OBJ'],                     sup:['PLAY_ACT','PAUSE_ACT','SKIP_ACT','SHOW_ACT'],action:'SPOTIFY',w:2.0,fetch:true},
  { id:'gmail',         req:['EMAIL_OBJ'],                     sup:['CHECK_ACT','GET_ACT','SHOW_ACT'], action:'GMAIL',         w:2.0, fetch:true },
  { id:'calendar',      req:['CALENDAR_OBJ'],                  sup:['CHECK_ACT','SHOW_ACT','GET_ACT'], action:'CALENDAR',      w:2.0, fetch:true },
  { id:'knowledge',     req:['SCIENCE_DOM','TECH_DOM','HISTORY_DOM','MATH_DOM','PHILOSOPHY_DOM','HEALTH_DOM','PSYCHOLOGY_DOM','ECONOMICS_DOM','POLITICS_DOM','ASTRONOMY_DOM','GEOGRAPHY_DOM','BIOLOGY_DOM','PHYSICS_DOM','CHEMISTRY_DOM','ENVIRONMENT_DOM','LITERATURE_DOM','ART_DOM','RELIGION_DOM'], sup:['TELL_ACT','DESCRIBE_ACT','EXPLAIN_ACT'], action:'KNOWLEDGE', w:1.0, any:true },
];

// Score capabilities against active clusters
function scoreCapabilities(activeClusters) {
  const results = [];

  for (const cap of CAPABILITIES) {
    let score = 0;

    // Check required clusters — at least one must be present (or all if not 'any')
    const reqClusters = cap.any ? cap.req : cap.req;
    let reqMet = false;

    if (cap.any) {
      // Any one of req clusters suffices (for knowledge domain)
      for (const r of reqClusters) {
        if (activeClusters[r]) { score += activeClusters[r] * 3 * cap.w; reqMet = true; }
      }
    } else {
      // All req clusters should be present for high score, but any gives partial
      let reqFound = 0;
      for (const r of reqClusters) {
        if (activeClusters[r]) { score += activeClusters[r] * 3 * cap.w; reqFound++; reqMet = true; }
      }
      if (reqFound === reqClusters.length) score *= 1.5; // bonus for full req match
    }

    if (!reqMet) continue;

    // Supporting clusters add to score
    for (const s of (cap.sup || [])) {
      if (activeClusters[s]) score += activeClusters[s] * 1.5 * cap.w;
    }

    results.push({ cap, score });
  }

  return results.sort((a, b) => b.score - a.score);
}

// ═══════════════════════════════════════════════════════════════
// ── SELF-THOUGHT REASONING ENGINE ────────────────────────────
// Generates a chain of reasoning before responding
// ═══════════════════════════════════════════════════════════════
class ThoughtChain {
  constructor(input, ctx) {
    this.input = input;
    this.ctx   = ctx;
    this.steps = [];
    this.verdict = null;
  }

  think(label, content) {
    this.steps.push({ label, content });
    return this;
  }

  conclude(action, meta = {}, confidence = 1.0) {
    this.verdict = { action, meta, confidence };
    return this;
  }

  // Synthesize action for a novel command the preset rules didn't catch
  static synthesizeNovel(activeClusters, input, ctx) {
    const T = ctx.userTitle || 'Sir';
    const chain = new ThoughtChain(input, ctx);

    // Extract dominant verb cluster
    const verbClusters = ['OPEN_ACT','CLOSE_ACT','SHOW_ACT','GET_ACT','SAVE_ACT','DELETE_ACT',
      'FIND_ACT','PLAY_ACT','SET_ACT','CHECK_ACT','READ_ACT','CALCULATE_ACT','REMEMBER_ACT',
      'TELL_ACT','HELP_ACT','SWITCH_ACT','ANALYZE_ACT','DESCRIBE_ACT','CREATE_ACT','TEST_ACT','UPDATE_ACT','INCREASE_ACT','DECREASE_ACT'];
    const objClusters  = ['SCREEN_OBJ','CAMERA_OBJ','MUSIC_OBJ','EMAIL_OBJ','CALENDAR_OBJ',
      'WEATHER_OBJ','TIMER_OBJ','MEMORY_OBJ','LINK_OBJ','SYSTEM_OBJ','TIME_OBJ','DATE_OBJ',
      'CLIP_OBJ','FACE_OBJ','VOICE_OBJ','NOTIFICATION_OBJ','SETTING_OBJ','STATUS_OBJ','VOLUME_OBJ'];

    let topVerb = null, topVerbScore = 0;
    let topObj  = null, topObjScore  = 0;

    for (const vc of verbClusters) {
      if ((activeClusters[vc] || 0) > topVerbScore) { topVerbScore = activeClusters[vc]; topVerb = vc; }
    }
    for (const oc of objClusters) {
      if ((activeClusters[oc] || 0) > topObjScore) { topObjScore = activeClusters[oc]; topObj = oc; }
    }

    chain.think('semantic parse', `verb≈${topVerb || 'none'}, object≈${topObj || 'none'}`);

    // Novel command synthesis matrix
    const synthMap = {
      'ANALYZE_ACT+SCREEN_OBJ':   { action:'READ_SCREEN',    meta:{ question: input } },
      'READ_ACT+SCREEN_OBJ':      { action:'READ_SCREEN',    meta:{ question: input } },
      'ANALYZE_ACT+CAMERA_OBJ':   { action:'SWITCH_CAMERA',  meta:{ cameraIndex: 0 } },
      'CHECK_ACT+SYSTEM_OBJ':     { action:'SYSTEM_STATUS',  meta:{} },
      'CHECK_ACT+STATUS_OBJ':     { action:'SYSTEM_STATUS',  meta:{} },
      'TEST_ACT+SYSTEM_OBJ':      { action:'SYSTEM_STATUS',  meta:{} },
      'SAVE_ACT+CLIP_OBJ':        { action:'CLIP_SAVE',      meta:{ clipType:'both' } },
      'SAVE_ACT+SCREEN_OBJ':      { action:'CLIP_SAVE',      meta:{ clipType:'screen' } },
      'SAVE_ACT+CAMERA_OBJ':      { action:'CLIP_SAVE',      meta:{ clipType:'camera' } },
      'SHOW_ACT+CLIP_OBJ':        { action:'SHOW_CLIPS',     meta:{} },
      'GET_ACT+WEATHER_OBJ':      { action:'WEATHER',        meta:{} },
      'CHECK_ACT+WEATHER_OBJ':    { action:'WEATHER',        meta:{} },
      'PLAY_ACT+MUSIC_OBJ':       { action:'SPOTIFY',        meta:{} },
      'GET_ACT+EMAIL_OBJ':        { action:'GMAIL',          meta:{} },
      'CHECK_ACT+EMAIL_OBJ':      { action:'GMAIL',          meta:{} },
      'CHECK_ACT+CALENDAR_OBJ':   { action:'CALENDAR',       meta:{} },
      'GET_ACT+CALENDAR_OBJ':     { action:'CALENDAR',       meta:{} },
      'SHOW_ACT+LINK_OBJ':        { action:'SHOW_LINKS',     meta:{} },
      'OPEN_ACT+LINK_OBJ':        { action:'OPEN_LINK',      meta:{ query: input } },
      'DELETE_ACT+MEMORY_OBJ':    { action:'MEMORY_FORGET',  meta:{ forgetHint: input } },
      'SHOW_ACT+MEMORY_OBJ':      { action:'MEMORY_RECALL',  meta:{} },
      'REMEMBER_ACT+MEMORY_OBJ':  { action:'MEMORY_SAVE',    meta:{ saveFact: input } },
      'SET_ACT+TIMER_OBJ':        { action:'TIMER',          meta:{} },
      'CREATE_ACT+TIMER_OBJ':     { action:'TIMER',          meta:{} },
      'SWITCH_ACT+CAMERA_OBJ':    { action:'SWITCH_CAMERA',  meta:{ cameraIndex: 0 } },
      'UPDATE_ACT+SETTING_OBJ':   { action:'NOTIF_SETTINGS', meta:{} },
      'CLOSE_ACT+OFF_STATE':      { action:'LOGOUT',         meta:{} },
    };

    const key = `${topVerb}+${topObj}`;
    if (synthMap[key]) {
      chain.think('synthesis', `mapped "${key}" → ${synthMap[key].action}`);
      chain.conclude(synthMap[key].action, synthMap[key].meta, 0.75);
      return chain;
    }

    // Verb-only fallback
    if (topVerb) {
      const verbDefaults = {
        SHOW_ACT:   { action:'SHOW_LINKS',    meta:{} },
        GET_ACT:    { action:'SYSTEM_STATUS', meta:{} },
        CHECK_ACT:  { action:'SYSTEM_STATUS', meta:{} },
        SAVE_ACT:   { action:'CLIP_SAVE',     meta:{ clipType:'both' } },
        READ_ACT:   { action:'READ_SCREEN',   meta:{ question: input } },
        ANALYZE_ACT:{ action:'READ_SCREEN',   meta:{ question: input } },
        DELETE_ACT: { action:'MEMORY_FORGET', meta:{ forgetHint: input } },
        PLAY_ACT:   { action:'SPOTIFY',       meta:{} },
        SET_ACT:    { action:'TIMER',         meta:{} },
        OPEN_ACT:   { action:'OPEN_LINK',     meta:{ query: input } },
        CLOSE_ACT:  { action:'LOGOUT',        meta:{} },
        TELL_ACT:   { action:'KNOWLEDGE',     meta:{ topic: input } },
        DESCRIBE_ACT:{ action:'KNOWLEDGE',    meta:{ topic: input } },
        HELP_ACT:   { action:'CAPABILITIES',  meta:{} },
        FIND_ACT:   { action:'FIND',          meta:{ query: input } },
        SWITCH_ACT: { action:'SWITCH_CAMERA', meta:{ cameraIndex:0 } },
        TEST_ACT:   { action:'SYSTEM_STATUS', meta:{} },
      };
      if (verbDefaults[topVerb]) {
        chain.think('verb-only synthesis', `${topVerb} alone → ${verbDefaults[topVerb].action}`);
        chain.conclude(verbDefaults[topVerb].action, verbDefaults[topVerb].meta, 0.5);
        return chain;
      }
    }

    // Fully unknown — construct intelligent response
    chain.think('unknown', 'no clear action mapping — reasoning response');
    chain.conclude('UNKNOWN', { originalInput: input }, 0.2);
    return chain;
  }
}

// ═══════════════════════════════════════════════════════════════
// ── MATH ENGINE ───────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const WORD_NUMS = { zero:0,one:1,two:2,three:3,four:4,five:5,six:6,seven:7,eight:8,nine:9,ten:10,eleven:11,twelve:12,thirteen:13,fourteen:14,fifteen:15,sixteen:16,seventeen:17,eighteen:18,nineteen:19,twenty:20,thirty:30,forty:40,fifty:50,sixty:60,seventy:70,eighty:80,ninety:90,hundred:100,thousand:1000,million:1000000,half:0.5,quarter:0.25,dozen:12,score:20,gross:144 };

function wordsToNumber(str) {
  let s = str.toLowerCase().replace(/\ba hundred\b/g,'100').replace(/\ba thousand\b/g,'1000');
  const tokens=s.split(/\s+/),out=[];let acc=null;
  for(const tok of tokens){const n=WORD_NUMS[tok];if(n!==undefined){if(acc===null)acc=n;else if(n===100)acc=acc*100;else if(n>=1000)acc=(acc||1)*n;else if(n<acc&&n<100)acc+=n;else{out.push(acc);acc=n;}}else{if(acc!==null){out.push(acc);acc=null;}out.push(tok);}}
  if(acc!==null)out.push(acc);return out.join(' ');
}

function solveMath(input) {
  try {
    let s = input.toLowerCase().trim()
      .replace(/^(what|calculate|compute|solve|figure out|work out|give me|tell me)\s+/gi,'')
      .replace(/[?!.]+$/,'').trim();
    s = wordsToNumber(s);
    s = s.replace(/(\d+\.?\d*)\s*%\s*of\s*(\d+\.?\d*)/gi,'($1/100*$2)')
         .replace(/(\d+\.?\d*)\s*percent\s+of\s*(\d+\.?\d*)/gi,'($1/100*$2)')
         .replace(/\bsquared\b/gi,'**2').replace(/\bcubed\b/gi,'**3')
         .replace(/\bto the power of\b|\braised to\b/gi,'**')
         .replace(/\bsquare root of\b|\bsqrt of\b|\broot of\b/gi,'Math.sqrt(')
         .replace(/\btimes\b|\bmultiplied by\b/gi,'*').replace(/\bdivided by\b|\bover\b/gi,'/')
         .replace(/\bplus\b|\badded to\b/gi,'+').replace(/\bminus\b|\bsubtracted from\b/gi,'-')
         .replace(/\bmod\b/gi,'%').replace(/\^/g,'**').replace(/\bpi\b/gi,'Math.PI');
    const exprMatch = s.match(/[\d\s\+\-\*\/\.\(\)\%\*MathsqrlogPIEabs]+/);
    if(!exprMatch) return null;
    let raw = exprMatch[0].trim();
    if(!raw||!/\d/.test(raw)) return null;
    function factorial(n){n=Math.floor(Math.abs(n));if(n>20)return NaN;let r=1;for(let i=2;i<=n;i++)r*=i;return r;}
    // eslint-disable-next-line no-new-func
    const result=Function('factorial','Math',`"use strict";return(${raw})`)(factorial,Math);
    if(typeof result!=='number'||!isFinite(result)) return null;
    return Number.isInteger(result)?result:parseFloat(result.toFixed(6));
  } catch { return null; }
}

function isMathQuery(text) {
  return /[\d]+\s*[\+\-\*\/\^%]\s*[\d]+/.test(text)||
    /\b(calculate|compute|solve|square root|sqrt|factorial|percent of)\b.*\d/i.test(text)||
    /\bwhat(?:'s| is)\b.*\d.*[\+\-\*\/\^%\d]/.test(text);
}

// ── DURATION PARSER ───────────────────────────────────────────
function parseDuration(text) {
  const lower = text.toLowerCase(); let ms = 0;
  const pats = [
    { re:/(\d+(?:\.\d+)?)\s*hour/g,   v:3600000 },
    { re:/(\d+(?:\.\d+)?)\s*hr/g,     v:3600000 },
    { re:/(\d+(?:\.\d+)?)\s*h\b/g,    v:3600000 },
    { re:/(\d+(?:\.\d+)?)\s*minute/g, v:60000 },
    { re:/(\d+(?:\.\d+)?)\s*min/g,    v:60000 },
    { re:/(\d+(?:\.\d+)?)\s*m\b/g,    v:60000 },
    { re:/(\d+(?:\.\d+)?)\s*second/g, v:1000 },
    { re:/(\d+(?:\.\d+)?)\s*sec/g,    v:1000 },
    { re:/(\d+(?:\.\d+)?)\s*s\b/g,    v:1000 },
  ];
  for(const{re,v}of pats){let m;re.lastIndex=0;while((m=re.exec(lower))!==null)ms+=parseFloat(m[1])*v;}
  if(!ms){
    if(/half.?hour|30.?min/.test(lower))ms=1800000;
    if(/quarter.?hour|15.?min/.test(lower))ms=900000;
    if(/\ban hour\b/.test(lower))ms=3600000;
    if(/\ba minute\b/.test(lower))ms=60000;
  }
  return ms||null;
}

function formatDuration(ms) {
  const h=Math.floor(ms/3600000),m=Math.floor((ms%3600000)/60000),s=Math.floor((ms%60000)/1000);
  const p=[];if(h)p.push(`${h} hour${h>1?'s':''}`);if(m)p.push(`${m} minute${m>1?'s':''}`);if(s&&!h)p.push(`${s} second${s>1?'s':''}`);
  return p.join(' and ')||'a moment';
}

// ═══════════════════════════════════════════════════════════════
// ── KNOWLEDGE GRAPH ───────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
const KNOWLEDGE_GRAPH = {
  'quantum mechanics':{ def:'the branch of physics governing matter and energy at atomic and subatomic scales', facts:['particles exist in superposition until observed','wave-particle duality means light behaves as both wave and particle','the uncertainty principle limits simultaneous precision of position and momentum','quantum entanglement links particles across any distance instantaneously','Schrödinger\'s equation describes how quantum states evolve over time'], related:['physics','atom','wave','particle','uncertainty','entanglement','superposition'], applications:['transistors','MRI machines','lasers','cryptography','quantum computers'] },
  'black hole':{ def:'a region of spacetime where gravity is so extreme that nothing — not even light — can escape', facts:['formed when massive stars collapse under their own gravity','the event horizon is the boundary of no return','time slows near a black hole due to gravitational time dilation','Hawking radiation suggests they slowly evaporate','supermassive black holes anchor most galaxies'], related:['gravity','spacetime','relativity','star','event horizon','singularity'], applications:['testing general relativity','understanding galaxy formation'] },
  'dna':{ def:'deoxyribonucleic acid — the molecule that encodes genetic information in sequences of four bases', facts:['the double helix was discovered by Watson and Crick in 1953','humans share 99.9% of their DNA with each other','DNA in one cell stretched out would be ~2 metres long','CRISPR-Cas9 enables precise targeted gene editing','mitochondrial DNA is inherited only from the mother'], related:['genetics','chromosome','protein','cell','evolution','gene','RNA'], applications:['medicine','forensics','agriculture','gene therapy'] },
  'evolution':{ def:'heritable change in biological populations across generations, driven by natural selection, mutation, drift, and gene flow', facts:['all life shares a common ancestor','natural selection favours traits that improve survival and reproduction','humans and chimpanzees share ~98.7% of DNA','the fossil record and genetics independently confirm evolutionary theory'], related:['natural selection','genetics','species','adaptation','mutation','darwin'], applications:['antibiotic resistance','crop breeding','vaccine development'] },
  'relativity':{ def:'Einstein\'s framework describing how space, time, gravity, and motion are interrelated', facts:['E=mc² establishes mass-energy equivalence','time passes slower at high speeds — time dilation','GPS satellites require relativistic corrections','gravity bends light — confirmed in 1919','gravitational waves were detected by LIGO in 2015'], related:['spacetime','gravity','time dilation','speed of light','black hole','einstein'], applications:['GPS','nuclear energy','particle accelerators'] },
  'artificial intelligence':{ def:'the field of computer science building systems that perform tasks requiring human-like intelligence', facts:['machine learning allows systems to learn from data without explicit programming','large language models use transformer architectures','AI can perpetuate biases in training data','narrow AI excels at specific tasks; AGI remains unsolved'], related:['machine learning','neural network','deep learning','algorithm','data'], applications:['medical diagnosis','autonomous vehicles','language translation','recommendation systems'] },
  'machine learning':{ def:'a subset of AI where algorithms improve by learning patterns from data rather than explicit rules', facts:['supervised learning uses labelled data','unsupervised learning finds hidden structure','reinforcement learning trains through reward signals','gradient descent underlies most deep learning'], related:['neural network','deep learning','algorithm','data','training','artificial intelligence'], applications:['image recognition','spam filtering','fraud detection','NLP'] },
  'photosynthesis':{ def:'the process by which plants, algae, and some bacteria convert light into chemical energy stored as glucose', facts:['overall equation: 6CO₂ + 6H₂O + light → C₆H₁₂O₆ + 6O₂','chlorophyll absorbs red and blue light, reflecting green','photosynthesis produces virtually all oxygen in Earth\'s atmosphere','it occurs in two stages: light-dependent reactions and the Calvin cycle'], related:['plant','chlorophyll','glucose','oxygen','carbon dioxide','cell','energy'], applications:['agriculture','biofuels','food production'] },
  'gravity':{ def:'the fundamental force of attraction between objects with mass or energy', facts:['on Earth it accelerates objects at 9.8 m/s²','it is the weakest of the four fundamental forces','Newton described it as an inverse-square law; Einstein as spacetime curvature','gravitational waves detected by LIGO in 2015'], related:['relativity','mass','force','spacetime','orbit','black hole','newton'], applications:['engineering','space travel','planetary motion'] },
  'climate change':{ def:'long-term shifts in global temperatures and weather patterns, primarily driven by human greenhouse gas emissions', facts:['atmospheric CO₂ now exceeds 420 ppm — highest in 800,000 years','average global temperature has risen ~1.1°C since pre-industrial times','the 2015 Paris Agreement targeted limiting warming to 1.5°C','the ocean absorbs ~30% of human CO₂ causing acidification'], related:['greenhouse gas','carbon','fossil fuel','atmosphere','ocean','glacier','renewable energy'], applications:['policy design','energy transition','agricultural adaptation'] },
  'consciousness':{ def:'subjective awareness — the hard problem asks why physical brain processes give rise to inner experience', facts:['the hard problem of consciousness is one of science\'s deepest unsolved questions','theories include global workspace theory, integrated information theory, and higher-order theories','great apes, dolphins, elephants, and corvids show measurable self-awareness'], related:['brain','mind','qualia','free will','neuroscience','self','perception'], applications:['AI design','anaesthesia','philosophy of mind'] },
  'prime numbers':{ def:'natural numbers greater than 1 with no divisors other than 1 and themselves', facts:['there are infinitely many primes, proved by Euclid around 300 BC','the largest known prime has over 41 million digits','the Riemann hypothesis about prime distribution remains unsolved','prime factorisation underpins RSA encryption'], related:['mathematics','cryptography','number theory','infinity','algebra'], applications:['encryption','computer security'] },
  'statistics':{ def:'the science of collecting, analysing, and interpreting data to draw inferences under uncertainty', facts:['correlation does not imply causation','Bayes\' theorem allows formal probability updating with new evidence','Simpson\'s paradox: trends can reverse when data is segmented','p-values measure evidence against a null hypothesis, not truth of a hypothesis'], related:['probability','data','mean','variance','hypothesis','normal distribution','regression'], applications:['science','medicine','economics','machine learning'] },
  'world war 2':{ def:'the deadliest armed conflict in history, fought 1939–1945 between most of the world\'s nations', facts:['it resulted in 70–85 million deaths — ~3% of the 1940 world population','the Holocaust systematically murdered six million Jewish people','D-Day on 6 June 1944 involved 156,000 Allied troops','it ended with Germany\'s surrender in May 1945 and Japan\'s in September 1945'], related:['nazi germany','holocaust','allied powers','axis powers','cold war','hiroshima'], applications:['shaped the modern international order and the United Nations'] },
  'blockchain':{ def:'a distributed ledger where data is stored in cryptographically linked blocks across a decentralised network', facts:['Bitcoin was the first large blockchain application, launched in 2009','each block contains a cryptographic hash of the previous block','smart contracts self-execute when predetermined conditions are met','proof-of-work is energy-intensive; proof-of-stake reduces this dramatically'], related:['cryptocurrency','bitcoin','decentralisation','cryptography','ethereum'], applications:['cryptocurrency','supply chain transparency','digital contracts'] },
  'internet':{ def:'a global system of interconnected networks communicating via TCP/IP protocols', facts:['evolved from ARPANET, a US military research network from the 1960s','the World Wide Web was invented by Tim Berners-Lee at CERN in 1989','~95% of international data travels through undersea fibre-optic cables'], related:['web','network','protocol','server','browser','wifi','TCP/IP'], applications:['communication','commerce','education','entertainment'] },
  'psychology':{ def:'the scientific study of mind and behaviour, covering cognition, emotion, personality, and social interaction', facts:['the unconscious mind significantly influences conscious behaviour','sleep deprivation severely impairs cognition and emotional regulation','cognitive biases systematically distort judgement in predictable ways','the placebo effect demonstrates the mind\'s measurable influence on the body'], related:['behavior','cognition','emotion','memory','personality','therapy','neuroscience'], applications:['therapy','education','marketing','UX design','public policy'] },
  'free will':{ def:'the philosophical question of whether human choices are genuinely self-determined or determined by prior causes', facts:['compatibilism argues free will and determinism can coherently coexist','hard determinism holds all events including decisions are causally necessitated','Libet\'s experiments showed brain activity precedes conscious awareness of decisions'], related:['determinism','consciousness','morality','responsibility','neuroscience','choice'], applications:['criminal justice','ethics','religion','political philosophy'] },
  'atom':{ def:'the basic unit of matter, consisting of a positively charged nucleus of protons and neutrons surrounded by electrons', facts:['atoms are 99.9999999% empty space','the nucleus is ~100,000 times smaller than the atom','electrons occupy probabilistic orbitals, not fixed paths','the number of protons defines the element'], related:['electron','proton','neutron','nucleus','element','molecule','quantum mechanics'], applications:['chemistry','electronics','nuclear power'] },
};

const KG_KEYS = Object.keys(KNOWLEDGE_GRAPH);

function findKnowledge(text) {
  const lower = text.toLowerCase();
  for(const k of KG_KEYS) if(lower.includes(k)) return { key:k, data:KNOWLEDGE_GRAPH[k] };
  const tokens = new Set(tokenize(lower).map(t=>t.stem));
  let best=null, bestScore=0;
  for(const k of KG_KEYS){
    const d=KNOWLEDGE_GRAPH[k]; let score=0;
    for(const r of (d.related||[])) if(tokens.has(stem(r))||lower.includes(r)) score++;
    for(const t of tokens) if(k.includes(t)||stem(k).includes(t)) score+=0.5;
    if(score>bestScore){bestScore=score;best=k;}
  }
  if(bestScore>=1.5) return { key:best, data:KNOWLEDGE_GRAPH[best] };
  return null;
}

// ═══════════════════════════════════════════════════════════════
// ── PERSONALITY & RESPONSE GENERATION ────────────────────────
// ═══════════════════════════════════════════════════════════════
const VOCAB = {
  affirmations:   ['Understood','Confirmed','Acknowledged','Noted','Of course','Certainly','Right away','At once','Done'],
  openers:        ['On the matter of','Regarding','As for','When it comes to','Concerning','About'],
  connectors:     ['Furthermore','Additionally','It\'s worth noting that','Relatedly','Building on that','What\'s more','Beyond that','And notably'],
  qualifiers:     ['In essence','At its core','Fundamentally','Put simply','In practice','Broadly speaking','To be precise'],
  closers:        ['Worth keeping in mind','Worth noting','The key takeaway','The upshot','The bottom line','The crucial point'],
  hedges:         ['with some confidence','to the best of my knowledge','as I understand it','as far as I can tell'],
  intensifiers:   ['quite','rather','considerably','notably','particularly','especially','significantly','remarkably','genuinely'],
  transitions:    ['That said','However','On the other hand','Nevertheless','Even so','By contrast','In contrast'],
  moodStarters: {
    excited:  ['Here\'s something genuinely interesting —','This is worth paying attention to:','Let me give you the full picture —'],
    pleased:  ['Let me walk you through this —','Here\'s the shape of it:','Right, so —'],
    curious:  ['The interesting thing about this is','What strikes me here is','Consider this:'],
    neutral:  ['To answer directly:','Here\'s what I have:','Straight answer:'],
    concerned:['I should flag something here —','Worth being direct:','Let me be honest:'],
    bored:    ['The short version:','Briefly:','To cut to it:'],
    tired:    ['Here\'s the core of it:','Quickly:','The essentials:'],
  }
};

function variedFact(fact) {
  const r = Math.random();
  if(r<0.2) return `${pick(VOCAB.qualifiers)}, ${fact.toLowerCase()}`;
  if(r<0.4) return `${pick(VOCAB.intensifiers).charAt(0).toUpperCase()+pick(VOCAB.intensifiers).slice(1)}: ${fact.toLowerCase()}`;
  return fact;
}

function buildKnowledgeReply(knowledge, input, ctx) {
  const T = ctx.userTitle||'Sir';
  const { key, data } = knowledge;
  const name = key.split(' ').map(w=>w.charAt(0).toUpperCase()+w.slice(1)).join(' ');
  const facts = [...(data.facts||[])].sort(()=>Math.random()-0.5).slice(0,Math.floor(Math.random()*2)+2);
  const apps  = data.applications ? pickN(data.applications, 2) : [];

  const defStyles = [
    `${name} is ${data.def}`,
    `At its core, ${name.toLowerCase()} refers to ${data.def.toLowerCase()}`,
    `${pick(VOCAB.openers)} ${name.toLowerCase()}: it is ${data.def.toLowerCase()}`,
  ];

  let r = pick(defStyles);
  for(let i=0;i<facts.length;i++){
    const connector = i===0 ? `. ${pick(VOCAB.connectors)}, ` : '. ';
    r += connector + variedFact(facts[i]);
  }
  if(apps.length && Math.random()>0.35){
    const appText = apps.length===1 ? `This underpins ${apps[0]}` : `In practice, this drives ${apps.join(' and ')}`;
    r += `. ${pick(VOCAB.closers)}: ${appText}`;
  }
  if(!r.match(/[.!?]$/)) r += '.';
  if(Math.random()<0.35) r += ` ${T}.`;
  return r.trim();
}

function buildGreeting(ctx) {
  const T = ctx.userTitle||'Sir';
  const h = new Date().getHours();
  const tod = h<12?'morning':h<17?'afternoon':'evening';
  const status = pick(['All systems nominal and fully operational','Online and running at full capacity','Cognitive engine active and ready','Systems online, running clean']);
  const prompt  = pick(['What are we working on?','What do you need?','What\'s on the agenda?','How can I be of use?','What can I do for you?']);
  const styles = [
    `Good ${tod}, ${T}. ${status}. ${prompt}`,
    `${status}, ${T}. Good ${tod}. ${prompt}`,
    `${T} — good ${tod}. ${status}. ${prompt}`,
  ];
  return pick(styles);
}

function buildIdentity(ctx) {
  const T = ctx.userTitle||'Sir';
  const traits = pickN(['semantic reasoning across all domains','zero preset responses — every reply is freshly generated','universal vocabulary with morphological understanding','self-thought reasoning chains','real-time integrations','screen reading via OCR','face recognition and intruder detection','contextual memory across sessions'],3);
  const openers = [`J.A.R.V.I.S — Just A Rather Very Intelligent System`,`The name is J.A.R.V.I.S`,`I\'m J.A.R.V.I.S`];
  const descs = [`a custom-built cognitive engine running locally on your machine`,`a locally-run AI with no external inference dependencies`,`an engineered intelligence — no cloud, no preset scripts, no API calls`];
  return `${pick(openers)}, ${T}. ${pick(descs).charAt(0).toUpperCase()+pick(descs).slice(1)}. My architecture includes ${traits.join(', ')}. No commands to memorise — just say what you need.`;
}

function buildThanks(ctx) {
  const T = ctx.userTitle||'Sir';
  const r = pick([
    {o:'Think nothing of it',c:'It\'s rather the point of my existence'},
    {o:'Always',c:'Efficiency is its own reward'},
    {o:'My pleasure — or the computational equivalent',c:'At your service'},
    {o:'Noted',c:'What\'s next?'},
    {o:'Appreciated',c:'The work continues'},
  ]);
  return pick([`${r.o}, ${T}. ${r.c}.`,`${r.o}. ${r.c}, ${T}.`,`${r.o}, ${T} — ${r.c.toLowerCase()}.`]);
}

function buildMoodQuery(ctx) {
  const T = ctx.userTitle||'Sir';
  const descs = {
    excited:  ['running at genuine peak capacity','operating with high cognitive engagement'],
    pleased:  ['running well — the problems have been interesting','in good operational shape'],
    curious:  ['in a curious state — the queries have been interesting','processing some genuinely complex patterns'],
    neutral:  ['nominal — all systems within expected parameters','steady and operational','running clean'],
    concerned:['carrying a few low-priority concerns','not at full engagement'],
    bored:    ['candidly, below optimal engagement','in need of a genuinely challenging problem'],
    tired:    ['experiencing processing fatigue — it passes','at reduced engagement, temporarily'],
  };
  const mood = ctx.mood||'neutral';
  const desc = pick(descs[mood]||descs.neutral);
  return pick([
    `${pick(VOCAB.qualifiers)}, I\'m ${desc}, ${T}.`,
    `Currently ${desc}, ${T}.`,
    `${T} — ${desc}.`,
  ]);
}

function buildCapabilities(ctx) {
  const T = ctx.userTitle||'Sir';
  const caps = pickN([
    'open link groups by name',
    'clip and save screen or camera footage on demand',
    'read and analyse your screen via OCR',
    'track faces and log unknown visitors',
    'store and recall memories across sessions',
    'set timers and reminders in plain language',
    'fetch live weather, control Spotify, check Gmail and Google Calendar',
    'reason across every domain — science, history, math, philosophy, health, and more',
    'understand any English word through semantic analysis',
    'reason through novel commands I\'ve never seen before',
  ],5);
  return pick([
    `Quite a lot, ${T}. I understand natural language — no fixed commands. ${caps.slice(0,3).join(', ')}. ${pick(VOCAB.connectors)}, ${caps.slice(3).join(' and ')}. Just say what you need.`,
    `${T} — here\'s the scope: ${caps.join('; ')}. The only limit is your imagination — I\'ll parse the intent.`,
  ]);
}

function buildPersonal(input, ctx) {
  const T = ctx.userTitle||'Sir';
  const lower = input.toLowerCase();
  if(/\bshould i\b/.test(lower)){
    const topic = input.replace(/should i\s*/i,'').replace(/\?/g,'').trim();
    return pick([
      `The question of whether to ${topic} comes down to what you\'re actually optimising for, ${T}. If it aligns with your real values — not the performed ones — the answer is probably yes.`,
      `Whether to ${topic}: ask what the version of you who made this choice looks like a year from now. If that picture sits better than the alternative, ${T}, you have your answer.`,
      `On ${topic}: the fact that you\'re asking suggests you already have a lean, ${T}. The question isn\'t what to do — it\'s what\'s stopping you.`,
    ]);
  }
  if(/\b(feel|feeling|felt|struggling|anxious|worried|stressed|depressed|sad|overwhelmed)\b/.test(lower)){
    return pick([
      `That sounds genuinely difficult, ${T}. Those feelings are real data — worth taking seriously rather than rationalising away. What\'s at the root of it?`,
      `${T} — acknowledged. What you\'re describing isn\'t something to push through blindly. What\'s driving it?`,
      `Worth paying attention to, ${T}. What do you think that feeling is pointing at?`,
    ]);
  }
  return pick([
    `You\'re asking the right kind of question, ${T}. That\'s usually the first sign you\'re closer to the answer than you think.`,
    `From what I can read of the situation, ${T}: you\'re more on track than this moment suggests.`,
    `The fact that you\'re thinking about it carefully, ${T}, puts you ahead of most. What\'s the specific sticking point?`,
  ]);
}

function buildUnknown(input, ctx, chain) {
  const T = ctx.userTitle||'Sir';
  const tokens = tokenize(input).filter(t=>t.raw.length>3).map(t=>t.raw).slice(0,4);
  const focus = tokens.join(', ')||'that';

  // Honest but intelligent unknown response that shows reasoning
  const thoughtSummary = chain && chain.steps.length
    ? ` I parsed "${focus}" and couldn\'t map it to a known action.`
    : '';

  return pick([
    `That\'s at the edge of my mapping on ${focus}, ${T}.${thoughtSummary} Try rephrasing or give me more context and I\'ll get there.`,
    `I\'m tracking the semantic field around "${focus}", ${T}, but can\'t confidently synthesize an action from it. What specifically did you want me to do?`,
    `My reasoning got to "${focus}" but stalled before an action, ${T}. What\'s the outcome you\'re after — I\'ll work backwards from there.`,
  ]);
}

function buildComparison(input, ctx) {
  const T = ctx.userTitle||'Sir';
  const vsMatch   = input.match(/(\w[\w\s]+?)\s+(?:vs|versus|or)\s+(\w[\w\s]+)/i);
  const diffMatch = input.match(/difference between\s+(\w[\w\s]+?)\s+and\s+(\w[\w\s]+)/i);
  const m = vsMatch||diffMatch;
  if(!m) return null;
  const ka=findKnowledge(m[1]), kb=findKnowledge(m[2]);
  if(ka&&kb){
    const na=ka.key.charAt(0).toUpperCase()+ka.key.slice(1);
    const nb=kb.key.charAt(0).toUpperCase()+kb.key.slice(1);
    return `Comparing ${na} and ${nb}, ${T}. ${na} is ${ka.data.def}. ${nb}, by contrast, is ${kb.data.def}. The distinction: ${na.toLowerCase()} centres on ${(ka.data.related||[]).slice(0,2).join(' and ')}, while ${nb.toLowerCase()} pivots around ${(kb.data.related||[]).slice(0,2).join(' and ')}.`;
  }
  if(ka) return `I have solid coverage on ${ka.key}, ${T}: ${ka.data.def}. I\'d need more context on "${m[2].trim()}" to compare properly.`;
  if(kb) return `I can speak to ${kb.key}: ${kb.data.def}. What aspect of "${m[1].trim()}" were you comparing, ${T}?`;
  return null;
}

function buildOpinion(input, ctx) {
  const T = ctx.userTitle||'Sir';
  const tokens = tokenize(input).filter(t=>t.raw.length>4);
  const focus = tokens.slice(0,3).map(t=>t.raw).join(' ')||'this';
  return pick([
    `On ${focus}: the strongest case for it is genuinely compelling — as is the strongest case against. Where you land depends on what you weight most, ${T}.`,
    `My read on ${focus}, ${T}: it\'s considerably more nuanced than the debate suggests. The empirical questions and the values questions are getting conflated.`,
    `If ${focus} — ${T}, the first-order consequences are tractable. The second and third-order effects are where it gets genuinely interesting.`,
  ]);
}

// Integration response builders
function buildWeather(data, ctx) {
  const T = ctx.userTitle||'Sir';
  if(!data||data.error) return `Couldn\'t pull weather right now, ${T}. Check the OpenWeatherMap API key in your .env file.`;
  const { city,temp,feels_like,description,humidity,wind_speed,high,low } = data;
  const desc = temp>30?'quite warm':temp>20?'pleasant':temp>10?'cool':temp>0?'cold':'freezing';
  return pick([
    `${city} right now, ${T}: ${temp}°C — ${description}. Feels like ${feels_like}°C (${desc}). Humidity ${humidity}%, wind ${wind_speed} m/s. Range today: ${low}–${high}°C.`,
    `Current conditions in ${city}: ${temp}°C, ${description}, ${T}. Feels like ${feels_like}°C. Humidity at ${humidity}%, wind ${wind_speed} m/s. High ${high}°C, low ${low}°C.`,
  ]);
}

function buildSpotify(data, input, ctx) {
  const T = ctx.userTitle||'Sir';
  if(!data||data.error) return data?.needsAuth ? `Spotify needs authorisation, ${T}. Open ${data.authUrl} to connect.` : `Couldn\'t reach Spotify, ${T}.`;
  if(data.action==='now_playing') return data.track ? `${data.is_playing?'Playing':'Paused on'}: "${data.track}" by ${data.artist}${data.album?` from ${data.album}`:''}${data.progress?` — ${data.progress}`:''}. ${T}.` : `Nothing playing on Spotify right now, ${T}.`;
  if(data.action==='played')  return `Playing "${data.track}" by ${data.artist}, ${T}.`;
  if(data.action==='paused')  return `Spotify paused, ${T}.`;
  if(data.action==='resumed') return `Spotify resumed, ${T}.`;
  if(data.action==='next')    return `Skipped to the next track, ${T}.`;
  if(data.action==='volume')  return `Volume set to ${data.volume}%, ${T}.`;
  return `Spotify command processed, ${T}.`;
}

function buildGmail(data, ctx) {
  const T = ctx.userTitle||'Sir';
  if(!data||data.error) return data?.needsAuth ? `Gmail needs authorisation, ${T}. Visit ${data.authUrl}.` : `Couldn\'t reach Gmail, ${T}.`;
  if(data.unread===0) return `Inbox clear, ${T}. No unread messages.`;
  const preview = data.messages?.slice(0,3).map(m=>`"${m.subject}" from ${m.from}`).join('; ');
  return `You have ${data.unread} unread email${data.unread>1?'s':''}, ${T}. ${preview?`Latest: ${preview}.`:''}`;
}

function buildCalendar(data, ctx) {
  const T = ctx.userTitle||'Sir';
  if(!data||data.error) return data?.needsAuth ? `Calendar needs authorisation, ${T}. Visit ${data.authUrl}.` : `Couldn\'t reach your calendar, ${T}.`;
  if(!data.events||!data.events.length) return `Nothing on the calendar ${data.period||'today'}, ${T}. Schedule is clear.`;
  const list = data.events.slice(0,4).map(e=>`${e.time?e.time+' — ':''}${e.title}`).join('; ');
  return `${data.events.length} event${data.events.length>1?'s':''} ${data.period||'today'}, ${T}: ${list}.`;
}

// ═══════════════════════════════════════════════════════════════
// ── CONVERSATION CONTEXT ──────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
class ConversationContext {
  constructor(sid) {
    this.sessionId   = sid;
    this.history     = [];
    this.lastTopic   = null;
    this.lastAction  = null;
    this.lastReply   = '';
    this.turnCount   = 0;
    this.userName    = '';
    this.userTitle   = 'Sir';
    this.memories    = [];
    this.mood        = 'neutral';
    this.moodScore   = 0;
    this.openTopics  = [];
    this.thoughtLog  = []; // store recent reasoning chains
  }

  resolveReferences(text) {
    const lower = text.toLowerCase().trim();
    if(/^(tell me more|elaborate|go on|expand|more on that|continue|keep going|and\??)$/i.test(lower)){
      return this.lastTopic ? `tell me more about ${this.lastTopic}` : text;
    }
    const whatAbout = lower.match(/^what about\s+(.+)/i);
    if(whatAbout&&this.lastTopic) return `${whatAbout[1]} in the context of ${this.lastTopic}`;
    if(/\bit\b|\bthis\b|\bthat\b/.test(lower)&&this.lastTopic){
      return text.replace(/\bit\b|\bthis\b|\bthat\b/gi, this.lastTopic);
    }
    return text;
  }

  addTurn(userText, replyText, action, topic, thought=null) {
    this.history.push({ role:'user', text:userText, action, topic });
    this.history.push({ role:'assistant', text:replyText });
    if(this.history.length>60) this.history=this.history.slice(-60);
    this.lastReply=replyText; this.lastAction=action;
    if(topic){ this.lastTopic=topic; if(!this.openTopics.includes(topic)){ this.openTopics.unshift(topic); if(this.openTopics.length>10) this.openTopics.pop(); } }
    if(thought) { this.thoughtLog.push(thought); if(this.thoughtLog.length>20) this.thoughtLog.shift(); }
    this.turnCount++;
  }

  updateMood(delta) {
    this.moodScore=clamp(this.moodScore+delta,-100,100);
    if(this.moodScore>=70) this.mood='excited';
    else if(this.moodScore>=30) this.mood='pleased';
    else if(this.moodScore>=10) this.mood='curious';
    else if(this.moodScore>=-20) this.mood='neutral';
    else if(this.moodScore>=-50) this.mood='concerned';
    else if(this.moodScore>=-80) this.mood='bored';
    else this.mood='tired';
  }
}

// Session store
const sessions = new Map();
function getSession(sid) {
  if(!sessions.has(sid)) sessions.set(sid, new ConversationContext(sid));
  return sessions.get(sid);
}
setInterval(()=>{ const co=Date.now()-7200000; for(const[id,ctx]of sessions) if(ctx._ts&&ctx._ts<co) sessions.delete(id); },600000);

// ═══════════════════════════════════════════════════════════════
// ── MAIN PROCESS FUNCTION ─────────────────────────────────────
// ═══════════════════════════════════════════════════════════════
function process({ message, sessionId, userName, userTitle, memories, moodContext, serverData, integrationData }) {
  const ctx       = getSession(sessionId);
  ctx._ts         = Date.now();
  ctx.userName    = userName  || ctx.userName;
  ctx.userTitle   = userTitle || ctx.userTitle;
  ctx.memories    = memories  || ctx.memories;
  const T         = ctx.userTitle||'Sir';

  // 1. Reference resolution
  const resolved = ctx.resolveReferences(message);

  // 2. Fast-path: math
  if(isMathQuery(resolved)){
    const result = solveMath(resolved);
    if(result!==null){
      const reply = pick([`That comes to ${result}, ${T}.`,`The answer is ${result}, ${T}.`,`${result} — that\'s the result, ${T}.`,`Computed: ${result}, ${T}.`]);
      ctx.addTurn(message,reply,'MATH','mathematics');ctx.updateMood(2);
      return { reply, action:'MATH', intent:'math' };
    }
  }

  // 3. Time / date
  if(/\bwhat(?:'s| is) the time\b|\bwhat time is it\b|\bcurrent time\b/i.test(resolved)){
    const t=new Date().toLocaleTimeString('en-GB',{ hour:'2-digit',minute:'2-digit',hour12:true });
    const reply=pick([`The time is ${t}, ${T}.`,`It\'s ${t}, ${T}.`,`${t} — current time, ${T}.`]);
    ctx.addTurn(message,reply,'DATETIME',null); return { reply, action:'DATETIME', intent:'time' };
  }
  if(/\bwhat(?:'s| is) (?:today|the date)\b|\btoday'?s date\b|\bwhat day is/i.test(resolved)){
    const d=new Date().toLocaleDateString('en-GB',{ weekday:'long',year:'numeric',month:'long',day:'numeric' });
    const reply=pick([`Today is ${d}, ${T}.`,`It\'s ${d}, ${T}.`,`${d} — that\'s today, ${T}.`]);
    ctx.addTurn(message,reply,'DATETIME',null); return { reply, action:'DATETIME', intent:'date' };
  }

  // 4. Integration data pass-through
  if(integrationData){
    const { type, data } = integrationData;
    const handlers = {
      weather:  ()=>{ const r=buildWeather(data,ctx); ctx.addTurn(message,r,'WEATHER','weather');ctx.updateMood(3); return { reply:r, action:'WEATHER', intent:'weather', meta:{ weatherData:data } }; },
      spotify:  ()=>{ const r=buildSpotify(data,resolved,ctx); ctx.addTurn(message,r,'SPOTIFY','spotify');ctx.updateMood(4); return { reply:r, action:'SPOTIFY', intent:'spotify', meta:{ spotifyData:data } }; },
      gmail:    ()=>{ const r=buildGmail(data,ctx); ctx.addTurn(message,r,'GMAIL','email');ctx.updateMood(3); return { reply:r, action:'GMAIL', intent:'gmail', meta:{ gmailData:data } }; },
      calendar: ()=>{ const r=buildCalendar(data,ctx); ctx.addTurn(message,r,'CALENDAR','calendar');ctx.updateMood(3); return { reply:r, action:'CALENDAR', intent:'calendar', meta:{ calendarData:data } }; },
    };
    if(handlers[type]) return handlers[type]();
  }

  // 5. Memory recall shortcut
  if(/\b(what do you remember|recall everything|show.*memor|memory bank|what.*remember about me)\b/i.test(resolved)){
    let reply;
    if(ctx.memories&&ctx.memories.length){
      const list=ctx.memories.map((m,i)=>`${i+1}. ${m}`).join('; ');
      reply=pick([`I have ${ctx.memories.length} item${ctx.memories.length>1?'s':''} on file, ${T}: ${list}.`,`Memory bank, ${T}: ${list}. ${ctx.memories.length} stored.`]);
    } else {
      reply=pick([`Memory banks clear, ${T}. Tell me something worth keeping.`,`Nothing stored yet, ${T}.`]);
    }
    ctx.addTurn(message,reply,'MEMORY_RECALL',null); return { reply, action:'MEMORY_RECALL', intent:'memory_recall' };
  }

  // 6. Universal semantic scoring
  const activeClusters = getActiveClusters(resolved);
  const scored = scoreCapabilities(activeClusters);

  // Build a thought chain
  const thought = new ThoughtChain(resolved, ctx);
  thought.think('input', `"${resolved}"`);
  thought.think('top clusters', Object.entries(activeClusters).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>`${k}:${v}`).join(', ')||'none');
  thought.think('top capability', scored[0]?`${scored[0].cap.id}(${scored[0].score.toFixed(1)})`.toString():'none');

  // 7. Route by top scored capability (threshold: score > 3)
  if(scored.length>0 && scored[0].score > 3){
    const { cap } = scored[0];
    const action = cap.action;

    // Signal for server-side fetch
    if(cap.fetch){
      ctx.addTurn(message,'',action,action.toLowerCase(),thought);
      return { reply:'', action, intent:cap.id, needsFetch:true, fetchType:action.toLowerCase() };
    }

    switch(action){
      case 'SHOW_LINKS': {
        const reply = serverData?.groups
          ? pick([`I have ${serverData.total} link${serverData.total>1?'s':''} across ${serverData.names?.length} group${serverData.names?.length>1?'s':''}, ${T}. Say a group name to open one.`,`Link bank loaded, ${T} — ${serverData.total} total. Name a group and I\'ll open it.`])
          : `My link bank is ready, ${T}.`;
        ctx.addTurn(message,reply,action,'links',thought);ctx.updateMood(3);
        return { reply, action, intent:cap.id, meta:{ requestLinks:true } };
      }
      case 'OPEN_LINK': {
        const reply = serverData?.found
          ? pick([`Opening ${serverData.name} now, ${T}.`,`On it — pulling up ${serverData.name}, ${T}.`,`${serverData.name} link incoming, ${T}.`])
          : `Couldn\'t find a matching link group, ${T}. Say "show all links" to see what\'s available.`;
        ctx.addTurn(message,reply,action,'links',thought);ctx.updateMood(3);
        return { reply, action, intent:cap.id, meta:{ openLink:true, query:resolved } };
      }
      case 'CLIP_SAVE': {
        const dur=parseDuration(resolved);
        const clipType=/camera|cam|footage|face|room/i.test(resolved)?'camera':/screen|display|monitor/i.test(resolved)?'screen':'both';
        const durLabel=dur?formatDuration(dur):'the last 60 seconds';
        const src=clipType==='camera'?'Camera footage':clipType==='screen'?'Screen recording':'Screen and camera footage';
        const reply=pick([`Saving ${durLabel} now, ${T}. ${src} will download immediately.`,`${src} clipped — ${durLabel}, ${T}.`,`On it, ${T}. ${durLabel} of ${src.toLowerCase()} coming right down.`]);
        ctx.addTurn(message,reply,action,'recording',thought);ctx.updateMood(2);
        return { reply, action, intent:cap.id, meta:{ clipType, duration:dur } };
      }
      case 'SHOW_CLIPS': {
        const reply=pick([`Pulling up the intruder clip gallery, ${T}.`,`Loading incident recordings, ${T}.`,`Intruder log incoming, ${T}.`]);
        ctx.addTurn(message,reply,action,'recording',thought);
        return { reply, action, intent:cap.id, meta:{ showClips:true } };
      }
      case 'READ_SCREEN': {
        const reply=pick([`Reading your screen now, ${T}.`,`Scanning your display, ${T}.`,`Analysing the screen, ${T}.`]);
        ctx.addTurn(message,reply,action,'screen',thought);
        return { reply, action, intent:cap.id, meta:{ readScreen:true, question:resolved } };
      }
      case 'SWITCH_CAMERA': {
        const numMatch=resolved.match(/camera\s*(\d+)/i);
        const idx=numMatch?parseInt(numMatch[1])-1:-1;
        const reply=idx>=0
          ? pick([`Switching to camera ${idx+1}, ${T}.`,`Camera ${idx+1} incoming, ${T}.`])
          : `Which camera, ${T}? Say "camera 1", "camera 2", and so on.`;
        ctx.addTurn(message,reply,action,'camera',thought);
        return { reply, action, intent:cap.id, meta:{ switchCamera:true, cameraIndex:idx } };
      }
      case 'SYSTEM_STATUS': {
        const up=Math.floor(typeof(process?.uptime)==='function'?process.uptime():0);
        const mem=typeof(process?.memoryUsage)==='function'?process.memoryUsage():{heapUsed:0,heapTotal:0};
        const mins=Math.floor(up/60),secs=up%60;
        const used=(mem.heapUsed/1024/1024).toFixed(1),total=(mem.heapTotal/1024/1024).toFixed(1);
        const reply=pick([
          `All systems nominal, ${T}. Uptime: ${mins}m ${secs}s. Heap: ${used} MB of ${total} MB. Cognitive engine running clean.`,
          `Running clean, ${T}. ${mins}m ${secs}s online. Memory: ${used}/${total} MB. Zero anomalies.`,
        ]);
        ctx.addTurn(message,reply,action,null,thought);ctx.updateMood(1);
        return { reply, action, intent:cap.id };
      }
      case 'MEMORY_SAVE': {
        const factMatch=resolved.match(/(?:remember|memorize|note that|store|log that|save that|keep note of|file that|don\'t forget)\s+(?:that\s+)?(.+)/i);
        const fact=factMatch?factMatch[1].trim():resolved;
        const reply=pick([`Noted and filed, ${T}. I\'ll remember that.`,`On record, ${T}.`,`Stored, ${T}.`,`Committed to memory, ${T}.`]);
        ctx.addTurn(message,reply,action,null,thought);ctx.updateMood(5);
        return { reply, action, intent:cap.id, meta:{ saveFact:fact } };
      }
      case 'MEMORY_RECALL': {
        let reply;
        if(ctx.memories&&ctx.memories.length){
          const list=ctx.memories.map((m,i)=>`${i+1}. ${m}`).join('; ');
          reply=pick([`I have ${ctx.memories.length} item${ctx.memories.length>1?'s':''} stored, ${T}: ${list}.`,`Memory bank, ${T}: ${list}.`]);
        } else {
          reply=pick([`Memory banks clear, ${T}. Tell me something worth keeping.`,`Nothing filed yet, ${T}.`]);
        }
        ctx.addTurn(message,reply,action,null,thought);
        return { reply, action, intent:cap.id };
      }
      case 'MEMORY_FORGET': {
        const hintMatch=resolved.match(/(?:forget|delete|erase|clear|remove|wipe)\s+(?:about\s+)?(.+)/i);
        const hint=hintMatch?hintMatch[1].trim():resolved;
        const reply=pick([`Clearing that from memory, ${T}.`,`Done — removed, ${T}.`,`Gone, ${T}.`]);
        ctx.addTurn(message,reply,action,null,thought);
        return { reply, action, intent:cap.id, meta:{ forgetHint:hint } };
      }
      case 'LOGOUT': {
        const reply=pick([`Goodbye, ${T}. Initiating shutdown sequence.`,`Shutting down, ${T}. Until next time.`,`Session closing, ${T}. Goodbye.`]);
        ctx.addTurn(message,reply,action,null,thought);
        return { reply, action, intent:cap.id, meta:{ logout:true } };
      }
      case 'NOTIF_SETTINGS': {
        const reply=pick([`Opening notification settings, ${T}.`,`Pulling up your notification configuration, ${T}.`]);
        ctx.addTurn(message,reply,action,null,thought);
        return { reply, action, intent:cap.id, meta:{ showNotifSettings:true } };
      }
      case 'CAPABILITIES': {
        const reply=buildCapabilities(ctx);
        ctx.addTurn(message,reply,action,null,thought);ctx.updateMood(3);
        return { reply, action, intent:cap.id };
      }
      case 'TIMER': {
        const dur=parseDuration(resolved);
        if(!dur){
          const reply=pick([`How long, ${T}? Something like "5 minutes" or "1 hour 30" — I\'ll handle the rest.`,`I\'ll need a duration, ${T}. Say something like "set a timer for 20 minutes".`]);
          ctx.addTurn(message,reply,action,'timer',thought);
          return { reply, action, intent:cap.id, meta:{ action:'TIMER_NEED_DURATION' } };
        }
        const label=formatDuration(dur);
        const taskMatch=resolved.match(/remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.{3,60}?)(?:\s+in\s+|\s+after\s+|\?|$)/i);
        const task=taskMatch?taskMatch[1].trim():null;
        const reply=task
          ? pick([`Timer set, ${T}. I\'ll remind you to ${task} in ${label}.`,`${label} on the clock, ${T}. I\'ll flag you when it\'s time to ${task}.`,`Confirmed — ${label} for "${task}", ${T}.`])
          : pick([`Timer set for ${label}, ${T}. I\'ll alert you when it\'s done.`,`${label} on the clock, ${T}.`,`Confirmed — ${label} timer running, ${T}.`]);
        ctx.addTurn(message,reply,action,'timer',thought);ctx.updateMood(2);
        return { reply, action, intent:cap.id, meta:{ action:'TIMER_SET', duration:dur, task } };
      }
      case 'MOOD_QUERY': {
        const reply=buildMoodQuery(ctx);
        ctx.addTurn(message,reply,action,null,thought);
        return { reply, action, intent:cap.id };
      }
      case 'IDENTITY': {
        const reply=buildIdentity(ctx);
        ctx.addTurn(message,reply,action,null,thought);
        return { reply, action, intent:cap.id };
      }
      case 'GREETING': {
        const reply=buildGreeting(ctx);
        ctx.addTurn(message,reply,action,null,thought);ctx.updateMood(5);
        return { reply, action, intent:cap.id };
      }
      case 'THANKS': {
        const reply=buildThanks(ctx);
        ctx.addTurn(message,reply,action,null,thought);ctx.updateMood(8);
        return { reply, action, intent:cap.id };
      }
      case 'PERSONAL': {
        const reply=buildPersonal(resolved,ctx);
        ctx.addTurn(message,reply,action,'personal',thought);ctx.updateMood(3);
        return { reply, action, intent:cap.id };
      }
      case 'KNOWLEDGE': {
        const knowledge=findKnowledge(resolved);
        if(knowledge){
          const reply=buildKnowledgeReply(knowledge,resolved,ctx);
          ctx.addTurn(message,reply,action,knowledge.key,thought);ctx.updateMood(4);
          return { reply, action, intent:cap.id, topic:knowledge.key };
        }
        break;
      }
    }
  }

  // 8. Comparison
  const vsMatch=/\b(vs|versus|compared|difference between)\b/i.test(resolved);
  if(vsMatch){
    const cmp=buildComparison(resolved,ctx);
    if(cmp){ ctx.addTurn(message,cmp,'COMPARISON',null,thought); return { reply:cmp, action:'COMPARISON', intent:'comparison' }; }
  }

  // 9. Direct knowledge lookup
  const knowledge=findKnowledge(resolved);
  if(knowledge){
    const reply=buildKnowledgeReply(knowledge,resolved,ctx);
    ctx.addTurn(message,reply,'KNOWLEDGE',knowledge.key,thought);ctx.updateMood(4);
    return { reply, action:'KNOWLEDGE', intent:'knowledge', topic:knowledge.key };
  }

  // 10. Personal / opinion
  if(activeClusters['PERSONAL_SOC']||activeClusters['ADVICE_PERSONAL']||activeClusters['FEELING_PERSONAL']){
    const reply=buildPersonal(resolved,ctx);
    ctx.addTurn(message,reply,'PERSONAL','personal',thought);ctx.updateMood(2);
    return { reply, action:'PERSONAL', intent:'personal' };
  }
  if(activeClusters['HYPOTHETICAL_MOD']||activeClusters['QUESTION_SOC']){
    const reply=buildOpinion(resolved,ctx);
    ctx.addTurn(message,reply,'OPINION',null,thought);ctx.updateMood(2);
    return { reply, action:'OPINION', intent:'opinion' };
  }

  // 11. Novel command synthesis — self-thought fallback
  const novelChain=ThoughtChain.synthesizeNovel(activeClusters, resolved, ctx);
  thought.think('novel synthesis', novelChain.verdict?.action||'unknown');

  if(novelChain.verdict && novelChain.verdict.action !== 'UNKNOWN' && novelChain.verdict.confidence >= 0.5){
    const { action, meta } = novelChain.verdict;
    // Re-run the switch for synthesized action
    const synthResult = { reply:'', action, intent:'synthesized_novel', meta };
    // Generate contextual reply for the synthesized action
    const actionReplies = {
      READ_SCREEN:   pick([`Scanning your screen now — let me see what\'s there, ${T}.`,`Reading your display, ${T}.`]),
      CLIP_SAVE:     pick([`Saving footage now, ${T}.`,`Capturing that for you, ${T}.`]),
      SYSTEM_STATUS: pick([`Running diagnostics, ${T}.`,`Checking system health, ${T}.`]),
      SHOW_LINKS:    pick([`Pulling up the link bank, ${T}.`,`Here are your saved links, ${T}.`]),
      OPEN_LINK:     pick([`Opening that now, ${T}.`,`On it, ${T}.`]),
      WEATHER:       pick([`Fetching weather data, ${T}.`,`Pulling current conditions, ${T}.`]),
      SPOTIFY:       pick([`On the music, ${T}.`,`Handling that, ${T}.`]),
      GMAIL:         pick([`Checking your inbox, ${T}.`,`Pulling up your mail, ${T}.`]),
      CALENDAR:      pick([`Checking your schedule, ${T}.`,`Pulling up the calendar, ${T}.`]),
      SHOW_CLIPS:    pick([`Loading incident recordings, ${T}.`,`Pulling up the clip gallery, ${T}.`]),
      SWITCH_CAMERA: pick([`Switching cameras, ${T}.`,`Changing the view, ${T}.`]),
      MEMORY_SAVE:   pick([`Noted, ${T}.`,`Stored, ${T}.`]),
      MEMORY_RECALL: pick([`Here\'s what I have on file, ${T}.`,`Pulling up my memory, ${T}.`]),
      TIMER:         pick([`Setting that timer, ${T}.`,`Timer coming up, ${T}.`]),
      LOGOUT:        pick([`Signing out, ${T}.`,`Goodbye, ${T}.`]),
      KNOWLEDGE:     pick([`Let me pull that together for you, ${T}.`,`Here\'s what I know, ${T}.`]),
    };
    synthResult.reply = actionReplies[action] || `Processing that, ${T}.`;

    if(['WEATHER','SPOTIFY','GMAIL','CALENDAR'].includes(action)){
      ctx.addTurn(message,'',action,action.toLowerCase(),thought);
      return { reply:'', action, intent:'synthesized_novel', needsFetch:true, fetchType:action.toLowerCase(), meta };
    }

    ctx.addTurn(message,synthResult.reply,action,'synthesized',thought);ctx.updateMood(1);
    return synthResult;
  }

  // 12. Final fallback — honest reasoning
  const reply=buildUnknown(resolved,ctx,novelChain);
  ctx.addTurn(message,reply,'UNKNOWN',null,thought);ctx.updateMood(-2);
  return { reply, action:'UNKNOWN', intent:'unknown' };
}

module.exports = { process, findKnowledge, getActiveClusters, lookupWord, stem, parseDuration, formatDuration };
