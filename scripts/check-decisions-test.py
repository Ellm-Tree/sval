#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-decisions.py still flags what it exists for.

A pattern that stops matching passes every record, so each rule has a record
it must flag and one it must pass. Citations below are assembled from parts,
so this file passes the script's own citation check.

    python3 scripts/check-decisions-test.py

scripts/lint.sh runs it.
"""

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-decisions.py"
spec = importlib.util.spec_from_file_location("check_decisions", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

NAME = "0042-a-thing.md"
DECISION = "Decision"


def record(title="# 0042. A thing", status="**Status:** Accepted on 2026-10-01.",
           body="Tabs sync."):
    return (f"{title}\n\n{status}\n\n## Context\n\n{body}\n\n"
            f"## {DECISION}\n\nIt holds.\n\n## Consequences\n\nNone.\n")


def problems(text, name=NAME):
    return [problem for _, problem in check.record_findings(name, text)]


class Records(unittest.TestCase):
    def test_a_clean_record_passes(self):
        self.assertEqual(problems(record()), [])

    def test_a_specified_status_passes(self):
        status = ("**Status:** Accepted on 2026-10-01. Specified in\n"
                  "`2026-09-24-sval-browser-design.md`, §5.3 and §6.2.")
        self.assertEqual(problems(record(status=status)), [])

    def test_a_lettered_number_passes(self):
        self.assertEqual(problems(record(title="# 1052b. A thing"), "1052b-a-thing.md"), [])

    def test_a_title_with_another_number_fails(self):
        self.assertTrue(problems(record(title="# 0043. A thing")))

    def test_an_undated_status_fails(self):
        self.assertTrue(problems(record(status="**Status:** Accepted")))

    def test_a_status_with_progress_fails(self):
        status = "**Status:** Accepted on 2026-10-01, by the owner. Built, apart from import."
        self.assertTrue(problems(record(status=status)))

    def test_an_extra_section_fails(self):
        text = record() + "\n## Amended 2026-11-01\n\nMore.\n"
        self.assertTrue(problems(text))

    def test_an_issue_number_fails(self):
        self.assertTrue(problems(record(body="Closed by Sval/sval" + "#194.")))

    def test_history_words_fail(self):
        for body in ("Pins no " + "longer sync.", "Spec §7 once " + "had a rule.",
                     "This amend" + "s 0077.", "No " + "migration: no users."):
            with self.subTest(body=body):
                self.assertTrue(problems(record(body=body)))

    def test_present_tense_rejection_passes(self):
        body = "Per-tab control is rejected: an agent's tabs share one window."
        self.assertEqual(problems(record(body=body)), [])


class Citations(unittest.TestCase):
    def test_finds_each_number_in_a_list(self):
        line = "as decisions " + "0101, 0106 and 0137 say"
        self.assertEqual(list(check.cited(line)), ["0101", "0106", "0137"])

    def test_finds_a_path(self):
        line = "see docs/decisions/" + "1052b-x.md"
        self.assertEqual(list(check.cited(line)), ["1052b"])

    def test_ignores_a_bare_number(self):
        self.assertEqual(list(check.cited("a 1000-byte limit in 2026")), [])


if __name__ == "__main__":
    sys.exit(0 if unittest.main(exit=False).result.wasSuccessful() else 1)
