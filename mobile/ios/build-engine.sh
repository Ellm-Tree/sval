#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Build the phones' native library (mobile/sval-mobile: the engine in engine/
# and the folder connectors) for the iPhone, its simulator or both, and
# generate the Swift bindings the app compiles against, into
# mobile/ios/Generated/. It builds both as they stand, uncommitted changes
# included.
#
#   mobile/ios/build-engine.sh [--ship] device|simulator...
#
# `device` is what an archive or an install on an iPhone links, `simulator`
# what the tests link. The app builds only for the slices last built.
# `--ship` builds with the crate's `ship` profile, for a build a user
# receives (mobile/sval-mobile/Cargo.toml).
#
# The engine is told which code it is through SVAL_ENGINE_TREE, as
# scripts/build-core-wasm.sh tells the desktop's.
set -euo pipefail

usage="usage: $0 [--ship] device|simulator..."
PROFILE=release
if [[ "${1:-}" == --ship ]]; then
  PROFILE=ship
  shift
fi
[[ $# -gt 0 ]] || { echo "$usage" >&2; exit 2; }
TARGETS=()
for slice in "$@"; do
  case "$slice" in
    device) TARGETS+=(aarch64-apple-ios) ;;
    simulator) TARGETS+=(aarch64-apple-ios-sim) ;;
    *) echo "$usage" >&2; exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENGINE="$REPO_ROOT/engine"
CRATE="$REPO_ROOT/mobile/sval-mobile"
# One target directory for the engine and this crate, so neither builds twice.
export CARGO_TARGET_DIR="$ENGINE/target"
OUT="$REPO_ROOT/mobile/ios/Generated"
# The app's deployment target (`project.yml`). rustc and the cc crate read it
# from here; without it ring's C objects target the SDK's own iOS version,
# newer than the app runs on.
export IPHONEOS_DEPLOYMENT_TARGET="$(sed -n 's/^ *iOS: "\(.*\)"$/\1/p' "$REPO_ROOT/mobile/ios/project.yml")"

TREE="$(git -C "$REPO_ROOT" rev-parse HEAD:engine)"
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=no -- engine)" ]]; then
  TREE="$TREE-dirty"
fi
echo "==> Sval engine: tree $TREE"

# From the crate, so rustup picks its rust-toolchain.toml, the engine's channel.
cd "$CRATE"
for target in "${TARGETS[@]}"; do
  echo "==> Building the engine for $target"
  rustup target add --toolchain "$(rustup show active-toolchain | cut -d' ' -f1)" "$target" >/dev/null
  SVAL_ENGINE_TREE="$TREE" cargo rustc --lib --profile "$PROFILE" \
    --target "$target" --crate-type staticlib
done

echo "==> Generating Swift bindings"
# Only what this script makes: XcodeGen writes Info.plist here too.
rm -rf "$OUT/swift" "$OUT/headers" "$OUT/SvalEngine.xcframework"
mkdir -p "$OUT/headers"
# Library mode reads the interface from the metadata symbols the exports
# leave in the library, and uniffi_bindgen reads them from a static archive's
# members as from a dylib.
cargo run --release \
  --manifest-path "$REPO_ROOT/mobile/uniffi-bindgen/Cargo.toml" \
  --target-dir "$ENGINE/target" -- \
  generate --library "$ENGINE/target/${TARGETS[0]}/$PROFILE/libsval_mobile.a" \
  --language swift --out-dir "$OUT/swift"

mv "$OUT/swift/"*.h "$OUT/headers/"
# An xcframework's headers are found through a file of exactly this name, so
# each crate's module map goes into the one file.
cat "$OUT/swift/"*.modulemap > "$OUT/headers/module.modulemap"
rm "$OUT/swift/"*.modulemap

echo "==> Packaging SvalEngine.xcframework"
args=()
for target in "${TARGETS[@]}"; do
  args+=(-library "$ENGINE/target/$target/$PROFILE/libsval_mobile.a" -headers "$OUT/headers")
done
xcodebuild -create-xcframework "${args[@]}" -output "$OUT/SvalEngine.xcframework" >/dev/null

echo "==> Staged:"
ls "$OUT" "$OUT/swift"
