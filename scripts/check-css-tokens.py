#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Check that every custom property Sval's CSS sets for Firefox is one Firefox reads.

    python3 scripts/check-css-tokens.py

Sval restyles Firefox by giving Firefox's own custom properties Sval's values
(`--toolbarbutton-border-radius`, `--panel-border-radius`). Nothing fails when
Mozilla renames one: the declaration stays, and from then on it does nothing.
So a custom property a sheet under chrome/ sets must be read somewhere, as
`var(--name)` or by a script, in Firefox's front end in build/firefox or in
chrome/ itself. A name that starts with `--sval-` is Sval's own and is left
to its author.

A script that builds a name, as `var(--tab-group-color-${color})` does, reads
every name with that beginning.

scripts/lint.sh runs it, and scripts/check-css-tokens-test.py tests it.
"""

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SVAL_DIR = pathlib.PurePosixPath("browser/components/sval")

# Where Firefox's front end draws from: its sheets, and the markup and scripts
# that read a custom property themselves.
FIREFOX_DIRS = [
    "browser/base",
    "browser/components",
    "browser/extensions",
    "browser/themes",
    "devtools/client",
    "devtools/shared",
    "layout/style/res",
    "toolkit/components",
    "toolkit/content",
    "toolkit/mozapps",
    "toolkit/themes",
]
READ_FROM = {".css", ".js", ".mjs", ".jsx", ".xhtml", ".html", ".svg"}

SET_RE = re.compile(r"(?m)^\s*(--[\w-]+)\s*:")
VAR_RE = re.compile(r"var\(\s*(--[\w-]+)")
SCRIPT_RE = re.compile(r"""(?:getPropertyValue|setProperty|removeProperty)\(\s*["'`](--[\w-]+)""")
BUILT_RE = re.compile(r"(--[\w-]*-)\$\{")


def strip_comments(css):
    return re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group().count("\n"), css, flags=re.S)


def names_read(directory, skip=lambda path: False):
    """The custom properties read under `directory`, and the beginnings of built names."""
    names, beginnings = set(), set()
    for path in directory.rglob("*"):
        if path.suffix not in READ_FROM or not path.is_file():
            continue
        if {"node_modules", "test", "tests"} & set(path.parts) or skip(path):
            continue
        text = path.read_text(errors="ignore")
        names.update(VAR_RE.findall(text))
        names.update(SCRIPT_RE.findall(text))
        beginnings.update(BUILT_RE.findall(text))
    return names, beginnings


def find_problems(root):
    """Returns (css file, line, name) for each property set that nothing reads."""
    root = pathlib.Path(root)
    firefox = root / "build/firefox"

    def is_svals(path):
        # sync-files.sh copies chrome/ into the tree, so a file there with a
        # twin under chrome/ is Sval's, and so is all of Sval's own directory,
        # where a file removed from chrome/ can linger.
        relative = path.relative_to(firefox)
        return (root / "chrome" / relative).exists() or relative.parts[:3] == SVAL_DIR.parts

    names, beginnings = names_read(root / "chrome")
    for directory in FIREFOX_DIRS:
        if (firefox / directory).is_dir():
            found, built = names_read(firefox / directory, is_svals)
            names |= found
            beginnings |= built

    problems = []
    for path in sorted((root / "chrome").rglob("*.css")):
        if "/test/" in path.as_posix():
            continue
        css = strip_comments(path.read_text())
        for match in SET_RE.finditer(css):
            name = match.group(1)
            if name.startswith("--sval-") or name in names:
                continue
            if any(name.startswith(beginning) for beginning in beginnings):
                continue
            line = css.count("\n", 0, match.start()) + 1
            problems.append((path.relative_to(root), line, name))
    return problems


def main():
    if not (REPO / "build/firefox/browser/themes").is_dir():
        print("error: no build tree at build/firefox to read Firefox's custom properties from", file=sys.stderr)
        return 1
    problems = find_problems(REPO)
    for path, line, name in problems:
        print(f"{path}:{line}: {name} is set, and nothing in Firefox or Sval reads it")
    if problems:
        print(
            "\nA custom property Firefox renamed keeps its old declaration, which does"
            "\nnothing. Set the name Firefox reads, or remove the declaration.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
