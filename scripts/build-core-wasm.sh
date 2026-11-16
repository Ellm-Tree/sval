#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Build the engine in engine/ for wasm and stage the artifact where
# sync-files.sh will copy it into the browser. It builds engine/ as it stands,
# uncommitted changes included.
#
#   scripts/build-core-wasm.sh
#
# The engine is told which code it is through SVAL_ENGINE_TREE: the git tree id
# of engine/ at HEAD, with -dirty appended when engine/ has uncommitted
# changes. engineVersion() reports it.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE="$REPO_ROOT/engine"
DEST="$REPO_ROOT/chrome/browser/components/sval"

TREE="$(git -C "$REPO_ROOT" rev-parse HEAD:engine)"
# Untracked files are not counted: one can only reach the build through a
# tracked file that names it, and that file would then be modified.
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no -- engine)" ]]; then
  TREE="$TREE-dirty"
fi
echo "==> Sval engine: tree $TREE"

echo "==> Building the engine for wasm32-unknown-unknown"
# From engine/: rustup picks the toolchain from the directory cargo runs in,
# and engine/rust-toolchain.toml lists the wasm target, which the repository's
# own rust-toolchain.toml, pinned for Gecko, does not.
(
  cd "$ENGINE"
  SVAL_ENGINE_TREE="$TREE" cargo build --manifest-path Cargo.toml \
    --target-dir target \
    --release --target wasm32-unknown-unknown --features wasm
)

echo "==> Generating JS glue"
# --target web produces an ES module. The worker is an .mjs loaded as
# `{ type: "module" }`, and a module worker has no importScripts, so the
# no-modules/importScripts combination is not available to us.
wasm-bindgen \
  --target web \
  --out-dir "$DEST" \
  --out-name sval_core \
  --no-typescript \
  "$ENGINE/target/wasm32-unknown-unknown/release/sval_core.wasm"

# The glue is an ES module, so it carries the extension that says so: a .js in
# this tree is linted as a script and the module syntax fails to parse.
mv -f "$DEST/sval_core.js" "$DEST/sval_core.mjs"

echo "==> Staged:"
ls -la "$DEST/sval_core.mjs" "$DEST/sval_core_bg.wasm"
