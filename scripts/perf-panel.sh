#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Time the Workspace panel with thousands of tabs. A test profile gets N tabs
# across 20 Workspaces, a third of them in one Workspace nested 13 groups
# deep, and each step is timed: switching into that Workspace, a first
# render, an unchanged render, a sound change, a title change, opening a tab
# and closing ten at once, with the tree reads and renders each took.
#
#   scripts/perf-panel.sh                         # 3,000 tabs
#   scripts/perf-panel.sh --sizes 1000,3000
#   scripts/perf-panel.sh --label before          # names the results file
#   scripts/perf-panel.sh --profile open-tab      # a Gecko profile of steps
#
# The test, scripts/perf/panel-scale.js, is in none of the suites: this adds
# it to the build tree's browser-chrome manifest for the run and puts the
# manifest back after. It runs through scripts/test.sh in a built worktree.
# Results and profiles go to build/perf/panel-<time>/.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"
DIR=browser/components/sval/test/browser
NAME=browser_sval_panel_scale_perf.js

SIZES=3000
LABEL=run
PROFILE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sizes) SIZES="$2"; shift 2 ;;
    --label) LABEL="$2"; shift 2 ;;
    --profile) PROFILE="$2"; shift 2 ;;
    *) echo "perf-panel: unknown argument $1" >&2; exit 1 ;;
  esac
done

MANIFEST="$SRC/$DIR/browser.toml"
[[ -f "$MANIFEST" ]] || {
  echo "perf-panel: no build tree; run scripts/build-worktree.sh" >&2
  exit 1
}
OUT="$REPO_ROOT/build/perf/panel-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUT"
ORIGINAL="$(mktemp "$OUT/browser.toml.XXXXXX")"
cp "$MANIFEST" "$ORIGINAL"
restore() {
  cp "$ORIGINAL" "$MANIFEST"
  rm -f "$ORIGINAL" "$SRC/$DIR/$NAME"
}
trap restore EXIT
cp "$REPO_ROOT/scripts/perf/panel-scale.js" "$SRC/$DIR/$NAME"
printf '\n["%s"]\n' "$NAME" >>"$MANIFEST"

status=0
SVAL_PERF_OUT="$OUT" SVAL_PERF_SIZES="$SIZES" SVAL_PERF_LABEL="$LABEL" \
  SVAL_PERF_PROFILE="$PROFILE" "$REPO_ROOT/scripts/test.sh" "$DIR/$NAME" \
  >"$OUT/test.log" 2>&1 || status=$?
grep -E 'PERF |TEST-UNEXPECTED' "$OUT/test.log" | sed 's/^.*\(PERF \)/\1/' || true
echo "perf-panel: results in $OUT"
exit "$status"
