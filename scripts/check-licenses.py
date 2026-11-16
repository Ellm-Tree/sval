#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Check that every file in this repository says which license it is under.

    scripts/check-licenses.py

LICENSING.md explains the repository's licenses. REUSE.toml, at the root, is the classification:
it names every Mozilla-derived file, the reserved brand art, the third-party
logos, and the Sval files that cannot carry a comment. A file it does not name
is Sval's own work and must carry Sval's notice in its first lines, with the
copyright line of whoever wrote it, Ellm Tree, Inc. or a contributor:

    SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
    Copyright 2026 Ellm Tree, Inc.

A file REUSE.toml classifies as MPL-2.0 must keep Mozilla's MPL header if it
can carry a comment at all, because MPL 2.0 section 3.4 forbids removing it.
The check also fails on a Sval file that still carries the MPL header, on a
file REUSE.toml gives another license that carries Sval's notice, on a license
identifier with no text in LICENSES/, and on a brand-art notice in
branding/sval/LICENSE that differs from the copy REUSE needs in LICENSES/.

CI runs this on every event, in a job of its own, so a change that skips the
build is still checked; Sval's scripts/lint.sh runs it too. It needs Python
3.11 or newer, for tomllib. scripts/lint.sh says why Mozilla's own `license`
linter is not used.

