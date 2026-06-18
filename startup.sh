#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# J.A.R.V.I.S — Startup Script (Render-compatible)
# Installs Piper into ./bin/ (no root needed)
# ═══════════════════════════════════════════════════════════════

set -e

echo "[STARTUP] Beginning J.A.R.V.I.S boot sequence..."

# ── 1. INSTALL PIPER INTO LOCAL BIN ──────────────────────────
PIPER_BIN="./bin/piper"
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
  # Copy binary AND the lib folder it needs
  cp /tmp/piper/piper ./bin/piper
  cp -r /tmp/piper/lib ./bin/lib 2>/dev/null || true
  chmod +x ./bin/piper
  rm -rf /tmp/piper.tar.gz /tmp/piper

  echo "[STARTUP] Piper installed at $PIPER_BIN"
fi

# ── 2. DOWNLOAD JARVIS VOICE MODEL ───────────────────────────
VOICE_DIR="./voices/jarvis"
ONNX_FILE="$VOICE_DIR/en_GB-jarvis-medium.onnx"
JSON_FILE="$VOICE_DIR/en_GB-jarvis-medium.onnx.json"

mkdir -p "$VOICE_DIR"

if [ -f "$ONNX_FILE" ] && [ -f "$JSON_FILE" ]; then
  echo "[STARTUP] JARVIS voice model already present — skipping download"
else
  echo "[STARTUP] Downloading JARVIS voice model (~65MB)..."

  curl -L \
    "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/medium/en_GB-jarvis-medium.onnx" \
    -o "$ONNX_FILE"

  curl -L \
    "https://huggingface.co/jgkawell/jarvis/resolve/main/en/en_GB/jarvis/medium/en_GB-jarvis-medium.onnx.json" \
    -o "$JSON_FILE"

  echo "[STARTUP] JARVIS voice model downloaded ✓"
fi

echo "[STARTUP] Boot sequence complete. Bringing J.A.R.V.I.S online..."
