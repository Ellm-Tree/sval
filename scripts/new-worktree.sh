#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Create a worktree, and give it its own build tree, patched and built.
#
#   scripts/new-worktree.sh [--no-build] <topic> [<start-point>]
#
# It also starts scripts/reclaim-dev.sh --apply, which removes what is
# finished: merged worktrees nothing has open, and mach state no checkout uses.
# A session that ends before cleaning up after its merge leaves those behind.
# The run's output is in reclaim-dev.log in the common git directory.
#
# --no-build stops after `git worktree add`, for work that never launches
# Sval or runs its browser tests. Every script that needs build/firefox names
# scripts/build-worktree.sh when it is missing, which does the rest.
set -euo pipefail

build=1
args=()
for arg in "$@"; do
  case "$arg" in
    --no-build) build=0 ;;
    *) args+=("$arg") ;;
  esac
done
if [[ ${#args[@]} -lt 1 || ${#args[@]} -gt 2 ]]; then
  echo "usage: $0 [--no-build] <topic> [<start-point>]" >&2
  exit 1
fi
TOPIC="${args[0]}"
START="${args[1]:-HEAD}"

# The main checkout is the parent of the common git directory, wherever this
# script is run from.
COMMON="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
MAIN="$(dirname "$COMMON")"
WT="$MAIN/.worktrees/$TOPIC"

# In the background, since it fetches every checkout beside this one. A
# worktree just added has no commits of its own, so the run keeps it.
nohup "$(dirname "${BASH_SOURCE[0]}")/reclaim-dev.sh" --apply >"$COMMON/reclaim-dev.log" 2>&1 &

git -C "$MAIN" worktree add "$WT" -b "$TOPIC" "$START"

# The commit-msg hook (.githooks/commit-msg) checks each subject as it is
# written. The setting is in the shared config, so it covers every worktree,
# and a relative path resolves in each worktree's own top level.
git -C "$MAIN" config core.hooksPath .githooks

if [[ "$build" == 1 ]]; then
  "$WT/scripts/build-worktree.sh"
else
  echo "==> No build tree; scripts/build-worktree.sh makes one"
fi
echo "==> Worktree ready at $WT"
