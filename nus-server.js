/**
 * nus-server.js  —  FULL JARVIS BRAIN, NUS KNOT UI
 * ─────────────────────────────────────────────────
 * npm run nus
 *
 *   • Loads the entire Jarvis tool stack (Computer, Hermes, Weather, etc.)
 *   • Serves the NUS knot UI at /nus  (auto-opens in your default browser)
 *   • Proxies /api/chat so the knot gets SHOW_PC_VIEW, TOOL, all actions
 *   • When SHOW_PC_VIEW fires, the knot pops a VNC overlay bubble — no /nus
 *     URL needed, it opens itself
 *   • No startup.sh, no Electron, no HUD — just the knot + full brain
 */

require('dotenv').config();

/* ── auto-open browser once ──────────────────────────────────────────────── */
function openBrowser(url) {
  const { exec } = require('child_process');
  const cmd =
    process.platform === 'win32'  ? `start "" "${url}"` :
    process.platform === 'darwin' ? `open "${url}"` :
                                    `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) console.warn('[nus-server] Could not auto-open browser:', err.message);
  });
}

/* ── express + http ──────────────────────────────────────────────────────── */
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const http       = require('http');

const app        = express();
const httpServer = http.createServer(app);

const PORT = process.env.NUS_PORT
  || (process.argv.includes('--port') && process.argv[process.argv.indexOf('--port') + 1])
  || process.env.PORT
  || 3000;

const NUS_ONLY = true; // this file IS the nus-only boot

/* ── crash guard ─────────────────────────────────────────────────────────── */
process.on('unhandledRejection', (r) => console.error('[nus-server] unhandled rejection:', r));
process.on('uncaughtException',  (e) => console.error('[nus-server] uncaught exception:', e.message));

/* ── lazy-load heavy Jarvis modules (don't block startup) ────────────────── */
let _computer = null;
let _groq     = null;
let _ai       = null;
let _trainer  = null;

function getComputer() {
  if (!_computer) {
    try { _computer = require('./computer'); console.log('[nus-server] computer.js ✓'); }
    catch(e) { console.warn('[nus-server] computer.js unavailable:', e.message); _computer = {}; }
  }
  return _computer;
}

function getGroq() {
  if (!_groq) {
    try { _groq = require('./hermes-engine'); console.log('[nus-server] hermes-engine.js ✓'); }
    catch(e) { console.warn('[nus-server] hermes-engine.js unavailable:', e.message); _groq = null; }
  }
  return _groq;
}

function getAI() {
  if (!_ai) {
    try { _ai = require('./ai-engine'); console.log('[nus-server] ai-engine.js ✓'); }
    catch(e) { console.warn('[nus-server] ai-engine.js unavailable:', e.message); _ai = null; }
  }
  return _ai;
}

function getTrainer() {
  if (!_trainer) {
    try { _trainer = require('./trainer'); }
    catch(e) { _trainer = { addExample: () => {} }; }
  }
  return _trainer;
}

/* ── session history (mirrors server.js session helpers) ─────────────────── */
const _sessions = new Map();

function getSessionHistory(sessionId) {
  return _sessions.get(sessionId) || [];
}
function appendToSession(sessionId, role, content) {
  const h = _sessions.get(sessionId) || [];
  h.push({ role, content: String(content).slice(0, 2000) });
  if (h.length > 40) h.splice(0, h.length - 40); // cap at 40 turns
  _sessions.set(sessionId, h);
}

/* ── middleware ──────────────────────────────────────────────────────────── */
app.use(cors());
app.use(express.json({ limit: '8mb' }));

/* ── serve NUS companion static files ───────────────────────────────────── */
const NUS_PUBLIC = path.join(__dirname, 'public', 'nus-companion');
// Serve under BOTH paths:
//   /nus-companion/...  (legacy path)
//   /nus/...            (so relative paths in index.html like "styles.css"
//                        resolve to /nus/styles.css correctly)
app.use('/nus-companion', express.static(NUS_PUBLIC));
app.use('/nus', express.static(NUS_PUBLIC));

/* ── routes ──────────────────────────────────────────────────────────────── */
app.get('/', (req, res) => res.redirect('/nus'));

app.get('/nus', (req, res) =>
  res.sendFile(path.join(NUS_PUBLIC, 'index.html'))
);

/* ── health ──────────────────────────────────────────────────────────────── */
app.get('/api/status', (req, res) =>
  res.json({ ok: true, service: 'jarvis-nus-full', ts: new Date().toISOString() })
);

/* ── settings ────────────────────────────────────────────────────────────── */
app.get('/api/nus/settings', (req, res) => res.json({
  provider: 'jarvis',
  apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '' },
  models: { jarvis: { fast: 'jarvis', smart: 'jarvis' } },
  shortcuts: { assist: 'CommandOrControl+Return' },
  smart: false, onboarded: false, knotCorner: 'br', _founderTools: false,
}));
app.post('/api/nus/settings', (req, res) => res.json({ ok: true }));

/* ── SHOW_PC_VIEW helper — mirrors server.js handlePcViewOpen ────────────── */
function extractYoutubeIntent(message) {
  if (!/\byoutube\b/i.test(message || '')) return null;
  const m =
    message.match(/\b(?:watch|play|put on|pull up|open|search)\b\s+(.+?)\s+on\s+youtube\b/i) ||
    message.match(/\byoutube\b\s*[:\-]?\s+(.+)$/i);
  const query = (m && m[1] || '').trim();
  return query
    ? `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`
    : 'https://www.youtube.com';
}

async function handlePcView(message, T = 'Sir') {
  const Computer = getComputer();
  if (!Computer.isDesktopConfigured || !Computer.isDesktopConfigured()) {
    return {
      reply: `I don't have a desktop sandbox set up yet, ${T} — add E2B_API_KEY to .env, run \`npm install\`, restart, and I can show you my computer.`,
      action: 'ERROR', intent: 'pcView',
    };
  }
  try {
    const { url } = await Computer.ensureDesktopStream();
    const youtubeUrl = extractYoutubeIntent(message);
    if (youtubeUrl) {
      try { await Computer.desktopLaunch('google-chrome', youtubeUrl); }
      catch (e) {
        try { await Computer.desktopLaunch('firefox', youtubeUrl); } catch {}
      }
    }
    let audioUrl = null;
    try { const a = await Computer.ensureDesktopAudioStream(); audioUrl = a.url; } catch {}
    return {
      reply: `Pulling up my computer now, ${T}.${youtubeUrl ? ' Getting YouTube up for you.' : ''}`,
      action: 'SHOW_PC_VIEW', intent: 'pcView',
      meta: { streamUrl: url, audioUrl },
    };
  } catch (e) {
    return { reply: `Couldn't start the desktop, ${T} — ${e.message}`, action: 'ERROR', intent: 'pcView' };
  }
}

