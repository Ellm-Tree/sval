#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Make a Gecko build's packages into a version a consumer can use: check
# <dist-dir> holds every package <platform> needs, then write SHA256SUMS and
# meta.json beside them, and print the file names, meta.json last. Uploaded
# with scripts/publish-gecko.sh, the directory becomes version <key> of
# gecko-<platform>. Copied as it is, it is a directory scripts/fetch-gecko.sh
# accepts as complete.
#
# The platform `engine` is the wasm engine scripts/build-core-wasm.sh stages,
# keyed by scripts/engine-key.sh and published as the package sval-engine.
#
# Usage: ./scripts/stage-gecko.sh <platform> <key> <dist-dir>

set -euo pipefail

if [[ $# -ne 3 ]]; then
  echo "usage: $0 <platform> <key> <dist-dir>" >&2
  exit 1
fi
PLATFORM="$1"
KEY="$2"
DIST="$3"

case "$PLATFORM" in
  linux64) package=target.tar.xz ;;
  win64) package=target.zip ;;
  macos-aarch64 | macos-x86_64) package=target.dmg ;;
  engine) ;;
  *)
    echo "error: unknown platform '$PLATFORM'" >&2
    exit 1
    ;;
esac
if [[ "$PLATFORM" == engine ]]; then
  files=(sval_core_bg.wasm sval_core.mjs)
else
  files=("$package" target.common.tests.tar.zst target.xpt_artifacts.zip target.crashreporter-symbols.zip)
fi
if [[ "$PLATFORM" == macos-* ]]; then
  files+=(target.update_framework_artifacts.zip)
fi
for f in "${files[@]}"; do
  [[ -f "$DIST/$f" ]] || { echo "error: $DIST/$f is missing" >&2; exit 1; }
done

# shellcheck source=scripts/lib/registry.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/registry.sh"
(cd "$DIST" && sha256 "${files[@]}") > "$DIST/SHA256SUMS"
. "$(dirname "${BASH_SOURCE[0]}")/../upstream.txt"
KEY="$KEY" PLATFORM="$PLATFORM" UPSTREAM="$UPSTREAM_REF" \
  COMMIT="${GITHUB_SHA:-$(git rev-parse HEAD)}" REF="${GITHUB_REF:-}" \
  RUN="${GITHUB_SERVER_URL:-}/${GITHUB_REPOSITORY:-}/actions/runs/${GITHUB_RUN_NUMBER:-}" \
  python3 -c '
import datetime, json, os
e = os.environ
print(json.dumps({
    "key": e["KEY"], "platform": e["PLATFORM"], "upstream": e["UPSTREAM"],
    "commit": e["COMMIT"], "ref": e["REF"], "run": e["RUN"],
    "built": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
}, indent=2))' > "$DIST/meta.json"

printf '%s\n' "${files[@]}" SHA256SUMS meta.json
