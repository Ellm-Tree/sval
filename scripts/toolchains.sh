#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Keep the toolchains a Gecko compile builds with in Forgejo's generic package
# registry, so a pin can still be compiled once Mozilla's copies are gone.
#
# configure's --enable-bootstrap downloads each toolchain (clang, rustc,
# cbindgen, the sysroots, MSVC's "vs") into the mozbuild state directory as
# <state>/<name>, and records the index hash it came from in
# <state>/indices/<name>. When both are there and the hash is the one it
# wants, it downloads nothing (bootstrap_path in build/moz.configure/
# bootstrap.configure). Mozilla's toolchain artifacts expire, a year after they
# were built by default (expiration-policy in taskcluster/config.yml).
#
#   save     uploads each toolchain in <state> as version <index hash> of the
#            package toolchain-<name>, then the list of them, "<name> <hash>"
#            per line, as version <upstream pin> of toolchains-<platform>.
#   restore  puts every toolchain on that list back into <state>, so configure
#            finds it current and leaves Mozilla alone. A toolchain the
#            registry cannot give is left to configure, which downloads it
#            from Mozilla as it would anyway.
#
# Each toolchain version holds <name>.tar.gz and, uploaded last as the mark of
# a complete version, its SHA256SUMS. The registry refuses to overwrite a file,
# so a complete version never changes. Index hashes name the toolchain build,
# so pins that share a toolchain share its version.
#
# Usage: ./scripts/toolchains.sh save|restore <platform> <state-dir>
#   SVAL_PACKAGES_TOKEN  write:package to save, read:package to restore, on the
#                       Sval organisation; restore falls back on ~/.netrc
#   SVAL_PACKAGES_URL    default https://git.ellmtree.ai/api/packages/Sval/generic

set -euo pipefail

if [[ $# -ne 3 || ( "$1" != save && "$1" != restore ) ]]; then
  echo "usage: $0 save|restore <platform> <state-dir>" >&2
  exit 1
fi
MODE="$1"
PLATFORM="$2"
STATE="$3"
case "$PLATFORM" in
  linux64 | win64 | macos-aarch64 | macos-x86_64) ;;
  *)
    echo "error: unknown platform '$PLATFORM'" >&2
    exit 1
    ;;
esac
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/upstream.txt"
# shellcheck source=scripts/lib/registry.sh
source "$REPO_ROOT/scripts/lib/registry.sh"
LIST="$REGISTRY/toolchains-$PLATFORM/$UPSTREAM_REF/toolchains.txt"

if [[ "$MODE" == save ]]; then
  registry_open sval-gecko required
else
  registry_open sval-gecko optional
fi
work="$REGISTRY_TMP"
upload() {
  local code
  code="$(api -o /dev/null -w '%{http_code}' --upload-file "$1" "$2")"
  [[ "$code" == 201 ]] || { echo "error: uploading $2 returned $code" >&2; exit 1; }
}

save() {
  local list="$work/toolchains.txt" index name hash base tarball
  : > "$list"
  for index in "$STATE"/indices/*; do
    [[ -f "$index" ]] || continue
    name="$(basename "$index")"
    hash="$(tr -d '[:space:]' < "$index")"
    # An index whose toolchain is gone records a download that did not finish.
    [[ -e "$STATE/$name" && -n "$hash" ]] || continue
    printf '%s %s\n' "$name" "$hash" >> "$list"

    # Two compiles on different keys can share a toolchain and archive it at
    # once; SHA256SUMS goes last and marks the version complete.
    base="$REGISTRY/toolchain-$name/$hash"
    if claim_version "$base" SHA256SUMS "$name.tar.gz" "toolchain-$name $hash"; then
      continue
    fi
    tarball="$work/$name.tar.gz"
    tar -C "$STATE" -czf "$tarball" "$name"
    (cd "$work" && sha256 "$name.tar.gz") > "$work/SHA256SUMS"
    echo "==> Archiving toolchain-$name $hash ($(du -h "$tarball" | cut -f1))"
    upload "$tarball" "$base/$name.tar.gz"
    upload "$work/SHA256SUMS" "$base/SHA256SUMS"
    rm -f "$tarball"
  done

  if [[ ! -s "$list" ]]; then
    echo "error: $STATE holds no bootstrapped toolchains" >&2
    exit 1
  fi
  sort -o "$list" "$list"
  case "$(api -o "$work/archived.txt" -w '%{http_code}' "$LIST")" in
    200)
      if cmp -s "$list" "$work/archived.txt"; then
        echo "==> toolchains-$PLATFORM $UPSTREAM_REF is already archived"
      else
        # The list belongs to the pin, so a compile of the same pin that
        # builds with other toolchains has changed one with a patch.
        echo "::warning::toolchains-$PLATFORM $UPSTREAM_REF lists other toolchains than this compile used"
        diff "$work/archived.txt" "$list" || true
      fi
      ;;
    404)
      upload "$list" "$LIST"
      echo "==> Archived toolchains-$PLATFORM $UPSTREAM_REF"
      ;;
    *)
      echo "error: the registry answered for toolchains-$PLATFORM $UPSTREAM_REF unexpectedly" >&2
      exit 1
      ;;
  esac
}

restore() {
  local code name hash base
  code="$(api -o "$work/toolchains.txt" -w '%{http_code}' "$LIST")"
  case "$code" in
    200) ;;
    404)
      echo "==> No toolchains archived for $PLATFORM at $UPSTREAM_REF; configure fetches them from Mozilla"
      return
      ;;
    *)
      echo "::warning::the registry answered $code for toolchains-$PLATFORM $UPSTREAM_REF; configure fetches them from Mozilla"
      return
      ;;
  esac
  mkdir -p "$STATE/indices"
  while read -r name hash; do
    if [[ -e "$STATE/$name" && "$(cat "$STATE/indices/$name" 2>/dev/null)" == "$hash" ]]; then
      echo "==> $name is already in place"
      continue
    fi
    base="$REGISTRY/toolchain-$name/$hash"
    mkdir -p "$work/$name"
    if [[ "$(api -o "$work/$name/SHA256SUMS" -w '%{http_code}' "$base/SHA256SUMS")" != 200 ]] ||
      [[ "$(api -o "$work/$name/$name.tar.gz" -w '%{http_code}' "$base/$name.tar.gz")" != 200 ]] ||
      ! (cd "$work/$name" && sha256_check SHA256SUMS); then
      echo "::warning::could not restore toolchain-$name $hash; configure fetches it from Mozilla"
      rm -rf "$work/$name"
      continue
    fi
    rm -rf "${STATE:?}/$name" "$STATE/indices/$name"
    tar -C "$STATE" -xzf "$work/$name/$name.tar.gz"
    printf '%s' "$hash" > "$STATE/indices/$name"
    rm -rf "$work/$name"
    echo "==> Restored $name"
  done < "$work/toolchains.txt"
}

"$MODE"
