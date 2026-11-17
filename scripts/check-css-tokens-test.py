#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-css-tokens.py still flags what it exists for.

A pattern that stops matching passes every file, so each case builds a small
tree and names the properties the check must flag and the near-misses it must
pass.

    python3 scripts/check-css-tokens-test.py

scripts/lint.sh runs it.
"""

import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "check-css-tokens.py"
spec = importlib.util.spec_from_file_location("check_css_tokens", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

FIREFOX = {
    "browser/themes/shared/toolbar.css": ".b { padding: var(--toolbarbutton-padding-outer); }",
    "browser/components/tabbrowser/drag.js": "x = `var(--tab-group-color-${color})`;",
    "toolkit/content/widgets/panel.js": 'el.style.getPropertyValue("--panel-width");',
    "devtools/client/aboutdebugging/base.css": ".a { color: var( --bg-color ); }",
    "browser/themes/node_modules/x/x.css": ".a { color: var(--only-in-node-modules); }",
    "browser/themes/test/browser_x.js": 'getPropertyValue("--only-in-a-test");',
    "browser/components/sval/stale.css": ".a { color: var(--only-in-svals-copy); }",
}


def problems(css, extra=None):
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        for name, text in FIREFOX.items():
            path = root / "build/firefox" / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        sval = root / "chrome/browser/components/sval"
        sval.mkdir(parents=True)
        (sval / "a.css").write_text(css)
        for name, text in (extra or {}).items():
            (sval / name).write_text(text)
        return [(line, name) for _, line, name in check.find_problems(root)]


class CssTokens(unittest.TestCase):
    def test_flags_a_name_firefox_does_not_read(self):
        self.assertEqual(
            problems(":root {\n  --toolbarbutton-outer-padding: 0px;\n}\n"),
            [(2, "--toolbarbutton-outer-padding")],
        )

    def test_flags_a_name_only_a_dependency_a_test_or_svals_copy_reads(self):
        for name in ("--only-in-node-modules", "--only-in-a-test", "--only-in-svals-copy"):
            with self.subTest(name):
                self.assertEqual(problems(f".a {{ }}\n.b {{\n{name}: 1;\n}}"), [(3, name)])

    def test_counts_lines_through_comments(self):
        css = "/* one\n two */\n:root {\n  --gone: 1px;\n}"
        self.assertEqual(problems(css), [(4, "--gone")])

    def test_passes_the_near_misses(self):
        for css in (
            ":root {\n  --toolbarbutton-padding-outer: 0px;\n}",
            ":root {\n  --tab-group-color-red: #f00;\n}",
            ":root {\n  --panel-width: 10px;\n}",
            ":root {\n  --bg-color: #000;\n}",
            ":root {\n  --sval-anything: 1px;\n}",
            "/* :root {\n  --gone: 1px;\n} */",
            ":root {\n  --mine: 1px;\n}\n.a { width: var(--mine); }",
        ):
            with self.subTest(css):
                self.assertEqual(problems(css), [])

    def test_passes_a_name_another_sval_file_reads(self):
        css = ":root {\n  --chip-width: 1px;\n}"
        for name, text in (
            ("b.css", ".b { width: var(--chip-width); }"),
            ("b.js", 'form.style.setProperty("--chip-width", "2px");'),
        ):
            with self.subTest(name):
                self.assertEqual(problems(css, {name: text}), [])


if __name__ == "__main__":
    unittest.main()
