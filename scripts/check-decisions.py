#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Fails on a decision record that breaks docs/decisions/README.md's rules,
and on a citation of a decision that does not exist.

A record says what is true now, so the check reads every record whole: its
title carries the filename's number, its Status line is the one form the README
gives, it has the three sections, and it holds no issue or pull request number
and none of the words that only narrate an earlier state. Whether a record's
reasons are sound is for review.

A cited decision must exist in every tracked file outside docs/decisions too,
because a record is deleted when it stops holding and its citations go with it.

    python3 scripts/check-decisions.py

CI's `checks` job runs it before anything is built, and scripts/lint.sh runs it.
"""

import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DECISIONS = "docs/decisions"

NUMBER = r"\d{4}[a-z]?"
TITLE = re.compile(rf"^# ({NUMBER})\. \S")
STATUS = re.compile(
    r"^\*\*Status:\*\* Accepted on \d{4}-\d{2}-\d{2}\."
    r"(?: Specified in `?[\w./-]+\.md`?(?:, §[\w.]+(?:(?:,| and) §[\w.]+)*)?\.)?$"
)
SECTIONS = ("## Context", "## Decision", "## Consequences")

RULES = [
    ("issue or PR number",
     re.compile(r"(?:^|[\s(\[])(?:[Ss]val/[\w.-]+)?#\d+\b(?![\w-])"
                r"|\b(?:issue|PR|pull request)\s+#?\d+\b", re.I)),
    ("history",
     re.compile(r"\bno longer\b|\bused to\b|\bonce (?:had|was|were|did|said)\b"
                r"|\bamend(?:s|ed|ment)\b|\bsupersede[sd]?\b|\bpreviously\b"
                r"|\bformerly\b|\buntil now\b|\bno migration\b"
                r"|\bbefore this (?:decision|change|record)\b", re.I)),
]

CITATION = re.compile(
    rf"\b[Dd]ecisions? ({NUMBER}(?:(?:, and |, | and | or |/){NUMBER})*)\b"
    rf"|docs/decisions/({NUMBER})-"
)


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], check=True,
                          capture_output=True, text=True).stdout


def records():
    return sorted(p for p in (ROOT / DECISIONS).glob("[0-9]*.md"))


def record_findings(name, text):
    """(line number, problem) for each rule the record `name` breaks."""
    found = []
    lines = text.splitlines()
    number = re.match(NUMBER, name).group(0)
    title = TITLE.match(lines[0]) if lines else None
    if not title or title.group(1) != number:
        found.append((1, f"title is not '# {number}. <title>'"))
    status = [i for i, line in enumerate(lines) if line.startswith("**Status:**")]
    if len(status) != 1:
        found.append((1, "needs exactly one **Status:** line"))
    else:
        start = status[0]
        end = start
        while end + 1 < len(lines) and lines[end + 1].strip():
            end += 1
        paragraph = " ".join(line.strip() for line in lines[start:end + 1])
        if not STATUS.match(paragraph):
            found.append((start + 1, "Status is not 'Accepted on <date>.' "
                                     "with an optional 'Specified in <spec>, §<n>.'"))
    headings = [line.strip() for line in lines if line.startswith("## ")]
    if headings != list(SECTIONS):
        found.append((1, f"sections are {headings}, not {list(SECTIONS)}"))
    for i, line in enumerate(lines, 1):
        for rule, pattern in RULES:
            if pattern.search(line):
                found.append((i, f"{rule}: {line.strip()}"))
    return found


def cited(text):
    """Every decision number `text` cites."""
    for match in CITATION.finditer(text):
        if match.group(1):
            yield from re.findall(NUMBER, match.group(1))
        else:
            yield match.group(2)


def main():
    failed = 0
    names = {re.match(NUMBER, p.name).group(0) for p in records()}
    for path in records():
        for line, problem in record_findings(path.name, path.read_text()):
            print(f"{DECISIONS}/{path.name}:{line}: {problem}")
            failed += 1

    for path in git("ls-files", "-z").split("\0"):
        if not path or path.startswith("build/"):
            continue
        try:
            text = (ROOT / path).read_text()
        except (OSError, UnicodeDecodeError):
            continue
        for i, line in enumerate(text.splitlines(), 1):
            for number in cited(line):
                if number not in names:
                    print(f"{path}:{i}: cites decision {number}, which does not exist")
                    failed += 1

    if failed:
        print(f"error: {failed} problem(s) above break docs/decisions/README.md's rules",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
