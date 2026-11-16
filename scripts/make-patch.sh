#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Capture the current modifications in the upstream tree as a patch file.
#
# Usage: ./scripts/make-patch.sh no-firefox-labs [path...]
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
  git diff ${DIFF_ARGS[@]+"${DIFF_ARGS[@]}"}
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
