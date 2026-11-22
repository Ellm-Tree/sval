#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-rhythm.py still flags what it exists for.

A threshold that drifts passes every file, so each case names a paragraph
the check must flag and a near miss it must pass.

    python3 scripts/check-rhythm-test.py

scripts/lint.sh runs it.
"""

import importlib.util
import pathlib
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "check-rhythm.py"
spec = importlib.util.spec_from_file_location("check_rhythm", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


def flagged(text):
    return [m for _, prose in check.paragraphs(text) for m in check.faults(prose)]


class Rhythm(unittest.TestCase):
    def test_flags_clipped_sentences(self):
        text = (
            "A cookie banner on every visit? Point at it with Sval's Remove "
            "tool. A slider widens the choice from a link to the whole box. "
            "Sval saves a rule, so it stays gone on that site and on your "
            "other devices. Undo brings it back.\n"
        )
        self.assertTrue(any("averaging" in m for m in flagged(text)))

    def test_flags_a_run_of_short_sentences(self):
        text = (
            "Sval keeps every Workspace you make in your sync folder, along "
            "with its tabs and groups and the order you left them in. The "
            "button shows it. The site gets silence. It doesn't ask again.\n"
        )
        self.assertTrue(any("in a row" in m for m in flagged(text)))

    def test_flags_sentences_of_one_length(self):
        text = (
            "Each of your devices writes its changes to the folder. Each "
            "device also reads the other devices' changes from the folder. "
            "Whatever carries the folder between devices carries Workspaces "
            "too. That's your cloud service, your network, or a drive.\n"
        )
        self.assertTrue(any("one length" in m for m in flagged(text)))

    def test_flags_too_many_pauses(self):
        text = (
            "To show a removed part again, open Removal rules for this site "
            "in the site settings menu, then select Show again. Snip, the "
            "scissors button, removes a part only until you reload.\n"
        )
        self.assertTrue(any("per 100 words" in m for m in flagged(text)))

    def test_passes_flowing_prose(self):
        text = (
            "Sval can wipe a cookie banner off a site for good. Click the "
            "banner, slide to grab the whole box, and it stays gone on every "
            "visit and every device you sync.\n\n"
            "Remove from this site lives in the address bar's site settings "
            "menu. Pick anything on a page and Sval hides it on every visit, "
            "across every device you sync. Undo brings it right back if you "
            "slip.\n"
        )
        self.assertEqual(flagged(text), [])

    def test_skips_steps_code_tables_and_labels(self):
        text = (
            "---\ntitle: Short. Lines. Here.\n---\n\n"
            "1. Select the tab.\n2. Press Delete.\n3. Close it.\n\n"
            "```\nShort. Lines. Here. Again.\n```\n\n"
            "| Short. | Lines. Here. Again. |\n\n"
            "- **Undo.** Puts the tab back in the Workspace where you left it "
            "a moment ago, with its history and its place in the group.\n"
        )
        self.assertEqual(flagged(text), [])


if __name__ == "__main__":
    unittest.main()
