# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Fetch a release build's Breakpad symbols, sval-symbols <build id>
# (scripts/publish-symbols.sh), sourced by the scripts that read crash files
# and performance profiles.
#
# sval_symbols <build id> prints the directory the symbols are unpacked in,
# laid out as mach's crashreporter-symbols are: <debug file>/<debug id>/<file>.sym.
# Only a release compile publishes symbols; for any other build id it fails.
#
#   SVAL_PACKAGES_TOKEN  read:package on the Sval organisation; without it,
#                        curl reads the registry host's entry in ~/.netrc
#   SVAL_SYMBOLS_CACHE   default: ~/.cache/sval-symbols

sval_symbols() {
  local build_id="$1"
  if [[ ! "$build_id" =~ ^[0-9]{14}$ ]]; then
    echo "error: $build_id is not a build id" >&2
    return 1
  fi
  # A published file never changes (the registry refuses to overwrite one),
  # so a build's unpacked symbols are kept and reused.
  local cache="${SVAL_SYMBOLS_CACHE:-$HOME/.cache/sval-symbols}/$build_id"
  if [[ ! -f "$cache/.complete" ]]; then
    # shellcheck source=scripts/lib/registry.sh
    source "$(dirname "${BASH_SOURCE[0]}")/registry.sh"
    registry_open sval optional
    local found=0 platform file code
    for platform in linux64 win64 macos-aarch64 macos-x86_64; do
      file="$platform.crashreporter-symbols.zip"
      code="$(api -o "$REGISTRY_TMP/$file" -w '%{http_code}' "$REGISTRY/sval-symbols/$build_id/$file")"
      case "$code" in
        200)
          echo "==> Unpacking sval-symbols $build_id $file" >&2
          unzip -q -o "$REGISTRY_TMP/$file" -d "$REGISTRY_TMP/symbols"
          found=1
          ;;
        404) ;;
        *)
          echo "error: fetching sval-symbols $build_id $file returned $code" >&2
          return 1
          ;;
      esac
    done
    if [[ "$found" == 0 ]]; then
      echo "error: sval-symbols has no version $build_id; only a release compile publishes symbols" >&2
      return 1
    fi
    mkdir -p "$(dirname "$cache")"
    rm -rf "$cache"
    mv "$REGISTRY_TMP/symbols" "$cache"
    touch "$cache/.complete"
  fi
  echo "$cache"
}
