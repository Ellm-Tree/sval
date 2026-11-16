#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Report which Gecko the last artifact build ran on, and when it says Sval's,
# check that the libxul in the object directory is Sval's. CI runs this after
# every build.
#
# A fallback to Mozilla's Gecko is a warning: the tree changes something native,
# and its Gecko does not exist until a CI run compiles it (scripts/build.sh). A
# build that says Sval's Gecko and holds Mozilla's libxul is an error: Sval's
# libxul carries Sval's distribution id, and Mozilla's never does.
#
# Usage: ./scripts/check-gecko-source.sh [objdir]   (default objdir-frontend)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"
BIN="$SRC/${1:-objdir-frontend}/dist/bin"

read -r source key < "$SRC/.sval-gecko-source"
if [[ "$source" != sval ]]; then
  echo "::warning::built on Mozilla's Gecko: this tree's Gecko key${key:+ $key} is not published"
  exit 0
fi

libxul=""
for f in "$BIN/libxul.so" "$BIN/xul.dll" "$BIN/XUL"; do
  [[ -f "$f" ]] && libxul="$f"
done
if [[ -z "$libxul" ]]; then
  echo "error: no libxul in $BIN" >&2
  exit 1
fi
# The distribution id is the one mozconfig gives every build.
dist_id="$(sed -n 's/^ac_add_options --with-distribution-id=//p' "$REPO_ROOT/mozconfig")"
if [[ -z "$dist_id" ]] || ! grep -qF "$dist_id" "$libxul"; then
  echo "error: the build says Sval's Gecko, and $(basename "$libxul") is not Sval's" >&2
  exit 1
fi
echo "built on Sval's Gecko, key $key; $(basename "$libxul") is Sval's"
