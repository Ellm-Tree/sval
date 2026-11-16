#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Download a pinned third-party tool's release file, such as gitleaks or Vale,
# from Sval's copy in Forgejo's generic package registry, and from its
# publisher only when the registry lacks it. A required check that downloads
# from GitHub fails whenever GitHub's release downloads do. The file must
# match the SHA-256 the caller pins, wherever it came from.
#
# The copy is version <version> of the package tool-<name>, holding <file>.
# publish downloads the file from the publisher and uploads it there, once per
# pin: run it when a pin moves.
#
# Usage: ./scripts/fetch-tool.sh fetch|publish <name> <version> <file> <sha256> <url> <out>
#   SVAL_PACKAGES_TOKEN  read:package to fetch, write:package to publish, on
#                       the Sval organisation; fetch falls back on ~/.netrc
#   SVAL_PACKAGES_URL    default https://git.ellmtree.ai/api/packages/Sval/generic

set -euo pipefail

if [[ $# -ne 7 || ( "$1" != fetch && "$1" != publish ) ]]; then
  echo "usage: $0 fetch|publish <name> <version> <file> <sha256> <url> <out>" >&2
  exit 1
fi
MODE="$1" NAME="$2" VERSION="$3" FILE="$4" SHA="$5" URL="$6" OUT="$7"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/registry.sh
source "$REPO_ROOT/scripts/lib/registry.sh"
COPY="$REGISTRY/tool-$NAME/$VERSION/$FILE"
if [[ "$MODE" == publish ]]; then
  registry_open sval-gecko required
else
  registry_open sval optional
fi
part="$REGISTRY_TMP/$FILE"

matches() { [[ "$(sha256 "$part" | cut -d' ' -f1)" == "$SHA" ]]; }

from_publisher() {
  curl -fsSL --retry 3 --max-time 120 -o "$part" "$URL" && matches
}

if [[ "$MODE" == publish ]]; then
  if [[ "$(status "$COPY")" == 200 ]]; then
    echo "==> tool-$NAME $VERSION $FILE is already published"
    exit 0
  fi
  from_publisher || { echo "error: $URL did not give the pinned file" >&2; exit 1; }
  code="$(api -o /dev/null -w '%{http_code}' --upload-file "$part" "$COPY")"
  [[ "$code" == 201 ]] || { echo "error: uploading $COPY returned $code" >&2; exit 1; }
  echo "==> Published tool-$NAME $VERSION $FILE"
  exit 0
fi

code="$(api --retry 3 --max-time 120 -o "$part" -w '%{http_code}' "$COPY" || true)"
if [[ "$code" != 200 ]]; then
  echo "::warning::the registry answered $code for tool-$NAME $VERSION $FILE; downloading it from its publisher" >&2
  from_publisher || { echo "error: $URL did not give the pinned file" >&2; exit 1; }
elif ! matches; then
  echo "error: the registry's tool-$NAME $VERSION $FILE does not match its pinned checksum" >&2
  exit 1
fi
mkdir -p "$(dirname "$OUT")"
mv "$part" "$OUT"
