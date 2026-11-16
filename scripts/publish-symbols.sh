#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Publish a release compile's symbol archive, which `mach buildsymbols` writes,
# to Forgejo's generic package registry as <platform>.crashreporter-symbols.zip
# in version <build id> of sval-symbols. A crash's annotations carry the build
# id, so scripts/read-crash.sh finds a crash file's symbols by it. Each compile
# has a build id of its own, and the platform in the file name keeps two
# compiles in one second apart.
#
# The registry refuses to overwrite a file, and a file is there only once its
# upload completed, so a file already there is this compile's: a re-run of
# the step publishes nothing.
#
# Usage: ./scripts/publish-symbols.sh <platform> <dist-dir>
#   SVAL_PACKAGES_TOKEN  a token with write:package on the Sval organisation
#   SVAL_PACKAGES_URL    default https://git.ellmtree.ai/api/packages/Sval/generic
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 <platform> <dist-dir>" >&2
  exit 1
fi
PLATFORM="$1"
DIST="$2"
case "$PLATFORM" in
  linux64 | win64 | macos-aarch64 | macos-x86_64) ;;
  *)
    echo "error: unknown platform '$PLATFORM'" >&2
    exit 1
    ;;
esac
# shellcheck source=scripts/lib/registry.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/registry.sh"
registry_open sval-gecko required

# MOZ_SIMPLE_PACKAGE_NAME=target names the archive (package-name.mk,
# SYMBOL_ARCHIVE_BASENAME).
archive="$DIST/target.crashreporter-symbols.zip"
[[ -s "$archive" ]] || { echo "error: $archive is missing; run mach buildsymbols" >&2; exit 1; }
build_id="$(sed -n 's/^BuildID=//p' "$DIST/bin/platform.ini" | head -1)"
[[ "$build_id" =~ ^[0-9]{14}$ ]] || { echo "error: $DIST/bin/platform.ini has no BuildID" >&2; exit 1; }

file="$PLATFORM.crashreporter-symbols.zip"
url="$REGISTRY/sval-symbols/$build_id/$file"
echo "==> Uploading $file ($(du -h "$archive" | cut -f1)) as sval-symbols $build_id"
code="$(api -o /dev/null -w '%{http_code}' --upload-file "$archive" "$url")"
case "$code" in
  201) echo "==> Published sval-symbols $build_id $file" ;;
  409) echo "==> sval-symbols $build_id already holds $file" ;;
  *)
    echo "error: uploading $file returned $code" >&2
    exit 1
    ;;
esac
