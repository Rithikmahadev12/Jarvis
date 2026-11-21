/**
 * nus-server.js
 * Boots ONLY the NUS companion UI — no Jarvis HUD, no heavy modules,
 * no electron, no startup.sh. Just the knot.
 *
 * Usage:
 *   npm run nus
 *   node nus-server.js
 *   node nus-server.js --port 4000
 *
 * Then open: http://localhost:3000/nus
 */
require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const http    = require('http');

const app        = express();
const httpServer = http.createServer(app);
const PORT       = process.env.NUS_PORT
               || (process.argv.includes('--port') && process.argv[process.argv.indexOf('--port') + 1])
               || process.env.PORT
               || 3000;

// ── CRASH GUARD ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[nus-server] unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[nus-server] uncaught exception:', err.message);
});

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ── STATIC: serve the companion UI files ──────────────────────────
app.use('/nus-companion', express.static(path.join(__dirname, 'public', 'nus-companion')));

// ── ROOT: redirect / → /nus so the URL is clean ──────────────────
app.get('/', (req, res) => res.redirect('/nus'));

// ── NUS COMPANION UI ─────────────────────────────────────────────
app.get('/nus', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'nus-companion', 'index.html'));
});

// ── HEALTH PING (bridge polls this to show "connected to Jarvis") ─
app.get('/api/status', (req, res) => {
  res.json({ ok: true, service: 'jarvis-nus', ts: new Date().toISOString() });
});

// ── SETTINGS (stateless — companion keeps state in localStorage) ──
app.get('/api/nus/settings', (req, res) => {
  res.json({
    provider: 'jarvis',
    apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '' },
    models: { jarvis: { fast: 'jarvis', smart: 'jarvis' } },
    shortcuts: { assist: 'CommandOrControl+Return' },
    smart: false,
    onboarded: false,
    knotCorner: 'br',
    _founderTools: false,
  });
});

app.post('/api/nus/settings', (req, res) => {
  res.json({ ok: true });
});

// ── STREAMING AI ASK ─────────────────────────────────────────────
// Loads ai-engine.js only when a request comes in so startup is instant.
// Falls back to direct Anthropic streaming if ai-engine isn't available.
let AI = null;
function getAI() {
  if (AI) return AI;
  try {
    AI = require('./ai-engine');
    console.log('[nus-server] ai-engine.js loaded ✓');
  } catch (e) {
    console.warn('[nus-server] ai-engine.js not available — using direct Anthropic fallback');
  }
  return AI;
}

const MODE_SYSTEM = {
  guide:     'You are Jarvis, an AI companion. The user clicked "What should I do?" — give a clear, prioritised answer about their immediate next best action. Be concise and direct.',
  assist:    'You are Jarvis. Help the user with whatever they are currently working on. Be concise and actionable.',
  say:       'You are Jarvis. Suggest what the user should say next in their current conversation. Be direct and natural-sounding.',
  objection: 'You are Jarvis. Help the user handle the objection being raised. Give a clear, persuasive response.',
  numbers:   'You are Jarvis. Surface the key numbers, metrics, or data points relevant to the user\'s current situation.',
  followup:  'You are Jarvis. Suggest smart follow-up questions the user should ask. Make them thoughtful and strategic.',
  recap:     'You are Jarvis. Give a brief, structured recap of the current conversation or situation.',
  brief:     'You are Jarvis. Give a pre-meeting briefing. Cover key points, participants, and what matters most.',
  spar:      'You are Jarvis playing an adversarial sparring partner. Challenge the user\'s thinking rigorously.',
  score:     'You are Jarvis. Score the user\'s performance and give actionable, honest feedback.',
  ask:       'You are Jarvis, a sharp AI assistant. Answer the user\'s question directly and helpfully.',
};

