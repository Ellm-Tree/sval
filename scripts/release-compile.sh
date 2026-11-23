#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Compile one platform of a release and stage what ships, in the build image
# (.forgejo/docker), from a checkout whose upstream is fetched, patches applied
# and engine staged. scripts/release-build.sh runs it on the release build VM;
# nothing else does.
#
# It reads no cache and no package registry: configure's --enable-bootstrap
# downloads every toolchain from Mozilla (MSVC's from Microsoft), and the
# compiler cache starts empty.
#
# Usage: ./scripts/release-compile.sh build|symbols|sign|stage linux64|win64 OUT
#   build    compile and package, and write the symbol archive
#   symbols  publish the symbol archive with scripts/publish-symbols.sh: the
#            only step given SVAL_PACKAGES_TOKEN; without it it publishes
#            nothing, with a warning
#   sign     Authenticode-sign win64's package and installer: the only step
#            given the signing environment scripts/sign-windows.sh reads;
#            without GOOGLE_CLOUD_ACCESS_TOKEN it signs nothing, with a warning
#   stage    make the complete update from the package and copy what ships
#            into OUT
#   SVAL_RELEASE_VERSION       the version a tag names, or 0.0.0
#   SVAL_BUILD_NUMBER          tells apart two .deb/.rpm builds of one version
#   SVAL_SAFEBROWSING_KEYFILE  Sval's Safe Browsing key, built in
#   SVAL_PGO_PROFRAW           win64's raw PGO profiles and jar log, as
#                              scripts/release-build.sh is given them
#
# OUT gets target.tar.xz, sval.deb, sval.rpm and target.complete.mar for
# linux64; target.zip, target.installer.exe and target.complete.mar for win64.
set -euo pipefail

usage="usage: $0 build|symbols|sign|stage linux64|win64 OUT"
STEP="${1:?$usage}"
PLATFORM="${2:?$usage}"
OUT="${3:?$usage}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

case "$PLATFORM" in
  linux64) target=host objdir=objdir-gecko package=target.tar.xz ;;
  win64) target=win64 objdir=objdir-gecko-win64 package=target.zip ;;
  *)
    echo "error: unknown platform '$PLATFORM'" >&2
    exit 1
    ;;
esac
: "${SVAL_RELEASE_VERSION:?}" "${SVAL_BUILD_NUMBER:?}"
[[ -s "${SVAL_SAFEBROWSING_KEYFILE:?a release needs Sval\'s Safe Browsing key}" ]]

export SVAL_MODE=gecko SVAL_TARGET="$target" SVAL_SKIP_BOOTSTRAP=1
export MOZ_SIMPLE_PACKAGE_NAME=target
DIST="build/firefox/$objdir/dist"
mkdir -p "$OUT"

