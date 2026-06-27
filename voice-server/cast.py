"""
cast.py — tiny CLI bridge between Node and pychromecast.

Usage:
    python3 cast.py "<device name>" "<media url>"

Discovers Cast-capable devices on the local network (this includes
Google Home / Nest Mini speakers, not just Chromecasts — they all
speak the same Cast protocol for media playback), finds the one
whose friendly name matches (case-insensitive), and tells it to
play the given audio URL.

Exit codes:
    0  — playback started successfully
    1  — bad arguments
    2  — device not found on the network
    3  — device found but failed to start playback
"""

import sys

try:
    import pychromecast
except ImportError:
    print(
        "pychromecast isn't installed. Run: "
        "pip install pychromecast --break-system-packages",
        file=sys.stderr,
    )
    sys.exit(1)


def main():
    if len(sys.argv) < 3:
        print("Usage: cast.py <device_name> <media_url>", file=sys.stderr)
        sys.exit(1)

    device_name, media_url = sys.argv[1], sys.argv[2]

    chromecasts, browser = pychromecast.get_chromecasts(timeout=8)
    try:
        target = next(
            (c for c in chromecasts if c.name.strip().lower() == device_name.strip().lower()),
            None,
        )
        if target is None:
            available = ", ".join(c.name for c in chromecasts) or "(none found)"
            print(
                f"Couldn't find a Cast device named '{device_name}'. "
                f"Devices on the network: {available}",
                file=sys.stderr,
            )
            sys.exit(2)

        target.wait(timeout=10)
        mc = target.media_controller
        mc.play_media(media_url, "audio/wav")
        mc.block_until_active(timeout=10)
        sys.exit(0)
    except Exception as e:  # noqa: BLE001 — surface anything to stderr for Node to log
        print(f"Cast playback failed: {e}", file=sys.stderr)
        sys.exit(3)
    finally:
        pychromecast.discovery.stop_discovery(browser)


if __name__ == "__main__":
    main()
