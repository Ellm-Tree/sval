#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Check that every Sval icon is drawn through the inventory in SvalIcons.sys.mjs.

    python3 scripts/check-icons.py           # check
    python3 scripts/check-icons.py --write   # regenerate what it generates

`SvalIcons.sys.mjs` names each icon for what it stands for, so one action
or state shows one glyph wherever Sval draws it. The check fails on:

- a URL into one of Sval's icon folders anywhere in chrome/ or patches/
  outside the inventory and jar.mn, so a surface cannot pick a glyph of its
  own;
- an inventory path jar.mn does not register;
- a `var(--sval-icon-<name>)` or `iconURL("<name>")` whose name the
  inventory lacks, which would draw nothing;
- a `sval-icons.css` that differs from what --write generates;
- a jar.mn `% override` onto one of Sval's icon files the inventory does
  not name, so Firefox's own surfaces draw only the inventory's art;
- a copy in `firefox-icons/`, or jar.mn's block of them, that differs from
  what --write generates from FIREFOX_ICONS, a copy whose license REUSE.toml
  gives otherwise than its source's, and, where a build tree is present, a
  FIREFOX_ICONS size that differs from the Firefox file the build packaged.

--write generates `sval-icons.css`, the `firefox-icons/` copies and jar.mn's
block between its "BEGIN Firefox icons" and "END Firefox icons" lines.

