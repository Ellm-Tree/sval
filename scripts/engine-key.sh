#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Print the engine key: a SHA-256 over what decides the bytes of the wasm
# engine scripts/build-core-wasm.sh stages. CI's engine job publishes the
# engine under it as version <key> of the package sval-engine, and the jobs that
# test it fetch it by the same key, so no job depends on another job's
# artifacts.
#
# The inputs are the git tree of engine/ at HEAD, which carries the engine's
# source, Cargo.lock and the rust-toolchain.toml cargo builds it with; the
# wasm-bindgen-cli version the CI image installs, which writes the glue;
# this repository's rust-toolchain.toml, the image's default toolchain; and
# build-core-wasm.sh, which runs both. Raise KEY_VERSION to move every key at
# once.
#
# Usage: ./scripts/engine-key.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

KEY_VERSION=1

bindgen="$(sed -n 's/.*cargo install wasm-bindgen-cli --version \([^ ]*\).*/\1/p' .forgejo/docker/Dockerfile)"
if [[ -z "$bindgen" ]]; then
  echo "error: no wasm-bindgen-cli version in .forgejo/docker/Dockerfile" >&2
  exit 1
fi

# shellcheck source=scripts/lib/registry.sh
source ./scripts/lib/registry.sh

{
  printf 'version %s\n' "$KEY_VERSION"
  printf 'engine %s\n' "$(git rev-parse HEAD:engine)"
  printf 'wasm-bindgen %s\n' "$bindgen"
  for f in rust-toolchain.toml scripts/build-core-wasm.sh; do
    printf 'file %s %s\n' "$f" "$(git hash-object -- "$f")"
  done
} | sha256 | cut -d' ' -f1
