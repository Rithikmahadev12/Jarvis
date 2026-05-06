// ═══════════════════════════════════════════════════════════════
// J.A.R.V.I.S — Picture-in-Picture HUD Widgets v1.0
// Each HUD panel becomes its own floating PiP window
// stays on top of ANY tab, zero extensions needed
// ═══════════════════════════════════════════════════════════════

window.PiPWidgets = (function () {

  const widgets = new Map();

  const WIDGET_DEFS = {
    clock:  { label:"CLOCK",        w:300, h:160, render:renderClock  },
    mood:   { label:"MOOD",         w:300, h:160, render:renderMood   },
    system: { label:"SYSTEM",       w:300, h:160, render:renderSystem },
    memory: { label:"MEMORY",       w:300, h:160, render:renderMemory },
    neural: { label:"NEURAL",       w:300, h:160, render:renderNeural },
    audio:  { label:"AUDIO",        w:300, h:160, render:renderAudio  },
    user:   { label:"USER",         w:300, h:160, render:renderUser   },
    all:    { label:"ALL SYSTEMS",  w:620, h:340, render:renderAll    },
  };

  const C = {
    bg:"#010c14", bg2:"#021828", blue:"#00c8ff",
    blueDim:"rgba(0,200,255,0.18)", blueGlow:"rgba(0,200,255,0.35)",
    amber:"#ffaa00", green:"#00ff88", red:"#ff3333",
    textDim:"#3a6a88", text:"#a8dff5", textBright:"#d8f4ff",
  };

  const _sessionStart = Date.now();
  let   _frame        = 0;

  // ── DRAW HELPERS ────────────────────────────────────────────
  function hud(ctx, w, h) {
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, w, h);

    ctx.strokeStyle = "rgba(0,200,255,0.04)";
    ctx.lineWidth   = 0.5;
    for (let x=0;x<w;x+=30){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke();}
    for (let y=0;y<h;y+=30){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}

    ctx.strokeStyle = "rgba(0,200,255,0.25)";
    ctx.lineWidth   = 1;
    ctx.strokeRect(1,1,w-2,h-2);

    const s=16;
    ctx.strokeStyle=C.blue; ctx.lineWidth=1.5;
    [[2,2],[w-2-s,2],[2,h-2-s],[w-2-s,h-2-s]].forEach(([cx,cy],i)=>{
      ctx.beginPath();
      if(i===0){ctx.moveTo(cx+s,cy);ctx.lineTo(cx,cy);ctx.lineTo(cx,cy+s);}
      if(i===1){ctx.moveTo(cx,cy);ctx.lineTo(cx+s,cy);ctx.lineTo(cx+s,cy+s);}
      if(i===2){ctx.moveTo(cx+s,cy+s);ctx.lineTo(cx,cy+s);ctx.lineTo(cx,cy);}
      if(i===3){ctx.moveTo(cx,cy+s);ctx.lineTo(cx+s,cy+s);ctx.lineTo(cx+s,cy);}
      ctx.stroke();
    });

    ctx.strokeStyle="rgba(0,200,255,0.12)"; ctx.lineWidth=1;
    ctx.beginPath();ctx.moveTo(0,28);ctx.lineTo(w,28);ctx.stroke();
  }

  function lbl(ctx,text,x,y){
    ctx.font="500 9px Orbitron,monospace";
    ctx.fillStyle=C.textDim; ctx.fillText(text.toUpperCase(),x,y);
  }
  function big(ctx,text,x,y,color){
    ctx.font="400 28px 'Share Tech Mono',monospace";
    ctx.fillStyle=color||C.blue; ctx.fillText(text,x,y);
  }
  function sm(ctx,text,x,y,color){
    ctx.font="400 11px 'Share Tech Mono',monospace";
    ctx.fillStyle=color||C.textDim; ctx.fillText(text,x,y);
  }
  function bar(ctx,x,y,w,pct,color){
    ctx.fillStyle="rgba(0,200,255,0.08)"; ctx.fillRect(x,y,w,4);
    ctx.fillStyle=color||C.blue; ctx.fillRect(x,y,w*Math.min(1,Math.max(0,pct)),4);
  }
  function titleBar(ctx,w,wlabel){
    ctx.font="700 9px Orbitron,monospace";
    ctx.fillStyle=C.blue;
    ctx.fillText("J.A.R.V.I.S  ·  "+wlabel,10,18);
    ctx.beginPath();ctx.arc(w-12,14,3,0,Math.PI*2);
    ctx.fillStyle=C.blue;ctx.fill();
  }

  // ── WIDGET RENDERERS ────────────────────────────────────────
  function renderClock(ctx,w,h){
    _frame++;
    hud(ctx,w,h); titleBar(ctx,w,"CLOCK");
    const now=new Date();
    const time=now.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
    const date=now.toLocaleDateString("en-GB",{weekday:"short",day:"2-digit",month:"short",year:"numeric"});
    lbl(ctx,"LOCAL TIME",16,54);
    ctx.font="400 34px 'Share Tech Mono',monospace";
    ctx.fillStyle=C.blue; ctx.shadowColor=C.blueGlow; ctx.shadowBlur=10;
    ctx.fillText(time,16,96); ctx.shadowBlur=0;
    lbl(ctx,"DATE",16,116);
    sm(ctx,date.toUpperCase(),16,134,C.text);
    bar(ctx,16,148,w-32,now.getSeconds()/60,C.blue);
  }

  function renderMood(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,"MOOD");
    const s=window.state||{};
    const mood=s.mood||"neutral", score=s.moodScore||0;
    const MC={excited:"#ffee55",pleased:C.green,curious:C.blue,neutral:"#88ccee",concerned:C.amber,bored:"#6688aa",tired:"#445566"};
    const MI={excited:"⚡",pleased:"●",curious:"◈",neutral:"●",concerned:"▲",bored:"◌",tired:"◯"};
    const col=MC[mood]||C.blue;
    lbl(ctx,"EMOTIONAL STATE",16,54);
    ctx.font="400 24px 'Share Tech Mono',monospace";
    ctx.fillStyle=col; ctx.shadowColor=col; ctx.shadowBlur=8;
    ctx.fillText((MI[mood]||"●")+"  "+mood.toUpperCase(),16,90); ctx.shadowBlur=0;
    lbl(ctx,"SCORE",16,112);
    sm(ctx,score.toString(),16,130,col);
    bar(ctx,16,144,w-32,(score+100)/200,col);
  }

  function renderSystem(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,"SYSTEM");
    const elapsed=Date.now()-_sessionStart;
    const hh=Math.floor(elapsed/3600000);
    const mm=Math.floor((elapsed%3600000)/60000);
    const ss=Math.floor((elapsed%60000)/1000);
    const uptime=`${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}`;
    const s=window.state||{};
    const phase=(s.phase||"idle").toUpperCase();
    const PL={IDLE:"STANDBY",CHATTING:"ACTIVE",LISTENING:"LISTENING",THINKING:"PROCESSING",SPEAKING:"SPEAKING"};
    const PC={CHATTING:C.green,SPEAKING:C.amber,LISTENING:C.blue,THINKING:C.amber};
    lbl(ctx,"SESSION UPTIME",16,54);
    ctx.font="400 26px 'Share Tech Mono',monospace";
    ctx.fillStyle=C.blue; ctx.fillText(uptime,16,88);
    lbl(ctx,"PHASE",16,110);
    ctx.font="400 15px 'Share Tech Mono',monospace";
    ctx.fillStyle=PC[phase]||C.textDim; ctx.fillText(PL[phase]||"STANDBY",16,130);
    bar(ctx,16,148,w-32,Math.min(1,elapsed/3600000),C.blue);
  }

  function renderMemory(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,"MEMORY");
    const s=window.state||{}, mem=s.memories||[], n=mem.length;
    lbl(ctx,"MEMORY BANK",16,54);
    ctx.font="400 40px 'Share Tech Mono',monospace";
    ctx.fillStyle=C.blue; ctx.shadowColor=C.blueGlow; ctx.shadowBlur=10;
    ctx.fillText(n.toString(),16,104); ctx.shadowBlur=0;
    sm(ctx,n===1?"LONG-TERM FACT":"LONG-TERM FACTS",66,96,C.textDim);
    if(mem.length>0){
      lbl(ctx,"LAST STORED",16,118);
      const last=(typeof mem[mem.length-1]==="string"?mem[mem.length-1]:mem[mem.length-1]?.fact)||"";
      sm(ctx,last.slice(0,38)+(last.length>38?"…":""),16,136,C.text);
    } else {
      sm(ctx,"NO FACTS STORED YET",16,130,C.textDim);
    }
  }

  function renderNeural(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,"NEURAL ENGINE");
    const s=window.state||{}, count=s.interactionCount||0;
    lbl(ctx,"INTERACTIONS",16,54);
    ctx.font="400 40px 'Share Tech Mono',monospace";
    ctx.fillStyle=C.blue; ctx.shadowColor=C.blueGlow; ctx.shadowBlur=10;
    ctx.fillText(count.toString(),16,104); ctx.shadowBlur=0;
    lbl(ctx,"ACTIVITY",16,118);
    for(let i=0;i<10;i++){
      const active=i<(count%10+1);
      const bh=active?10+Math.random()*18:4;
      ctx.fillStyle=active?C.blue:"rgba(0,200,255,0.12)";
      ctx.fillRect(16+i*22,148-bh,16,bh);
    }
  }

  function renderAudio(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,"AUDIO INPUT");
    const s=window.state||{}, active=s.isListening||false;
    const col=active?C.blue:C.textDim;
    lbl(ctx,"MIC STATUS",16,54);
    ctx.font="400 18px 'Share Tech Mono',monospace";
    ctx.fillStyle=col; ctx.fillText(active?"● ACTIVE":"○ INACTIVE",16,82);
    lbl(ctx,"WAVEFORM",16,104);
    for(let i=0;i<20;i++){
      const bh=active?8+Math.random()*32:4;
      ctx.fillStyle=active?`rgba(0,200,255,${0.4+Math.random()*0.6})`:"rgba(0,200,255,0.1)";
      ctx.fillRect(16+i*13,148-bh,8,bh);
    }
  }

  function renderUser(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,"USER");
    const s=window.state||{};
    const user=(s.user||"—").toUpperCase();
    const title=(s.userTitle||"—").toUpperCase();
    const mood=(s.mood||"neutral").toUpperCase();
    lbl(ctx,"AUTHORISED USER",16,54);
    ctx.font="400 22px 'Share Tech Mono',monospace";
    ctx.fillStyle=C.blue; ctx.fillText(user,16,84);
    lbl(ctx,"TITLE",16,106); sm(ctx,title,16,124,C.text);
    lbl(ctx,"MOOD",130,106); sm(ctx,mood,130,124,C.text);
  }

  function renderAll(ctx,w,h){
    hud(ctx,w,h); titleBar(ctx,w,"ALL SYSTEMS");
    const s=window.state||{};
    const now=new Date();
    const time=now.toLocaleTimeString("en-GB",{hour:"2-digit",minute:"2-digit",second:"2-digit",hour12:false});
    const elapsed=Date.now()-_sessionStart;
    const mm=Math.floor(elapsed/60000), ss=Math.floor((elapsed%60000)/1000);
    const uptime=`${mm}m ${ss}s`;
    const mood=s.mood||"neutral", score=s.moodScore||0, count=s.interactionCount||0;
    const phase=(s.phase||"idle").toUpperCase();
    const memN=(s.memories||[]).length;
    const user=(s.user||"—").toUpperCase();
    const MC={excited:"#ffee55",pleased:C.green,curious:C.blue,neutral:"#88ccee",concerned:C.amber,bored:"#6688aa",tired:"#445566"};
    const PC={CHATTING:C.green,SPEAKING:C.amber,LISTENING:C.blue,THINKING:C.amber};
    const moodCol=MC[mood]||C.blue, phaseCol=PC[phase]||C.textDim;

    const col1=16, col2=w/2+8;
    const rows=[48,108,168,228,288];

    function sec(x,y,label,val,color){
      lbl(ctx,label,x,y);
      ctx.font="400 17px 'Share Tech Mono',monospace";
      ctx.fillStyle=color||C.blue; ctx.fillText(val,x,y+22);
    }

    sec(col1,rows[0],"LOCAL TIME",    time,              C.blue);
    sec(col2,rows[0],"UPTIME",        uptime,            C.blue);
    sec(col1,rows[1],"PHASE",         phase,             phaseCol);
    sec(col2,rows[1],"USER",          user,              C.blue);
    sec(col1,rows[2],"MOOD",          mood.toUpperCase(),moodCol);
    sec(col2,rows[2],"SCORE",         score.toString(),  moodCol);
    sec(col1,rows[3],"INTERACTIONS",  count.toString(),  C.blue);
    sec(col2,rows[3],"MEMORY BANK",   memN+" STORED",    C.blue);
    sec(col1,rows[4],"MIC",           s.isListening?"ACTIVE":"STANDBY", s.isListening?C.green:C.textDim);
    sec(col2,rows[4],"AI ENGINE",     "ONLINE",          C.green);

    ctx.strokeStyle="rgba(0,200,255,0.08)"; ctx.lineWidth=1;
    rows.forEach(y=>{ctx.beginPath();ctx.moveTo(16,y+34);ctx.lineTo(w-16,y+34);ctx.stroke();});
    ctx.beginPath();ctx.moveTo(w/2,36);ctx.lineTo(w/2,h-16);ctx.stroke();
  }

  // ── PIP ENGINE ──────────────────────────────────────────────
  async function openWidget(id){
    if(widgets.has(id)){
      notify(`${WIDGET_DEFS[id]?.label||id} widget is already open.`);
      return widgets.get(id);
    }
    const def=WIDGET_DEFS[id];
    if(!def){notify("Unknown widget: "+id);return null;}

    const canvas=document.createElement("canvas");
    canvas.width=def.w; canvas.height=def.h;
    const ctx=canvas.getContext("2d");
    def.render(ctx,def.w,def.h);

    const stream=canvas.captureStream(30);
    const video=document.createElement("video");
    video.srcObject=stream; video.muted=true;
    video.width=def.w; video.height=def.h;
    await video.play();

    let pipWindow=null;

    if("documentPictureInPicture" in window){
      try{
        pipWindow=await window.documentPictureInPicture.requestWindow({width:def.w,height:def.h});
        pipWindow.document.body.style.cssText="margin:0;padding:0;background:#010c14;overflow:hidden;";
        video.style.cssText="width:100%;height:100%;display:block;";
        pipWindow.document.body.appendChild(video);
      }catch(e){
        console.warn("[PiP] Document PiP failed:",e);
        pipWindow=null;
      }
    }

    if(!pipWindow){
      try{
        await video.requestPictureInPicture();
      }catch(e){
        notify("PiP failed — try clicking the page first, then ask again.");
        stream.getTracks().forEach(t=>t.stop());
        return null;
      }
    }

    const interval=setInterval(()=>def.render(ctx,def.w,def.h), 1000/30);
    const entry={video,canvas,ctx,interval,stream,def,pipWindow};
    widgets.set(id,entry);

    const cleanup=()=>{
      clearInterval(interval);
      stream.getTracks().forEach(t=>t.stop());
      widgets.delete(id);
    };
    if(pipWindow) pipWindow.addEventListener("pagehide",cleanup);
    else video.addEventListener("leavepictureinpicture",cleanup);

    return entry;
  }

  async function closeWidget(id){
    const entry=widgets.get(id);
    if(!entry)return;
    clearInterval(entry.interval);
    entry.stream.getTracks().forEach(t=>t.stop());
    if(entry.pipWindow) try{entry.pipWindow.close();}catch{}
    else try{await document.exitPictureInPicture();}catch{}
    widgets.delete(id);
  }

  async function closeAll(){
    for(const id of [...widgets.keys()]) await closeWidget(id);
  }

  async function openAll(){
    for(const id of Object.keys(WIDGET_DEFS)){
      if(id==="all")continue;
      await openWidget(id);
      await new Promise(r=>setTimeout(r,500));
    }
  }

  function notify(msg){
    if(window.addMsg) window.addMsg("system",msg);
    else console.log("[PiP]",msg);
  }

  function detectWidgetId(query){
    if(/clock|time|date/.test(query))            return "clock";
    if(/mood|emotion|feel/.test(query))          return "mood";
    if(/system|status|uptime|phase/.test(query)) return "system";
    if(/memor/.test(query))                      return "memory";
    if(/neural|interact|activit/.test(query))    return "neural";
    if(/audio|mic|sound|listen/.test(query))     return "audio";
    if(/user|authoris|profile/.test(query))      return "user";
    if(/all|everything|full|hud/.test(query))    return "all";
    return null;
  }

  async function handleVoiceCommand(action, meta){
    const query=(meta?.query||"").toLowerCase();
    if(action==="HIDE_HUD"){
      const targetId=detectWidgetId(query);
      if(targetId){
        await closeWidget(targetId);
        notify(`${WIDGET_DEFS[targetId]?.label||targetId} widget closed.`);
      } else {
        await closeAll();
        notify("All HUD widgets closed.");
      }
      return;
    }
    // SHOW_HUD
    const targetId=detectWidgetId(query)||"all";
    notify(`Launching ${WIDGET_DEFS[targetId]?.label||targetId} HUD as Picture-in-Picture…`);
    await openWidget(targetId);
  }

  return { open:openWidget, close:closeWidget, closeAll, openAll, handleVoiceCommand, detectWidgetId, list:()=>[...widgets.keys()], WIDGET_DEFS };

})();
