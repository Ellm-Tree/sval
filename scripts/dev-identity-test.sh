#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Checks lib/launch.sh's sign_dev_bundle on a stand-in bundle shaped like a
# build's: the app and Sval's helpers take the dev ids and fixed executable
# UUIDs, a helper outside app.sval keeps its id, and the result verifies.
# macOS only. /usr/bin/true stands in for each executable because it is a
# universal binary, so both slice layouts are rewritten.
set -euo pipefail

if [[ "$(uname)" != "Darwin" ]]; then
  echo "dev-identity-test: macOS only; skipped"
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/launch.sh
source "$REPO_ROOT/scripts/lib/launch.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
APP="$WORK/Sval.app"
failures=0

fail() {
  echo "FAIL: $*" >&2
  failures=$((failures + 1))
}

# bundle <dir> <id> <executable>
bundle() {
  mkdir -p "$1/Contents/MacOS"
  cp /usr/bin/true "$1/Contents/MacOS/$3"
  cat >"$1/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$2</string>
<key>CFBundleExecutable</key><string>$3</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
}

bundle "$APP" app.sval.sval sval
bundle "$APP/Contents/MacOS/sval-child.app" app.sval.plugincontainer sval-child
bundle "$APP/Contents/MacOS/gpu-helper.app" app.sval.sval-gpu-helper "Sval GPU Helper"
bundle "$APP/Contents/MacOS/updater.app" app.sval.updater sval-update
bundle "$APP/Contents/MacOS/callback_app.app" org.mozilla.TestAUSHelper callback_app
touch "$APP/Contents/moz.build"

signed_id() {
  codesign -dv "$1" 2>&1 | sed -n 's/^Identifier=//p'
}

uuids() {
  dwarfdump --uuid "$1" | awk '{print $2}' | sort | tr '\n' ' '
}

original="$(uuids /usr/bin/true)"
sign_dev_bundle "$APP" - || fail "sign_dev_bundle failed"
first="$(uuids "$APP/Contents/MacOS/sval")"

expect_id() {
  local got
  got="$(signed_id "$1")"
  [[ "$got" == "$2" ]] || fail "$1 is signed as '$got', expected $2"
}
expect_id "$APP" app.sval.dev
expect_id "$APP/Contents/MacOS/sval-child.app" app.sval.dev.plugincontainer
expect_id "$APP/Contents/MacOS/gpu-helper.app" app.sval.dev.sval-gpu-helper
expect_id "$APP/Contents/MacOS/updater.app" app.sval.dev.updater
plist_id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' \
  "$APP/Contents/MacOS/callback_app.app/Contents/Info.plist")"
[[ "$plist_id" == org.mozilla.TestAUSHelper ]] ||
  fail "a helper outside app.sval became $plist_id"

[[ "$first" != "$original" ]] || fail "the app's executable kept its build UUIDs"
[[ "$(uuids "$APP/Contents/MacOS/sval-child.app/Contents/MacOS/sval-child")" != "$first" ]] ||
  fail "a helper shares the app's executable UUID"
for signed in "$APP" "$APP"/Contents/MacOS/{sval-child,gpu-helper}.app; do
  codesign --verify --strict "$signed" 2>&1 || fail "$signed does not verify"
done

# A second launch of the same build, or another build, gets the same identity.
sign_dev_bundle "$APP" - || fail "a second sign_dev_bundle failed"
expect_id "$APP" app.sval.dev
[[ "$(uuids "$APP/Contents/MacOS/sval")" == "$first" ]] ||
  fail "a second signing changed the executable's UUIDs"

if ((failures)); then
  echo "dev-identity-test: $failures failure(s)" >&2
  exit 1
fi
echo "dev-identity-test: passed"
