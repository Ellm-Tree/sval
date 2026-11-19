#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Check that Sval and sval-mcp agree on the wire between them.

    python3 scripts/check-agent-wire.py

Sval's listener is JavaScript and `sval-mcp` is Rust, so what both must hold
the same is written twice: the handshake's version, where the port file is,
and the most bytes one frame carries. A change to one side alone still
builds, and fails only when an agent connects. Each value below is read from
both sources and must be equal.

scripts/lint.sh runs it, and scripts/check-agent-wire-test.py tests it.
"""

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SVAL = "chrome/browser/components/sval/"
SHIM = "tools/sval-mcp/src/"

# Each value: its name, then for Sval and for sval-mcp the file that states it
# and a pattern whose one group is the value as written.
SHARED = [
    (
        "the handshake's version",
        (SVAL + "SvalAgents.sys.mjs", r"^const HELLO = (\d+);$"),
        (SHIM + "bridge.rs", r"^const HELLO: u64 = (\d+);$"),
    ),
    (
        "the agents directory",
        (SVAL + "SvalAgentConst.sys.mjs", r'^export const AGENT_DIR = "([^"]+)";$'),
        (SHIM + "bridge.rs", r'^const AGENT_DIR: &str = "([^"]+)";$'),
    ),
    (
        "the port file",
        (SVAL + "SvalAgentConst.sys.mjs", r'^export const PORT_FILE = "([^"]+)";$'),
        (SHIM + "bridge.rs", r'^const PORT_FILE: &str = "([^"]+)";$'),
    ),
    (
        "the most bytes in a frame",
        (SVAL + "SvalAgentWire.sys.mjs", r"^export const MAX_FRAME_BYTES = ([\d *]+);$"),
        (SHIM + "frame.rs", r"^pub const MAX_FRAME_BYTES: usize = ([\d *]+);$"),
    ),
]


def stated(root, path, pattern):
    """The value `pattern` finds in `path`, or None when it finds none or several."""
    found = re.findall(pattern, (root / path).read_text(encoding="utf-8"), re.M)
    return found[0] if len(found) == 1 else None


def problems(root):
    """One line for each shared value the two sides state differently."""
    out = []
    for name, sval, shim in SHARED:
        ours, theirs = stated(root, *sval), stated(root, *shim)
        if ours is None or theirs is None:
            side = sval[0] if ours is None else shim[0]
            out.append(f"{side}: {name} is not stated once, as this check reads it")
        elif ours != theirs:
            out.append(f"{name}: {sval[0]} says {ours}, {shim[0]} says {theirs}")
    return out


def main():
    found = problems(REPO)
    for line in found:
        print(f"check-agent-wire: {line}", file=sys.stderr)
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main())
