#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Fetch the wasm engine published under <key> (scripts/engine-key.sh) and put
# it where scripts/sync-files.sh copies it from. Every CI job that tests Sval
# runs this; CI's engine job publishes the key first.
#
# It fails unless both files arrived. sync-files.sh substitutes a stub that
# throws on import when the engine is absent, and never overwrites a real one,
# so a job that went on without them would test against the stub.
#
# Usage: ./scripts/fetch-engine.sh <key>
#   SVAL_PACKAGES_TOKEN  a token with read:package on the Sval organisation
set -euo pipefail

if [[ $# -ne 1 || -z "$1" ]]; then
  echo "usage: $0 <key>" >&2
  exit 1
fi
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

./scripts/fetch-gecko.sh engine "$1" build/sval-engine
dest=chrome/browser/components/sval
for f in sval_core.mjs sval_core_bg.wasm; do
  cp "build/sval-engine/$f" "$dest/$f"
  [[ -s "$dest/$f" ]] || { echo "error: $dest/$f is empty" >&2; exit 1; }
  echo "ok: $f $(wc -c < "$dest/$f" | tr -d ' ') bytes"
done
