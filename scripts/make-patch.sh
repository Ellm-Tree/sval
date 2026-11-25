#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Capture the current modifications in the upstream tree as a patch file.
#
# Usage: ./scripts/make-patch.sh remove-normandy [path...]
#
# `apply-patches.sh` commits the applied series, so the diff this takes is
# against pristine plus every existing patch: editing a file another patch
# already touched yields only your new lines.
#
# With no path arguments this captures every modification in the tree, which
# picks up unrelated edits and files synced from chrome/. Pass explicit
# pathspecs to scope the diff to the files this patch owns.
#
# This captures modifications to files Mozilla already has. A new file belongs
# in chrome/ or branding/, where it costs nothing on a rebase.
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <patch-name-without-extension> [path...]" >&2
  exit 1
fi

NAME="$1"
shift
PATHS=("$@")
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"
OUT="$REPO_ROOT/patches/${NAME}.patch"
DELETE_LIST="$REPO_ROOT/patches/${NAME}.delete"

if [[ ${#PATHS[@]} -eq 0 ]]; then
  echo "warning: no pathspec given — capturing EVERY modification in $SRC." >&2
  echo "         This is only safe with a single patch in patches/series." >&2
  echo "         With more than one patch, pass explicit paths: $0 $NAME <path...>" >&2
fi

cd "$SRC"
if [[ ${#PATHS[@]} -eq 0 ]]; then
  DIFF_ARGS=()
else
  DIFF_ARGS=(-- "${PATHS[@]}")
fi

if git diff --quiet ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"}; then
  echo "error: no modifications in $SRC — nothing to capture" >&2
  exit 1
fi

# A whole file the change deletes goes in the patch's deletion list, which
# names it, and stays out of the patch, which would carry every line of it
# (apply-patches.sh). The list keeps the paths it already holds, because
# those files are gone from the tree this diffs against.
deleted="$(git diff --name-only --diff-filter=D ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"})"
if [[ -n "$deleted" ]]; then
  {
    [[ -f "$DELETE_LIST" ]] && cat "$DELETE_LIST"
    printf '%s\n' "$deleted"
  } | LC_ALL=C sort -u > "$DELETE_LIST.tmp"
  mv "$DELETE_LIST.tmp" "$DELETE_LIST"
  echo "==> Wrote $DELETE_LIST"
fi

if git diff --quiet --diff-filter=d ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"}; then
  echo "==> The change only deletes files, so it has no patch"
  echo ""
  echo "Now add this line to patches/series:"
  echo "    ${NAME}.delete"
  exit 0
fi

# A patch starts with a `Sval: <what>` line and a paragraph saying why, which
# `git apply` skips. Regenerating keeps whatever header is already there.
header=""
if [[ -f "$OUT" ]]; then
  header="$(sed '/^diff --git /,$d' "$OUT")"
fi
{
  if [[ -n "$header" ]]; then
    printf '%s\n\n' "$header"
  fi
  git diff --diff-filter=d ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"}
} > "$OUT"
echo "==> Wrote $OUT"
if [[ -z "$header" ]]; then
  echo "    Add a header above the first diff line: 'Sval: <what>', a blank line,"
  echo "    and why the change is needed."
fi
echo ""
echo "Files touched:"
git diff --name-only ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"} | sed 's/^/    /'
echo ""
echo "Now add this line to patches/series:"
echo "    ${NAME}.patch"
if [[ -f "$DELETE_LIST" ]]; then
  echo "and, on the line after it:"
  echo "    ${NAME}.delete"
fi