function modeDefault(mode) {
  const d = {
    guide:     'What should I do right now? Give me a clear, prioritized answer.',
    assist:    'Help me with what I am working on right now.',
    say:       'What should I say next in this conversation?',
    objection: 'Help me handle the objection being raised.',
    numbers:   'What are the key numbers or metrics relevant here?',
    followup:  'What follow-up questions should I ask?',
    recap:     'Give me a quick recap of what has been discussed.',
    brief:     'Give me a pre-call briefing.',
    spar:      'Start a sparring session. Challenge my thinking.',
    score:     'Score my performance so far and give me feedback.',
  };
  return d[mode] || 'Help me.';
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// word-stream a plain string back as SSE
async function wordStream(res, text) {
  const words = String(text || '').split(' ');
  for (let i = 0; i < words.length; i++) {
    const token = (i === 0 ? '' : ' ') + words[i];
    res.write(`data: ${JSON.stringify({ token })}\n\n`);
    await delay(14);
  }
  res.write('data: [DONE]\n\n');
  res.end();
}

// direct Anthropic streaming (when no ai-engine)
async function anthropicStream(res, systemPrompt, userMessage) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.write(`data: ${JSON.stringify({ error: 'No ANTHROPIC_API_KEY in .env and ai-engine not available.' })}\n\n`);
    res.end();
    return;
  }

  try {
    const { default: Anthropic } = await import('@anthropic-ai/sdk').catch(() => ({ default: null }));
    if (!Anthropic) {
      // sdk not installed — word-stream a placeholder
      await wordStream(res, 'Jarvis AI engine is not connected yet. Add your ANTHROPIC_API_KEY to .env to enable responses.');
      return;
    }

    const client = new Anthropic({ apiKey: key });
    const stream = await client.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }],
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta && chunk.delta.text) {
        res.write(`data: ${JSON.stringify({ token: chunk.delta.text })}\n\n`);
      }
    }
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
}

app.post('/api/nus/ask', async (req, res) => {
  const { mode = 'ask', text = '', sessionId = 'nus', resumeContext = '' } = req.body || {};
  const systemPrompt = (MODE_SYSTEM[mode] || MODE_SYSTEM.ask)
    + (resumeContext ? `\n\nUser background:\n${resumeContext}` : '');
  const userMessage = text || modeDefault(mode);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const engine = getAI();

  // path 1: ai-engine has streamChat
  if (engine && typeof engine.streamChat === 'function') {
    try {
      await engine.streamChat({
        message: userMessage, systemPrompt, sessionId,
        onToken: (t) => res.write(`data: ${JSON.stringify({ token: t })}\n\n`),
        onDone:  ()  => { res.write('data: [DONE]\n\n'); res.end(); },
        onError: (e) => { res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`); res.end(); },
      });
      return;
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
      return;
    }
  }

  // path 2: ai-engine has plain chat()
  if (engine && typeof engine.chat === 'function') {
    try {
      const reply = await engine.chat({ message: userMessage, systemPrompt, sessionId });
      await wordStream(res, reply);
      return;
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
      res.end();
      return;
    }
  }

  // path 3: direct Anthropic (no ai-engine)
  await anthropicStream(res, systemPrompt, userMessage);
});

// ── also proxy /api/chat so the bridge's fallback path works ──────
app.post('/api/chat', async (req, res) => {
  const { message = '', sessionId = 'nus' } = req.body || {};
  const engine = getAI();

  if (engine && typeof engine.chat === 'function') {
    try {
      const reply = await engine.chat({ message, sessionId });
      return res.json({ reply });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  res.json({ reply: 'AI engine not connected. Add ANTHROPIC_API_KEY to .env.' });
});

// ── START ─────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('\n╔═══════════════════════════════════════════╗');
  console.log('║   J.A.R.V.I.S  —  NUS Companion Mode     ║');
  console.log('╠═══════════════════════════════════════════╣');
  console.log(`║  Companion  →  http://localhost:${PORT}/nus  ║`);
  console.log('╚═══════════════════════════════════════════╝\n');
  console.log('  Full Jarvis:  npm start');
  console.log('  Knot only:    npm run nus\n');
});
