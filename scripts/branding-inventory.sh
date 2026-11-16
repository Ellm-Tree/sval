#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Check that nothing in branding/sval is Mozilla's, and print the inventory.
#
# Every file under branding/sval is hashed and compared against every file in
# every one of upstream's branding directories (browser/branding/*). A file
# that is byte-identical to any of them is Mozilla's, whatever its name and
# whichever build file reads it: the macOS bundle step, the installer
# Makefiles and the msix packager all take files from the branding directory
# without going through its jar.mn or moz.build, so a check limited to the
# manifests misses them.
#
# The manifests are still parsed, for two things the hash comparison cannot
# see: a declared asset that is missing, and the "Declared by" column.
#
# Usage: ./scripts/branding-inventory.sh [--markdown]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SVAL="$REPO_ROOT/branding/sval"
UPSTREAM="$REPO_ROOT/build/firefox/browser/branding"

if [[ ! -d "$UPSTREAM/unofficial" ]]; then
  echo "error: no upstream checkout at $UPSTREAM — run scripts/fetch-upstream.sh first" >&2
  exit 1
fi

MARKDOWN=0
[[ "${1:-}" == "--markdown" ]] && MARKDOWN=1

status=0
SVAL="$SVAL" UPSTREAM="$UPSTREAM" MARKDOWN="$MARKDOWN" python3 <<'PY' || status=$?
import os, re, hashlib, sys

sval = os.environ["SVAL"]
upstream = os.environ["UPSTREAM"]
markdown = os.environ["MARKDOWN"] == "1"

# Files that may stay byte-identical to upstream. Each is text that carries no
# artwork, name or colour of Mozilla's.
ALLOWED_NAMES = {
    # Build plumbing: the branding directory has to register its jar manifest
    # and subdirectories in the same form as every upstream channel.
    "moz.build": "build plumbing",
    # A list of chrome paths that browser code reads as chrome://branding/...;
    # the paths are fixed by that code, so Sval's list matches upstream's.
    "jar.mn": "build plumbing",
}
ALLOWED_PATHS = {
    # The stub installer's profile-cleanup page layout: margins, font sizes and
    # white text, identical in every upstream channel. It has no image or
    # colour of its own; the art behind it is stubinstaller/bgstub.jpg.
    "stubinstaller/profile_cleanup_page.css": "installer layout, no art",
}

declared = {}   # path relative to branding/sval -> reason it ships


def declare(path, why):
    declared.setdefault(os.path.normpath(path), why)


def parse_jar(jar_rel, base_rel):
    """jar.mn lines are '  dest/path' or '  dest/path   (source/path)'."""
    p = os.path.join(sval, jar_rel)
    if not os.path.exists(p):
        return
    for line in open(p):
        s = line.strip()
        if not s or s.startswith(("#", "%", "[")) or s.endswith(".jar:"):
            continue
        m = re.match(r"^(\S+)(?:\s+\((.+)\))?$", s)
        if not m:
            continue
        dest, src = m.group(1), m.group(2)
        if src:
            if "*" in src:      # glob, e.g. en-US/**/*.ftl
                continue
            declare(os.path.join(base_rel, src), f"{jar_rel} -> {dest}")
        else:
            declare(os.path.join(base_rel, os.path.basename(dest)), f"{jar_rel} -> {dest}")


parse_jar("content/jar.mn", "content")
parse_jar("locales/jar.mn", "locales")

mb = os.path.join(sval, "moz.build")
if os.path.exists(mb):
    for line in open(mb):
        if line.strip().startswith("#"):
            continue
        for q in re.findall(r'"([^"]+\.(?:png|ico|icns|xml|bmp|svg|js))"', line):
            declare(q, "moz.build")

# The FTL bundle is globbed in jar.mn; enumerate the real files.
ftl_dir = os.path.join(sval, "locales", "en-US")
for root, _, names in os.walk(ftl_dir):
    for f in names:
        if f.endswith(".ftl"):
            declare(os.path.relpath(os.path.join(root, f), sval),
                    "locales/jar.mn -> [localization] glob")


