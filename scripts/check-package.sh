#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Package the built tree with `mach package` and check that the package holds
# Sval's own files.
#
# The package manifest (browser/installer/package-manifest.in) copies only the
# files it names, so a file Sval adds that the manifest does not name is left
# out of the package without an error. A package missing app-sval-prefs.js is
# Firefox with Firefox's defaults: telemetry and everything else Sval switches
# off comes back on. Artifact and full builds both package, so this runs
# against whatever `scripts/build.sh` produced.
#
# Usage: ./scripts/check-package.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/launch.sh
source "$REPO_ROOT/scripts/lib/launch.sh"
SRC="$REPO_ROOT/build/firefox"
cd "$SRC"

# A package is Sval only on Sval's Gecko. An artifact build that fell back to
# Mozilla's (scripts/artifact-gecko.sh) runs Sval's front end without Sval's
# native changes, and front-end code that calls them throws. A full build
# leaves no .sval-gecko-source.
if [[ -f .sval-gecko-source ]]; then
  read -r gecko_source _ < .sval-gecko-source
  if [[ "$gecko_source" != sval ]]; then
    echo "error: this build runs on Mozilla's Gecko, and a package needs Sval's." >&2
    echo "       Rebuild with SVAL_GECKO_SOURCE=sval ./scripts/build.sh; it says why it cannot." >&2
    exit 1
  fi
fi

log="$(mktemp)"
work="$(mktemp -d)"
trap 'rm -f "$log"; rm -rf "$work"' EXIT

"$REPO_ROOT/scripts/stage-sval-mcp.sh"
"$REPO_ROOT/scripts/stage-sval-folder.sh"

echo "==> Packaging"
./mach package 2>&1 | tee "$log"

failed=0
if grep -q 'Missing file(s)' "$log"; then
  echo "error: the package manifest names files the build did not produce:" >&2
  grep 'Missing file(s)' "$log" | sed 's/^/  /' >&2
  failed=1
fi

dist="$(./mach environment --format=json | python3 -c 'import json,sys; print(json.load(sys.stdin)["topobjdir"])')/dist"
pkg="$(ls -t "$dist"/*.tar.xz "$dist"/*.dmg "$dist"/*.zip 2>/dev/null \
  | grep -v -e xpt_artifacts -e update_framework_artifacts -e crashreporter-symbols -e '\.tests\.' | head -1 || true)"
if [[ -z "$pkg" ]]; then
  echo "error: mach package left no package in $dist" >&2
  exit 1
fi
echo "==> Checking $pkg"

# Unpack the package's app directory into $work, whatever the platform's format.
case "$pkg" in
  *.tar.xz) tar -xJf "$pkg" -C "$work" ;;
  *.zip) unzip -q "$pkg" -d "$work" ;;
  *.dmg) copy_app_from_dmg "$pkg" "$work" ;;
esac

omni="$(find "$work" -path '*/browser/omni.ja' | head -1)"
if [[ -z "$omni" ]]; then
  echo "error: no browser/omni.ja in $pkg" >&2
  exit 1
fi
entries="$(unzip -Z1 "$omni")"
files="$(cd "$work" && find . -type f)"

require_entry() {
  if ! grep -qx "$1" <<<"$entries"; then
    echo "error: browser/omni.ja lacks $1" >&2
    failed=1
  fi
}
require_entry defaults/preferences/app-sval-prefs.js
require_entry defaults/preferences/app-sval-firefox-ui.js
require_entry defaults/sval-permissions

# GTK draws a window's icon from these; macOS and Windows take theirs from the
# bundle and the executable.
if [[ "$pkg" == *.tar.xz ]]; then
  for size in 16 32 48 64 128; do
    if ! grep -q "/browser/chrome/icons/default/default$size.png\$" <<<"$files"; then
      echo "error: $pkg lacks browser/chrome/icons/default/default$size.png" >&2
      failed=1
    fi
  done
fi

# Sval's own programs sit beside the browser binary: the shim agents launch,
# where Sval's agent settings point them, and the shared-folder helper, which
# the browser starts from there. Each carries the package's build id, so Sval
# can tell which build it came from.
platform_ini="$(cd "$work" && find . -name platform.ini | head -1)"
build_id="$(sed -n 's/^BuildID=//p' "$work/$platform_ini" | head -1)"
# An instrumented build's package leaves them out: its manifest names them
# only outside MOZ_PROFILE_GENERATE, and nothing ships that package.
profile_generate="$(./mach python -c 'import buildconfig; print(buildconfig.substs.get("MOZ_PROFILE_GENERATE") or "")' | tail -1)"
if [[ -z "$profile_generate" ]]; then
  for program in sval-mcp sval-folder; do
    found="$(cd "$work" && find . -type f \( -name "$program" -o -name "$program.exe" \) | head -1)"
    if [[ -z "$found" ]]; then
      echo "error: $pkg lacks $program" >&2
      failed=1
      continue
    fi
    case "$pkg" in
      *.dmg) beside="*.app/Contents/MacOS/$program" ;;
      *) beside="$(dirname "$platform_ini")/$program*" ;;
    esac
    # shellcheck disable=SC2053 # $beside is a glob on purpose.
    if [[ "$found" != $beside ]]; then
      echo "error: $program is at $found, away from the browser binary" >&2
      failed=1
    fi
    if [[ -z "$build_id" ]] || ! LC_ALL=C grep -aqF "$build_id" "$work/$found"; then
      echo "error: $found does not carry the package's build id ${build_id:-(none)}" >&2
      failed=1
    fi
  done
fi

# A compiled Windows Gecko carries the MSVC runtime beside its own DLLs; without
# it, nothing in the package starts on a machine lacking Microsoft's
# redistributable.
if [[ "$pkg" == *.zip ]]; then
  for dll in vcruntime140.dll vcruntime140_1.dll msvcp140.dll; do
    if ! grep -q "/$dll\$" <<<"$files"; then
      echo "error: $pkg lacks $dll" >&2
      failed=1
    fi
  done
fi

if [[ "$failed" != 0 ]]; then
  exit 1
fi
echo "==> The package holds Sval's files"
