#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""check-ui-labels.py must flag a control Sval does not show and pass one it
does, from a step's bold name and from each part of a Settings path, with
Fluent terms read as Sval's brand.ftl defines them."""

import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parent / "check-ui-labels.py"

PAGE = """---
title: t
---

- **Not a control** is a list label outside a step.

1. Right-click the tab, then choose **Move to Workspace**.
2. Go to Settings › Fake Pane, then select **Move to Galaxy**.
3. Select **About Sval**.
4. Open Settings › Fake Pane › Qzxv Row.
5. Open Settings › Fake Pane shows the rows.

<Until v="9.9.9">

1. Select **Retired Galaxy Button**, a name the release before this one had.

</Until>

1. Select **Back Again Galaxy**.
"""


class Labels(unittest.TestCase):
    def test_flags_only_what_sval_does_not_show(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            strings = tmp / "firefox/browser/locales/en-US"
            strings.mkdir(parents=True)
            (strings / "fake.ftl").write_text(
                "-brand-short-name = Firefox\nfake-pane = Fake Pane\nabout = About { -brand-short-name }\n")
            docs = tmp / "docs"
            docs.mkdir()
            (docs / "page.md").write_text(PAGE)
            run = subprocess.run(
                [sys.executable, str(SCRIPT), str(docs)],
                env={**os.environ, "SVAL_FIREFOX_TREE": str(tmp / "firefox")},
                capture_output=True, text=True,
            )
            self.assertEqual(run.returncode, 1)
            flagged = [line.split('"')[1] for line in run.stdout.splitlines()]
            self.assertEqual(
                flagged, ["Move to Galaxy", "Qzxv Row", "Back Again Galaxy"]
            )


if __name__ == "__main__":
    unittest.main()
