# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Summarise a Gecko profile, as scripts/read-profile.sh describes.

The profile is the one `nsIProfiler.getProfileDataAsGzippedArrayBuffer`
writes: the parent's threads and libraries at the top, each child process's
under `processes`, every thread with its own string table. A native frame's
location is its address as `0x...`, which falls inside one of its process's
`libs`; Breakpad's `.sym` files give the function at that address relative to
the library's start.
"""

import argparse
import bisect
import collections
import gzip
import json
import os
import re
import sys

ADDRESS = re.compile(r"^0x[0-9a-f]+$")

# Markers worth seeing whatever thread they are on: the GPU process taking a
# video off its overlay ("Video swapchain present is slow", "DisableOverlay"),
# a device reset or hang, and anything Gecko itself calls slow or janky.
NOTABLE = re.compile(
    r"overlay|swapchain|device ?reset|hung|slow|jank|gpu|composit|vsync",
    re.IGNORECASE,
)


def load(path):
    with open(path, "rb") as f:
        head = f.read(2)
    opener = gzip.open if head == b"\x1f\x8b" else open
    with opener(path, "rt", encoding="utf-8") as f:
        return json.load(f)


def processes(profile):
    """Each process's profile, the parent first."""
    yield profile
    for child in profile.get("processes", []):
        yield from processes(child)


class Symbols:
    """Function names from Breakpad `.sym` files, read once per library."""

    def __init__(self, root):
        self.root = root
        self.tables = {}

    def table(self, lib):
        key = (lib.get("debugName"), lib.get("breakpadId"))
        if key not in self.tables:
            self.tables[key] = self.read(*key)
        return self.tables[key]

    def read(self, debug_name, debug_id):
        if not self.root or not debug_name or not debug_id:
            return None
        stem = debug_name[:-4] if debug_name.lower().endswith(".pdb") else debug_name
        path = os.path.join(self.root, debug_name, debug_id, stem + ".sym")
        if not os.path.isfile(path):
            return None
        funcs = {}
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("FUNC "):
                    parts = line.rstrip("\n").split(" ", 4)
                    if parts[1] == "m":
                        parts = line.rstrip("\n").split(" ", 5)[1:]
                    funcs[int(parts[1], 16)] = parts[4]
                elif line.startswith("PUBLIC "):
                    parts = line.rstrip("\n").split(" ", 3)
                    if parts[1] == "m":
                        parts = line.rstrip("\n").split(" ", 4)[1:]
                    funcs.setdefault(int(parts[1], 16), parts[3])
        starts = sorted(funcs)
        return starts, [funcs[s] for s in starts]

    def name(self, libs, address):
        for lib in libs:
            if lib["start"] <= address < lib["end"]:
                relative = address - lib["start"] + lib.get("offset", 0)
                found = self.table(lib)
                if found:
                    starts, names = found
                    i = bisect.bisect_right(starts, relative) - 1
                    if i >= 0:
                        return names[i]
                return f"{lib.get('debugName')}+0x{relative:x}"
        return hex(address)


def column(table, name):
    return table["schema"][name]


def thread_summary(thread, libs, symbols, functions):
    strings = thread["stringTable"]
    samples = thread["samples"]
    stack_col = column(samples, "stack")
    cpu_col = samples["schema"].get("threadCPUDelta")
    frame_of = column(thread["stackTable"], "frame")
    location = column(thread["frameTable"], "location")
    stacks = thread["stackTable"]["data"]
    frames = thread["frameTable"]["data"]

    names = {}

    def frame_name(index):
        if index not in names:
            text = strings[frames[index][location]]
            names[index] = (
                symbols.name(libs, int(text, 16)) if ADDRESS.match(text) else text
            )
        return names[index]

    count = 0
    cpu = 0.0
    self_time = collections.Counter()
    for row in samples["data"]:
        stack = row[stack_col]
        if stack is None:
            continue
        weight = row[cpu_col] if cpu_col is not None and len(row) > cpu_col else None
        count += 1
        cpu += weight or 0
        # A sample's CPU delta weighs it, so a thread waiting in the kernel
        # counts for nothing. Without CPU deltas every sample weighs one.
        self_time[frame_name(stacks[stack][frame_of])] += (
            weight or 0 if cpu_col is not None else 1
        )
    return count, cpu, self_time.most_common(functions)


def markers(thread):
    strings = thread["stringTable"]
    schema = thread["markers"]["schema"]
    names = collections.Counter()
    notable = collections.Counter()
    for row in thread["markers"]["data"]:
        name = strings[row[schema["name"]]]
        names[name] += 1
        data = row[schema["data"]] if len(row) > schema["data"] else None
        text = data.get("name", "") if isinstance(data, dict) else ""
        if NOTABLE.search(name) or NOTABLE.search(text):
            notable[f"{name}: {text}" if text else name] += 1
    return names, notable


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("profile")
    parser.add_argument("--build-id", action="store_true")
    parser.add_argument("--symbols", default="")
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--functions", type=int, default=15)
    args = parser.parse_args()

    profile = load(args.profile)
    meta = profile["meta"]
    if args.build_id:
        print(meta.get("appBuildID", ""))
        return

    symbols = Symbols(args.symbols)
    units = meta.get("sampleUnits", {}).get("threadCPUDelta", "")
    per_second = {"µs": 1e6, "ns": 1e9}.get(units)
    print(
        f"Build {meta.get('appBuildID', 'unknown')} on {meta.get('oscpu', '?')}, "
        f"interval {meta.get('interval')} ms, CPU in {units or 'nothing'}"
    )
    if not args.symbols:
        print("No symbols: native frames are shown as library+offset")

    rows = []
    for proc in processes(profile):
        for thread in proc["threads"]:
            count, cpu, top = thread_summary(
                thread, proc["libs"], symbols, args.functions
            )
            times = [r[column(thread["samples"], "time")] for r in thread["samples"]["data"]]
            span = (max(times) - min(times)) / 1000 if len(times) > 1 else 0
            rows.append((cpu or count, thread, proc, count, cpu, span, top))
    rows.sort(key=lambda r: r[0], reverse=True)

    print("\nBusiest threads")
    for _, thread, _, count, cpu, span, _ in rows[: args.threads * 2]:
        share = (
            f"{100 * cpu / per_second / span:5.1f}% of a core"
            if per_second and span
            else f"{cpu:.0f} {units}"
        )
        print(
            f"  {thread.get('processType', '?'):8} pid {thread.get('pid')} "
            f"{thread['name'][:28]:28} {count:6} samples  {share}  over {span:.1f} s"
        )

    for _, thread, _, count, cpu, _, top in rows[: args.threads]:
        total = sum(n for _, n in top) and (cpu or count)
        print(f"\n{thread.get('processType', '?')} pid {thread.get('pid')} {thread['name']}: self time")
        for name, n in top:
            print(f"  {100 * n / max(total, 1):5.1f}%  {name[:150]}")

    print("\nNotable markers")
    any_notable = False
    for proc in processes(profile):
        for thread in proc["threads"]:
            names, notable = markers(thread)
            for text, n in notable.most_common():
                any_notable = True
                print(f"  {thread.get('processType', '?')} {thread['name']}: {n} x {text[:150]}")
    if not any_notable:
        print("  none")
    return 0


if __name__ == "__main__":
    sys.exit(main())
