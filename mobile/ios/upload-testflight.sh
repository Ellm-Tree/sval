#!/bin/bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

# Archives the iPhone app and uploads it to App Store Connect, where it
# appears in TestFlight. The build is signed for distribution with the Apple
# account signed in to Xcode, or with an App Store Connect API key when
# ASC_KEY_PATH, ASC_KEY_ID and ASC_ISSUER_ID are set. It lives in the public
# source because the scripts that build a binary are part of its
# Corresponding Source (AGPL-3.0 section 1).
#
# Usage, from the repository's root:
#   mobile/ios/upload-testflight.sh <build-number>
# The build number must be higher than every build uploaded for this version.
set -euo pipefail

build_number="${1:?usage: $0 <build-number>}"
case "$build_number" in
  *[!0-9]*) echo "error: the build number is a whole number" >&2; exit 2 ;;
esac

here="$(cd "$(dirname "$0")" && pwd)"
work="$here/build/testflight"
rm -rf "$work"
mkdir -p "$work"

"$here/build-engine.sh"
(cd "$here" && xcodegen generate)

auth=(-allowProvisioningUpdates)
if [ -n "${ASC_KEY_PATH:-}" ]; then
  auth+=(-authenticationKeyPath "$ASC_KEY_PATH"
         -authenticationKeyID "${ASC_KEY_ID:?ASC_KEY_ID with ASC_KEY_PATH}"
         -authenticationKeyIssuerID "${ASC_ISSUER_ID:?ASC_ISSUER_ID with ASC_KEY_PATH}")
fi

xcodebuild archive \
  -project "$here/Sval.xcodeproj" -scheme Sval -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$work/Sval.xcarchive" \
  CURRENT_PROJECT_VERSION="$build_number" \
  "${auth[@]}"

# The repository's version and the build number given are what App Store
# Connect gets: Xcode would otherwise pick its own build number.
cat > "$work/ExportOptions.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>destination</key>
	<string>upload</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<key>manageAppVersionAndBuildNumber</key>
	<false/>
</dict>
</plist>
PLIST

xcodebuild -exportArchive \
  -archivePath "$work/Sval.xcarchive" \
  -exportOptionsPlist "$work/ExportOptions.plist" \
  -exportPath "$work/export" \
  "${auth[@]}"

echo "==> Uploaded build $build_number. It shows in App Store Connect's TestFlight tab once Apple has processed it."
