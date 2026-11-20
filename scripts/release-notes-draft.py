#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Lists what changed since the last release, for whoever writes the next
# release's notes (docs/writing-style.md, "Release notes"): every pull request
# merged into main since the newest v* tag, grouped by its title's type
# (CONTRIBUTING.md, "Commit messages") and marking those that changed only
# what no user sees, then the change to docs/features.md. It writes nothing;
# a person writes the notes.
#
# Usage: scripts/release-notes-draft.py [<since-tag>]
import importlib.util
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
os.chdir(os.path.join(HERE, ".."))

spec = importlib.util.spec_from_file_location(
    "check_commit_msg", os.path.join(HERE, "check-commit-msg.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

# Tests, CI, and the scripts and docs only developers read. docs/features.md
# and the website are what a user reads.
INTERNAL = re.compile(
    r"(^|/)tests?/|^\.forgejo/|^ci/|^scripts/|^CLAUDE\.md$|^README\.md$"
    r"|^docs/(?!features\.md$)|^REUSE\.toml$|^renovate\.json$"
)
MERGE = re.compile(r"^Merge pull request '(.*)' \((#\d+)\)")


def git(*args):
    return subprocess.run(["git", *args], check=True, capture_output=True, text=True).stdout


def main():
    git("fetch", "-q", "--tags", "origin", "main")
    since = sys.argv[1] if len(sys.argv) > 1 else git(
        "describe", "--tags", "--abbrev=0", "--match", "v*", "origin/main").strip()
    print(f"Pull requests merged into main since {since}. Those marked * change")
    print("something a user can see; the rest change only tests, CI or internal docs.\n")
    groups = {kind: [] for kind in (*check.TYPES, "untyped")}
    log = git("log", "--first-parent", "--merges", "--format=%H %s", f"{since}..origin/main")
    for line in log.splitlines():
        sha, subject = line.split(" ", 1)
        match = MERGE.match(subject)
        if not match:
            continue
        files = git("diff", "--name-only", f"{sha}^1", sha).split()
        visible = any(not INTERNAL.search(f) for f in files)
        typed = check.TYPED.match(match[1])
        kind = typed["type"] if typed and typed["type"] in check.TYPES else "untyped"
        groups[kind].append(f"{'*' if visible else ' '} {match[2]} {match[1]}")
    for kind, entries in groups.items():
        if entries:
            print(f"{kind}:")
            print("\n".join(entries) + "\n")
    print(f"\ndocs/features.md since {since}:")
    for line in git("diff", f"{since}..origin/main", "--", "docs/features.md").splitlines():
        if line[:1] in "+-" and line[:3] not in ("+++", "---"):
            print(line)


main()
