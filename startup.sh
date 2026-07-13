#!/bin/bash
# NOTE: no "set -e" here on purpose. This script boots an optional, secondary
# voice server. If pip/curl/uvicorn hiccup, we want to log it and keep going
# so the main Node app (server.js) still starts.
#
# IMPORTANT: this script now runs CONCURRENTLY with `node server.js` (see
# package.json's start script — it's "startup.sh & node server.js", not "&&").
# Node does not wait for this script to finish, so nothing in here should be
# assumed to exist yet from server.js's point of view. Node binds its port
# immediately; everything below just prepares the optional voice/Hermes
# subsystems in the background so Render's port scan never stalls waiting
# on pip installs or model downloads again.

echo "[STARTUP] Beginning J.A.R.V.I.S boot sequence (background)..."

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
# Switched from en_US-ryan-high to en_US-ryan-low: the "high" model was
# too slow on Render's free-tier CPU and caused /synthesize to time out
# under tts.js's 30s limit. "low" trades some voice quality for much
# faster synthesis, which matters more than quality for Home Talk audio
# played through a phone/speaker.
MODEL="$VOICE_DIR/en_US-ryan-low.onnx"
CONFIG="$VOICE_DIR/en_US-ryan-low.onnx.json"

if [ ! -f "$MODEL" ]; then
  echo "[STARTUP] Downloading Piper voice model (~20MB)..."
  curl -fL -o "$MODEL"  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/low/en_US-ryan-low.onnx" || \
    echo "[STARTUP][WARN] Voice model download failed."
  curl -fL -o "$CONFIG" "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/low/en_US-ryan-low.onnx.json" || \
    echo "[STARTUP][WARN] Voice model config download failed."
fi

if [ -n "$GROQ_API_KEY" ]; then
  echo "[STARTUP] GROQ_API_KEY found — Jarvis will talk to Groq's API directly for the AI brain."
else
  echo "[STARTUP][WARN] No GROQ_API_KEY found in .env — Jarvis's AI brain will be unavailable until you add one."
fi

# ── HERMES AGENT (real local LLM via Ollama) ────────────────────
# Render sets $RENDER automatically on every deploy. When it's set,
# we're running in the cloud — there's no local desktop for Jarvis
# to open apps/files on, so we skip Ollama/Hermes entirely and don't
# waste boot time on a multi-GB model download. When $RENDER is
# unset, we're on someone's own machine: make sure Ollama is
# installed, running, and has actually pulled the Hermes model, so
# Jarvis can reason about "open X" commands with a real local LLM.
# Groq still handles the main AI brain either way — this is purely
# about the local "open X on my computer" capability.
HERMES_MODEL="${HERMES_MODEL:-hermes3}"

if [ -n "$RENDER" ]; then
  echo "[STARTUP] Running on Render — skipping Ollama/Hermes agent (no local PC to control from here)."
else
  echo "[STARTUP] Running locally — checking for Ollama (needed to run the Hermes agent)..."
  if ! command -v ollama >/dev/null 2>&1; then
    OS_NAME="$(uname -s 2>/dev/null || echo unknown)"
    if [ "$OS_NAME" = "Linux" ]; then
      echo "[STARTUP] Ollama not found — installing it (official script, Linux only)..."
      curl -fsSL https://ollama.com/install.sh | sh || \
        echo "[STARTUP][WARN] Ollama install failed. Install manually from https://ollama.com/download."
    else
      echo "[STARTUP][WARN] Ollama not found. On macOS/Windows it needs to be installed manually:"
      echo "[STARTUP][WARN]   -> https://ollama.com/download"
      echo "[STARTUP][WARN] Local 'open X on my computer' commands will be unavailable until it's installed."
    fi
  fi

  if command -v ollama >/dev/null 2>&1; then
    # Start the Ollama server in the background if it isn't already running.
    if ! curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
      echo "[STARTUP] Starting Ollama server..."
      ollama serve > /tmp/ollama.log 2>&1 &
      sleep 2
    fi
    echo "[STARTUP] Pulling Hermes model ($HERMES_MODEL) — first run only, several GB, this can take a while..."
    ollama pull "$HERMES_MODEL" || \
      echo "[STARTUP][WARN] Failed to pull $HERMES_MODEL. Jarvis will retry lazily the first time you ask it to open something."
    echo "[STARTUP] Hermes agent ready ($HERMES_MODEL via Ollama)."
  fi
fi

echo "[STARTUP] Launching voice server on :5050..."
# Use "python3 -m uvicorn" instead of the bare "uvicorn" command. This works
# regardless of whether pip's script shims are on PATH, since it just asks
# the python interpreter to run the installed uvicorn module directly.
python3 -m uvicorn voice-server.server:app --host 0.0.0.0 --port 5050 &

echo "[STARTUP] Background setup launched. (Node is already up on its own port and does not wait for this.)"

# Keep this script's own process alive so its background jobs (hermes gateway,
# uvicorn, the readiness poller) aren't orphaned/killed the instant this
# script's foreground line finishes.
wait
