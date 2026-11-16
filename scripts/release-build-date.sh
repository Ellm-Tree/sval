#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Print the build id every compile of a release uses, as MOZ_BUILD_DATE, from
# the release's tag. The macOS compile and the Linux and Windows one run on
# different machines, and each computes the same id from the tag alone:
#   v*         an annotated tag: its tagger time
#   dry-run-*  a lightweight tag: its commit's committer time, which comes
#              before any v* tag made on that commit, so a dry run and the
#              release never share an id, and the registry, which keeps the
#              first file uploaded under a name, never holds a dry run's
#              symbols under a release's id
# Times are UTC, in MOZ_BUILD_DATE's form, YYYYMMDDhhmmss.
#
# Usage: ./scripts/release-build-date.sh <tag>
#   run in a checkout that holds the tag
set -euo pipefail

tag="${1:?usage: $0 <tag>}"
ref="refs/tags/$tag"
if ! git rev-parse -q --verify "$ref" > /dev/null; then
  echo "error: this checkout has no tag $tag" >&2
  exit 1
fi
kind="$(git cat-file -t "$ref")"
case "$tag:$kind" in
  v*:tag) field=taggerdate ;;
  dry-run-*:commit) field=committerdate ;;
  v*:*)
    echo "error: $tag is not an annotated tag, so it names no time of its own" >&2
    exit 1
    ;;
  *)
    echo "error: $tag is neither an annotated v* tag nor a dry-run-* tag" >&2
    exit 1
    ;;
esac
id="$(TZ=UTC git for-each-ref --format="%($field:format-local:%Y%m%d%H%M%S)" "$ref")"
if [[ ! "$id" =~ ^[0-9]{14}$ ]]; then
  echo "error: $tag gave no build id" >&2
  exit 1
fi
echo "$id"