scripts/lint.sh runs it, and scripts/check-icons-test.py tests it.
"""

import importlib.util
import pathlib
import re
import sys
import tomllib

REPO = pathlib.Path(__file__).resolve().parent.parent
SVAL_DIR = pathlib.PurePosixPath("chrome/browser/components/sval")
INVENTORY = SVAL_DIR / "SvalIcons.sys.mjs"
SHEET = SVAL_DIR / "sval-icons.css"
JAR = SVAL_DIR / "jar.mn"
PREFIX = "chrome://browser/content/sval/"
FOLDERS = (
    "icons",
    "header-icons",
    "protection-icons",
    "dialog-icons",
    "sync-icons",
    "notification-icons",
)

ENTRY_RE = re.compile(r"""^\s*"?([a-z0-9-]+)"?:\s*"([a-z-]+/[\w-]+\.svg)",\s*$""", re.M)
SVAL_URL_RE = re.compile(r"content/sval/(?:%s)\b" % "|".join(re.escape(f) for f in FOLDERS))
VAR_RE = re.compile(r"--sval-icon-([a-z0-9-]+)")
CALL_RE = re.compile(r"""iconURL\(\s*["']([a-z0-9-]+)["']\s*\)""")
JAR_RE = re.compile(r"^\s*content/browser/sval/(\S+)\s+\(", re.M)
OVERRIDE_RE = re.compile(r"^% override (\S+) chrome://browser/content/sval/(\S+)$", re.M)
SCANNED = {".css", ".mjs", ".js", ".xhtml", ".html", ".patch"}
COPIES = SVAL_DIR / "firefox-icons"
EXEMPT = {INVENTORY, SHEET, JAR}
FIREFOX_RE = re.compile(
    r"""^\s*"(chrome://[^"]+)":\s*\[\s*"([a-z0-9-]+)",\s*([\d.]+),\s*([\d.]+),\s*(true|false),?\s*\],?$""",
    re.M,
)
BLOCK_RE = re.compile(r"(# BEGIN Firefox icons[^\n]*\n(?:#[^\n]*\n)*?)(.*?)(# END Firefox icons\n)", re.S)
SVG_TAG_RE = re.compile(r"<svg\b[^>]*>", re.S)
# Sval's ink on light and on dark (`sval-page.css`), for a copy drawn where no
# context paint reaches it. `SVGImageContext::MaybeStoreContextPaint` gives an
# SVG image the colour scheme of the element that draws it, so the media
# query follows the page.
INK = ("#060a2e", "#ffffff")

HEADER = """\
/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/* Generated from SvalIcons.sys.mjs by scripts/check-icons.py --write.
 * Edit the inventory there, never this file. */

:root,
:host {
"""


def read_inventory(root):
    """Returns {name: path} from the inventory, in its order."""
    return dict(ENTRY_RE.findall((root / INVENTORY).read_text()))


def generate(icons):
    lines = [f'  --sval-icon-{name}: url("{PREFIX}{path}");' for name, path in icons.items()]
    return HEADER + "\n".join(lines) + "\n}\n"


def read_firefox(root):
    """Returns {firefox url: (name, width, height, sized)} from FIREFOX_ICONS."""
    text = (root / INVENTORY).read_text()
    return {
        url: (name, float(w), float(h), sized == "true")
        for url, name, w, h, sized in FIREFOX_RE.findall(text)
    }


def number(value):
    return f"{value:.3f}".rstrip("0").rstrip(".")


def copy_name(source, width, height, sized):
    """The copy of `source` drawn at a Firefox file's size."""
    glyph = pathlib.PurePosixPath(source).stem
    return f"{glyph}-{number(width)}x{number(height)}{'' if sized else '-scalable'}.svg"


def make_copy(svg, width, height, sized):
    """`svg`, a 24 by 24 glyph, in a box of Firefox's proportions, centred at
    full size along its shorter side, stating Firefox's size where Firefox's
    file does."""
    tag = SVG_TAG_RE.search(svg).group(0)
    paint = "fill" if re.search(r'\sfill="context-fill', tag) else "stroke"
    box_w = 24 * max(1, width / height)
    box_h = 24 * max(1, height / width)
    attrs = re.findall(r'[\w:-]+="[^"]*"', tag)
    kept = [a for a in attrs if a.split("=")[0] not in ("width", "height", "viewBox")]
    size = [f'width="{number(width)}"', f'height="{number(height)}"'] if sized else []
    view = [f'viewBox="{number(-(box_w - 24) / 2)} {number(-(box_h - 24) / 2)} {number(box_w)} {number(box_h)}"']
    new_tag = "<svg\n" + "".join(f"  {a}\n" for a in kept[:1] + size + view + kept[1:]) + ">"
    style = (
        f"\n  <style>\n    :root {{ {paint}: context-fill {INK[0]}; }}\n"
        f"    @media (prefers-color-scheme: dark) {{ :root {{ {paint}: context-fill {INK[1]}; }} }}\n  </style>"
    )
    return svg.replace(tag, new_tag + style, 1)


def generated_copies(root, icons, firefox):
    """Returns ({copy path: text}, {firefox url: copy path})."""
    copies, targets = {}, {}
    for url, (name, width, height, sized) in firefox.items():
        source = icons.get(name)
        if source is None:
            continue
        rel = COPIES / copy_name(source, width, height, sized)
        targets[url] = rel
        if rel not in copies:
            copies[rel] = make_copy((root / SVAL_DIR / source).read_text(), width, height, sized)
    return copies, targets


def jar_block(copies, targets):
    lines = [
        f"    content/browser/sval/{rel.relative_to(SVAL_DIR)} ({rel.relative_to(SVAL_DIR)})"
        for rel in sorted(copies)
    ]
    lines += [f"% override {url} {PREFIX}{rel.relative_to(SVAL_DIR)}" for url, rel in targets.items()]
    return "".join(line + "\n" for line in lines)


def write_jar(text, block):
    match = BLOCK_RE.search(text)
    return text[: match.start(2)] + block + text[match.end(2) :]


def packaged_sizes(root):
    """{firefox url: (width, height, sized)} read from a build tree's packaged
    chrome, or None without one."""
    dist = next(iter(sorted((root / "build/firefox").glob("objdir*/dist/bin"))), None)
    if dist is None or not (dist / "chrome.manifest").exists():
        return None
    registry = {}

    def load(manifest):
        for line in manifest.read_text().splitlines():
            parts = line.split()
            if parts and parts[0] == "manifest":
                load(manifest.parent / parts[1])
            elif parts and parts[0] == "content":
                registry.setdefault((parts[1], "content"), manifest.parent / parts[2])
            elif parts and parts[0] == "skin":
                registry.setdefault((parts[1], "skin"), manifest.parent / parts[3])

    load(dist / "chrome.manifest")
    if (dist / "browser/chrome.manifest").exists():
        load(dist / "browser/chrome.manifest")

    def size(url):
        package, kind, rest = re.match(r"chrome://([^/]+)/([^/]+)/(.+)", url).groups()
        path = registry.get((package, kind), pathlib.Path("/nonexistent")) / rest
        if not path.exists():
            return None
        tag = SVG_TAG_RE.search(path.read_text()).group(0)
        attr = lambda a: (m.group(1) if (m := re.search(rf'\s{a}="([\d.]+)', tag)) else None)
        if attr("width"):
            return float(attr("width")), float(attr("height")), True
        _, _, w, h = re.search(r'viewBox="([^"]+)"', tag).group(1).split()
        return float(w), float(h), False

    return size


def license_problems(root, copies, firefox, icons):
    reuse = root / "REUSE.toml"
    if not reuse.exists():
        return []
    spec = importlib.util.spec_from_file_location("check_licenses", pathlib.Path(__file__).parent / "check-licenses.py")
    licenses = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(licenses)
    annotations = []
    for entry in tomllib.loads(reuse.read_text()).get("annotations", []):
        paths = [entry["path"]] if isinstance(entry["path"], str) else entry["path"]
        annotations.append({"regexes": [licenses.reuse_glob(p) for p in paths], "license": entry["SPDX-License-Identifier"]})
    problems = []
    sources = {COPIES / copy_name(icons[n], w, h, s): icons[n] for n, w, h, s in firefox.values() if n in icons}
    for rel in copies:
        got = licenses.classify(rel.as_posix(), annotations)
        want = licenses.classify((SVAL_DIR / sources[rel]).as_posix(), annotations)
        if got != want:
            problems.append(("REUSE.toml", 0, f"{rel} is {got}, but its source {sources[rel]} is {want}"))
    return problems


def scanned_files(root):
    for top in ("chrome", "patches"):
        for path in sorted((root / top).rglob("*")):
            rel = pathlib.PurePosixPath(path.relative_to(root).as_posix())
            if path.suffix in SCANNED and rel not in EXEMPT and "/test/" not in rel.as_posix():
                yield path, rel


def find_problems(root):
    """Returns (file, line, message) for each problem."""
    root = pathlib.Path(root)
    icons = read_inventory(root)
    problems = []

    jar = (root / JAR).read_text()
    registered = set(JAR_RE.findall(jar))
    paths = set(icons.values())
    for firefox, target in OVERRIDE_RE.findall(jar):
        if target.split("/")[0] in FOLDERS and target not in paths:
            problems.append((JAR, 0, f"{firefox} is drawn with {target}, which no inventory name holds"))
    for name, path in icons.items():
        if path not in registered:
            problems.append((INVENTORY, 0, f"{name}: {path} is not in jar.mn"))

    sheet = root / SHEET
    if not sheet.exists() or sheet.read_text() != generate(icons):
        problems.append((SHEET, 0, "differs from SvalIcons.sys.mjs; run scripts/check-icons.py --write"))

    firefox = read_firefox(root)
    for url, (name, *_) in firefox.items():
        if name not in icons:
            problems.append((INVENTORY, 0, f"{url}: no icon named {name}"))
    copies, targets = generated_copies(root, icons, firefox)
    on_disk = {COPIES / p.name for p in (root / COPIES).glob("*.svg")} if (root / COPIES).exists() else set()
    for rel in sorted(on_disk | set(copies)):
        if rel not in copies or not (root / rel).exists() or (root / rel).read_text() != copies[rel]:
            problems.append((rel, 0, "differs from FIREFOX_ICONS; run scripts/check-icons.py --write"))
    match = BLOCK_RE.search(jar)
    if not match or match.group(2) != jar_block(copies, targets):
        problems.append((JAR, 0, "its Firefox icons block differs from FIREFOX_ICONS; run scripts/check-icons.py --write"))
    size = packaged_sizes(root)
    if size:
        for url, (name, w, h, sized) in firefox.items():
            packaged = size(url)
            if packaged and packaged != (w, h, sized):
                problems.append((INVENTORY, 0, f"{url} is {packaged} in the build, but FIREFOX_ICONS says {(w, h, sized)}"))
    problems += license_problems(root, copies, firefox, icons)

    for path, rel in scanned_files(root):
        text = path.read_text()
        for number, line in enumerate(text.splitlines(), 1):
            if rel.suffix == ".patch" and not line.startswith("+"):
                continue
            if SVAL_URL_RE.search(line):
                problems.append((rel, number, "names an icon file; use var(--sval-icon-<name>) or iconURL(<name>)"))
            for name in VAR_RE.findall(line) + CALL_RE.findall(line):
                if name not in icons:
                    problems.append((rel, number, f"no icon named {name} in SvalIcons.sys.mjs"))
    return problems


def main(argv):
    if argv[1:] == ["--write"]:
        icons = read_inventory(REPO)
        (REPO / SHEET).write_text(generate(icons))
        copies, targets = generated_copies(REPO, icons, read_firefox(REPO))
        (REPO / COPIES).mkdir(exist_ok=True)
        for stale in (REPO / COPIES).glob("*.svg"):
            if COPIES / stale.name not in copies:
                stale.unlink()
        for rel, text in copies.items():
            (REPO / rel).write_text(text)
        jar = REPO / JAR
        jar.write_text(write_jar(jar.read_text(), jar_block(copies, targets)))
        return 0
    problems = find_problems(REPO)
    for path, line, message in problems:
        print(f"{path}:{line}: {message}", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
