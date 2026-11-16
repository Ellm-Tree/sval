#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-mask-icons.py still flags what it exists for.

A pattern that stops matching passes every file, so each case builds a small
tree and names the masks the check must flag and the near-misses it must pass.

    python3 scripts/check-mask-icons-test.py

scripts/lint.sh runs it.
"""

import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "check-mask-icons.py"
spec = importlib.util.spec_from_file_location("check_mask_icons", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

ICONS = {
    "stroke.svg": '<svg fill="none" stroke="context-fill" stroke-width="2"/>',
    "fill.svg": '<svg fill="context-fill" fill-opacity="context-fill-opacity"/>',
    "styled.svg": '<svg><path style="stroke: context-stroke;"/></svg>',
    "fallback.svg": '<svg fill="none" stroke="context-fill black"/>',
    "opacity.svg": '<svg fill="#000" fill-opacity="context-fill-opacity"/>',
    "plain.svg": '<svg fill="none" stroke="#000"/>',
}


def problems(css):
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        sval = root / check.SVAL_DIR
        (sval / "icons").mkdir(parents=True)
        jar = []
        for name, svg in ICONS.items():
            (sval / "icons" / name).write_text(svg)
            jar.append(f"    content/browser/sval/icons/{name} (icons/{name})")
        (sval / "jar.mn").write_text("\n".join(jar) + "\n")
        (sval / "a.css").write_text(css)
        return [(line, url.rsplit("/", 1)[1]) for _, line, url in check.find_problems(root)]


def url(name):
    return f'url("chrome://browser/content/sval/icons/{name}")'


class MaskIcons(unittest.TestCase):
    def test_flags_a_mask_on_a_bare_paint(self):
        for name in ("stroke.svg", "fill.svg", "styled.svg"):
            with self.subTest(name):
                self.assertEqual(problems(f".a {{\n  mask: {url(name)} center;\n}}\n"), [(2, name)])

    def test_flags_mask_image(self):
        self.assertEqual(problems(f".a {{ mask-image: {url('stroke.svg')}; }}"), [(1, "stroke.svg")])

    def test_counts_lines_through_comments(self):
        css = f"/* one\n two */\n.a {{ mask: {url('stroke.svg')}; }}"
        self.assertEqual(problems(css), [(3, "stroke.svg")])

    def test_passes_the_near_misses(self):
        for css in (
            f".a {{ mask: {url('fallback.svg')}; }}",
            f".a {{ mask: {url('opacity.svg')}; }}",
            f".a {{ mask: {url('plain.svg')}; }}",
            f".a {{ background: {url('stroke.svg')}; -moz-context-properties: fill; }}",
            f".a {{ --icon: {url('stroke.svg')}; mask: var(--icon); mask-size: 16px; }}",
            f"/* .a {{ mask: {url('stroke.svg')}; }} */",
        ):
            with self.subTest(css):
                self.assertEqual(problems(css), [])


if __name__ == "__main__":
    unittest.main()
