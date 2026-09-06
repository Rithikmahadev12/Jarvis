"""
J.A.R.V.I.S — per-account Solana wallet generator (internal helper)

Used by wallet-setup.js's ensureUserWallet() to auto-provision a wallet
for an enrolled account that hasn't linked one yet. Unlike
make_wallet.py (the deliberately-manual, run-it-yourself owner wallet
generator), this script writes nothing to disk itself — it just prints
a fresh keypair as JSON to stdout and lets the calling Node process
decide exactly where the secret key gets stored:

    {"address": "...", "secret": [64 ints]}

Usage:
    python3 make_user_wallet.py
"""

import json
from solders.keypair import Keypair


def main():
    kp = Keypair()
    print(json.dumps({
        "address": str(kp.pubkey()),
        "secret": list(bytes(kp.to_bytes())),
    }))


if __name__ == "__main__":
    main()
