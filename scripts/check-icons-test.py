#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-icons.py still flags what it exists for.

A pattern that stops matching passes every file, so each case builds a small
tree and names what the check must flag and the near-misses it must pass.

    python3 scripts/check-icons-test.py

scripts/lint.sh runs it.
"""

import importlib.util
import pathlib
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "check-icons.py"
spec = importlib.util.spec_from_file_location("check_icons", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

INVENTORY = """\
export const ICONS = Object.freeze({
  pin: "icons/pin.svg",
  "site-camera": "protection-icons/sc-camera.svg",
});
"""
JAR = """\
# BEGIN Firefox icons
# END Firefox icons
    content/browser/sval/icons/pin.svg (icons/pin.svg)
    content/browser/sval/protection-icons/sc-camera.svg (protection-icons/sc-camera.svg)
"""


def problems(files, inventory=INVENTORY, jar=JAR, sheet=None):
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        (root / check.SVAL_DIR).mkdir(parents=True)
        (root / "patches").mkdir()
        (root / check.INVENTORY).write_text(inventory)
        (root / check.JAR).write_text(jar)
        (root / check.SHEET).write_text(
            sheet if sheet is not None else check.generate(check.read_inventory(root))
        )
        for name, text in files.items():
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
        return [(str(path), line, message.split(";")[0]) for path, line, message in check.find_problems(root)]


A = "chrome/browser/components/sval/a.css"


class Icons(unittest.TestCase):
    def test_reads_quoted_and_bare_names(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            (root / check.SVAL_DIR).mkdir(parents=True)
            (root / check.INVENTORY).write_text(INVENTORY)
            self.assertEqual(
                check.read_inventory(root),
                {"pin": "icons/pin.svg", "site-camera": "protection-icons/sc-camera.svg"},
            )

    def test_flags_an_icon_url_outside_the_inventory(self):
        for text in (
            '.a { mask: url("chrome://browser/content/sval/icons/pin.svg"); }',
            '.a { --g: url("chrome://browser/content/sval/protection-icons/sc-camera.svg"); }',
            'const ICONS = "chrome://browser/content/sval/icons";',
        ):
            with self.subTest(text):
                self.assertEqual(len(problems({A: text})), 1)

    def test_flags_an_added_patch_line_only(self):
        url = '"chrome://browser/content/sval/icons/pin.svg"'
        self.assertEqual(len(problems({"patches/a.patch": f"+  iconSrc: {url},\n"})), 1)
        self.assertEqual(problems({"patches/a.patch": f"-  iconSrc: {url},\n"}), [])

    def test_flags_an_unknown_name(self):
        for text in (".a { mask: var(--sval-icon-pinn); }", 'iconURL("pinn")'):
            with self.subTest(text):
                self.assertEqual(problems({A: text}), [(A, 1, "no icon named pinn in SvalIcons.sys.mjs")])

    def test_flags_a_path_jar_lacks(self):
        self.assertEqual(
            problems({}, jar="# BEGIN Firefox icons\n# END Firefox icons\n    content/browser/sval/icons/pin.svg (icons/pin.svg)\n"),
            [(str(check.INVENTORY), 0, "site-camera: protection-icons/sc-camera.svg is not in jar.mn")],
        )

    def test_flags_an_override_onto_art_the_inventory_lacks(self):
        jar = JAR + "    content/browser/sval/icons/x.svg (icons/x.svg)\n"
        for target, flagged in (("icons/x.svg", 1), ("icons/pin.svg", 0), ("illustrations/a.svg", 0)):
            with self.subTest(target):
                line = f"% override chrome://global/skin/icons/a.svg chrome://browser/content/sval/{target}\n"
                self.assertEqual(len(problems({}, jar=jar + line)), flagged)

    def test_a_copy_takes_firefox_s_size_and_proportions(self):
        svg = '<svg\n  xmlns="http://www.w3.org/2000/svg"\n  width="24"\n  height="24"\n  viewBox="0 0 24 24"\n  stroke="context-fill #000"\n>\n  <path d="M1 1" />\n</svg>\n'
        square = check.make_copy(svg, 16, 16, True)
        self.assertIn('width="16"', square)
        self.assertIn('viewBox="0 0 24 24"', square)
        self.assertIn("stroke: context-fill #060a2e", square)
        wide = check.make_copy(svg, 54, 42, False)
        self.assertNotIn("width=", wide)
        self.assertIn('viewBox="-3.429 0 30.857 24"', wide)

    def test_flags_a_copy_firefox_icons_does_not_make(self):
        firefox = '\nexport const FIREFOX_ICONS = Object.freeze({\n  "chrome://global/skin/icons/a.svg": ["pin", 16, 16, true],\n});\n'
        found = problems({"chrome/browser/components/sval/icons/pin.svg": '<svg\n  viewBox="0 0 24 24"\n  stroke="context-fill #000"\n>\n</svg>\n'}, inventory=INVENTORY + firefox)
        self.assertIn("its Firefox icons block differs from FIREFOX_ICONS", [m for _, _, m in found])
        self.assertIn(str(check.COPIES / "pin-16x16.svg"), [f for f, _, _ in found])

    def test_flags_a_stale_sheet(self):
        self.assertEqual(problems({}, sheet=":root {}\n")[0][0], str(check.SHEET))

    def test_passes_the_near_misses(self):
        for text in (
            ".a { mask: var(--sval-icon-pin); }",
            'iconURL("site-camera")',
            '.a { mask: url("chrome://global/skin/icons/close.svg"); }',
            '.a { background: url("chrome://browser/content/sval/search-icons/kagi.png"); }',
            "option.style.setProperty('--sval-row-icon', `var(--sval-icon-${name})`);",
        ):
            with self.subTest(text):
                self.assertEqual(problems({A: text}), [])


if __name__ == "__main__":
    unittest.main()
