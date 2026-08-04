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

# On Windows (Git Bash / WSL edge cases) there's often no bare "pip" or
# "python3" on PATH even when Python itself is installed — Windows'
# installer usually only adds "python" and "py". Pick whichever of
# python3/python/py actually exists instead of hardcoding one, so this
# doesn't silently no-op with "pip: command not found" on Windows while
# working fine on Render (Linux, where python3 always exists).
PY=""
for candidate in python3 python py; do
  if command -v "$candidate" >/dev/null 2>&1; then PY="$candidate"; break; fi
done

if [ -z "$PY" ]; then
  echo "[STARTUP][WARN] No Python interpreter (python3/python/py) found on PATH — Piper TTS, pychromecast, and Home Talk voice server will be skipped. Install Python 3 and re-run if you want those features."
else
  echo "[STARTUP] Using '$PY' for Python steps."
  echo "[STARTUP] Installing Piper TTS (ONNX, no PyTorch)..."
  "$PY" -m pip install piper-tts fastapi uvicorn --break-system-packages --quiet || \
    "$PY" -m pip install piper-tts fastapi uvicorn --quiet || \
    echo "[STARTUP][WARN] pip install for Piper/uvicorn failed, voice server will be skipped."

  echo "[STARTUP] Installing pychromecast (for Home Talk)..."
  "$PY" -m pip install pychromecast --break-system-packages --quiet || \
    "$PY" -m pip install pychromecast --quiet || \
    echo "[STARTUP][WARN] pip install for pychromecast failed."
fi

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

# ── AI BRAIN: Groq, everywhere (local machine or Render) ─────────
# No local model to install or pull anymore — Jarvis always talks to
# Groq's cloud API for the AI brain, the "open X on my computer"
# agent, and screen-reading Q&A. $RENDER (set automatically by
# Render on every deploy) is only used to tell whether the
# "open X on my computer" agent should be enabled — there's no local
# PC to control from a cloud deploy.
if [ -n "$RENDER" ]; then
  echo "[STARTUP] Running on Render (cloud) — Jarvis agent stays disabled (no local PC to control from here)."
else
  echo "[STARTUP] Running locally — the 'open X on my computer' agent and screen-reading Q&A are enabled."
fi
if [ -n "$GROQ_API_KEY" ]; then
  echo "[STARTUP] GROQ_API_KEY found — Jarvis will talk to Groq's API directly for the AI brain."
else
  echo "[STARTUP][WARN] No GROQ_API_KEY found in .env — Jarvis's AI brain will be unavailable until you add one."
fi

if [ -n "$PY" ]; then
  echo "[STARTUP] Launching voice server on :5050..."
  # Use "<python> -m uvicorn" instead of the bare "uvicorn" command. This works
  # regardless of whether pip's script shims are on PATH, since it just asks
  # the python interpreter to run the installed uvicorn module directly.
  "$PY" -m uvicorn voice-server.server:app --host 0.0.0.0 --port 5050 &
else
  echo "[STARTUP] Skipping voice server launch (no Python interpreter found earlier)."
fi

echo "[STARTUP] Background setup launched. (Node is already up on its own port and does not wait for this.)"

# Keep this script's own process alive so its background jobs (hermes gateway,
# uvicorn, the readiness poller) aren't orphaned/killed the instant this
# script's foreground line finishes.
wait
