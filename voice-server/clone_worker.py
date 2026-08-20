"""
J.A.R.V.I.S — Voice Clone Worker
─────────────────────────────────
Runs entirely inside Jarvis's E2B cloud sandbox (see computer.js /
voice-clone-routes.js on the Node side) — never on Render and never on
someone's own desktop. Every account's cloning and synthesis happens on
that one sandbox, so there's no capability check and no "wait for a
better machine" queue — this IS the machine.

Uses Chatterbox TTS (Resemble AI, MIT license, open-source code + open
weights — no third-party API involved): hand it a ~5-10s reference clip
and it can speak any new sentence in that voice on the spot — no
training step, no GPU required (works on CPU, just slower per line).
Switched from Coqui XTTS-v2 to this after repeated dependency-chain
breakage (torchaudio/torchcodec/transformers version churn) — Chatterbox
has fewer moving parts, ships under a permissive commercial-friendly
license instead of XTTS's non-commercial CPML, and needs no interactive
license-agreement workaround.

Every output from Chatterbox carries Resemble's inaudible PerTh
watermark baked in by the model itself — that's upstream behavior, not
something this code adds or can turn off.

Talks to the outside world purely through argv + files, so the Node
side never needs anything fancier than Computer.runOnSandbox() +
Computer files.write/read — no server process, no port, nothing to
keep alive between calls.

USAGE (from inside the sandbox):
    python3 clone_worker.py clone <user>
        Reads   /tmp/voice-clones/<user>/reference.wav
        Prints  {"saved": true, "reason": "Cloned."}  (or an error)

    python3 clone_worker.py synth <user> <text_file> <out_wav>
        Reads   <text_file> (plain text, the line to speak)
        Writes  <out_wav>
        Prints  {"ok": true}  (or an error)

The Chatterbox model (~1-2GB) downloads from Hugging Face on first use
and is cached in the sandbox's filesystem for the rest of that sandbox's
life (it's a long-lived dedicated sandbox, not the aggressively-reaped
shared one — see createDedicatedSandbox in computer.js).
"""

import os
import sys
import json

VOICE_DIR = "/tmp/voice-clones"


def _reference_path(user: str) -> str:
    safe = "".join(c for c in user.lower().strip() if c.isalnum() or c in "-_") or "default"
    return os.path.join(VOICE_DIR, safe, "reference.wav")


_model = None


def _load_model():
    global _model
    if _model is not None:
        return _model
    import torch
    from chatterbox.tts import ChatterboxTTS
    device = "cuda" if torch.cuda.is_available() else "cpu"
    _model = ChatterboxTTS.from_pretrained(device=device)
    return _model


def cmd_clone(user: str):
    ref = _reference_path(user)
    if not os.path.isfile(ref):
        print(json.dumps({"saved": False, "reason": "No reference audio uploaded for this account."}), flush=True)
        return
    try:
        model = _load_model()
        # Smoke-test the clip now so a bad/too-short/silent upload fails
        # here with a clear reason, instead of on the first real reply.
        model.generate("Voice check.", audio_prompt_path=ref)
        print(json.dumps({"saved": True, "reason": "Cloned."}), flush=True)
    except Exception as e:
        print(json.dumps({"saved": False, "reason": f"{e.__class__.__name__}: {e}"}), flush=True)


def cmd_synth(user: str, text_file: str, out_file: str):
    ref = _reference_path(user)
    if not os.path.isfile(ref):
        print(json.dumps({"ok": False, "reason": "No cloned voice on file for this account."}), flush=True)
        return
    try:
        with open(text_file, "r", encoding="utf-8") as f:
            text = f.read().strip()
        if not text:
            print(json.dumps({"ok": False, "reason": "Empty text."}), flush=True)
            return
        import torchaudio as ta
        model = _load_model()
        wav = model.generate(text, audio_prompt_path=ref)
        ta.save(out_file, wav, model.sr)
        print(json.dumps({"ok": True}), flush=True)
    except Exception as e:
        print(json.dumps({"ok": False, "reason": f"{e.__class__.__name__}: {e}"}), flush=True)


if __name__ == "__main__":
    try:
        if len(sys.argv) < 3:
            print(json.dumps({"ok": False, "reason": "usage: clone_worker.py <clone|synth> <user> [text_file] [out_file]"}), flush=True)
            sys.exit(1)

        action, user = sys.argv[1], sys.argv[2]
        if action == "clone":
            cmd_clone(user)
        elif action == "synth":
            if len(sys.argv) < 5:
                print(json.dumps({"ok": False, "reason": "synth needs <text_file> <out_file>"}), flush=True)
                sys.exit(1)
            cmd_synth(user, sys.argv[3], sys.argv[4])
        else:
            print(json.dumps({"ok": False, "reason": f"unknown action '{action}'"}), flush=True)
            sys.exit(1)
    except Exception as e:
        # Last-resort catch-all: cmd_clone/cmd_synth already catch their own
        # errors and print JSON, but this guarantees ONE valid JSON line
        # comes out no matter what breaks (bad argv, an import-time error,
        # anything outside those functions' own try/except) — the Node
        # side's safeJson() always has something real to parse instead of
        # falling through to a generic error message with no detail.
        print(json.dumps({"ok": False, "saved": False, "reason": f"{e.__class__.__name__}: {e}"}), flush=True)
        sys.exit(1)
