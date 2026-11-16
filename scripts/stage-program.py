# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
"""Build one of Sval's own programs in tools/ for the tree's target and put it
where the package manifest names it, beside the browser binary:

- sval-mcp, the shim agents launch (patches/package-sval-mcp.patch,
  sval-mcp-ships-with-sval spec §3);
- sval-folder, the helper the browser runs to read and write a shared folder
  (patches/package-sval-folder.patch, decision 1437).

Each is built with the browser's build id and version, so Sval's own
installer and updater ship it at the browser's build.

The programs are built here and never by the Gecko compile, so a change to one
moves no Gecko key. A compiled build names its Rust target and toolchain in
its substs, and a win64 cross-compile links with the lld-link and the LIB path
its configure found. An artifact build compiles no Rust and runs on the
platform it packages for, so it builds for the host.

Run through mach, which provides buildconfig: scripts/stage-sval-mcp.sh and
scripts/stage-sval-folder.sh.

    stage-program.py <sval-mcp|sval-folder>
"""

import os
import platform
import re
import shutil
import subprocess
import sys
from pathlib import Path

import buildconfig

REPO_ROOT = Path(__file__).resolve().parent.parent
PROGRAMS = ("sval-mcp", "sval-folder")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in PROGRAMS:
        sys.exit(f"usage: {sys.argv[0]} <{'|'.join(PROGRAMS)}>")
    name = sys.argv[1]
    substs = buildconfig.substs
    objdir = Path(buildconfig.topobjdir)
    target = substs.get("RUST_TARGET") or ""
    suffix = substs.get("BIN_SUFFIX") or ""

    platform_ini = (objdir / "dist/bin/platform.ini").read_text()
    build_id = next(iter(re.findall(r"^BuildID=(.+)$", platform_ini, re.M)), "")
    if not build_id:
        sys.exit(f"error: {objdir}/dist/bin/platform.ini has no BuildID; build the tree first")

    out = objdir / name
    args = [substs.get("CARGO") or "cargo", "build", "--release", "--locked"]
    args += ["--manifest-path", str(REPO_ROOT / "tools" / name / "Cargo.toml")]
    release = out / "release"
    if target:
        args += ["--target", target]
        release = out / target / "release"

    env = dict(os.environ, SVAL_BUILD_ID=build_id, CARGO_TARGET_DIR=str(out))
    if substs.get("MOZ_APP_VERSION_DISPLAY"):
        env["SVAL_APP_VERSION"] = substs["MOZ_APP_VERSION_DISPLAY"]
    if substs.get("RUSTC"):
        env["RUSTC"] = substs["RUSTC"]
    if target.endswith("-windows-msvc") and platform.system() != "Windows":
        linker = "CARGO_TARGET_" + target.upper().replace("-", "_") + "_LINKER"
        env[linker] = substs.get("LINKER") or ""
        env["LIB"] = substs.get("LIB") or ""

    print(f"==> Building {name} {target or 'for the host'}, build {build_id}", flush=True)
    subprocess.run(args, env=env, check=True)
    # macOS packages from the app bundle the build assembled in dist, whose
    # Contents/MacOS is the manifest's @BINPATH@, and mach runs the bundle's
    # xpcshell there too (get_binary_path in python/mozbuild/mozbuild/base.py).
    dest = objdir / "dist/bin"
    if substs.get("OS_ARCH") == "Darwin":
        dest = objdir / "dist" / substs["MOZ_MACBUNDLE_NAME"] / "Contents/MacOS"
    shutil.copy2(release / f"{name}{suffix}", dest / f"{name}{suffix}")
    print(f"==> Staged {dest}/{name}{suffix}")

if __name__ == "__main__":
    main()
