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

echo "[STARTUP] Launching voice server on :5050..."
# Use "python3 -m uvicorn" instead of the bare "uvicorn" command. This works
# regardless of whether pip's script shims are on PATH, since it just asks
# the python interpreter to run the installed uvicorn module directly.
python3 -m uvicorn voice-server.server:app --host 0.0.0.0 --port 5050 &

echo "[STARTUP] Boot sequence complete."
