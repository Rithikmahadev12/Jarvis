#!/bin/bash
set -e

# ── Fix PATH so pip-installed binaries are findable ──────────────────────────
export PATH="$HOME/.local/bin:/opt/render/.local/bin:$PATH"

echo "[STARTUP] Beginning J.A.R.V.I.S boot sequence..."

# ── Python dependencies ───────────────────────────────────────────────────────
echo "[STARTUP] Installing Piper TTS (ONNX, no PyTorch)..."
pip install piper-tts fastapi uvicorn --break-system-packages --quiet

echo "[STARTUP] Installing pychromecast (for Home Talk)..."
pip install pychromecast --break-system-packages --quiet

# ── Voice model ───────────────────────────────────────────────────────────────
VOICE_DIR="./voice-server/voices"
mkdir -p "$VOICE_DIR"
MODEL="$VOICE_DIR/en_US-ryan-high.onnx"
CONFIG="$VOICE_DIR/en_US-ryan-high.onnx.json"

if [ ! -f "$MODEL" ]; then
  echo "[STARTUP] Downloading Piper voice model (~60MB)..."
  curl -L -o "$MODEL"  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx"
  curl -L -o "$CONFIG" "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json"
else
  echo "[STARTUP] Voice model already present, skipping download."
fi

# ── Launch voice server in background ────────────────────────────────────────
echo "[STARTUP] Launching voice server on :5050..."
uvicorn voice-server.server:app --host 0.0.0.0 --port 5050 &
VOICE_PID=$!

# Give uvicorn a moment to bind before Node starts
sleep 3

# Confirm voice server is actually running
if kill -0 "$VOICE_PID" 2>/dev/null; then
  echo "[STARTUP] Voice server is up (PID $VOICE_PID)."
else
  echo "[STARTUP] WARNING: Voice server failed to start. TTS will be unavailable."
fi

echo "[STARTUP] Boot sequence complete."
