#!/bin/bash
# ═══════════════════════════════════════════════════════════════
# J.A.R.V.I.S — Startup Script
# Boots the XTTS-v2 voice clone server (Voice/Voice.wav) alongside
# the main Node process.
# ═══════════════════════════════════════════════════════════════
set -e

echo "[STARTUP] Beginning J.A.R.V.I.S boot sequence..."

# ── 1. PYTHON DEPS FOR VOICE SERVER ──────────────────────────
echo "[STARTUP] Checking voice server dependencies..."
pip install fastapi uvicorn TTS soundfile --break-system-packages --quiet

# ── 2. VERIFY REFERENCE VOICE FILE EXISTS ────────────────────
VOICE_FILE="./Voice/Voice.wav"
if [ ! -f "$VOICE_FILE" ]; then
  echo "[STARTUP] WARNING: $VOICE_FILE not found — voice cloning will fail."
else
  echo "[STARTUP] Reference voice found: $VOICE_FILE"
fi

# ── 3. START VOICE SERVER IN BACKGROUND ──────────────────────
echo "[STARTUP] Launching voice server on :5050..."
uvicorn voice-server.server:app --host 0.0.0.0 --port 5050 &

echo "[STARTUP] Boot sequence complete. Bringing J.A.R.V.I.S online..."
