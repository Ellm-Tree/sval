#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Waits until a booted simulator's PosterBoard has drawn its wallpapers.

    wait-for-wallpapers.py UDID SINCE

SINCE is when the simulator booted, as `date '+%Y-%m-%d %H:%M:%S'` prints
it. After every boot, PosterBoard draws a snapshot of each wallpaper in the
lock screen's gallery, several at once. On a Mac runner's virtual GPU that
holds backboardd, which every UI test query passes through, for minutes. A
run ends with PosterBoard's "tearing down snapshot manager assertions", and
a second run can start within a second of the first ending, so the wait ends
once the last run has stayed ended for QUIET seconds.
"""

import json
import subprocess
import sys
import time
from datetime import datetime

QUIET = 30
POLL = 10
LIMIT = 15 * 60
PREDICATE = 'process == "PosterBoard" AND eventMessage CONTAINS "snapshot manager assertions"'


def last_event(udid, since):
    out = subprocess.run(
        ["xcrun", "simctl", "spawn", udid, "log", "show", "--start", since,
         "--style", "json", "--predicate", PREDICATE],
        check=True, capture_output=True, text=True).stdout
    events = json.loads(out or "[]")
    if not events:
        return None
    event = events[-1]
    at = datetime.strptime(event["timestamp"], "%Y-%m-%d %H:%M:%S.%f%z")
    return event["eventMessage"], at


def main():
    udid, since = sys.argv[1], sys.argv[2]
    started = time.monotonic()
    while time.monotonic() - started < LIMIT:
        event = last_event(udid, since)
        if event is None:
            print("PosterBoard has not started its snapshots", flush=True)
        else:
            message, at = event
            age = (datetime.now(at.tzinfo) - at).total_seconds()
            if message.startswith("tearing down") and age >= QUIET:
                print(f"PosterBoard finished its snapshots {age:.0f} s ago", flush=True)
                return 0
            state = "finished" if message.startswith("tearing down") else "is drawing"
            print(f"PosterBoard {state} its snapshots, {age:.0f} s ago", flush=True)
        time.sleep(POLL)
    print(f"::warning::PosterBoard's snapshots did not finish in {LIMIT // 60} minutes", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
