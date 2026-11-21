# Integrating NUS Companion UI into Jarvis

## What you got

```
public/nus-companion/
  index.html        ← the full NUS knot companion UI
  styles.css        ← NUS glassmorphism styles (verbatim)
  knot-look.css     ← knot colour states (verbatim)
  knot3d.js         ← 3D animated knot renderer (verbatim)
  strand.js         ← thread/strand animation (verbatim)
  icons.js          ← lucide icons (verbatim)
  renderer.js       ← NUS companion logic (verbatim)
  jarvis-bridge.js  ← 🔑 the bridge: replaces Electron IPC with Jarvis REST+Socket.IO

nus-routes.js       ← Express route module to mount in server.js
```

## Step 1 — Copy files

```bash
# From your Jarvis-main root:
mkdir -p public/nus-companion
cp path/to/jarvis-nus-output/public/nus-companion/* public/nus-companion/
cp path/to/jarvis-nus-output/nus-routes.js .
```

## Step 2 — Wire into server.js

Find the line in `server.js` where routes are defined (after `const AI = require('./ai-engine')`).
Add this near the top of your routes section:

```js
// NUS Companion UI
const NusRoutes = require('./nus-routes');
NusRoutes.mount(app, AI, path);
```

That's it. The companion is now live at `http://localhost:3000/nus`.

## Step 3 — Wire streaming (optional but recommended)

The bridge calls `/api/nus/ask` for streaming. The route module tries
`AI.streamChat(...)` first. If your `ai-engine.js` exports `streamChat`,
it works out of the box.

If `ai-engine.js` only exports `chat(...)` (non-streaming), the route
word-streams the reply at ~14ms per word — good enough for the knot UI.

If you want true token-by-token streaming, add to `ai-engine.js`:

```js
async function streamChat({ message, systemPrompt, sessionId, onToken, onDone, onError }) {
  // Use Anthropic streaming:
  const stream = await anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: message }],
  });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.text) {
      onToken(chunk.delta.text);
    }
  }
  onDone();
}
module.exports.streamChat = streamChat;
```

## How the bridge works

```
Browser page (index.html)
  └── jarvis-bridge.js  ← sets window.nus
        └── nus.ask({ mode, text })
              └── POST /api/nus/ask   ← SSE stream
                    └── nus-routes.js
                          └── AI.streamChat / AI.chat
                                └── ai-engine.js  (Claude / OpenAI / etc.)

Events back to renderer:
  llm:start  → shows user bubble, opens tiles
  llm:token  → streams word by word into the glass panel  
  llm:done   → finalises, hides caret
  llm:error  → shows error in panel
```

## Fallback AI (no backend needed)

The bridge has a direct Anthropic fallback. If Jarvis's backend is unreachable,
it uses the `anthropic` key the user enters in Settings → Provider to call
Claude directly from the browser. So the knot works even on a static host.

## URL

```
https://your-jarvis-deploy.onrender.com/nus
```

The companion floats in the bottom-right corner, identical to NUS Desktop.
