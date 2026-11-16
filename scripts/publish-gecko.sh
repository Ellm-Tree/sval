#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Publish a Gecko build's packages to Forgejo's generic package registry, as
# version <key> of the package gecko-<platform>. scripts/gecko-key.sh prints
# the key; an artifact build fetches its Gecko by it. The platform `engine`
# publishes the wasm engine as version <key> of sval-engine, where
# scripts/engine-key.sh prints the key.
#
# meta.json goes last and marks the version complete: a consumer that finds no
# meta.json treats the version as absent. The registry refuses to overwrite a
# file, so a complete version never changes, which the artifact cache relies
# on: it never revalidates a downloaded URL.
#
# Any branch's run publishes the key it compiled, so two runs can publish one
# key at once: scripts/lib/registry.sh's claim_version waits for another run's
# publish rather than duplicate it. An upload the registry refuses as a
# duplicate is the same race, and waits too.
#
# Usage: ./scripts/publish-gecko.sh <platform> <key> <dist-dir>
#   SVAL_PACKAGES_TOKEN  a token with write:package on the Sval organisation
#   SVAL_PACKAGES_URL    default https://git.ellmtree.ai/api/packages/Sval/generic

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <platform> <key> <dist-dir>" >&2
  exit 1
fi
PLATFORM="$1"
KEY="$2"
DIST="$3"
NAME="gecko-$PLATFORM"
[[ "$PLATFORM" == engine ]] && NAME=sval-engine
# shellcheck source=scripts/lib/registry.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/registry.sh"
BASE="$REGISTRY/$NAME/$KEY"
registry_open sval-gecko required

case "$PLATFORM" in
  linux64) package=target.tar.xz ;;
  win64) package=target.zip ;;
  macos-aarch64 | macos-x86_64) package=target.dmg ;;
  engine) package=sval_core_bg.wasm ;;
  *)
    echo "error: unknown platform '$PLATFORM'" >&2
    exit 1
    ;;
esac

if claim_version "$BASE" meta.json "$package" "$NAME $KEY"; then
  exit 0
fi

staged="$("$(dirname "${BASH_SOURCE[0]}")/stage-gecko.sh" "$PLATFORM" "$KEY" "$DIST")"
while read -r f; do
  echo "==> Uploading $f ($(du -h "$DIST/$f" | cut -f1))"
  code="$(api -o /dev/null -w '%{http_code}' --upload-file "$DIST/$f" "$BASE/$f")"
  if [[ "$code" == 409 ]]; then
    echo "==> another run is publishing $NAME $KEY; waiting for it"
    if await_marker "$BASE" meta.json; then
      echo "==> $NAME $KEY was published by another run"
      exit 0
    fi
    echo "error: $f exists and $NAME $KEY never completed" >&2
    exit 1
  fi
  [[ "$code" == 201 ]] || { echo "error: uploading $f returned $code" >&2; exit 1; }
done <<<"$staged"
echo "==> Published $NAME $KEY"
