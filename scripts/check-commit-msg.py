#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Fails on a commit subject or pull request title CONTRIBUTING.md's "Commit
messages" section rules out.

A subject is an optional area prefix ("ci:", "Settings:"), then an imperative
verb from VERBS, at most MAX_LENGTH characters, with no trailing period and no
em dash. A subject that opens on a noun ("The installer keeps...", "Pins are
left out...") fails on its first word. Whether the body says why is for review.

    python3 scripts/check-commit-msg.py                 # the branch's commits
    python3 scripts/check-commit-msg.py --base <rev>    # against another base
    python3 scripts/check-commit-msg.py --title <text>  # a pull request title
    python3 scripts/check-commit-msg.py --file <path>   # a commit-msg hook's file

The branch's commits are the ones after its merge base with origin/main, merges
left out, so history before a branch is never read. .githooks/commit-msg runs
the --file form, CI's `checks` job the other two, and scripts/lint.sh the first.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

MAX_LENGTH = 72

# Git writes these subjects itself, or a tool does from another subject.
EXEMPT = re.compile(r"^(Merge |Revert \"|fixup! |squash! |amend! )")

# The work-in-progress prefix on a pull request title, which builds nothing
# and which a title drops when the work is done.
WIP = re.compile(r"^WIP:\s*")

# One token naming the area a change is in: a component, a file or a tool.
AREA = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/+-]*: ")

# Imperative verbs a subject may open with. A real verb the list lacks goes in
# it; a noun or a third-person form ("Keeps", "Pins") never does.
VERBS = frozenset("""
    accept add adjust align allow apply archive assert avoid await backport bound bring
    build bump cache call cancel cap capitalize capture carry catch change check clean
    clear clip close collapse combine compile configure convert copy correct
    count cover create cut decide declare default defer delete deny describe
    detect disable discard document drag draw drop dedupe enable end enforce
    ensure escape exclude expand explain expose extend extract fail fetch file
    fill filter find finish fix flag focus fold follow force format free gate
    generate give group guard handle hide hold ignore implement import improve
    include inline install isolate keep kill label launch let lift limit link
    lint list load localise lock log lower make map mark match measure merge
    migrate mirror move mute name narrow note number offer omit open order
    package parse pass patch pause pick pin place point poll port prefer
    prepare preserve prevent print profile prune publish pull push put raise
    read rebase rebuild record recover reduce refactor refresh refuse register
    reject release reload remove rename render reorder repair replace report
    request require rerun re-run reroute reset resize resolve restore restrict restyle
    retry return reuse revert review rewrite route run save say scale scope scroll
    scrub seal select send separate serve set share shorten show shrink sign
    simplify size skip sort speed split stage start stop store stream strip
    style submit support suppress switch sync tag teach test throttle tidy
    time toggle track translate trim try turn undo unify unpin unset update
    upgrade use validate verify wait warn watch widen wire wrap write
""".split())


def problems(subject):
    """The rules subject breaks, as messages; empty when it passes."""
    subject = WIP.sub("", subject.strip())
    if not subject:
        return ["the subject is empty"]
    if EXEMPT.match(subject):
        return []
    found = []
    if len(subject) > MAX_LENGTH:
        found.append(f"it is {len(subject)} characters; the limit is {MAX_LENGTH}")
    if subject.endswith("."):
        found.append("it ends with a period")
    if "—" in subject:
        found.append("it has an em dash")
    rest = AREA.sub("", subject, count=1)
    word = re.split(r"[\s,:;]", rest, maxsplit=1)[0]
    if word.lower() not in VERBS:
        found.append(
            f"it opens on {word!r}, which is not an imperative verb in VERBS; "
            "name the change (\"Fix\", \"Add\", \"Remove\"), never the state it leaves"
        )
    return found


def subject_of_file(path):
    """The first line git keeps from a commit message file."""
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("#"):
            continue
        if line.strip():
            return line
    return ""


def branch_commits(base):
    """(sha, subject) for each non-merge commit after the merge base with base."""
    merge_base = subprocess.run(
        ["git", "-C", str(ROOT), "merge-base", base, "HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    out = subprocess.run(
        ["git", "-C", str(ROOT), "log", "--no-merges", "--format=%h%x00%s",
         f"{merge_base}..HEAD"],
        capture_output=True, text=True, check=True,
    ).stdout
    return [tuple(line.split("\0", 1)) for line in out.splitlines() if line]


def report(label, subject):
    found = problems(subject)
    for problem in found:
        print(f"{label}: {subject!r}: {problem}", file=sys.stderr)
    return bool(found)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--base", default="origin/main")
    parser.add_argument("--title")
    parser.add_argument("--file")
    args = parser.parse_args()

    failed = False
    if args.file:
        failed = report("commit message", subject_of_file(args.file))
    elif args.title is not None:
        failed = report("pull request title", args.title)
    else:
        for sha, subject in branch_commits(args.base):
            failed |= report(f"commit {sha}", subject)
    if failed:
        print("See CONTRIBUTING.md, \"Commit messages\".", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