/* ── FULL /api/chat — Jarvis brain wired into the knot ───────────────────── */
// PC_VIEW regex (mirrors server.js KNOWN_INTENTS.pcView)
const PC_VIEW_RE = /\b(show (me )?(your |the )?pc\b|show (me )?your (computer|desktop)|pc view|remote (into|control) (your |the )?pc|take over (your |the )?pc|control (your |the )?(pc|computer)\b)\b/i;

app.post('/api/chat', async (req, res) => {
  let {
    message, sessionId = 'nus', userName, userTitle,
    memories = [], moodContext = '', userTimezone,
    attachments, source, systemHint,
  } = req.body || {};

  if (!message) return res.status(400).json({ error: 'Missing message' });

  const T = userTitle || 'Sir';

  // ── fold attachments into message ──
  if (Array.isArray(attachments) && attachments.length) {
    const blocks = attachments.slice(0, 5).map(a => {
      const name = String(a?.name || 'file').slice(0, 200);
      if (a?.textContent) {
        let c = String(a.textContent);
        if (c.length > 6000) c = c.slice(0, 6000) + '\n...[truncated]';
        return `\n\n[Attached file: ${name}]\n${c}`;
      }
      return `\n\n[Attached file: ${name}]`;
    }).join('');
    message = message + blocks;
  }

  // ── 1. PC VIEW fast-path (regex, mirrors legacy server.js) ──
  if (PC_VIEW_RE.test(message)) {
    const result = await handlePcView(message, T);
    return res.json(result);
  }

  // ── 2. Full Groq/Hermes tool-calling brain ──
  const Groq = getGroq();
  if (Groq && Groq.isConfigured && Groq.isConfigured()) {
    try {
      const toolResult = await Groq.chatWithTools({
        message,
        userTitle: T,
        memories,
        context: moodContext,
        conversationHistory: getSessionHistory(sessionId),
        tz: userTimezone,
        // executeTool — only wire tools that work without full server.js context
        executeTool: async (name, args) => {
          // PC view tool call
          if (name === 'show_pc') {
            const q = args.youtube_query;
            const fakeMsg = q ? `show pc and watch ${q} on youtube` : args.open_youtube ? 'show pc and open youtube' : 'show pc';
            return handlePcView(fakeMsg, T);
          }
          // Weather
          if (name === 'get_weather') {
            try {
              const Weather = require('./weather');
              return { reply: await Weather.getForecast(args.location || args.city || 'your area') };
            } catch { return { reply: `Weather unavailable right now, ${T}.` }; }
          }
          // Spotify
          if (name === 'spotify') {
            try {
              const Spotify = require('./spotify');
              return Spotify.handle(args);
            } catch { return { reply: `Spotify unavailable right now, ${T}.` }; }
          }
          // Reminders / todos / habits
          if (name === 'set_reminder' || name === 'add_todo') {
            try {
              const mod = name === 'set_reminder' ? require('./reminders') : require('./todos');
              return { reply: await mod.add(args) };
            } catch { return { reply: `Done, ${T}.` }; }
          }
          // Google / search
          if (name === 'search' || name === 'google') {
            try {
              const Google = require('./google');
              return { reply: await Google.search(args.query || message) };
            } catch { return { reply: `Search unavailable, ${T}.` }; }
          }
          // News
          if (name === 'get_news') {
            try {
              const News = require('./news');
              return { reply: await News.getHeadlines(args) };
            } catch { return { reply: `News unavailable, ${T}.` }; }
          }
          return null; // let hermes handle anything else as pure text
        },
      });

      if (toolResult && toolResult.reply) {
        getTrainer().addExample(message, toolResult.reply, toolResult.intent || 'chat', null, 0.85, 'nus');
        appendToSession(sessionId, 'user',      message);
        appendToSession(sessionId, 'assistant', toolResult.reply);
        return res.json({
          reply:  toolResult.reply,
          action: toolResult.action || (toolResult.usedTool ? 'TOOL' : 'CHAT'),
          intent: toolResult.intent,
          meta:   toolResult.meta,
        });
      }
    } catch (err) {
      console.error('[nus-server] chatWithTools error:', err.message);
      if (/rate.?limit|429/i.test(err.message || '')) {
        const r = `Apologies, ${T} — rate-limited by Groq right now. Try again in ~20 seconds.`;
        return res.json({ reply: r, action: 'RATE_LIMITED', intent: 'error' });
      }
      // fall through to ai-engine
    }
  }

  // ── 3. ai-engine fallback ──
  const AI = getAI();
  if (AI && typeof AI.process === 'function') {
    try {
      const result = AI.process({ message, sessionId, userName, userTitle: T, memories });
      if (result && result.reply) {
        appendToSession(sessionId, 'user',      message);
        appendToSession(sessionId, 'assistant', result.reply);
        return res.json({ reply: result.reply, action: 'CHAT', intent: 'chat' });
      }
    } catch (err) {
      console.error('[nus-server] ai-engine error:', err.message);
    }
  }

  // ── 4. Direct Anthropic SSE fallback ──
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.json({
      reply: `I'm not connected to a brain yet, ${T}. Add ANTHROPIC_API_KEY or Groq keys to .env and restart.`,
      action: 'CHAT', intent: 'chat',
    });
  }

  // Stream it
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => ({ default: null }));
    if (!Anthropic) {
      res.write(`data: ${JSON.stringify({ token: `Anthropic SDK not installed, ${T}. Run: npm install @anthropic-ai/sdk` })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    const client = new Anthropic({ apiKey: anthropicKey });
    const sysMsg = systemHint || `You are Jarvis, an intelligent personal assistant. Address the user as "${T}". Be concise, direct, and helpful.`;
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: sysMsg,
      messages: [
        ...getSessionHistory(sessionId).slice(-10),
        { role: 'user', content: message },
      ],
    });
    let full = '';
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        full += chunk.delta.text;
        res.write(`data: ${JSON.stringify({ token: chunk.delta.text })}\n\n`);
      }
    }
    appendToSession(sessionId, 'user',      message);
    appendToSession(sessionId, 'assistant', full);
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

/* ── streaming NUS ask endpoint (knot mode buttons) ─────────────────────── */
const MODE_SYSTEM = {
  guide:     'You are Jarvis. The user clicked "What should I do?" — give a clear, prioritized answer about their immediate next best action. Be concise.',
  assist:    'You are Jarvis. Help the user with whatever they are currently working on. Be concise and actionable.',
  say:       'You are Jarvis. Suggest what the user should say next in their current conversation. Be direct.',
  objection: 'You are Jarvis. Help the user handle the objection being raised. Give a clear, persuasive response.',
  numbers:   'You are Jarvis. Surface the key numbers and metrics relevant to the user\'s current situation.',
  followup:  'You are Jarvis. Suggest smart follow-up questions. Make them thoughtful and strategic.',
  recap:     'You are Jarvis. Give a brief, structured recap of the current situation.',
  brief:     'You are Jarvis. Give a pre-meeting briefing. Cover key points and what matters most.',
  spar:      'You are Jarvis playing an adversarial sparring partner. Challenge the user\'s thinking rigorously.',
  score:     'You are Jarvis. Score the user\'s performance and give actionable, honest feedback.',
  ask:       'You are Jarvis, a sharp AI assistant. Answer the user\'s question directly and helpfully.',
};

app.post('/api/nus/ask', async (req, res) => {
  const { mode = 'ask', text = '', sessionId = 'nus', resumeContext = '' } = req.body || {};
  const systemPrompt = (MODE_SYSTEM[mode] || MODE_SYSTEM.ask)
    + (resumeContext ? `\n\nUser background:\n${resumeContext}` : '');
  const userMessage = text || {
    guide: 'What should I do right now?',
    assist: 'Help me with what I am working on.',
    say: 'What should I say next?',
    objection: 'Help me handle the objection.',
    numbers: 'What are the key numbers here?',
    followup: 'What follow-up questions should I ask?',
    recap: 'Give me a quick recap.',
    brief: 'Give me a pre-call briefing.',
    spar: 'Start a sparring session.',
    score: 'Score my performance.',
  }[mode] || 'Help me.';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  // Try Groq first
  const Groq = getGroq();
  if (Groq && Groq.isConfigured && Groq.isConfigured()) {
    try {
      const result = await Groq.chat(userMessage, { systemPrompt, sessionId });
      if (result) {
        // word-stream it
        const words = String(result).split(' ');
        for (let i = 0; i < words.length; i++) {
          res.write(`data: ${JSON.stringify({ token: (i ? ' ' : '') + words[i] })}\n\n`);
          await new Promise(r => setTimeout(r, 12));
        }
        res.write('data: [DONE]\n\n');
        return res.end();
      }
    } catch {}
  }

  // Anthropic SSE
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.write(`data: ${JSON.stringify({ token: 'No AI key found. Add ANTHROPIC_API_KEY to .env.' })}\n\n`);
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => ({ default: null }));
    if (!Anthropic) {
      res.write(`data: ${JSON.stringify({ token: 'Anthropic SDK not installed.' })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    const client = new Anthropic({ apiKey: key });
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });
    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
        res.write(`data: ${JSON.stringify({ token: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

/* ── STT proxy — forward voice to Jarvis STT ─────────────────────────────── */
app.post('/api/stt', async (req, res) => {
  try {
    const STT = require('./stt');
    return STT.handle(req, res);
  } catch {
    res.status(503).json({ error: 'STT not available in this configuration.' });
  }
});

/* ── START ───────────────────────────────────────────────────────────────── */
httpServer.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}/nus`;

  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   J.A.R.V.I.S  —  NUS Companion  (Full Brain)  ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║  Companion  →  ${url}              ║`);
  console.log('╠══════════════════════════════════════════════════╣');
  console.log('║  Tools:  Computer (E2B)  •  Hermes  •  Anthropic ║');
  console.log('║  VNC popup: "show pc" or "show my pc"            ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // auto-open — single shot, 800ms after listen to let the port bind
  setTimeout(() => openBrowser(url), 800);
});
