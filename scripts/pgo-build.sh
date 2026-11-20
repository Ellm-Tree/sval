#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Compile a release's Gecko with profile-guided optimisation, on a machine
# that runs what it compiles: linux64, and macOS for both targets. These are
# the steps of Mozilla's shippable builds (taskcluster's generate-profile
# kind, taskcluster/scripts/misc/run-profileserver.sh):
#   1. compile and package an instrumented browser (SVAL_PGO=generate);
#   2. run build/pgo/profileserver.py with the package it staged, which
#      writes merged.profdata and the jar log;
#   3. remove the objdir and compile again with both (SVAL_PGO=use).
# win64 is cross-compiled, so its step 2 runs on Windows (gecko.yml's
# profile-win64) and scripts/release-compile.sh does steps 1 and 3 apart.
#
# The environment is scripts/build.sh's: SVAL_MODE=gecko, SVAL_TARGET and
# the release's variables. On Linux without a display, the profile run gets
# one from Xvfb.
#
# Usage: ./scripts/pgo-build.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"
PGO="$REPO_ROOT/build/pgo"

[[ "${SVAL_MODE:-}" == gecko ]] || { echo "error: PGO compiles Gecko; set SVAL_MODE=gecko" >&2; exit 1; }

# Mozilla's build has install races at high parallelism; a second,
# incremental `mach build` finishes what the first left (gecko.yml). It reads
# the mozconfig again, so SVAL_PGO stays exported for it.
compile() {
  "$REPO_ROOT/scripts/build.sh" || (cd "$SRC" && ./mach --no-interactive build)
}

objdir() {
  (cd "$SRC" && ./mach environment --format json) |
    python3 -I -c 'import json, sys; print(json.load(sys.stdin)["topobjdir"])'
}

echo "==> PGO 1/3: compiling the instrumented browser"
export SVAL_PGO=generate
compile
(cd "$SRC" && ./mach --no-interactive package)

echo "==> PGO 2/3: running the profile"
OBJDIR="$(objdir)"
rm -rf "$PGO"
mkdir -p "$PGO"
LLVM_PROFDATA="$(cd "$SRC" && ./mach python -c 'import buildconfig; print(buildconfig.substs["LLVM_PROFDATA"])' | tail -1)"
display=()
if [[ "$(uname -s)" == Linux && -z "${DISPLAY:-}" ]]; then
  display=(xvfb-run -a -s "-screen 0 1600x1200x24")
fi
# profileserver.py runs the objdir's staged package, writes the raw profiles
# to its working directory and merges them there, as mach's own PGO build
# runs it (python/mozbuild/mozbuild/build_commands.py).
(cd "$OBJDIR" &&
  LLVM_PROFDATA="$LLVM_PROFDATA" JARLOG_FILE="$PGO/en-US.log" \
    "${display[@]}" "$SRC/mach" python "$SRC/build/pgo/profileserver.py")
mv "$OBJDIR/merged.profdata" "$PGO/merged.profdata"
# The packager reads the jar log only if it exists (packager.mk), so a
# missing one would ship jars with nothing preloaded.
[[ -s "$PGO/en-US.log" ]] || { echo "error: the profile run wrote no jar log" >&2; exit 1; }

echo "==> PGO 3/3: compiling with the profile"
rm -rf "$OBJDIR"
export SVAL_PGO=use SVAL_PGO_PROFILE="$PGO/merged.profdata" SVAL_PGO_JARLOG="$PGO/en-US.log"
compile
