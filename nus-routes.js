'use strict';
/**
 * nus-routes.js
 * Mount this in Jarvis's server.js:
 *
 *   const NusRoutes = require('./nus-routes');
 *   NusRoutes.mount(app, AI, path);   // AI = your ai-engine.js module
 *
 * Adds:
 *   GET  /nus                  → serves the companion UI (public/nus-companion/index.html)
 *   POST /api/nus/ask          → streaming SSE AI call, routed through ai-engine.js
 *   GET  /api/nus/settings     → returns server-side default settings (client overrides locally)
 *   POST /api/nus/settings     → no-op (client stores in localStorage; server acks)
 *   GET  /api/status           → Jarvis health ping (companion uses this to show "connected")
 *
 * The companion already calls /api/chat for chat messages.  /api/nus/ask is a
 * lighter, streaming-first endpoint specifically for the knot modes (guide,
 * assist, say, recap, etc.) so we can inject a system prompt without touching
 * the main chat route.
 */

const path   = require('path');
const fs     = require('fs');

const NUS_PUBLIC = path.join(__dirname, 'public', 'nus-companion');

const MODE_SYSTEM = {
  guide:    'You are Jarvis, an AI companion. The user clicked "What should I do?" — give a clear, prioritised answer about their immediate next best action. Be concise and direct.',
  assist:   'You are Jarvis. Help the user with whatever they are currently working on. Be concise and actionable.',
  say:      'You are Jarvis. Suggest what the user should say next in their current conversation. Be direct and natural-sounding.',
  objection:'You are Jarvis. Help the user handle the objection being raised. Give a clear, persuasive response.',
  numbers:  'You are Jarvis. Surface the key numbers, metrics, or data points relevant to the user\'s current situation.',
  followup: 'You are Jarvis. Suggest smart follow-up questions the user should ask. Make them thoughtful and strategic.',
  recap:    'You are Jarvis. Give a brief, structured recap of the current conversation or situation.',
  brief:    'You are Jarvis. Give a pre-meeting briefing. Cover key points, participants, and what matters most.',
  spar:     'You are Jarvis playing an adversarial sparring partner. Challenge the user\'s thinking rigorously.',
  score:    'You are Jarvis. Score the user\'s performance and give actionable, honest feedback.',
  ask:      'You are Jarvis, a sharp AI assistant. Answer the user\'s question directly and helpfully.',
};

function mount(app, AI, pathModule) {
  if (!pathModule) pathModule = path;

  /* ── Serve the companion UI ──────────────────────────────────────────── */
  app.get('/nus', (req, res) => {
    const indexPath = pathModule.join(NUS_PUBLIC, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(404).send('NUS companion files not found. Copy public/nus-companion/ into Jarvis.');
    }
  });

  // Serve static files for the companion
  app.use('/nus-companion', require('express').static(NUS_PUBLIC));

  /* ── Health ping ─────────────────────────────────────────────────────── */
  app.get('/api/status', (req, res) => {
    res.json({ ok: true, service: 'jarvis', ts: new Date().toISOString() });
  });

  /* ── Settings (stateless — companion keeps state in localStorage) ─────── */
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
    // Client persists to localStorage; we just ack
    res.json({ ok: true });
  });

  /* ── Streaming AI ask ────────────────────────────────────────────────── */
  app.post('/api/nus/ask', async (req, res) => {
    const { mode = 'ask', text = '', sessionId = 'nus-default', resumeContext = '' } = req.body || {};

    const systemPrompt = (MODE_SYSTEM[mode] || MODE_SYSTEM.ask)
      + (resumeContext ? `\n\nUser background:\n${resumeContext}` : '');

    const userMessage = text || modeDefaultMessage(mode);

    // ── Try to stream via Jarvis AI engine ─────────────────────────────
    if (AI && typeof AI.streamChat === 'function') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      try {
        await AI.streamChat({
          message: userMessage,
          systemPrompt,
          sessionId,
          onToken: (token) => {
            res.write(`data: ${JSON.stringify({ token })}\n\n`);
          },
          onDone: () => {
            res.write('data: [DONE]\n\n');
            res.end();
          },
          onError: (err) => {
            res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
            res.end();
          },
        });
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
      return;
    }

    // ── Fallback: route through /api/chat and return as SSE ───────────
    if (AI && typeof AI.chat === 'function') {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      try {
        const reply = await AI.chat({
          message: userMessage,
          systemPrompt,
          sessionId,
        });

        const words = String(reply || '').split(' ');
        for (let i = 0; i < words.length; i++) {
          const token = (i === 0 ? '' : ' ') + words[i];
          res.write(`data: ${JSON.stringify({ token })}\n\n`);
          await delay(14);
        }
        res.write('data: [DONE]\n\n');
        res.end();
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
        res.end();
      }
      return;
    }

    // ── Last resort: tell client to use direct API fallback ───────────
    res.json({ reply: '[Jarvis AI engine not available. Add an Anthropic key in Settings.]' });
  });

  console.log('[nus-routes] mounted — companion UI at /nus, ask at /api/nus/ask');
}

function modeDefaultMessage(mode) {
  const defaults = {
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
  return defaults[mode] || 'Help me.';
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { mount };
