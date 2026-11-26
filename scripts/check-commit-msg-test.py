#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-commit-msg.py still flags the subjects it exists
for and passes the ones it must.

A rule that stops matching passes every subject, so each has subjects it must
flag and near-misses it must pass, and one case runs the script in a fresh git
repository to prove it reads only the commits a branch adds.

    python3 scripts/check-commit-msg-test.py

scripts/lint.sh runs it.
"""

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-commit-msg.py"
spec = importlib.util.spec_from_file_location("check_commit_msg", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class Subjects(unittest.TestCase):
    def test_flags(self):
        for subject in [
            "The Windows installer keeps to Sval's own registry keys",
            "Pins are left out of the Favorites menus",
            "A tab's menu in the panel adds its page to Favorites",
            "ci-image.sh prunes only the registry's images",
            "Settings: the sync row shows its state",
            "Adds the sync row",
            "Fixed the sync row",
            "Fix the sync row.",
            "Fix the sync row — and its label",
            "Fix " + "x" * check.MAX_LENGTH,
            "WIP: The sync row shows its state",
            "",
        ]:
            with self.subTest(subject=subject):
                self.assertTrue(check.problems(subject))

    def test_passes(self):
        for subject in [
            "Fix the sync row's label",
            "Remove pins from the Favorites menus",
            "ci-image.sh: prune only the registry's own tags",
            "Settings: show the sync row's state",
            "sval-mcp: re-run the handshake after an update",
            "Re-run CI",
            "WIP: Add the sync row",
            "Merge branch 'main' into sync-row",
            'Revert "The sync row shows its state"',
            "fixup! Fix the sync row",
            "Update dependency serde to v1.0.300",
        ]:
            with self.subTest(subject=subject):
                self.assertEqual(check.problems(subject), [])

    def test_title_flags(self):
        for subject in [
            "Fix the sync row's label",
            "Settings: show the sync row's state",
            "feature: Add the sync row",
            "Fix(sync): keep the row",
            "fix (sync): keep the row",
            "fix(sync): The sync row shows its state",
            "WIP: Add the sync row",
            "perf(ios): Redraw only the bar's fold while a page scrolls",
            "fix(read-profile): Read a marker's name stored as a string index",
            "improve(ios): Draw the sheet's list in the grid's collection view",
        ]:
            with self.subTest(subject=subject):
                self.assertTrue(check.problems(subject, title=True))

    def test_title_passes(self):
        for subject in [
            "fix: Keep pinned tabs in their group",
            "fix(sync): Keep pinned tabs in their group",
            "ci(ci-image.sh): prune only the registry's own tags",
            "feat(Settings): Add the sync row",
            "WIP: feat: Add the sync row",
            "build(deps): update dependency serde to v1.0.300",
            "security(deps): update dependency mozilla-firefox/firefox",
            'Revert "fix: Keep pinned tabs in their group"',
            "refactor(ios): Draw the grid from one list of lines",
            "test(peek): Read the reopened Peek's page before loading another",
        ]:
            with self.subTest(subject=subject):
                self.assertEqual(check.problems(subject, title=True), [])

    def test_commit_takes_a_type(self):
        self.assertEqual(check.problems("fix(sync): Keep pinned tabs"), [])
        self.assertTrue(check.problems("fix(sync): Pinned tabs stay"))
        self.assertEqual(check.problems("perf(ios): Redraw only the bar"), [])

    def test_file_skips_comments(self):
        with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f:
            f.write("# Please enter the commit message\n\nFix the sync row\n")
        try:
            self.assertEqual(check.subject_of_file(f.name), "Fix the sync row")
        finally:
            Path(f.name).unlink()


class Branch(unittest.TestCase):
    def test_reads_only_the_branch(self):
        repo = Path(tempfile.mkdtemp())
        try:
            (repo / "scripts").mkdir()
            shutil.copy(SCRIPT, repo / "scripts" / SCRIPT.name)

            def git(*args):
                subprocess.run(["git", "-C", str(repo), *args], check=True,
                               capture_output=True)

            git("init", "-q", "-b", "main")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
                "--allow-empty", "-m", "The old history reads like this")
            git("branch", "base")
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
                "--allow-empty", "-m", "Add the sync row")
            run = lambda: subprocess.run(
                [sys.executable, str(repo / "scripts" / SCRIPT.name), "--base", "base"],
                capture_output=True, text=True)
            self.assertEqual(run().returncode, 0, run().stderr)
            git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
                "--allow-empty", "-m", "The sync row shows its state")
            self.assertEqual(run().returncode, 1)
        finally:
            shutil.rmtree(repo)


if __name__ == "__main__":
    unittest.main()
