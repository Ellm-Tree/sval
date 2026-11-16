#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Find where Sval's own code spends time: startup, page loads and a tabs
# workload, each under the Gecko profiler, with Sval's functions ranked by the
# time sampled in them; and what each process holds in memory and spends in
# CPU while nobody touches the window. scripts/perf/perf.py does the
# measuring; this packages Sval, serves the tabs workload's page and keeps
# the results.
#
#   scripts/perf.sh                     # every workload, about 20 min
#   scripts/perf.sh --only tabs         # or startup, pages, memory, idle
#   scripts/perf.sh --pref name=false   # a pref for every launch, as JSON
#   scripts/perf.sh --app <Sval.app>     # an app already packaged
#   scripts/perf.sh --runs 5 --reps 1   # fewer launches and page loads
#
# A packaged build, never the objdir's: the objdir's app reads chrome from
# loose files instead of omni.ja, which changes startup. Results and the
# profiles, for profiler.firefox.com's "Load a profile from file", go to
# build/perf/<time>/. Run it while nothing else compiles or tests: load on the
# machine moves every number, and the run records the load average it started
# under. macOS only.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/launch.sh
source "$REPO_ROOT/scripts/lib/launch.sh"
SRC="$REPO_ROOT/build/firefox"

APP=""
PASS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) APP="$2"; shift 2 ;;
    --only | --runs | --reps | --tabs | --rounds | --title-seconds | --settle | --top | \
      --idle-seconds | --pref)
      PASS+=("$1" "$2"); shift 2 ;;
    *) echo "perf: unknown argument $1" >&2; exit 1 ;;
  esac
done

if [[ "$(uname)" != "Darwin" ]]; then
  echo "perf: macOS only for now" >&2
  exit 1
fi

load="$(sysctl -n vm.loadavg | awk '{print $2}')"
cores="$(sysctl -n hw.ncpu)"
if awk -v l="$load" -v c="$cores" 'BEGIN { exit !(l > c / 4) }'; then
  echo "perf: warning: load average is $load on $cores cores; results will be slow and noisy" >&2
fi

WORK="$(mktemp -d)"
OUT="$REPO_ROOT/build/perf/$(date +%Y%m%d-%H%M%S)"
SITE_PID=""
cleanup() {
  [[ -n "$SITE_PID" ]] && kill "$SITE_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

if [[ -z "$APP" ]]; then
  echo "==> Packaging sval"
  "$REPO_ROOT/scripts/stage-sval-mcp.sh" >"$WORK/stage-sval-mcp.log" 2>&1 || {
    tail -20 "$WORK/stage-sval-mcp.log" >&2
    exit 1
  }
  "$REPO_ROOT/scripts/stage-sval-folder.sh" >"$WORK/stage-sval-folder.log" 2>&1 || {
    tail -20 "$WORK/stage-sval-folder.log" >&2
    exit 1
  }
  (cd "$SRC" && ./mach package >"$WORK/package.log" 2>&1) || {
    tail -20 "$WORK/package.log" >&2
    exit 1
  }
  dist="$(cd "$SRC" && ./mach environment --format=json |
    python3 -c 'import json,sys; print(json.load(sys.stdin)["topobjdir"])')/dist"
  dmg="$(ls -t "$dist"/*.dmg | head -1)"
  mkdir -p "$WORK/sval"
  copy_app_from_dmg "$dmg" "$WORK/sval"
  APP="$(ls -d "$WORK"/sval/*.app)"
  # Given the dev identity (sign_dev_bundle), signed with the certificate the
  # keychain already trusts with Sval's secret when there is one, so a launch
  # reads it without asking. codesign refuses a bundle carrying extended
  # attributes, which the copy keeps.
  xattr -cr "$APP"
  if ! identity="$(dev_signing_identity)"; then
    identity=-
    echo "perf: no sval dev signing identity (scripts/dev-signing.sh); the keychain may ask on each launch" >&2
  fi
  if ! sign_dev_bundle "$APP" "$identity"; then
    echo "perf: could not give sval the dev identity" >&2
    exit 1
  fi
fi

SITE_PORT="$(free_port)"
python3 -I -m http.server --bind 127.0.0.1 --directory "$REPO_ROOT/scripts/perf/site" "$SITE_PORT" \
  >"$WORK/site.log" 2>&1 &
SITE_PID=$!

python3 -I "$REPO_ROOT/scripts/perf/perf.py" \
  --app "$APP" --work "$WORK" --out "$OUT" \
  --pages "$REPO_ROOT/scripts/perf/pages.txt" \
  --tab-page "http://127.0.0.1:$SITE_PORT/tab.html" \
  ${PASS[@]+"${PASS[@]}"}
