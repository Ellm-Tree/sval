#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Build a release's Linux or Windows packages on a Docker host, a clean
# machine reset before every build. It builds the
# image from .forgejo/docker, the engine from engine/, then the platform with
# scripts/release-compile.sh, and checks the packages before handing them on.
# Each platform is a build of its own, so one platform's failure costs no other
# platform's build.
#
# Usage: ./scripts/release-build.sh PLATFORM OUT
#   PLATFORM is linux64 or win64,
#   with the environment release-compile.sh documents, and
#   SVAL_PACKAGES_TOKEN  write:package on the Sval organisation, which
#                        publishes each platform's symbols
#   SVAL_RELEASE_TAG     the tag being built, which the checkout holds
#   SVAL_PGO_PROFRAW     for win64, the tag's release run's artifact
#                        pgo-win64-profile, unzipped: its raw PGO profiles
#                        and jar log as one .tar.gz, in a directory mounted where it is
#
# OUT gets PLATFORM/, as release-compile.sh fills it, and linux64/ also gets
# source-mpl.tar.xz, the source of the MPL 2.0 files (scripts/mpl-source.py).
set -euo pipefail

PLATFORM="${1:?usage: $0 PLATFORM OUT}"
OUT="${2:?usage: $0 PLATFORM OUT}"
case "$PLATFORM" in
  linux64 | win64) ;;
  *) echo "error: PLATFORM is linux64 or win64, not $PLATFORM" >&2; exit 2 ;;
esac
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PARENT="$(dirname "$REPO_ROOT")"
cd "$REPO_ROOT"
mkdir -p "$OUT" "$PARENT/mozbuild"
OUT="$(cd "$OUT" && pwd)"
image="sval-release-build:$$"
TREE=/builds/sval
# One build id for every step: each `mach build` otherwise writes a new one
# into buildid.h (build/variables.py), which relinks libxul after the package
# is made, so the .ini files' BuildID and the symbols would describe a build
# other than the one that ships. It comes from the tag, so macOS's compile
# carries the same one.
MOZ_BUILD_DATE="$(./scripts/release-build-date.sh "${SVAL_RELEASE_TAG:?}")"
export MOZ_BUILD_DATE

echo "==> Building the image"
docker build --pull \
  --platform linux/amd64 --provenance=false --sbom=false \
  --build-context repo=. \
  -t "$image" .forgejo/docker

# The checkout is mounted in the container at /builds/sval, and the key file
# and OUT are mounted where the environment names them. win64's compile reads
# a profile its instrumented build wrote in Sval/sval's release workflow, and
# a profile names each file-local function by its source's path, so both
# compile at that one path. clang-cl parses an argument starting with "/" as
# an option where it can, so a tree under, say, /w is taken for the /w flag
# when midl.py preprocesses an IDL file from it; Mozilla's own win64
# compiles build under /builds.
#
# Every step shares one mozbuild state directory, beside the checkout, for the
# toolchains configure downloads: signing rebuilds the installer and
# staging makes the update with them. A compile job needs about 2 GB. Only the signing step's container is given the signing
# credentials, and only the symbols step's the registry token, as extra
# arguments to run. The container runs as root over
# checkouts the runner's user owns, which git refuses unless it is told the
# directories are safe.
run() {
  local script="$1"
  shift
  docker run --rm \
    -v "$REPO_ROOT:$TREE" -w "$TREE" \
    -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
    -v "$OUT:$OUT" \
    -v "$SVAL_SAFEBROWSING_KEYFILE:$SVAL_SAFEBROWSING_KEYFILE:ro" \
    ${SVAL_PGO_PROFRAW:+-v "$SVAL_PGO_PROFRAW:$SVAL_PGO_PROFRAW:ro"} \
    -e SVAL_RELEASE_VERSION -e SVAL_BUILD_NUMBER -e SVAL_SAFEBROWSING_KEYFILE -e MOZ_BUILD_DATE \
    -e SVAL_PGO_PROFRAW \
    -v "$PARENT/mozbuild:/mozbuild" \
    -e SVAL_GECKO_JOBS=14 \
    "$@" "$image" bash -c "$script"
}

echo "==> Engine, upstream and patches"
run './scripts/build-core-wasm.sh && ./scripts/fetch-upstream.sh && ./scripts/apply-patches.sh'
run "./scripts/release-compile.sh build $PLATFORM $OUT/$PLATFORM"
run "./scripts/release-compile.sh symbols $PLATFORM $OUT/$PLATFORM" -e SVAL_PACKAGES_TOKEN
run "./scripts/release-compile.sh sign $PLATFORM $OUT/$PLATFORM" \
  -e AZURE_TENANT_ID -e AZURE_CLIENT_ID -e AZURE_CLIENT_SECRET \
  -e ARTIFACT_SIGNING_ENDPOINT -e ARTIFACT_SIGNING_ACCOUNT -e ARTIFACT_SIGNING_PROFILE
run "./scripts/release-compile.sh stage $PLATFORM $OUT/$PLATFORM"
if [[ "$PLATFORM" == linux64 ]]; then
  run "python3 scripts/mpl-source.py \"\$SVAL_RELEASE_VERSION\" $OUT/$PLATFORM/source-mpl.tar.xz"
fi
docker image rm "$image" > /dev/null

# sync-files.sh stands an empty module in for a missing engine, and a release
# carrying it would install and then never sync.
echo "==> Checking the package carries the engine"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [[ "$PLATFORM" == linux64 ]]; then
  omni="$(tar -tJf "$OUT/linux64/target.tar.xz" | grep '/browser/omni\.ja$')"
  tar -xJf "$OUT/linux64/target.tar.xz" -C "$work" "$omni"
  mv "$work/$omni" "$work/omni.ja"
else
  unzip -p "$OUT/win64/target.zip" '*/browser/omni.ja' > "$work/omni.ja"
fi
# A PGO build preloads the entries its profile run read, ahead of the jar's
# central directory, which unzip reports as a damaged zip. The tree's mozpack
# reads it.
size="$(python3 -I -c '
import sys
sys.path.insert(0, sys.argv[1])
from mozpack.mozjar import JarReader
entry = JarReader(sys.argv[2]).entries.get("chrome/browser/content/browser/sval/sval_core_bg.wasm")
print(entry["uncompressed_size"] if entry else "")
' "$REPO_ROOT/build/firefox/python/mozbuild" "$work/omni.ja")"
echo "sval_core_bg.wasm: ${size:-missing} bytes"
if [[ "${size:-0}" -le 100000 ]]; then
  echo "error: the package carries no real engine" >&2
  exit 1
fi
if [[ "$PLATFORM" == win64 ]]; then
  echo "==> $OUT holds the release's Windows packages"
  exit 0
fi

# Each Linux package on a clean system of its kind: the package manager
# resolves its dependencies, and the browser has to start.
echo "==> Checking the .deb and .rpm install and start"
start='sval --version && timeout 120 sval --headless --screenshot /tmp/s.png about:blank && test -s /tmp/s.png'
(cd "$OUT/linux64" && tar -c sval.deb) | docker run --rm -i debian:bookworm sh -c "mkdir /p && tar -x -C /p &&
  apt-get update -qq && apt-get install -y -qq /p/sval.deb > /dev/null && $start"
(cd "$OUT/linux64" && tar -c sval.rpm) | docker run --rm -i fedora:latest sh -c "mkdir /p && tar -x -C /p &&
  dnf install -y -q /p/sval.rpm > /dev/null && $start"
echo "==> $OUT holds the release's Linux packages"
