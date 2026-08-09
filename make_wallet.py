"""
J.A.R.V.I.S — Solana wallet generator (run this locally, on YOUR PC only)

Generates a brand-new Solana keypair, prints the public address, and
saves the private key to wallet.json IN THIS FOLDER ONLY.

The public address is written to data/wallet-config.json — the same
folder Jarvis's persistence.js already syncs to Supabase every ~20s —
so it propagates automatically to the running app AND to the
scheduled GitHub Actions bounty scan without you ever having to paste
it into .env or a GitHub secret by hand. (It's also written into
.env as a convenience/fallback in case Supabase sync isn't set up.)

wallet.json is listed in .gitignore, so `git push` will never send it
anywhere. Nothing in this repo reads wallet.json back except you —
Jarvis's own wallet module (solana-wallet.js) only ever uses the
PUBLIC address.

Do NOT run this on a cloud box, a GitHub Actions runner, or any
machine you don't fully control — a private key generated somewhere
you don't control is a private key you should assume is compromised.
That's exactly why this stays a manual, local, one-time step instead
of something Jarvis's scheduled cloud jobs ever touch.

Usage:
    pip install solders --break-system-packages
    python make_wallet.py
"""

import json
import os
import re
from datetime import datetime, timezone

from solders.keypair import Keypair

ROOT_DIR    = os.path.dirname(os.path.abspath(__file__))
ENV_PATH    = os.path.join(ROOT_DIR, ".env")
KEY_PATH    = os.path.join(ROOT_DIR, "wallet.json")
DATA_DIR    = os.path.join(ROOT_DIR, "data")
CONFIG_PATH = os.path.join(DATA_DIR, "wallet-config.json")


def write_wallet_config(address: str) -> None:
    """The source of truth every Jarvis module actually reads from.
    Lives in data/ so persistence.js's normal Supabase sync (which
    already mirrors that whole folder) carries it to every other
    environment automatically — no manual copy-paste anywhere."""
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w") as f:
        json.dump({
            "address": address,
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }, f, indent=2)


def update_env_address(address: str) -> None:
    """Also set SOLANA_WALLET_ADDRESS in .env as a fallback — not
    required for anything to work, but handy if you ever want to see
    it there or run without Supabase sync configured."""
    line = f'SOLANA_WALLET_ADDRESS="{address}"\n'
    if not os.path.exists(ENV_PATH):
        with open(ENV_PATH, "w") as f:
            f.write(line)
        return

    with open(ENV_PATH, "r") as f:
        contents = f.read()

    pattern = re.compile(r'^SOLANA_WALLET_ADDRESS=.*$', re.MULTILINE)
    if pattern.search(contents):
        contents = pattern.sub(line.strip(), contents)
    else:
        if not contents.endswith("\n"):
            contents += "\n"
        contents += line

    with open(ENV_PATH, "w") as f:
        f.write(contents)


def main():
    kp = Keypair()
    address = str(kp.pubkey())
    # 64-byte array (secret + public key) — the same format the
    # official Solana CLI (solana-keygen) uses for its wallet files,
    # so this file also works with solana-cli / solana-py if you
    # ever need it there.
    secret = list(bytes(kp.to_bytes()))

    with open(KEY_PATH, "w") as f:
        json.dump(secret, f)
    # Lock the file down to owner-read/write only where the OS supports it.
    try:
        os.chmod(KEY_PATH, 0o600)
    except (AttributeError, NotImplementedError):
        pass  # Windows doesn't support POSIX chmod bits; not much more to do here.

    write_wallet_config(address)
    update_env_address(address)

    print("=" * 60)
    print("New Solana wallet created.")
    print(f"ADDRESS (safe to share):  {address}")
    print(f"PRIVATE KEY saved to:     {KEY_PATH}  (NEVER share this file)")
    print(f"Address written to:       {CONFIG_PATH}  (auto-syncs everywhere)")
    print(f"Also mirrored into .env for convenience.")
    print("=" * 60)
    print("This wallet has a $0 balance until you send it something.")
    print("No restart needed — Jarvis picks the new address up on its next check.")


if __name__ == "__main__":
    main()
