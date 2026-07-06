#!/bin/bash
# NOTE: no "set -e" here on purpose. This script boots an optional, secondary
# voice server. If pip/curl/uvicorn hiccup, we want to log it and keep going
# so the main Node app (server.js) still starts.

echo "[STARTUP] Beginning J.A.R.V.I.S boot sequence..."

# pip with --break-system-packages installs console scripts (uvicorn, piper)
# into ~/.local/bin. That directory is NOT on PATH by default on Render's
# image, which is why "uvicorn: command not found" happened even though the
# install itself succeeded. Adding it to PATH fixes that.
export PATH="$HOME/.local/bin:$PATH"

echo "[STARTUP] Installing Piper TTS (ONNX, no PyTorch)..."
pip install piper-tts fastapi uvicorn --break-system-packages --quiet || \
  echo "[STARTUP][WARN] pip install for Piper/uvicorn failed, voice server will be skipped."

echo "[STARTUP] Installing pychromecast (for Home Talk)..."
pip install pychromecast --break-system-packages --quiet || \
  echo "[STARTUP][WARN] pip install for pychromecast failed."

VOICE_DIR="./voice-server/voices"
mkdir -p "$VOICE_DIR"
MODEL="$VOICE_DIR/en_US-ryan-high.onnx"
CONFIG="$VOICE_DIR/en_US-ryan-high.onnx.json"

if [ ! -f "$MODEL" ]; then
  echo "[STARTUP] Downloading Piper voice model (~60MB)..."
  curl -fL -o "$MODEL"  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx" || \
    echo "[STARTUP][WARN] Voice model download failed."
  curl -fL -o "$CONFIG" "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json" || \
    echo "[STARTUP][WARN] Voice model config download failed."
fi

echo "[STARTUP] Installing Hermes Agent (this is the Jarvis 'brain' AI, self-hosted)..."
pip install hermes-agent --break-system-packages --quiet || \
  echo "[STARTUP][WARN] pip install for hermes-agent failed, Hermes will be skipped — Jarvis falls back to whatever else is configured."

if command -v hermes >/dev/null 2>&1; then
  echo "[STARTUP] Configuring Hermes Agent..."

  # Point Hermes at whichever AI provider key you already have. Groq is checked
  # first since Jarvis already uses it (api.groq.com is OpenAI-compatible, so
  # Hermes can call it as a "custom endpoint" — no new signup needed).
  if [ -n "$GROQ_API_KEY" ]; then
    echo "[STARTUP] Hermes will use Groq (reusing existing GROQ_API_KEY)..."
    hermes config set model.provider custom                                       >/dev/null 2>&1
    hermes config set model.base_url "https://api.groq.com/openai/v1"             >/dev/null 2>&1
    hermes config set model.model    "${HERMES_MODEL:-llama-3.3-70b-versatile}"   >/dev/null 2>&1
    hermes config set OPENAI_API_KEY "$GROQ_API_KEY"                              >/dev/null 2>&1
  elif [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "[STARTUP] Hermes will use Anthropic..."
    hermes config set model "anthropic/${HERMES_MODEL:-claude-sonnet-4-6}" >/dev/null 2>&1
    hermes config set ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY"               >/dev/null 2>&1
  elif [ -n "$OPENROUTER_API_KEY" ]; then
    echo "[STARTUP] Hermes will use OpenRouter..."
    hermes config set model "openrouter/${HERMES_MODEL:-meta-llama/llama-3.3-70b-instruct}" >/dev/null 2>&1
    hermes config set OPENROUTER_API_KEY "$OPENROUTER_API_KEY"                              >/dev/null 2>&1
  else
    echo "[STARTUP][WARN] No AI provider key found (GROQ_API_KEY / ANTHROPIC_API_KEY / OPENROUTER_API_KEY) — Hermes has no model to think with, skipping."
  fi

  HERMES_KEY="${HERMES_API_KEY:-change-me-please}"

  # Expose the OpenAI-compatible API server on loopback only — Node talks to it
  # over 127.0.0.1, it's never exposed to the public internet.
  hermes config set API_SERVER_ENABLED true      >/dev/null 2>&1
  hermes config set API_SERVER_HOST 127.0.0.1    >/dev/null 2>&1
  hermes config set API_SERVER_KEY "$HERMES_KEY" >/dev/null 2>&1

  echo "[STARTUP] Launching Hermes Agent gateway (API server on :8642)..."
  hermes gateway run > ./hermes.log 2>&1 &

  echo "[STARTUP] Waiting for Hermes API server to come up..."
  for i in $(seq 1 30); do
    curl -sf -H "Authorization: Bearer $HERMES_KEY" http://127.0.0.1:8642/v1/models >/dev/null 2>&1 && \
      { echo "[STARTUP] Hermes Agent is up."; break; }
    sleep 1
  done
else
  echo "[STARTUP][WARN] 'hermes' command not found on PATH after install, skipping Hermes Agent."
fi

echo "[STARTUP] Launching voice server on :5050..."
# Use "python3 -m uvicorn" instead of the bare "uvicorn" command. This works
# regardless of whether pip's script shims are on PATH, since it just asks
# the python interpreter to run the installed uvicorn module directly.
python3 -m uvicorn voice-server.server:app --host 0.0.0.0 --port 5050 &

echo "[STARTUP] Boot sequence complete."
