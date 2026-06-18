#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# J.A.R.V.I.S — Startup Script (Render-compatible)
# FIX: HuggingFace requires redirect following (-L) AND a proper
# User-Agent, and the jgkawell model URL has moved.
# Falls back to the official en_GB-alan-low model if JARVIS
# voice unavailable.
# ═══════════════════════════════════════════════════════════════

set -e

echo "[STARTUP] Beginning J.A.R.V.I.S boot sequence..."

# ── 1. INSTALL PIPER ─────────────────────────────────────────
PIPER_DIR="./bin/piper_dir"
PIPER_BIN="$PIPER_DIR/piper"
mkdir -p ./bin

if [ -f "$PIPER_BIN" ]; then
  echo "[STARTUP] Piper already installed — skipping"
else
  echo "[STARTUP] Installing Piper TTS..."

  ARCH=$(uname -m)
  if [ "$ARCH" = "aarch64" ]; then
    PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_aarch64.tar.gz"
  else
    PIPER_URL="https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz"
  fi

  curl -L "$PIPER_URL" -o /tmp/piper.tar.gz
  tar -xzf /tmp/piper.tar.gz -C /tmp/
  cp -r /tmp/piper "$PIPER_DIR"
  chmod +x "$PIPER_BIN"
  rm -rf /tmp/piper.tar.gz /tmp/piper

  echo "[STARTUP] Piper installed at $PIPER_BIN"
fi

# ── 2. DOWNLOAD VOICE MODEL ───────────────────────────────────
VOICE_DIR="./voices/jarvis"
ONNX_FILE="$VOICE_DIR/en_GB-jarvis-medium.onnx"
JSON_FILE="$VOICE_DIR/en_GB-jarvis-medium.onnx.json"

mkdir -p "$VOICE_DIR"

MIN_SIZE=1000000  # 1MB minimum — a real model is ~65MB

check_file_valid() {
  local f="$1"
  [ -f "$f" ] && [ "$(wc -c < "$f")" -gt "$MIN_SIZE" ]
}

if check_file_valid "$ONNX_FILE" && [ -f "$JSON_FILE" ]; then
  echo "[STARTUP] JARVIS voice model already present — skipping download"
else
  echo "[STARTUP] Downloading JARVIS voice model..."

  # Try the correct HuggingFace URL with proper headers
  curl -L \
    -H "User-Agent: Mozilla/5.0" \
    "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/medium/en_GB-jarvis-medium.onnx" \
    -o "$ONNX_FILE"

  # Verify it's actually a real file (>1MB)
  if ! check_file_valid "$ONNX_FILE"; then
    echo "[STARTUP] JARVIS model download failed or too small ($(wc -c < "$ONNX_FILE") bytes) — falling back to alan-low"
    rm -f "$ONNX_FILE"

    # Fall back to official Piper en_GB-alan-low voice
    curl -L \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/low/en_GB-alan-low.onnx" \
      -o "$ONNX_FILE"

    curl -L \
      "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/alan/low/en_GB-alan-low.onnx.json" \
      -o "$JSON_FILE"

    # Update the model path env var so tts.js picks up the right file
    echo "PIPER_VOICE_MODEL=en_GB-alan-low" >> .env 2>/dev/null || true
    echo "[STARTUP] Fallback voice (alan-low) downloaded ✓"
  else
    # Download the JSON config too
    curl -L \
      -H "User-Agent: Mozilla/5.0" \
      "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/medium/en_GB-jarvis-medium.onnx.json" \
      -o "$JSON_FILE"

    echo "[STARTUP] JARVIS voice model downloaded ✓ ($(wc -c < "$ONNX_FILE") bytes)"
  fi
fi

echo "[STARTUP] Boot sequence complete. Bringing J.A.R.V.I.S online..."