Each identifier in a notice or in REUSE.toml, the permission included, needs
its text in LICENSES/ under the same name. The permission's identifier uses
SPDX 3.0's AdditionRef- prefix, for an addition the SPDX list does not hold.
"""

import html
import pathlib
import re
import subprocess
import sys
import tomllib

REPO = pathlib.Path(__file__).resolve().parent.parent

SVAL = "AGPL-3.0-only WITH AdditionRef-sval-app-store"
MPL = "MPL-2.0"
BRAND_ART = "LicenseRef-sval-brand-art"

# These patterns are not notices, so the REUSE tool is told to skip them.
# REUSE-IgnoreStart
SVAL_ID_RE = re.compile(r"SPDX-License-Identifier: AGPL-3\.0-only WITH AdditionRef-sval-app-store\b")
COPYRIGHT_RE = re.compile(r"Copyright \d{4}(?:[-, ]+\d{4})* \S")
# The company is Ellm Tree, Inc., two words.
MISNAMED_HOLDER_RE = re.compile(r"EllmTree,? Inc", re.IGNORECASE)
MPL_HEADER_RE = re.compile(
    r"This Source Code Form is subject to the terms of the Mozilla Public\s*\S*\s*License, v\. 2\.0\."
)
ANY_SPDX_RE = re.compile(r"SPDX-License-Identifier: (.+)")
SPDX_OPERATORS = {"AND", "OR", "WITH"}
# REUSE-IgnoreEnd

# A notice belongs at the top. Twelve lines leaves room for a shebang, an XML
# declaration, an editor modeline and a three-line MPL block.
HEADER_LINES = 12

# Files that cannot carry a comment, or whose format would be damaged by one.
UNCOMMENTABLE_SUFFIXES = {
    ".bmp", ".dll", ".icns", ".ico", ".jpg", ".json", ".lock", ".md", ".patch",
    ".pdf", ".png", ".wasm",
}
# A Debian package's compat file is a bare number, and its changelog format
# has no comment syntax.
UNCOMMENTABLE_NAMES = {"dsstore", "compat", "changelog.in"}

# What REUSE itself never expects to carry licensing information.
def is_exempt(path):
    name = path.rsplit("/", 1)[-1]
    return (
        path.startswith("LICENSES/")
        or path == "REUSE.toml"
        or name == "LICENSE"
        or name.startswith("LICENSE.")
        or name.endswith(".license")
    )


def commentable(path):
    name = path.rsplit("/", 1)[-1]
    return name not in UNCOMMENTABLE_NAMES and pathlib.PurePosixPath(name).suffix not in UNCOMMENTABLE_SUFFIXES


def reuse_glob(pattern):
    """REUSE.toml path semantics: `*` stays within a directory, `**` crosses."""
    out = []
    i = 0
    while i < len(pattern):
        if pattern.startswith("**", i):
            out.append(".*")
            i += 2
        elif pattern[i] == "*":
            out.append("[^/]*")
            i += 1
        elif pattern.startswith("\\*", i):
            out.append(re.escape("*"))
            i += 2
        else:
            out.append(re.escape(pattern[i]))
            i += 1
    return re.compile("".join(out) + r"\Z")


def load_annotations():
    data = tomllib.loads((REPO / "REUSE.toml").read_text(encoding="utf-8"))
    annotations = []
    for entry in data.get("annotations", []):
        paths = entry["path"]
        if isinstance(paths, str):
            paths = [paths]
        annotations.append(
            {
                "patterns": paths,
                "regexes": [reuse_glob(p) for p in paths],
                "license": entry["SPDX-License-Identifier"],
                "matched": False,
            }
        )
    return annotations


def classify(path, annotations):
    """The license REUSE.toml gives a path, or None. The last match wins.

    An annotation counts as matched when it matches any file, winning or not.
    A broad annotation that later ones override everywhere stays live: the
    published tree omits the website, and there "website/**" matches only the
    docs, which a later annotation licenses."""
    found = None
    for annotation in annotations:
        if any(r.match(path) for r in annotation["regexes"]):
            annotation["matched"] = True
            found = annotation
    return found["license"] if found else None


def identifiers(expression):
    """The license and addition identifiers in an SPDX expression."""
    expression = re.sub(r"\*/|-->", " ", expression).replace("(", " ").replace(")", " ")
    return {t for t in expression.split() if t not in SPDX_OPERATORS}


def head(path):
    try:
        with open(REPO / path, encoding="utf-8") as f:
            return "".join(line for _, line in zip(range(HEADER_LINES), f))
    except UnicodeDecodeError:
        return ""


def main():
    listing = subprocess.run(
        ["git", "-C", str(REPO), "ls-files", "--cached", "--others", "--exclude-standard"],
        capture_output=True,
        text=True,
        check=True,
    ).stdout.splitlines()
    files = [f for f in listing if (REPO / f).is_file() and not is_exempt(f)]
    if not files:
        print("error: git lists no files", file=sys.stderr)
        return 1

    annotations = load_annotations()
    problems = []
    used = set()

    for path in files:
        license = classify(path, annotations)
        text = head(path) if commentable(path) else ""
        has_sval = bool(SVAL_ID_RE.search(text))
        has_mpl = bool(MPL_HEADER_RE.search(text))
        if MISNAMED_HOLDER_RE.search(text):
            problems.append(f"{path}: the copyright holder is Ellm Tree, Inc., two words")
        for match in ANY_SPDX_RE.finditer(text):
            used.update(identifiers(match.group(1)))

        if license is None:
            used.update(identifiers(SVAL))
            if not commentable(path):
                problems.append(f"{path}: cannot carry a comment and REUSE.toml does not classify it")
                continue
            if not has_sval or not COPYRIGHT_RE.search(text):
                problems.append(
                    f"{path}: Sval's file without Sval's notice in its first {HEADER_LINES} lines "
                    f"(SPDX-License-Identifier: {SVAL} and Copyright <year> <holder>); "
                    "if it is Mozilla's code, list it as MPL-2.0 in REUSE.toml"
                )
            if has_mpl:
                problems.append(f"{path}: Sval's file still carries the MPL header")
            continue

        used.update(identifiers(license))
        if license == MPL:
            if commentable(path) and not has_mpl:
                problems.append(
                    f"{path}: Mozilla-derived, and its MPL header is missing (MPL 2.0 section 3.4)"
                )
            if has_sval:
                problems.append(f"{path}: Mozilla-derived, but carries Sval's notice")
            continue
        if has_mpl:
            problems.append(f"{path}: REUSE.toml says {license}, but the file carries the MPL header")
        if has_sval and license != SVAL:
            problems.append(f"{path}: REUSE.toml says {license}, but the file carries Sval's notice")

    for annotation in annotations:
        if not annotation["matched"]:
            problems.append(f"REUSE.toml: {annotation['patterns']} match no file")

    for license in sorted(used):
        if not (REPO / "LICENSES" / f"{license}.txt").is_file():
            problems.append(f"LICENSES/{license}.txt: missing, and {license} is in use")

    art_notice = REPO / "branding/sval/LICENSE"
    art_copy = REPO / "LICENSES" / f"{BRAND_ART}.txt"
    if art_notice.is_file() and art_copy.is_file() and art_notice.read_bytes() != art_copy.read_bytes():
        problems.append(f"branding/sval/LICENSE and LICENSES/{BRAND_ART}.txt differ; they are one notice")

    # about:license shows Sval's license texts, so they must be LICENSES/'s.
    page = REPO / "chrome/browser/base/content/overrides/app-license.html"
    if page.is_file():
        shown = page.read_text(encoding="utf-8")
        for license in identifiers(SVAL):
            text = REPO / "LICENSES" / f"{license}.txt"
            escaped = html.escape(text.read_text(encoding="utf-8"), quote=False) if text.is_file() else None
            if escaped is not None and escaped not in shown:
                problems.append(
                    f"{page.relative_to(REPO)}: does not show LICENSES/{license}.txt as it stands"
                )

    for problem in problems:
        print(f"error: {problem}")
    print(f"==> License notices: {len(files)} files checked, {len(problems)} problems")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
