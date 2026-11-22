#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Check the rhythm of user-facing prose against docs/writing-style.md's
"Let sentences flow". Vale scores one sentence at a time, and these faults
live between sentences: a run of clipped sentences, a paragraph whose
sentences all share one length, and a paragraph stopped by a comma or a
period every few words.

Usage: check-rhythm.py [--base <commit>] <file or folder>...
Reads .md and .mdx files. Headings, tables, code, front matter, MDX tags
and numbered steps are skipped: a step is one action by design.

With --base, only paragraphs that differ from where the branch forked from
that commit are checked, so an edit answers for the text it touches. A file git doesn't track, like a
draft in .scratch/, is checked whole."""

import re
import statistics
import subprocess
import sys
from pathlib import Path

# Three sentences in a row under SHORT words reads as clipped, and so does
# a paragraph of at least three sentences that average under MEAN words.
SHORT = 8
RUN = 3
MEAN = 12
# A paragraph of at least FLAT_MIN sentences whose lengths spread less
# than FLAT_SPREAD words (standard deviation) reads as one beat repeated.
FLAT_MIN = 4
FLAT_SPREAD = 2.5
# Commas and sentence ends per 100 words, in a paragraph of at least
# DENSE_MIN words.
DENSE_MIN = 25
DENSE_MAX = 16

WORD = re.compile(r"[A-Za-z0-9][\w'’.-]*")
# A sentence ends at . ! or ? before a space and a capital, a quote, a
# bracket or a markdown mark. Abbreviations Sval's docs use are joined first.
ABBREV = re.compile(r"\b(e\.g|i\.e|etc|vs|Mr|Ms|Dr)\.")
END = re.compile(r"(?<=[.!?])[\"”’)]?\s+(?=[\"“*_\[(`A-Z0-9])")


def paragraphs(text):
    """Yield (line number, prose) for each paragraph or bullet."""
    lines = text.splitlines()
    i = 0
    if lines and lines[0].strip() == "---":
        i = 1
        while i < len(lines) and lines[i].strip() != "---":
            i += 1
        i += 1
    fence = False
    block, start = [], 0

    def flush():
        if block:
            yield start, " ".join(block)
        block.clear()

    for n in range(i, len(lines)):
        raw = lines[n]
        s = raw.strip()
        if s.startswith("```") or s.startswith("~~~"):
            fence = not fence
            yield from flush()
            continue
        if fence:
            continue
        skip = (
            not s
            or s.startswith(("#", "|", "<", "import ", "export ", "{", ">"))
            or re.match(r"\d+\.\s", s)
            or raw.startswith(("    ", "\t")) and not block
        )
        if skip:
            yield from flush()
            continue
        bullet = re.match(r"[-*+]\s+", s)
        if bullet:
            yield from flush()
            s = s[bullet.end() :]
            # A bullet's bold label is a name, not a sentence.
            s = re.sub(r"^\*\*[^*]+\*\*[:.]?\s*", "", s)
        if not block:
            start = n + 1
        block.append(s)
    yield from flush()


def clean(prose):
    prose = re.sub(r"`[^`]*`", "code", prose)
    prose = re.sub(r"!?\[([^\]]*)\]\([^)]*\)", r"\1", prose)
    prose = re.sub(r"https?://\S+", "link", prose)
    prose = re.sub(r"[*_]{1,2}", "", prose)
    return ABBREV.sub(lambda m: m.group(1), prose)


def faults(prose):
    prose = clean(prose)
    sentences = [s for s in END.split(prose) if WORD.search(s)]
    lengths = [len(WORD.findall(s)) for s in sentences]
    found = []
    run = 0
    for length in lengths:
        run = run + 1 if length < SHORT else 0
        if run == RUN:
            found.append(
                f"{RUN} sentences in a row under {SHORT} words. Join them into "
                "one that flows."
            )
    if len(lengths) >= RUN and statistics.mean(lengths) < MEAN:
        found.append(
            f"{len(lengths)} sentences averaging "
            f"{statistics.mean(lengths):.0f} words. Join the ones that "
            "belong together, and cut the ones that say what the reader "
            "can see."
        )
    if len(lengths) >= FLAT_MIN and statistics.pstdev(lengths) < FLAT_SPREAD:
        found.append(
            f"{len(lengths)} sentences of nearly one length. Vary them: join "
            "two, or let one run longer."
        )
    words = sum(lengths)
    if words >= DENSE_MIN:
        stops = prose.count(",") + len(sentences)
        rate = 100 * stops / words
        if rate > DENSE_MAX:
            found.append(
                f"{rate:.0f} commas and periods per 100 words. Cut the pauses "
                "that do no work."
            )
    return found


def files(args):
    for arg in args:
        p = Path(arg)
        if p.is_dir():
            yield from sorted(q for q in p.rglob("*") if q.suffix in (".md", ".mdx"))
        elif p.suffix in (".md", ".mdx"):
            yield p
        elif not p.exists():
            print(f"check-rhythm: no such file or folder: {arg}", file=sys.stderr)
            sys.exit(1)


def changed_lines(path, base):
    """The line numbers of path that differ from base, or None for all."""
    if base is None:
        return None
    tracked = subprocess.run(
        ["git", "-C", str(path.parent), "ls-files", "--error-unmatch", path.name],
        capture_output=True,
    )
    if tracked.returncode:
        return None
    diff = subprocess.run(
        ["git", "-C", str(path.parent), "diff", "-U0", base, "--", path.name],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = set()
    for m in re.finditer(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", diff.stdout, re.M):
        start, count = int(m.group(1)), int(m.group(2) or 1)
        lines.update(range(start, start + count))
    return lines


def main(args):
    base = None
    if args[:1] == ["--base"]:
        # Against the merge base, so text main gained since the branch
        # forked isn't counted as this branch's edit.
        base = subprocess.run(
            ["git", "merge-base", args[1], "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
        args = args[2:]
    count = 0
    for path in files(args):
        text = path.read_text(encoding="utf-8")
        touched = changed_lines(path, base)
        rows = text.splitlines()
        for line, prose in paragraphs(text):
            # A paragraph spans from its first line to the next blank one.
            end = line
            while end < len(rows) and rows[end].strip():
                end += 1
            if touched is not None and not touched.intersection(range(line, end + 1)):
                continue
            for message in faults(prose):
                print(f"{path}:{line}: {message}")
                count += 1
    return 1 if count else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
