#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Mutation-tests the engine crate with cargo-mutants, and fails when a mutant
# survives. Its arguments go to cargo-mutants, which reads the crate's
# settings and equivalent mutants from engine/.cargo/mutants.toml:
#
#   scripts/engine-mutants.sh --in-diff <diff>   # what a change touches
#   scripts/engine-mutants.sh --shard 0/4        # a quarter of the crate
#
# CI runs it. The release binaries need a newer glibc than the CI image's
# Debian, so the pinned version is built when the one on PATH differs.
# Renovate does not track the pin.
#
# A fixed proptest seed gives every mutant the same cases, so a mutant's
# verdict does not change between runs, and fewer cases keep the convergence
# properties from dominating each run.
#
# With SVAL_MUTANTS_MISSED set, the survivors are also written to that file,
# which is empty when every mutant was caught, so the nightly can report them.
#
# A timed-out mutant made a test hang, which is a test failing, so it counts
# as caught. cargo-mutants reports a timeout ahead of a survivor in its exit
# status, so the survivors are read from its output instead.
set -euo pipefail

VERSION=27.1.0

if [ "$(cargo mutants --version 2>/dev/null)" != "cargo-mutants $VERSION" ]; then
  cargo install --locked cargo-mutants --version "$VERSION"
fi

cd "$(dirname "$0")/../engine"
out="$(mktemp -d)"
status=0
# --caught and --unviable print a line for every mutant. cargo-mutants
# otherwise prints only survivors and timeouts, and a shard can go most of an
# hour without either, which CI's stall guard cannot tell from a hang.
PROPTEST_CASES=64 PROPTEST_RNG_SEED=1 cargo mutants -j 2 --caught --unviable -o "$out" "$@" || status=$?
case "$status" in
  0 | 2 | 3) ;;
  *) exit "$status" ;;
esac
if [ -s "$out/mutants.out/timeout.txt" ]; then
  echo "Timed out, so caught:"
  cat "$out/mutants.out/timeout.txt"
fi
if [ -n "${SVAL_MUTANTS_MISSED:-}" ]; then
  cat "$out/mutants.out/missed.txt" 2>/dev/null > "$SVAL_MUTANTS_MISSED" || : > "$SVAL_MUTANTS_MISSED"
fi
if [ -s "$out/mutants.out/missed.txt" ]; then
  echo "::error::Mutants no test failed (a missing test, or an equivalent mutant for engine/.cargo/mutants.toml):"
  cat "$out/mutants.out/missed.txt"
  exit 1
fi
