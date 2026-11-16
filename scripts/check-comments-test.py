#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-comments.py still flags each pattern it exists for.

A pattern that stops matching passes every line, so each rule has comments it
must flag and near-misses it must pass, and one case runs the script in a
fresh git repository to prove it reads only the lines a branch adds. The
banned text below is assembled from parts, so this file passes its own check.

    python3 scripts/check-comments-test.py

scripts/lint.sh runs it.
"""

import importlib.util
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-comments.py"
spec = importlib.util.spec_from_file_location("check_comments", SCRIPT)
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)

DASH = "—"
HASH = "#"

FLAGGED = [
    ("a.js", f"// The tab closes {DASH} and the node goes.", "em dash"),
    ("a.rs", f"/// The merge keeps it (Sval/sval{HASH}499).", "issue or PR number"),
    ("a.sh", f"# Held so since {HASH}943.", "issue or PR number"),
    ("a.mjs", "  // See PR 12 for the reason.", "issue or PR number"),
    ("a.js", " * as `tabbrowser.js:" + "5837` does", "line number"),
    ("a.py", "# catalogue §1 line " + "3", "line number"),
    ("a.js", "// " + "This fix keeps the tab.", "words that need a diff"),
    ("a.mjs", " * (§10.7, Task " + "6)", "words that need a diff"),
    ("a.rs", "// " + "Critically, the order holds.", "intensifier"),
    ("a.yml", "  # --all-targets is load-" + "bearing", "intensifier"),
    ("a.js", "let x = 1; // what it " + "actually holds", "intensifier"),
    ("a.xhtml", "<!-- " + "Crucially, first. -->", "intensifier"),
]

PASSED = [
    ("a.js", "const dash = '—';"),
    ("a.css", "/* The switch is #333 on white. */"),
    ("a.rs", "#[derive(Debug)]"),
    ("a.sh", "#!/usr/bin/env bash"),
    ("a.js", "// spec §13 item 3 names the default engine."),
    ("a.js", "// Call before the change, await after it."),
    ("a.mjs", "// A node no longer in the tree is skipped."),
    ("a.js", "// decision 0111"),
    ("a.md", f"Prose {DASH} with a dash."),
    ("patches/a.patch", f"+// Mozilla's {DASH} code"),
    ("a.js", "const url = 'https://example.com/x#12';"),
    ("a.css", "/* Muted text stays at 4.5:1 on white. */"),
    ("a.rs", "/// A rustc defect (rust-lang/rust#114554)."),
]


class Rules(unittest.TestCase):
    def test_flags_each_pattern(self):
        for path, line, rule in FLAGGED:
            with self.subTest(line=line):
                self.assertIn(rule, check.findings(path, line))

    def test_passes_near_misses(self):
        for path, line in PASSED:
            with self.subTest(line=line):
                self.assertEqual(check.findings(path, line), [])


class Script(unittest.TestCase):
    def test_reads_only_added_lines(self):
        root = Path(tempfile.mkdtemp())
        try:
            (root / "scripts").mkdir()
            shutil.copy(SCRIPT, root / "scripts/check-comments.py")
            old = f"// Old {DASH} text.\n"
            (root / "a.js").write_text(old)
            git = ["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t"]
            subprocess.run([*git, "init", "-q", "-b", "main"], check=True)
            subprocess.run([*git, "add", "."], check=True)
            subprocess.run([*git, "commit", "-qm", "base"], check=True)
            base = subprocess.run([*git, "rev-parse", "HEAD"], check=True,
                                  capture_output=True, text=True).stdout.strip()
            run = [sys.executable, str(root / "scripts/check-comments.py"), "--base", base]

            (root / "a.js").write_text(old + "// New text.\n")
            self.assertEqual(subprocess.run(run, capture_output=True).returncode, 0)

            (root / "a.js").write_text(old + f"// New {DASH} text.\n")
            done = subprocess.run(run, capture_output=True, text=True)
            self.assertEqual(done.returncode, 1)
            self.assertIn("a.js:2: em dash", done.stdout)
        finally:
            shutil.rmtree(root)


if __name__ == "__main__":
    unittest.main()
