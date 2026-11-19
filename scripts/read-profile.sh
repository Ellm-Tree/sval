#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Summarise a performance recording, the .json.gz that Help › Record
# Performance saves (decision 2428): the busiest threads of each process, the
# functions each spends its time in, and the graphics and media markers.
# Native frames are named from the recorded build's symbols, sval-symbols
# <build id> (scripts/publish-symbols.sh), which only a release compile has;
# a development build's recording is summarised with its frames as addresses.
#
# Usage: ./scripts/read-profile.sh <profile> [--threads N] [--functions N]
#   SVAL_SYMBOLS_DIR     symbols to use in place of the build's published ones
#   SVAL_PACKAGES_TOKEN, SVAL_SYMBOLS_CACHE   as scripts/lib/sval-symbols.sh
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <profile> [--threads N] [--functions N]" >&2
  exit 1
fi
PROFILE="$1"
shift
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ ! -f "$PROFILE" ]]; then
  echo "error: no profile at $PROFILE" >&2
  exit 1
fi

symbols="${SVAL_SYMBOLS_DIR:-}"
if [[ -z "$symbols" ]]; then
  build_id="$(python3 -I "$here/read_profile.py" --build-id "$PROFILE")"
  if [[ -n "$build_id" ]]; then
    # shellcheck source=scripts/lib/sval-symbols.sh
    source "$here/lib/sval-symbols.sh"
    symbols="$(sval_symbols "$build_id")" ||
      echo "==> No symbols for build $build_id; native frames stay addresses" >&2
  fi
fi

python3 -I "$here/read_profile.py" "$PROFILE" --symbols "$symbols" "$@"
