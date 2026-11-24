#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Write the source of a Sval release's MPL 2.0 files as one archive.

    scripts/mpl-source.py VERSION OUT

MPL 2.0 section 3.2 makes whoever ships a binary of MPL files make their
source available. The archive holds every file REUSE.toml classifies as
MPL-2.0, the patch series' order, MPL 2.0's text, and a README naming the
Mozilla commit the patches apply to. It holds nothing under Sval's own
license besides the series' order, so it can be published before the
repository is.

The archive is the same bytes for the same commit: entries are sorted, owned
by root, and dated at the commit.
"""

import importlib.util
import io
import pathlib
import subprocess
import sys
import tarfile

REPO = pathlib.Path(__file__).resolve().parent.parent

spec = importlib.util.spec_from_file_location("check_licenses", REPO / "scripts/check-licenses.py")
check_licenses = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_licenses)

README = """\
Sval {version}: the source of its MPL 2.0 files

Sval is built from Firefox ESR, Mozilla's commit
{ref}
of {remote}.

- patches/ holds Sval's changes to Mozilla's files. Apply them to that
  commit in the order patches/series lists: a .patch with `git apply`, and
  a .delete by deleting each file it lists.
- chrome/ holds files Sval adds to Mozilla's tree, at the same paths
  without the leading chrome/.
- branding/sval/ is copied to browser/branding/sval/.
- packaging/linux/ holds the templates of the .deb and .rpm packages.

Each file is under the Mozilla Public License 2.0, in LICENSES/MPL-2.0.txt.
"""


def git(*args):
    return subprocess.run(
        ["git", "-C", str(REPO), *args], capture_output=True, text=True, check=True
    ).stdout


def upstream():
    values = {}
    for line in (REPO / "upstream.txt").read_text().splitlines():
        key, sep, value = line.partition("=")
        if sep and not line.startswith("#"):
            values[key] = value
    return values["UPSTREAM_REMOTE"], values["UPSTREAM_REF"]


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__.split("\n\n")[1])
    version, out = sys.argv[1], sys.argv[2]

    annotations = check_licenses.load_annotations()
    modes = {}
    for line in git("ls-files", "-s", "-z").split("\0"):
        if line:
            meta, path = line.split("\t", 1)
            modes[path] = 0o755 if meta.split()[0] == "100755" else 0o644
    files = sorted(
        p for p in modes if "MPL-2.0" in (check_licenses.classify(p, annotations) or "")
    )
    files += ["patches/series", "LICENSES/MPL-2.0.txt"]

    remote, ref = upstream()
    mtime = int(git("log", "-1", "--format=%ct").strip())
    root = f"sval-{version}-source-mpl"

    def entry(name, size, mode):
        info = tarfile.TarInfo(f"{root}/{name}")
        info.size, info.mode, info.mtime = size, mode, mtime
        info.uid = info.gid = 0
        info.uname = info.gname = "root"
        return info

    with tarfile.open(out, "w:xz", format=tarfile.PAX_FORMAT) as tar:
        readme = README.format(version=version, ref=ref, remote=remote).encode()
        tar.addfile(entry("README", len(readme), 0o644), io.BytesIO(readme))
        for path in sorted(files):
            data = (REPO / path).read_bytes()
            tar.addfile(entry(path, len(data), modes[path]), io.BytesIO(data))
    print(f"{out}: {len(files)} files")


if __name__ == "__main__":
    main()
