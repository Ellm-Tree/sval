#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Checks that scripts/check-licenses.py still fails on each shape it exists for.

Each case copies the checker into a fresh git repository that passes, adds one
file or change, and runs it there as CI does: the checker reads the repository
it sits in. A check that stops matching would otherwise pass every file. The
notices below are assembled from parts, so this file's own header is the only
notice the real check finds in it.

    python3 scripts/check-licenses-test.py

scripts/lint.sh runs it.
"""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent / "check-licenses.py"

SPDX = "SPDX-License-" + "Identifier: "
SVAL_ID = "AGPL-3.0-only WITH AdditionRef-sval-app-store"
SVAL_NOTICE = f"// {SPDX}{SVAL_ID}\n// Copyright 2026 Ellm Tree, Inc.\n"
MPL_NOTICE = (
    "/* This Source Code Form is subject to the terms of the Mozilla " + "Public\n"
    " * License, v. 2.0. If a copy of the MPL was not distributed with this\n"
    " * file, You can obtain one at http://mozilla.org/MPL/2.0/. */\n"
)
REUSE_TOML = """\
version = 1

[[annotations]]
path = ["data/*.json"]
SPDX-License-Identifier = "AGPL-3.0-only WITH AdditionRef-sval-app-store"

[[annotations]]
path = "mozilla/*.js"
SPDX-License-Identifier = "MPL-2.0"
"""


class Repo:
    def __init__(self, root):
        self.root = root
        self.write("scripts/check-licenses.py", SCRIPT.read_text())
        self.write("REUSE.toml", REUSE_TOML)
        self.write("LICENSES/AGPL-3.0-only.txt", "text\n")
        self.write("LICENSES/AdditionRef-sval-app-store.txt", "text\n")
        self.write("LICENSES/MPL-2.0.txt", "text\n")
        self.write("sval.js", SVAL_NOTICE + "export {};\n")
        self.write("mozilla/upstream.js", MPL_NOTICE + "export {};\n")
        self.write("data/settings.json", "{}\n")
        subprocess.run(["git", "init", "-q", str(root)], check=True)

    def write(self, path, text):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text)

    def problems(self):
        result = subprocess.run(
            [sys.executable, str(self.root / "scripts/check-licenses.py")],
            capture_output=True,
            text=True,
        )
        problems = [
            line.removeprefix("error: ")
            for line in result.stdout.splitlines()
            if line.startswith("error: ")
        ]
        if (result.returncode == 0) == bool(problems):
            raise AssertionError(f"exit {result.returncode} with {problems}: {result.stderr}")
        return problems


class CheckLicenses(unittest.TestCase):
    def setUp(self):
        root = Path(tempfile.mkdtemp(prefix="check-licenses-test-"))
        self.addCleanup(shutil.rmtree, root)
        self.repo = Repo(root)

    def assertOnly(self, fragment):
        problems = self.repo.problems()
        self.assertEqual(len(problems), 1, problems)
        self.assertIn(fragment, problems[0])

    def test_the_fixture_passes(self):
        self.assertEqual(self.repo.problems(), [])

    def test_a_sval_file_without_the_notice_fails(self):
        self.repo.write("new.js", "export {};\n")
        self.assertOnly("new.js: Sval's file without Sval's notice")

    def test_a_notice_without_the_copyright_line_fails(self):
        self.repo.write("new.js", f"// {SPDX}{SVAL_ID}\n")
        self.assertOnly("new.js: Sval's file without Sval's notice")

    def test_a_contributors_copyright_line_passes(self):
        self.repo.write("new.js", f"// {SPDX}{SVAL_ID}\n// Copyright 2026 Ada Lovelace\n")
        self.assertEqual(self.repo.problems(), [])

    def test_a_notice_below_the_first_lines_fails(self):
        self.repo.write("new.js", "\n" * 12 + SVAL_NOTICE)
        self.assertOnly("new.js: Sval's file without Sval's notice")

    def test_a_notice_after_a_shebang_passes(self):
        self.repo.write("tool.py", "#!/usr/bin/env python3\n" + SVAL_NOTICE.replace("//", "#"))
        self.assertEqual(self.repo.problems(), [])

    def test_a_sval_file_with_the_mpl_header_fails(self):
        self.repo.write("new.js", SVAL_NOTICE + MPL_NOTICE)
        self.assertOnly("new.js: Sval's file still carries the MPL header")

    def test_a_mozilla_file_without_its_header_fails(self):
        self.repo.write("mozilla/upstream.js", "export {};\n")
        self.assertOnly("mozilla/upstream.js: Mozilla-derived, and its MPL header is missing")

    def test_a_mozilla_file_with_svals_notice_fails(self):
        self.repo.write("mozilla/upstream.js", MPL_NOTICE + SVAL_NOTICE)
        self.assertOnly("mozilla/upstream.js: Mozilla-derived, but carries Sval's notice")

    def test_a_star_does_not_cross_a_directory(self):
        self.repo.write("mozilla/deeper/upstream.js", MPL_NOTICE)
        problems = self.repo.problems()
        self.assertIn(
            "mozilla/deeper/upstream.js: Sval's file still carries the MPL header", problems
        )

    def test_an_unclassified_file_that_cannot_carry_a_comment_fails(self):
        self.repo.write("other.json", "{}\n")
        self.assertOnly("other.json: cannot carry a comment and REUSE.toml does not classify it")

    def test_an_annotation_that_matches_nothing_fails(self):
        (self.repo.root / "data/settings.json").unlink()
        self.assertOnly("REUSE.toml: ['data/*.json'] match no file")

    def test_an_annotation_a_later_one_overrides_everywhere_passes(self):
        self.repo.write("REUSE.toml", REUSE_TOML + '''
[[annotations]]
path = "data/**"
SPDX-License-Identifier = "AGPL-3.0-only WITH AdditionRef-sval-app-store"
''')
        self.assertEqual(self.repo.problems(), [])

    def test_a_license_without_its_text_fails(self):
        (self.repo.root / "LICENSES/MPL-2.0.txt").unlink()
        self.assertOnly("LICENSES/MPL-2.0.txt: missing, and MPL-2.0 is in use")

    def test_a_license_named_only_in_a_file_needs_its_text(self):
        self.repo.write("new.js", SVAL_NOTICE + f"// {SPDX}MIT\n")
        self.assertOnly("LICENSES/MIT.txt: missing, and MIT is in use")

    def test_the_app_store_permission_needs_its_text(self):
        (self.repo.root / "LICENSES/AdditionRef-sval-app-store.txt").unlink()
        self.assertOnly(
            "LICENSES/AdditionRef-sval-app-store.txt: missing, and AdditionRef-sval-app-store is in use"
        )

    def test_a_polyform_notice_fails(self):
        self.repo.write("new.js", f"// {SPDX}PolyForm-Noncommercial-1.0.0\n// Copyright 2026 Ellm Tree, Inc.\n")
        problems = self.repo.problems()
        self.assertIn("new.js: Sval's file without Sval's notice", problems[0])

    def test_about_license_showing_a_stale_license_text_fails(self):
        page = "chrome/browser/base/content/overrides/app-license.html"
        self.repo.write(page, f"<!-- {SPDX}{SVAL_ID}\n   - Copyright 2026 Ellm Tree, Inc. -->\n<pre>text\n</pre>\n")
        self.assertEqual(self.repo.problems(), [])
        self.repo.write("LICENSES/AdditionRef-sval-app-store.txt", "new text\n")
        self.assertOnly(f"{page}: does not show LICENSES/AdditionRef-sval-app-store.txt")

    def test_a_brand_art_notice_that_differs_from_its_copy_fails(self):
        self.repo.write("branding/sval/LICENSE", "one\n")
        self.repo.write("LICENSES/LicenseRef-sval-brand-art.txt", "two\n")
        self.assertOnly("branding/sval/LICENSE and LICENSES/LicenseRef-sval-brand-art.txt differ")


if __name__ == "__main__":
    unittest.main(verbosity=1)
