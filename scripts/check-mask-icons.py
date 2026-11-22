#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Check that no CSS mask in chrome/ uses an icon that paints only with context paint.

    python3 scripts/check-mask-icons.py

An SVG image gets context paint only from an element that sets
`-moz-context-properties` (`SVGImageContext::MaybeStoreContextPaint`). Without
it, a bare `context-fill` fill falls back to black and a bare `context-fill`
or `context-stroke` stroke to transparent (`SVGUtils::MakeFillPatternFor`,
`SVGUtils::MakeStrokePatternFor`), so an outline icon used as a `mask` masks
everything away and draws nothing. Such an icon is drawn as a background
with `-moz-context-properties: fill` and `fill` set to its colour; an icon
with a fallback paint (`context-fill black`) is safe as a mask.

The check reads each `mask` and `mask-image` declaration in chrome/'s CSS
and maps a `chrome://browser/content/sval/` URL it names to its file through
Sval's jar.mn. A mask through `var(--sval-icon-<name>)` is read through
`sval-icons.css`, the inventory's sheet. A mask through any other `var()` is
left to its author: one custom property can hold either kind of icon on
different elements.

scripts/lint.sh runs it, and scripts/check-mask-icons-test.py tests it.
"""

import pathlib
import re
import sys

REPO = pathlib.Path(__file__).resolve().parent.parent
SVAL_DIR = pathlib.PurePosixPath("chrome/browser/components/sval")
PREFIX = "chrome://browser/content/sval/"

MASK_RE = re.compile(r"(?<![\w-])mask(?:-image)?\s*:([^;{}]*)")
URL_RE = re.compile(r"""url\(\s*["']?([^"')]+)["']?\s*\)""")
ICON_VAR_RE = re.compile(r"var\(\s*(--sval-icon-[a-z0-9-]+)\s*\)")
ICON_DEF_RE = re.compile(r"""(--sval-icon-[a-z0-9-]+):\s*url\("([^"]+)"\)""")
JAR_RE = re.compile(r"^\s*content/browser/sval/(\S+)\s+\((\S+)\)", re.M)
BARE_PAINT_RE = re.compile(
    r"""(?<![\w-])(?:fill|stroke)\s*(?:=\s*["']\s*context-(?:fill|stroke)\s*["']"""
    r"""|:\s*context-(?:fill|stroke)\s*(?:[;"'}]|$))""",
    re.M,
)


def strip_comments(css):
    return re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group().count("\n"), css, flags=re.S)


def bare_paint(svg):
    """Whether an SVG paints a fill or stroke with context paint and no fallback."""
    return bool(BARE_PAINT_RE.search(svg))


def find_problems(root):
    """Returns (css file, line, icon URL) for each mask on a bare-paint icon."""
    root = pathlib.Path(root)
    jar = {}
    jar_file = root / SVAL_DIR / "jar.mn"
    if jar_file.exists():
        for name, source in JAR_RE.findall(jar_file.read_text()):
            jar[name] = root / SVAL_DIR / source

    sheets = {}
    for path in sorted((root / "chrome").rglob("*.css")):
        if "/test/" in path.as_posix():
            continue
        sheets[path] = strip_comments(path.read_text())

    bare = {}

    def is_bare(url):
        if not url.startswith(PREFIX):
            return False
        if url not in bare:
            source = jar.get(url[len(PREFIX) :])
            bare[url] = bool(source and source.exists() and bare_paint(source.read_text()))
        return bare[url]

    icons_sheet = root / SVAL_DIR / "sval-icons.css"
    icon_urls = dict(ICON_DEF_RE.findall(icons_sheet.read_text())) if icons_sheet.exists() else {}

    problems = []
    for path, css in sheets.items():
        for match in MASK_RE.finditer(css):
            value = match.group(1)
            urls = URL_RE.findall(value) + [
                icon_urls[name] for name in ICON_VAR_RE.findall(value) if name in icon_urls
            ]
            line = css.count("\n", 0, match.start()) + 1
            for url in dict.fromkeys(urls):
                if is_bare(url):
                    problems.append((path.relative_to(root), line, url))
    return problems


def main():
    problems = find_problems(REPO)
    for path, line, url in problems:
        print(
            f"{path}:{line}: {url} paints with context-fill or "
            "context-stroke and no fallback, which a mask does not draw; "
            "draw it as a background with -moz-context-properties",
            file=sys.stderr,
        )
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
