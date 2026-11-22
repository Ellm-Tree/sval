#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Check the website's docs, docs/features.md and README.md, or the files
# given as arguments, against docs/writing-style.md with Vale, after a
# self-test that every rule still flags what it should and passes its near
# misses. scripts/check-rhythm.py then checks the rhythm between sentences
# in the paragraphs that differ from SVAL_PROSE_BASE, or from origin/main
# when files are given as arguments: the docs written before the check fail
# it, so an edit answers only for the text it touches. Vale is downloaded once per version into the user's cache by
# scripts/fetch-tool.sh, checked against the release's published SHA-256. A
# new VERSION goes in the registry with fetch-tool.sh publish, once per ASSET.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION=3.26.0

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) ASSET=Linux_64-bit SHA=22aa69a556558e4a9dfc63c17030777383d8d3c48dcdfad655fa98e839d666ed ;;
  Linux-aarch64) ASSET=Linux_arm64 SHA=3154179f4611140c9af54a8b3bc6a90bc02b73fe6c1f635369604dde0490406d ;;
  Darwin-arm64) ASSET=macOS_arm64 SHA=a6c3370f53bad93086c6b85f3163676e44e08049d69743afdcc13f3aab5b7482 ;;
  Darwin-x86_64) ASSET=macOS_64-bit SHA=df42b317be6ece6a6a70d06b952deec581d047046eb93ea4632f58da56a86ff9 ;;
  *) echo "check-prose: no Vale $VERSION build for $(uname -s) $(uname -m)" >&2; exit 1 ;;
esac

DIR="${XDG_CACHE_HOME:-$HOME/.cache}/sval/vale-$VERSION"
VALE="$DIR/vale"
if [[ ! -x "$VALE" ]]; then
  mkdir -p "$DIR"
  TARBALL="$DIR/vale.tar.gz"
  FILE="vale_${VERSION}_${ASSET}.tar.gz"
  "$REPO_ROOT/scripts/fetch-tool.sh" fetch vale "$VERSION" "$FILE" "$SHA" \
    "https://github.com/vale-cli/vale/releases/download/v$VERSION/$FILE" "$TARBALL"
  tar -xzf "$TARBALL" -C "$DIR" vale
  rm -f "$TARBALL"
fi

CONFIG="$REPO_ROOT/website/.vale.ini"
TESTS="$REPO_ROOT/scripts/check-prose-test"
# Each paragraph after the first in flagged.md breaks exactly one rule.
expected=$(($(grep -c . "$TESTS/flagged.md") - 1))
found=$("$VALE" --config "$CONFIG" --output line --no-exit "$TESTS/flagged.md" | wc -l | tr -d ' ')
if [[ "$found" != "$expected" ]]; then
  echo "check-prose: the self-test flagged $found of $expected lines in flagged.md" >&2
  "$VALE" --config "$CONFIG" --no-exit "$TESTS/flagged.md" >&2
  exit 1
fi
if ! "$VALE" --config "$CONFIG" "$TESTS/passed.md"; then
  echo "check-prose: the self-test flagged a line in passed.md" >&2
  exit 1
fi

# Vale reads an argument that names no file as the text to check, and
# passes it, so every path is checked for existence first.
if (($#)); then
  paths=("$@")
else
  paths=("$REPO_ROOT/website/src/content" "$REPO_ROOT/docs/features.md" "$REPO_ROOT/README.md")
fi
for path in "${paths[@]}"; do
  if [[ ! -e "$path" ]]; then
    echo "check-prose: no such file or folder: $path" >&2
    exit 1
  fi
done
status=0
"$VALE" --config "$CONFIG" "${paths[@]}" || status=$?
base="${SVAL_PROSE_BASE:-}"
if [[ -z "$base" ]] && (($#)) && git -C "$REPO_ROOT" rev-parse -q --verify origin/main >/dev/null; then
  base=origin/main
fi
if [[ -n "$base" ]]; then
  python3 -I "$REPO_ROOT/scripts/check-rhythm.py" --base "$base" "${paths[@]}" || status=$?
fi
exit "$status"