def digest(p):
    h = hashlib.sha256()
    with open(p, "rb") as fh:
        for chunk in iter(lambda: fh.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def walk(root, skip_top=()):
    for dirpath, dirnames, files in os.walk(root):
        if dirpath == root:
            dirnames[:] = [d for d in dirnames if d not in skip_top]
        for f in files:
            if f == ".DS_Store":
                continue
            full = os.path.join(dirpath, f)
            yield os.path.relpath(full, root), full


# browser/branding/sval in the build tree is sync-files.sh's copy of ours.
upstream_by_hash = {}
for rel, full in walk(upstream, skip_top=("sval",)):
    upstream_by_hash.setdefault(digest(full), []).append(rel)

files = dict(walk(sval))
for rel in declared:
    files.setdefault(rel, None)

rows = []
counts = {"SVAL-AUTHORED": 0, "SVAL-ONLY": 0, "ALLOWLISTED": 0, "INHERITED": 0, "MISSING": 0}
for rel in sorted(files):
    full = files[rel]
    why = declared.get(rel, "")
    note = ""
    if full is None:
        status = "MISSING"
    else:
        matches = upstream_by_hash.get(digest(full))
        allowed = ALLOWED_PATHS.get(rel) or ALLOWED_NAMES.get(os.path.basename(rel))
        if matches and allowed:
            status, note = "ALLOWLISTED", allowed
        elif matches:
            status, note = "INHERITED", "same bytes as " + ", ".join(sorted(matches))
        elif os.path.exists(os.path.join(upstream, "unofficial", rel)):
            status = "SVAL-AUTHORED"
        else:
            status = "SVAL-ONLY"
    counts[status] += 1
    rows.append((status, rel, why, note))

order = {"INHERITED": 0, "MISSING": 1, "ALLOWLISTED": 2, "SVAL-AUTHORED": 3, "SVAL-ONLY": 4}
rows.sort(key=lambda r: (order[r[0]], r[1]))

total = len(rows)
blocking = counts["INHERITED"] + counts["MISSING"]
summary = (f"{total} files: {counts['SVAL-AUTHORED']} sval-authored, "
           f"{counts['SVAL-ONLY']} sval-only, {counts['ALLOWLISTED']} allowlisted, "
           f"{counts['INHERITED']} still Mozilla's, {counts['MISSING']} missing.")
verdict = (f"RELEASE BLOCKED: {blocking} file(s) are not Sval's." if blocking
           else "Nothing under branding/sval is Mozilla's.")

if markdown:
    print("""# sval branding inventory

Generated by `./scripts/branding-inventory.sh --markdown` from the checkout it
ran in.

## What the gate checks

Every file under `branding/sval/` is compared byte for byte against every file
in every one of upstream's branding directories (`browser/branding/*`: aurora,
nightly, official and unofficial). A match, under any name, means sval would ship
Mozilla's file, so the gate fails.

The comparison covers the whole directory because the build reads branding files
from more places than the branding manifests. `browser/app/Makefile.in` copies
the macOS icons into the app bundle, `browser/app/moz.build` and
`browser/app/pbproxy/moz.build` compile the Windows `.ico` files into the
executables, `browser/installer/windows/Makefile.in` takes the installer art,
`toolkit/moz.configure` hands the DMG files to the packager, and
`python/mozbuild/mozbuild/repackaging/msix.py` copies `msix/Assets`. None of
those goes through `content/jar.mn`, `locales/jar.mn` or `moz.build`.

The manifests are still parsed, to report a declared asset that is missing and
to fill the "Declared by" column. A blank there means the file is read directly
by a build file, or is not shipped at all.

Status values:

- `INHERITED`: byte-identical to an upstream branding file. Blocks release.
- `MISSING`: declared by a manifest and absent. Blocks release.
- `ALLOWLISTED`: identical to upstream, and text that carries no artwork, name
  or colour of Mozilla's: `moz.build` and `jar.mn` build plumbing, and the stub
  installer's layout-only stylesheet. The list and its reasons are in
  `scripts/branding-inventory.sh`.
- `SVAL-AUTHORED`: upstream has a file at the same path, and Sval's differs.
- `SVAL-ONLY`: upstream has no file at that path.

## Legal requirements this gate serves

Mozilla's distribution policy is stricter than "don't say Firefox":

- Modified builds **may not use Mozilla trademarks at all** without prior written
  permission. This is a hard gate, not a nicety.
- A fork must choose branding that **denotes its own identity**.
- Naming must avoid `[Something]-fox`, `Moz-[Something]`, `[Something]-zilla`.
  "sval" passes.
- A disclaimer that sval is **not officially associated with Mozilla** must be
  carried equally prominently. `brand.ftl` defines `trademarkInfo`; that it is
  actually surfaced in the UI is **not yet verified**.
- The MPL separately *requires* retaining Mozilla attribution in license headers,
  so the goal is precision, not the absence of the word "Mozilla".

## Branding is separately licensed

Sval's brand art in `branding/sval/` is reserved, and `branding/sval/LICENSE`
lists it. Unmodified copies of sval may carry it, under the licenses on Sval's
code (AGPL-3.0-only with the Sval App Store Permission for Sval's own files,
MPL 2.0 for the files copied from Mozilla's branding); a modified version must replace it. This is the same code/brand split LibreWolf,
Floorp, and Zen use, and it mirrors what Mozilla's own trademark policy does
to sval.

## Status

| Status | File | Declared by | Note |
|---|---|---|---|""")
    marks = {"INHERITED": "❌", "MISSING": "⚠️", "ALLOWLISTED": "➖",
             "SVAL-AUTHORED": "✅", "SVAL-ONLY": "✅"}
    for status, rel, why, note in rows:
        print(f"| {marks[status]} {status} | `{rel}` | {why} | {note} |")
    print()
    print(summary)
    print(verdict)
else:
    for status, rel, why, note in rows:
        detail = "; ".join(x for x in (why, note) if x)
        print(f"{status:13} {rel:62} {('(' + detail + ')') if detail else ''}".rstrip())
    print()
    print(summary)
    print(verdict)

sys.exit(1 if blocking else 0)
PY

# Firefox's art outside the branding directory. Mozilla's illustrations and
# product logos live all over browser/, toolkit/ and devtools/, and the
# installer's icons in other-licenses/, where the hash comparison above never
# looks. Windows and macOS icons count, and so do the prebuilt installer stubs
# (.sfx), which carry an icon in their resources. docs/firefox-assets.md decides each one, and
# this fails on a candidate image the doc does not cover, and on a row that
# matches nothing, so a rebase that brings new art fails until it is decided.
# The report goes to stderr, so --markdown output stays the inventory alone.
TREE="$REPO_ROOT/build/firefox" DOC="$REPO_ROOT/docs/firefox-assets.md" python3 <<'PY' >&2 || status=$?
import fnmatch, os, re, sys

tree = os.environ["TREE"]
doc = os.environ["DOC"]

IMAGE = (".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".icns", ".bmp", ".sfx")
# Tests, docs and build-only directories never reach a user; the branding
# directories are the check above's, and browser/components/sval is Sval's own
# files, which sync-files.sh copies in.
SKIP = re.compile(
    r"/(test|tests|docs|storybook|mochitest|crashtests|reftests?)/"
    r"|^browser/branding/|^browser/components/sval/"
    r"|/node_modules/|\.stories\."
    r"|^browser/tools/mozscreenshots/"
)
NAMED = re.compile(r"fox|firefox|mozilla|kit|fenix|lockwise|monitor|relay|vpn|pocket|thunderbird|mascot", re.I)


def candidate(rel, full):
    """Art rather than a glyph: a large raster, a large SVG drawn in its own
    colours (a glyph takes the theme's through context-fill), or a file named
    for Firefox, Mozilla or one of their products."""
    if NAMED.search(os.path.basename(rel)):
        return True
    size = os.path.getsize(full)
    if rel.endswith(".svg"):
        text = open(full, errors="replace").read()
        return size > 3072 and "context-fill" not in text and "context-stroke" not in text
    return size > 4096


found = []
for top in ("browser", "toolkit", "devtools/client", "other-licenses"):
    for dirpath, _, names in os.walk(os.path.join(tree, top)):
        for name in names:
            if not name.lower().endswith(IMAGE):
                continue
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, tree).replace(os.sep, "/")
            if not SKIP.search(rel) and candidate(rel, full):
                found.append(rel)

# Every backticked path in the first cell of a table row.
patterns = []
for line in open(doc, encoding="utf-8"):
    if line.startswith("|") and not line.startswith("|---"):
        cell = line.split("|")[1]
        patterns += [p for p in re.findall(r"`([^`]+)`", cell) if "/" in p]


def covered(rel, pat):
    if pat.endswith("/**"):
        return rel.startswith(pat[:-2])
    return fnmatch.fnmatchcase(rel, pat)


unaudited = [rel for rel in sorted(found) if not any(covered(rel, p) for p in patterns)]
stale = [p for p in patterns if not any(covered(rel, p) for rel in found)]

for rel in unaudited:
    print(f"UNAUDITED     {rel}")
for p in stale:
    print(f"STALE ROW     {p} (matches no candidate image)")
print(f"{len(found)} candidate Firefox images, {len(unaudited)} not in docs/firefox-assets.md, "
      f"{len(stale)} rows matching nothing.")
if unaudited or stale:
    print("RELEASE BLOCKED: decide each image in docs/firefox-assets.md.")
    sys.exit(1)
print("Every candidate Firefox image is decided in docs/firefox-assets.md.")
PY

exit "$status"
