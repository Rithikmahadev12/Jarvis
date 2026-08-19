"""
J.A.R.V.I.S — Voice Clone Worker
─────────────────────────────────
Runs entirely inside Jarvis's E2B cloud sandbox (see computer.js /
voice-clone-routes.js on the Node side) — never on Render and never on
someone's own desktop. Every account's cloning and synthesis happens on
that one sandbox, so there's no capability check and no "wait for a
better machine" queue — this IS the machine.

Uses Coqui XTTS-v2 (open-source, zero-shot voice cloning): hand it a
6-30s reference clip and it can speak any new sentence in that voice on
the spot — no training step, no GPU required (works on CPU, just
slower per line).

Talks to the outside world purely through argv + files, so the Node
side never needs anything fancier than Computer.runOnSandbox() +
Computer files.write/read — no server process, no port, nothing to
keep alive between calls.

USAGE (from inside the sandbox):
    python3 clone_worker.py clone <user>
        Reads   /root/voice-clones/<user>/reference.wav
        Prints  {"saved": true, "reason": "Cloned."}  (or an error)

    python3 clone_worker.py synth <user> <text_file> <out_wav>
        Reads   <text_file> (plain text, the line to speak)
        Writes  <out_wav>
        Prints  {"ok": true}  (or an error)

The XTTS-v2 model (~2GB) downloads from Hugging Face on first use and
is cached in the sandbox's filesystem for the rest of that sandbox's
life (it's a long-lived dedicated sandbox, not the aggressively-reaped
shared one — see createDedicatedSandbox in computer.js).
"""

import io
import os
import sys
import json
import wave
import struct

VOICE_DIR = "/root/voice-clones"


def _reference_path(user: str) -> str:
    safe = "".join(c for c in user.lower().strip() if c.isalnum() or c in "-_") or "default"
    return os.path.join(VOICE_DIR, safe, "reference.wav")


_engine = None


def _load_engine():
    global _engine
    if _engine is not None:
        return _engine
    import torch
    from TTS.api import TTS
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _engine = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
    return _engine


def cmd_clone(user: str):
    ref = _reference_path(user)
    if not os.path.isfile(ref):
        print(json.dumps({"saved": False, "reason": "No reference audio uploaded for this account."}))
        return
    try:
        engine = _load_engine()
        # Smoke-test the clip now so a bad/too-short/silent upload fails
        # here with a clear reason, instead of on the first real reply.
        engine.tts(text="Voice check.", speaker_wav=ref, language="en")
        print(json.dumps({"saved": True, "reason": "Cloned."}))
    except Exception as e:
        print(json.dumps({"saved": False, "reason": f"{e.__class__.__name__}: {e}"}))


def cmd_synth(user: str, text_file: str, out_file: str):
    ref = _reference_path(user)
    if not os.path.isfile(ref):
        print(json.dumps({"ok": False, "reason": "No cloned voice on file for this account."}))
        return
    try:
        with open(text_file, "r", encoding="utf-8") as f:
            text = f.read().strip()
        if not text:
            print(json.dumps({"ok": False, "reason": "Empty text."}))
            return
        engine = _load_engine()
        samples = engine.tts(text=text, speaker_wav=ref, language="en")
        sample_rate = 24000  # XTTS-v2's native output rate
        with wave.open(out_file, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(sample_rate)
            frames = b"".join(struct.pack("<h", max(-32768, min(32767, int(s * 32767)))) for s in samples)
            w.writeframes(frames)
        print(json.dumps({"ok": True}))
    except Exception as e:
        print(json.dumps({"ok": False, "reason": f"{e.__class__.__name__}: {e}"}))


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print(json.dumps({"ok": False, "reason": "usage: clone_worker.py <clone|synth> <user> [text_file] [out_file]"}))
        sys.exit(1)

    action, user = sys.argv[1], sys.argv[2]
    if action == "clone":
        cmd_clone(user)
    elif action == "synth":
        if len(sys.argv) < 5:
            print(json.dumps({"ok": False, "reason": "synth needs <text_file> <out_file>"}))
            sys.exit(1)
        cmd_synth(user, sys.argv[3], sys.argv[4])
    else:
        print(json.dumps({"ok": False, "reason": f"unknown action '{action}'"}))
        sys.exit(1)
