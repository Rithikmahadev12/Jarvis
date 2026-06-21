#!/bin/bash
set -e
echo "[STARTUP] Beginning J.A.R.V.I.S boot sequence..."

echo "[STARTUP] Installing Piper TTS (ONNX, no PyTorch)..."
pip install piper-tts fastapi uvicorn --break-system-packages --quiet

VOICE_DIR="./voice-server/voices"
mkdir -p "$VOICE_DIR"
MODEL="$VOICE_DIR/en_US-ryan-high.onnx"
CONFIG="$VOICE_DIR/en_US-ryan-high.onnx.json"

if [ ! -f "$MODEL" ]; then
  echo "[STARTUP] Downloading Piper voice model (~60MB)..."
  curl -L -o "$MODEL"  "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx"
  curl -L -o "$CONFIG" "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/ryan/high/en_US-ryan-high.onnx.json"
fi

echo "[STARTUP] Launching voice server on :5050..."
uvicorn voice-server.server:app --host 0.0.0.0 --port 5050 &

echo "[STARTUP] Boot sequence complete."
