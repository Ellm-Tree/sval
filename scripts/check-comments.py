#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Fails on the comment patterns CONTRIBUTING.md's "Comments" section bans outright.

Only lines a branch adds or changes are read, against its merge base with
origin/main, so a file is held to the rule as it is touched. A renamed file's
added lines count, and so do uncommitted changes to tracked files, so a local
run checks what is about to be committed once new files are added to git. A file
under Mozilla's MPL header is Mozilla's and is skipped.

The patterns are the ones a regular expression can decide without judgement:
an em dash, a Sval issue or pull request number, a line number, words that only
mean something against a diff, and intensifiers. Whether a comment earns its
line at all is for review.

    python3 scripts/check-comments.py [--base <rev>]

CI's `checks` job runs it before anything is built, and scripts/lint.sh runs it.
"""

import argparse
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Paths whose text is not Sval's comments: Mozilla's code in patches, prose,
# data, and fixtures copied from other browsers.
SKIP = re.compile(
    r"^(patches|docs|LICENSES|build)/|\.(md|json|txt|svg|png|lock|patch)$|/test/xpcshell/data/"
)

SLASH = {".js", ".mjs", ".rs", ".c", ".cc", ".cpp", ".h", ".hh", ".mm", ".idl",
         ".webidl", ".css", ".swift", ".kt", ".java", ".ts"}
HASH = {".py", ".sh", ".yml", ".yaml", ".toml", ".ftl", ".properties", ".cfg",
        ".ini", ".conf"}
ANGLE = {".xhtml", ".html", ".xml", ".inc.xhtml"}
HASH_NAMES = {"mozconfig", "Dockerfile", "Makefile"}

RULES = [
    ("em dash", re.compile("\u2014")),
    ("issue or PR number",
     re.compile(r"(?:^|[\s(\[])(?:[Ss]val/[\w.-]+)?#\d+\b(?![\w-])"
                r"|\b(?:issue|PR|pull request)\s+#?\d+\b", re.I)),
    ("line number",
     re.compile(r"\blines?\s+\d+\b|\b[\w./-]+\.[A-Za-z]\w*:\d+\b|\bL\d{2,}\b")),
    ("words that need a diff",
     re.compile(r"\bthis fix\b|\b(?:before|after) the fix\b|\btask \d+\b|\bthe brief\b", re.I)),
    ("intensifier",
     re.compile(r"\b(?:critically|crucially|importantly|genuinely|actually"
                r"|load[- ]bearing|belt[- ]and[- ](?:braces|suspenders))\b", re.I)),
]


def style(path):
    p = Path(path)
    if p.name in HASH_NAMES or p.name.startswith("mozconfig"):
        return "hash"
    suffix = p.suffix
    if suffix in SLASH:
        return "slash"
    if suffix in HASH:
        return "hash"
    if suffix in ANGLE:
        return "angle"
    if not suffix and p.parent.name == "scripts":
        return "hash"
    return None


def comment_of(kind, line):
    """The comment text on a source line, or None when it carries none."""
    s = line.strip()
    if kind == "slash":
        if s.startswith(("//", "/*", "*")):
            return s
        cut = line.find(" // ")
        return line[cut:] if cut >= 0 else None
    if kind == "hash":
        if s.startswith("#!"):
            return None
        if s.startswith("#"):
            return s
        cut = line.find(" # ")
        return line[cut:] if cut >= 0 else None
    if kind == "angle":
        cut = line.find("<!--")
        return line[cut:] if cut >= 0 else None
    return None


def findings(path, line):
    """The rules `line` of `path` breaks, by name."""
    kind = style(path)
    if kind is None or SKIP.search(path):
        return []
    text = comment_of(kind, line)
    if text is None:
        return []
    found = [name for name, rule in RULES if rule.search(text)]
    if path.endswith(".css"):
        # `#333` in a stylesheet's comment is a colour.
        found = [name for name in found if name != "issue or PR number"]
    return found


def is_mozillas(path):
    try:
        head = (ROOT / path).read_text(errors="replace")[:600]
    except OSError:
        return False
    return "Mozilla Public" in head or "mozilla.org/MPL" in head


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], check=True,
                          capture_output=True, text=True).stdout


def added_lines(base):
    """(path, line number, text) for every line added since `base`."""
    diff = git("diff", "-U0", "--no-color", "--no-ext-diff", "--diff-filter=AMR", base)
    path, number = None, 0
    for raw in diff.splitlines():
        if raw.startswith("+++ "):
            path = raw[6:] if raw.startswith("+++ b/") else None
        elif raw.startswith("@@"):
            number = int(re.search(r"\+(\d+)", raw).group(1))
        elif raw.startswith("+") and path:
            yield path, number, raw[1:]
            number += 1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", help="compare with this commit instead of the merge base with origin/main")
    args = parser.parse_args()
    base = args.base or git("merge-base", "HEAD", "origin/main").strip()

    failed = 0
    mozillas = {}
    for path, number, text in added_lines(base):
        broken = findings(path, text)
        if not broken:
            continue
        if mozillas.setdefault(path, is_mozillas(path)):
            continue
        for name in broken:
            print(f"{path}:{number}: {name}: {text.strip()}")
            failed += 1
    if failed:
        print(f"error: {failed} comment line(s) above break CONTRIBUTING.md's \"Comments\" rules",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
