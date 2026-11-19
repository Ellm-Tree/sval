#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Builds the iPhone app for the App Store, unsigned, and writes Sval.app as a
# tar. The owner's release repository signs it for the App Store and uploads
# it, with keys this repository never holds. It lives in the
# public source because the scripts that build a binary are part of its
# Corresponding Source (AGPL-3.0 section 1).
#
#   mobile/ios/archive-unsigned.sh <out.tar>
set -euo pipefail

out="${1:?usage: $0 <out.tar>}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$here/build/unsigned"
rm -rf "$work"
mkdir -p "$work"

"$here/build-engine.sh"
(cd "$here" && xcodegen generate)

xcodebuild archive \
  -project "$here/Sval.xcodeproj" -scheme Sval -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$work/Sval.xcarchive" \
  CODE_SIGNING_ALLOWED=NO

tar -cf "$out" -C "$work/Sval.xcarchive/Products/Applications" Sval.app
echo "==> $out"
