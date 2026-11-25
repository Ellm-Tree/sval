#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Runs a command while it holds one of the checkout's build slots.

    build-slot.py heavy|light <cmd...>
    build-slot.py --status

Every worktree shares one machine. A Gecko compile takes every core, so one
runs at a time: the "heavy" slot. A worktree setup or an artifact build mostly
reads and writes the disk, so a few run at once: the "light" slots, three
unless SVAL_BUILD_SLOTS says otherwise. scripts/build.sh and
scripts/build-worktree.sh take their slot themselves.

A slot is an fcntl lock on a file in the common git directory, held by this
process, so every worktree of the checkout shares the slots. The kernel drops
the lock when this process exits, however it exits. The command runs without
the lock's descriptor, so a daemon it leaves running cannot hold the slot.
SVAL_BUILD_SLOT_HELD names the kinds a process already holds, so a script run
by another that holds a slot of its kind runs at once.
"""

import fcntl
import os
import signal
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def slot_dir():
    common = subprocess.run(
        ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
        cwd=HERE,
        capture_output=True,
        text=True,
        check=True,
    ).stdout.strip()
    path = Path(common) / "sval-build-slots"
    path.mkdir(exist_ok=True)
    return path


def slot_names(kind):
    if kind == "heavy":
        return ["heavy"]
    count = int(os.environ.get("SVAL_BUILD_SLOTS", "3"))
    return [f"light-{i}" for i in range(1, count + 1)]


def try_lock(path):
    f = open(path, "a+")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        f.close()
        return None
    return f


def status():
    slots = sorted(slot_dir().glob("*.lock"))
    held = False
    for path in slots:
        f = try_lock(path)
        if f is not None:
            f.close()
            continue
        held = True
        print(f"{path.stem}: {path.read_text().strip()}")
    if not held:
        print("free")


def acquire(kind, cmd):
    directory = slot_dir()
    waited = False
    while True:
        for name in slot_names(kind):
            f = try_lock(directory / f"{name}.lock")
            if f is not None:
                f.seek(0)
                f.truncate()
                since = time.strftime("%H:%M")
                f.write(f"pid {os.getpid()} since {since} in {os.getcwd()}: {' '.join(cmd)}\n")
                f.flush()
                return f
        if not waited:
            print(
                f"==> Waiting for a {kind} build slot; "
                f"{HERE / 'build-slot.py'} --status names the holders",
                file=sys.stderr,
            )
            waited = True
        time.sleep(2)


def run(kind, cmd):
    held = os.environ.get("SVAL_BUILD_SLOT_HELD", "").split()
    if kind in held:
        os.execvp(cmd[0], cmd)
    lock = acquire(kind, cmd)
    env = dict(os.environ, SVAL_BUILD_SLOT_HELD=" ".join(held + [kind]))
    proc = subprocess.Popen(cmd, env=env)
    # A terminal's Ctrl-C reaches the whole process group, the command
    # included, so this process only waits for the command to finish. A signal
    # sent to this process alone is passed on.
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    for sig in (signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, lambda s, _frame: proc.send_signal(s))
    code = proc.wait()
    lock.close()
    return 128 - code if code < 0 else code


def main(argv):
    if argv[1:] == ["--status"]:
        status()
        return 0
    if len(argv) < 3 or argv[1] not in ("heavy", "light"):
        print(__doc__.strip().splitlines()[2], file=sys.stderr)
        return 2
    return run(argv[1], argv[2:])


if __name__ == "__main__":
    sys.exit(main(sys.argv))
