#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Fetch Sval's Gecko packages for one platform and key from Forgejo's package
# registry into <dir>, and check them against the version's SHA256SUMS. A
# directory already holding a complete, verified copy is used as it is: a
# published version never changes.
#
# Exit status: 0 when <dir> holds the packages; 3 when the registry has no
# complete version under that key, or there is no credential to ask with, or
# the registry cannot be reached and there is no credential; 1 on any other
# failure, a refused credential included, SVAL_PACKAGES_TOKEN or the
# registry host's entry in ~/.netrc, because a credential that is there and
# refused is misconfiguration, and falling back on it would hide that: every
# build would run on Mozilla's Gecko, without Sval's native changes, and say so
# only in a line of build output. scripts/build.sh treats 3 as "build against
# Mozilla's Gecko".
#
# The platform `engine` fetches the wasm engine, version <key> of sval-engine
# (scripts/engine-key.sh).
#
# --check asks the registry and downloads nothing, with the same exit status:
# 0 when the version is complete, 3 when it is absent.
#
# Usage: ./scripts/fetch-gecko.sh <platform> <key> <dir>
#        ./scripts/fetch-gecko.sh --check <platform> <key>
#   SVAL_PACKAGES_TOKEN  a token with read:package on the Sval organisation; when
#                       unset, curl reads the registry host's entry in ~/.netrc
#   SVAL_PACKAGES_URL    default https://git.ellmtree.ai/api/packages/Sval/generic

set -euo pipefail

CHECK=""
if [[ "${1:-}" == --check ]]; then
  CHECK=1
  shift
  set -- ${1+"$@"} ""
fi
if [[ $# -ne 3 ]]; then
  echo "usage: $0 <platform> <key> <dir> | --check <platform> <key>" >&2
  exit 1
fi
PLATFORM="$1"
KEY="$2"
DIR="$3"
NAME="gecko-$PLATFORM"
[[ "$PLATFORM" == engine ]] && NAME=sval-engine
# shellcheck source=scripts/lib/registry.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/registry.sh"
BASE="$REGISTRY/$NAME/$KEY"
registry_open sval optional

# The registry's answer for meta.json: 3 for no complete version, or for no
# credential to ask with; 1 for a refused token or any other answer.
absent_or_refused() {
  case "$1" in
    404) exit 3 ;;
    401 | 403)
      if [[ -n "${SVAL_PACKAGES_TOKEN:-}" ]]; then
        echo "error: the package registry refused SVAL_PACKAGES_TOKEN ($1)" >&2
        exit 1
      fi
      if registry_netrc_entry; then
        echo "error: the package registry refused ~/.netrc's credential for $(registry_host) ($1)" >&2
        echo "       replace it with a token that has read:package on the Sval organisation" >&2
        exit 1
      fi
      echo "==> No credential for the package registry ($1): set SVAL_PACKAGES_TOKEN" >&2
      echo "    or a machine $(registry_host) entry in ~/.netrc to build on Sval's Gecko" >&2
      exit 3
      ;;
    *)
      echo "error: the registry answered $1 for $NAME $KEY" >&2
      exit 1
      ;;
  esac
}

# A curl that fails exits with its own status, and its 3 (a malformed URL)
# would read as "not published", so every request maps a failure to 1. With no
# credential, Sval's Gecko is out of reach whether or not the registry answers.
unreachable() {
  if [[ -z "${SVAL_PACKAGES_TOKEN:-}" ]] && ! registry_netrc_entry; then
    echo "==> Could not reach the package registry, and there is no credential for it" >&2
    exit 3
  fi
  echo "error: could not reach the package registry for $NAME $KEY" >&2
  exit 1
}

if [[ -n "$CHECK" ]]; then
  code="$(status "$BASE/meta.json")" || unreachable
  [[ "$code" == 200 ]] && exit 0
  absent_or_refused "$code"
fi

get() { api -o "$2" -w '%{http_code}' "$BASE/$1"; }

if [[ -f "$DIR/meta.json" ]] && (cd "$DIR" && sha256_check SHA256SUMS) 2>/dev/null; then
  exit 0
fi

mkdir -p "$DIR"
rm -f "$DIR/meta.json"
code="$(get meta.json "$DIR/meta.json.part")" || unreachable
if [[ "$code" != 200 ]]; then
  rm -f "$DIR/meta.json.part"
  absent_or_refused "$code"
fi

code="$(get SHA256SUMS "$DIR/SHA256SUMS")" || unreachable
[[ "$code" == 200 ]] || { echo "error: SHA256SUMS answered $code" >&2; exit 1; }
while read -r _ f; do
  echo "==> Downloading $NAME $f"
  code="$(get "$f" "$DIR/$f")" || unreachable
  [[ "$code" == 200 ]] || { echo "error: $f answered $code" >&2; exit 1; }
done < "$DIR/SHA256SUMS"
(cd "$DIR" && sha256_check SHA256SUMS) || { echo "error: $NAME $KEY failed its checksums" >&2; exit 1; }
mv "$DIR/meta.json.part" "$DIR/meta.json"
