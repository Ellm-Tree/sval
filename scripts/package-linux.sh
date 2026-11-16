#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Repackage a Linux build's tarball as a .deb and an .rpm, with Mozilla's own
# repackagers (`mach repackage deb|rpm`) and Sval's templates in
# packaging/linux. Run it in the patched tree's checkout, on Linux, with
# dpkg-buildpackage, debhelper and rpmbuild installed.
#
# The repackagers name the package after application.ini's RemotingName and
# look for the application under its Name, lowercased, both "sval", which is
# also the tarball's top directory, MOZ_APP_NAME (mozconfig).
#
# Usage: ./scripts/package-linux.sh <tarball> <version> <build-number> <out-dir>
#
# <version> is the package version, a plain X.Y.Z, and <build-number> tells
# apart two packages of one version.

set -euo pipefail

if [[ $# -ne 4 ]]; then
  echo "usage: $0 <tarball> <version> <build-number> <out-dir>" >&2
  exit 1
fi
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
tarball="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
version="$2"
build_number="$3"
mkdir -p "$4"
out="$(cd "$4" && pwd)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$REPO_ROOT/build/firefox"
./mach --no-interactive repackage deb \
  --input "$tarball" --output "$out/sval.deb" --arch x86_64 \
  --version "$version" --build-number "$build_number" \
  --templates "$REPO_ROOT/packaging/linux/debian" \
  --product sval --release-type release

# rpm.py copies any locale's langpack RPM into UPLOAD_DIR. Sval ships none.
mkdir -p "$work/langpacks" "$work/upload"
UPLOAD_DIR="$work/upload" ./mach --no-interactive repackage rpm \
  --input "$tarball" --input-xpi-dir "$work/langpacks" \
  --output "$out/sval.rpm" --arch x86_64 \
  --version "$version" --build-number "$build_number" \
  --templates "$REPO_ROOT/packaging/linux/rpm" \
  --product sval --release-type release

ls -la "$out/sval.deb" "$out/sval.rpm"
