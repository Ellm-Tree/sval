#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Claude Code PostToolUse hook: check a user-facing file an agent just
edited against docs/writing-style.md, with the edited checkout's own
scripts/check-prose.sh, so the agent sees what Vale flags before anyone
reads the text. Exit status 2 hands stderr back to the agent."""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

# The files scripts/check-prose.sh checks when it is given none.
CHECKED = re.compile(r"^(website/src/content/.+\.mdx?|docs/features\.md|README\.md)$")


def main():
    try:
        path = Path(json.load(sys.stdin)["tool_input"]["file_path"]).resolve()
    except (ValueError, KeyError, TypeError):
        return 0
    if not path.is_file():
        return 0
    top = subprocess.run(
        ["git", "-C", str(path.parent), "rev-parse", "--show-toplevel"],
        capture_output=True,
        text=True,
    )
    if top.returncode:
        return 0
    root = Path(top.stdout.strip()).resolve()
    # Only this repository's own checkouts run their check-prose.sh: an
    # edit elsewhere must never run a script found next to the edited file.
    project = os.environ.get("CLAUDE_PROJECT_DIR")
    if not project:
        return 0
    trees = subprocess.run(
        ["git", "-C", project, "worktree", "list", "--porcelain"],
        capture_output=True,
        text=True,
    )
    ours = {
        Path(line[len("worktree ") :]).resolve()
        for line in trees.stdout.splitlines()
        if line.startswith("worktree ")
    }
    if root not in ours:
        return 0
    script = root / "scripts" / "check-prose.sh"
    if not script.is_file() or not CHECKED.match(path.relative_to(root).as_posix()):
        return 0
    try:
        run = subprocess.run(
            [str(script), str(path)], capture_output=True, text=True, timeout=120
        )
    except subprocess.TimeoutExpired:
        print("check-prose.sh did not finish in 120 seconds.", file=sys.stderr)
        return 2
    if run.returncode == 0:
        return 0
    print(
        f"{path.name} breaks docs/writing-style.md. Rewrite each flagged "
        "sentence by the guide; don't reword only to dodge the rule.\n"
        + run.stdout
        + run.stderr,
        file=sys.stderr,
    )
    return 2


sys.exit(main())
