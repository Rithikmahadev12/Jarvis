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

# ── JARVIS AGENT (Groq-powered, LOCAL-ONLY) ─────────────────────
# Render sets $RENDER automatically on every deploy. When it's set,
# we're running in the cloud — there's no local desktop for Jarvis
# to open apps/files on, so the agent disables itself entirely
# (see jarvis-agent.js's isEnabled()) and there's nothing to boot
# here. When $RENDER is unset, we're on someone's own machine: the
# agent reasons about "open X" requests using Groq's cloud API (the
# same GROQ_API_KEY already checked above), not a local model — so,
# unlike the old Ollama-based agent, there's no separate binary to
# install and no model to pull. As long as GROQ_API_KEY is set, it's
# ready the instant this instance starts locally.
if [ -n "$RENDER" ]; then
  echo "[STARTUP] Running on Render — Jarvis agent stays disabled (no local PC to control from here)."
else
  if [ -n "$GROQ_API_KEY" ]; then
    echo "[STARTUP] Running locally — Jarvis agent ready (Groq-powered, 'open X on my computer' will work)."
  else
    echo "[STARTUP][WARN] Running locally but no GROQ_API_KEY set — Jarvis agent can't reason about 'open X' until one is added to .env."
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
