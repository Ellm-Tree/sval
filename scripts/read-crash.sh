#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Print a crash file's stacks with function names, files and lines: fetch the
# crashed build's symbols, sval-symbols <build id> (scripts/publish-symbols.sh),
# and run Mozilla's minidump-stackwalk on the minidump with them.
#
# A minidump names its libraries by debug id and carries no build id. The
# build id is the annotations' BuildID, in the file beside the dump: the
# Send Feedback form's <id>.extra.json, Gecko's own <id>.extra, or the
# extra.json the collector files with a crash dialog's dump.
#
# Only a release compile has symbols. A development or CI build's crash file
# has none to fetch.
#
# Usage: ./scripts/read-crash.sh <dump> [<annotations>]
#   <annotations>        default: the first of <id>.extra.json, <id>.extra and
#                        extra.json beside <id>.dmp
#   SVAL_PACKAGES_TOKEN  read:package on the Sval organisation; without it,
#                        curl reads the registry host's entry in ~/.netrc
#   MINIDUMP_STACKWALK   default: the one `mach bootstrap` installs,
#                        $MOZBUILD_STATE_PATH/minidump-stackwalk/minidump-stackwalk
#   SVAL_SYMBOLS_CACHE   default: ~/.cache/sval-symbols
set -euo pipefail

if [[ $# -lt 1 || $# -gt 2 ]]; then
  echo "usage: $0 <dump> [<annotations>]" >&2
  exit 1
fi
DUMP="$1"
EXTRA="${2:-}"
if [[ -z "$EXTRA" ]]; then
  for EXTRA in "${DUMP%.dmp}.extra.json" "${DUMP%.dmp}.extra" "$(dirname "$DUMP")/extra.json"; do
    [[ -f "$EXTRA" ]] && break
  done
fi
if [[ ! -f "$DUMP" ]] || [[ "$(head -c 4 "$DUMP")" != MDMP ]]; then
  echo "error: $DUMP is not a minidump" >&2
  exit 1
fi
if [[ ! -f "$EXTRA" ]]; then
  echo "error: no annotations at $EXTRA; pass the crash's annotations file" >&2
  exit 1
fi
build_id="$(python3 -I -c 'import json, sys; print(json.load(open(sys.argv[1])).get("BuildID", ""))' "$EXTRA")"
if [[ ! "$build_id" =~ ^[0-9]{14}$ ]]; then
  echo "error: $EXTRA has no BuildID" >&2
  exit 1
fi

stackwalk="${MINIDUMP_STACKWALK:-${MOZBUILD_STATE_PATH:-$HOME/.mozbuild}/minidump-stackwalk/minidump-stackwalk}"
if [[ ! -x "$stackwalk" ]]; then
  echo "error: no minidump-stackwalk at $stackwalk; ./mach bootstrap in build/firefox installs it" >&2
  exit 1
fi

# A published file never changes (the registry refuses to overwrite one), so
# a build's unpacked symbols are kept and reused.
cache="${SVAL_SYMBOLS_CACHE:-$HOME/.cache/sval-symbols}/$build_id"
if [[ ! -f "$cache/.complete" ]]; then
  # shellcheck source=scripts/lib/registry.sh
  source "$(dirname "${BASH_SOURCE[0]}")/lib/registry.sh"
  registry_open sval optional
  found=0
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
        exit 1
        ;;
    esac
  done
  if [[ "$found" == 0 ]]; then
    echo "error: sval-symbols has no version $build_id; only a release compile publishes symbols" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$cache")"
  rm -rf "$cache"
  mv "$REGISTRY_TMP/symbols" "$cache"
  touch "$cache/.complete"
fi

# The symbols directory is passed as mozcrash passes it (mozcrash.py).
"$stackwalk" "$DUMP" "$cache"
