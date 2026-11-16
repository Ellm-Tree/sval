#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Fail when a docs page names a control that no UI string in Sval holds.

docs/writing-style.md has a step bold a control's name as Sval shows it, and
write a setting's place as a path, Settings › Links. A page names a control
in two ways, then: a bold span in a numbered step, and each part of a path
that starts at Settings. Each must appear in Sval's UI strings, so a change
that renames a control fails here until its docs page follows (decision
2023).

Sval writes most of its labels in its own JS and HTML, and keeps Firefox's
elsewhere, so the strings searched are every file under chrome/, branding/
and patches/, and Firefox's en-US strings in the build tree. A label passes
if its text appears in any of them with whitespace collapsed, which HTML's
line wrapping needs.

Usage: check-ui-labels.py [docs-dir]
SVAL_FIREFOX_TREE names another checkout's build/firefox to read Firefox's
strings from.
"""

import os
import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
DOCS = REPO / "website/src/content/docs"
FIREFOX = pathlib.Path(os.environ.get("SVAL_FIREFOX_TREE", REPO / "build/firefox"))
FIREFOX_STRINGS = ["browser/locales/en-US", "toolkit/locales/en-US", "browser/branding"]
SOURCE_SUFFIXES = {".js", ".mjs", ".html", ".xhtml", ".ftl", ".patch", ".dtd", ".properties"}

STEP_RE = re.compile(r"^\s*\d+\.\s")
BOLD_RE = re.compile(r"\*\*([^*]+)\*\*")
PATH_RE = re.compile(r"Settings(?:\s*›\s*[^›,.;:\n\"\[\]()]+)+")


def normalize(text):
    return re.sub(r"\s+", " ", text.replace("’", "'")).strip()


def labels(page):
    """Yield (line number, label, is last part of a path) for each control
    the page names."""
    for number, line in enumerate(page.read_text(encoding="utf-8").splitlines(), 1):
        if STEP_RE.match(line):
            for match in BOLD_RE.finditer(line):
                yield number, normalize(match.group(1)), False
        for match in PATH_RE.finditer(line):
            parts = [normalize(p.replace("*", "")) for p in match.group(0).split("›")[1:]]
            for i, part in enumerate(parts):
                if part:
                    yield number, part, i == len(parts) - 1


def shown(label, last, strings):
    """A path's last part runs on into the sentence ("Settings › Sites
    shows ..."), so it passes when some leading run of its words is a
    label."""
    if label in strings:
        return True
    words = label.split(" ")
    return last and any(" ".join(words[:n]) in strings for n in range(len(words) - 1, 0, -1))


TERM_RE = re.compile(r"^(-[\w-]+) = (.+)$", re.MULTILINE)
PLACEABLE_RE = re.compile(r"\{ *(-[\w-]+) *\}")


def corpus():
    roots = [REPO / "chrome", REPO / "branding", REPO / "patches"]
    roots += [FIREFOX / sub for sub in FIREFOX_STRINGS]
    texts = []
    for root in roots:
        for path in root.rglob("*"):
            if path.suffix in SOURCE_SUFFIXES and "/test/" not in path.as_posix():
                texts.append(path.read_text(encoding="utf-8", errors="replace"))
    # Fluent builds a label such as "About { -brand-short-name }" from a term,
    # so each term is replaced with its value, as the UI shows it. Sval's
    # brand.ftl is read last, so its terms win over Firefox's.
    terms = {}
    for root in [FIREFOX / sub for sub in FIREFOX_STRINGS] + [REPO / "branding"]:
        for ftl in root.rglob("*.ftl"):
            terms.update(TERM_RE.findall(ftl.read_text(encoding="utf-8", errors="replace")))
    text = "\n".join(texts)
    text = PLACEABLE_RE.sub(lambda m: terms.get(m.group(1), m.group(0)), text)
    return normalize(text)


def main():
    docs = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else DOCS
    if not (FIREFOX / "browser/locales/en-US").is_dir():
        print(f"check-ui-labels: no Firefox strings at {FIREFOX}; scripts/build-worktree.sh makes the tree", file=sys.stderr)
        return 1
    strings = corpus()
    problems = 0
    for page in sorted(docs.rglob("*.md*")):
        for number, label, last in labels(page):
            if not shown(label, last, strings):
                print(f"{page.relative_to(REPO) if page.is_relative_to(REPO) else page}:{number}: "
                      f"no UI string reads \"{label}\"")
                problems += 1
    if problems:
        print(f"==> {problems} label(s) that Sval does not show; name each control as Sval does", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