build() {
  echo "==> Compiling $PLATFORM"
  # Both compile with profile-guided optimisation (mozconfig.gecko).
  # linux64 makes its own profile (scripts/pgo-build.sh). win64 is a
  # cross-compile, so its profile comes from Windows (gecko.yml's
  # profile-win64), whose raw profiles are merged with the llvm-profdata
  # configure bootstraps, the compile's own, before the compile's configure
  # checks the profile is there.
  if [[ "$PLATFORM" == linux64 ]]; then
    ./scripts/pgo-build.sh
  else
    [[ -s "${SVAL_PGO_PROFRAW:-}" ]] ||
      { echo "error: SVAL_PGO_PROFRAW names no win64 profile" >&2; exit 1; }
    SVAL_CONFIGURE_ONLY=1 ./scripts/build.sh
    local raw pgo="$REPO_ROOT/build/pgo"
    raw="$(mktemp -d)"
    # The archive comes from a Windows runner branch jobs reach, so only
    # regular .profraw files and the jar log, at its top level, are
    # unpacked.
    local listing
    listing="$(tar -tvzf "$SVAL_PGO_PROFRAW")"
    if grep -qv -e '^-.* [^/]*\.profraw$' -e '^-.* en-US\.log$' <<<"$listing"; then
      echo "error: the win64 profile holds more than .profraw files and en-US.log" >&2
      exit 1
    fi
    tar -xzf "$SVAL_PGO_PROFRAW" -C "$raw" --no-same-owner
    # The packager reads the jar log only if it exists (packager.mk), so a
    # missing one would ship jars with nothing preloaded.
    [[ -s "$raw/en-US.log" ]] ||
      { echo "error: the win64 profile holds no jar log" >&2; exit 1; }
    rm -rf "$pgo"
    mkdir -p "$pgo"
    mv "$raw/en-US.log" "$pgo/en-US.log"
    "${MOZBUILD_STATE_PATH:?}/clang/bin/llvm-profdata" merge \
      -o "$pgo/merged.profdata" "$raw"/*.profraw
    rm -rf "$raw"
    export SVAL_PGO=use SVAL_PGO_PROFILE="$pgo/merged.profdata" SVAL_PGO_JARLOG="$pgo/en-US.log"
    # Mozilla's build has install races at high parallelism; a second,
    # incremental `mach build` finishes what the first left (gecko.yml).
    ./scripts/build.sh || (cd build/firefox && ./mach --no-interactive build)
  fi

  local f="$DIST/bin/modules/AppConstants.sys.mjs"
  if [[ ! -f "$f" ]] || grep -q no-google-safebrowsing-api-key "$f"; then
    echo "error: the Safe Browsing key is not built in" >&2
    exit 1
  fi

  # A release ships this package, so xz compresses it single-threaded, as
  # small as the level makes it.
  XZ_OPT='' ./scripts/check-package.sh

  # A release compile keeps line tables (mozconfig.gecko), which dump_syms
  # turns into the archive a crash file is read with.
  (cd build/firefox && ./mach --no-interactive buildsymbols)
}

symbols() {
  if [[ -z "${SVAL_PACKAGES_TOKEN:-}" ]]; then
    echo "::warning::SVAL_PACKAGES_TOKEN is not set, so this release's $PLATFORM symbols are not published"
    return 0
  fi
  ./scripts/publish-symbols.sh "$PLATFORM" "$DIST"
}

sign() {
  [[ "$PLATFORM" == win64 ]] || return 0
  if [[ -z "${GOOGLE_CLOUD_ACCESS_TOKEN:-}" ]]; then
    echo "::warning::GOOGLE_CLOUD_ACCESS_TOKEN is not set, so this release's Windows files are unsigned"
  else
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends default-jre-headless openssl
    JSIGN_JAR="$(mktemp -d)/jsign.jar"
    export JSIGN_JAR
    curl -fsSL -o "$JSIGN_JAR" https://repo1.maven.org/maven2/net/jsign/jsign/7.6/jsign-7.6.jar
    echo "6cf58aa080e7ff82656f320cff8d4a3bff30408df8766806dcba3740dd839fa5  $JSIGN_JAR" | sha256sum -c -
    ./scripts/sign-windows.sh "build/firefox/$objdir"
  fi
}

stage() {
  if [[ "$PLATFORM" == win64 ]]; then
    if [[ ! -f "$DIST/target.installer.exe" ]]; then
      echo "error: mach package made no installer" >&2
      exit 1
    fi
    cp "$DIST/target.installer.exe" "$OUT/"
  fi
  cp "$DIST/$package" "$OUT/"

  # The complete update, from the package users install, signed files
  # included, for the sval-release MAR channel the updater accepts. The
  # release repository signs it.
  (cd build/firefox && ./mach --no-interactive repackage mar \
    --input "$objdir/dist/$package" \
    --mar "$objdir/dist/host/bin/mar" \
    --arch x86_64 \
    --mar-channel-id sval-release \
    --output "$OUT/target.complete.mar")

  # A beta's .deb and .rpm carry the version it leads to, 0.1.0 for
  # 0.1.0-rc.4, and the build number orders the betas and the release after
  # them as apt and dnf compare them.
  if [[ "$PLATFORM" == linux64 ]]; then
    apt-get update -qq
    apt-get install -y -qq --no-install-recommends build-essential debhelper dpkg-dev rpm
    ./scripts/package-linux.sh "$DIST/target.tar.xz" \
      "${SVAL_RELEASE_VERSION%%-*}" "$SVAL_BUILD_NUMBER" "$OUT"
  fi
  ls -la "$OUT"
}

case "$STEP" in
  build | symbols | sign | stage) "$STEP" ;;
  *)
    echo "error: unknown step '$STEP'" >&2
    exit 1
    ;;
esac
