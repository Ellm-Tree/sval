#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Print Mozilla's own tests from scripts/upstream-tests.txt for
# scripts/test.sh: one line per set of prefs the tests run with, each the
# prefs as `--setpref=<name>=<value>` arguments, then the tests. A line
# without prefs runs its tests on the defaults.
#
#   scripts/upstream-tests.sh
#   scripts/upstream-tests.sh --shard 2/2
#
# --shard I/N prints the I'th of N shards. The tests on the defaults go by
# directory, each to the shard with the fewest so far, and every group with
# prefs goes to the last shard. Mozilla's tests in one directory run in
# order and some leave state the next one in that order clears, so a
# directory stays whole. Each group a shard holds costs a harness start-up
# per kind of test in it, so a group with prefs runs once, whole. CI's first
# Linux half also runs lint.sh after its suite, so the second takes the
# groups with prefs.
#
# A test in scripts/upstream-test-known-failures.txt fails in Sval on purpose
# and is never printed, so a line moved to that list stops it running.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIST="$REPO_ROOT/scripts/upstream-tests.txt"
KNOWN="$REPO_ROOT/scripts/upstream-test-known-failures.txt"
PREFS="$REPO_ROOT/branding/sval/pref/app-sval-prefs.js"

shard=1 shards=1
if [[ "${1:-}" == --shard ]]; then
  [[ "${2:-}" =~ ^([0-9]+)/([0-9]+)$ ]] || { echo "usage: $0 [--shard I/N]" >&2; exit 1; }
  shard="${BASH_REMATCH[1]}" shards="${BASH_REMATCH[2]}"
  ((shard >= 1 && shard <= shards)) || { echo "error: no shard $2" >&2; exit 1; }
fi

entries() {
  sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$1"
}

# <name>=<value> with @default@ in the value replaced by Sval's default for
# <name> (branding/sval/pref/app-sval-prefs.js), so a line can say "sval's
# fingerprinting overrides with one switch turned off" without copying a
# string that changes whenever a switch is added.
with_default() {
  local name="${1%%=*}" value="${1#*=}" default
  if [[ "$value" == *@default@* ]]; then
    # A pref() call may wrap its name and value onto lines of their own.
    default="$(tr '\n' ' ' < "$PREFS" |
      sed -n "s/.*pref( *\"${name//./\\.}\", *\"\([^\"]*\)\" *);.*/\1/p")"
    [[ -n "$default" ]] || { echo "error: no default for $name in $PREFS" >&2; exit 1; }
    value="${value//@default@/$default}"
  fi
  printf '%s=%s' "$name" "$value"
}

known="$(entries "$KNOWN" | awk '{ print $1 }')"
entries "$LIST" | while read -r test prefs; do
  if printf '%s\n' "$known" | grep -qxF "$test"; then
    continue
  fi
  # The prefs, sorted so that one set is one key however a line orders it.
  # Each is computed in its own assignment, whose status is with_default's:
  # errexit does not reach into a substitution used as an argument.
  key=""
  if [[ -n "${prefs:-}" ]]; then
    args=()
    # shellcheck disable=SC2086 # one pref per word
    for pref in $prefs; do
      arg="$(with_default "$pref")" || exit 1
      args+=("--setpref=$arg")
    done
    key="$(printf '%s\n' "${args[@]}" | LC_ALL=C sort | tr '\n' ' ')"
  fi
  printf '%s\t%s\n' "$key" "$test"
done | LC_ALL=C sort -u | awk -F'\t' -v shard="$shard" -v shards="$shards" '
  { keys[NR] = $1; tests[NR] = $2 }
  $1 == "" {
    dir = $2; sub(/\/[^\/]*$/, "", dir)
    if (!(dir in owner)) { order[++dirs] = dir; owner[dir] = 0 }
    size[dir]++
  }
  END {
    # Directories in list order, each to the shard with the fewest tests.
    for (s = 1; s <= shards; s++) held[s] = 0
    for (d = 1; d <= dirs; d++) {
      best = 1
      for (s = 2; s <= shards; s++) if (held[s] < held[best]) best = s
      owner[order[d]] = best; held[best] += size[order[d]]
    }
    for (i = 1; i <= NR; i++) {
      if (keys[i] == "") {
        dir = tests[i]; sub(/\/[^\/]*$/, "", dir)
        if (owner[dir] != shard) continue
      } else if (shard != shards) continue
      if (!started || keys[i] != key) { if (started) print line; started = 1; key = keys[i]; line = keys[i] tests[i]; continue }
      line = line " " tests[i]
    }
    if (started) print line
  }
'
