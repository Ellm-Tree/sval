#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

"""Keep one page open and record what it holds every few minutes: its
total, the DOM nodes it removed but still references, and its functions and
closures. Run it on Sval and on stock Firefox of the same Gecko: growth both
show is the page's own.

    python3 -I scripts/perf/pagegrowth.py --app <Sval or Firefox> --out <dir>
        --url <page> [--play] [--state front|background|minimized]
        [--minutes 60] [--every 5] [--pref NAME=JSON]...

Each sample's about:memory report goes to --out as memory-NNN.json.gz, and
soak.log has a line per sample. docs/memory-soak.md covers reading them.
"""

import argparse
import gzip
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import soak  # noqa: E402
from soak import js  # noqa: E402


def page_bytes(path, host):
    with gzip.open(path, "rt") as f:
        reports = json.load(f)["reports"]
    total = orphans = closures = 0
    for r in reports:
        p = r["path"]
        if r["units"] != 0 or not p.startswith("explicit/window-objects/top(") or host not in p:
            continue
        total += r["amount"]
        if "/dom/orphan-nodes" in p:
            orphans += r["amount"]
        if "class(Function)" in p or "class(Call)" in p:
            closures += r["amount"]
    return total, orphans, closures


# Whether the page reads itself as hidden, and its video's state when it has one.
HIDDEN = r"""
const v = document.querySelector("video");
arguments[0](JSON.stringify({ hidden: document.hidden, paused: v ? v.paused : null }));
"""


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--app", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--url", required=True)
    ap.add_argument("--play", action="store_true", help="allow the page's media and start its first video")
    ap.add_argument("--minutes", type=float, default=60)
    ap.add_argument("--every", type=float, default=5)
    # Where the page sits while it is sampled: its tab in front, another tab
    # in front of it, or its window minimized.
    ap.add_argument("--state", choices=["front", "background", "minimized"], default="front")
    soak.add_pref_argument(ap)
    args = ap.parse_args()
    out = os.path.abspath(args.out)
    app = os.path.abspath(args.app)
    os.makedirs(out, exist_ok=True)
    soak.install(app)
    s = soak.Session(app, out, args.pref)
    host = re.sub(r"^https?://", "", args.url).split("/")[0]
    s.start()
    try:
        if args.play and not s.firefox:
            js(s.ch, soak.ALLOW_MEDIA % json.dumps([host]))
        handle = js(s.ch, "arguments[0](gBrowser.selectedBrowser.browserId)")
        s.navigate(handle, args.url)
        playing = s.play(handle) if args.play else None
        soak.log(out, f"{'firefox' if s.firefox else 'sval'} {s.binary}: {args.url} {playing or ''}")
        if args.state == "background":
            js(s.ch, soak.NEW_TAB)
        elif args.state == "minimized":
            js(s.ch, soak.WINDOW % json.dumps("minimized"))
        started = time.time()
        n = 0
        while True:
            minutes = (time.time() - started) / 60
            path = os.path.join(out, f"memory-{n:03d}.json.gz")
            soak.proc_info_safe(s.ch, path, False)
            total, orphans, closures = page_bytes(path, host)
            where = s.content(handle, HIDDEN, 10000)
            soak.log(
                out,
                f"{minutes:5.1f} min: page {total / 2**20:6.1f} MB, removed nodes {orphans / 2**20:5.1f}, "
                f"functions+closures {closures / 2**20:5.1f}, {where}",
            )
            n += 1
            if minutes >= args.minutes:
                break
            time.sleep(max(0, started + n * args.every * 60 - time.time()))
    finally:
        s.stop()


if __name__ == "__main__":
    main()
