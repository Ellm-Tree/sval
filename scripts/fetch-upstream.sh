#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Clone the pinned Firefox ESR source into build/firefox.
# Safe to re-run: re-fetches into a clean tree.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# shellcheck disable=SC1091
source ./upstream.txt

DEST="build/firefox"

# `mach artifact` walks back up to 500 revisions looking for indexed
# TaskCluster artifacts. A depth-1 clone gives it one candidate, so if HEAD's
# artifacts have expired or were never indexed, the artifact build fails with
# no fallback, and that grows more likely as the pin ages.
DEPTH=50

# A fetch of a new pin into a repository that keeps the old one adds a full
# shallow history beside it, about 1 GB, and nothing refers to the old one
# afterwards. Expiring the reflog lets gc drop it, so a repository that
# outlives its job holds one pin.
drop_old_pins() {
  git "$@" reflog expire --expire=now --all
  git "$@" gc --quiet --prune=now
}

# SVAL_UPSTREAM_CACHE names a bare repository that keeps the pinned commit
# between runs. CI sets it: without it every job downloads the same commit from
# GitHub. The cache is filled once per pin and read from local disk after that.
SOURCE="$UPSTREAM_REMOTE"
FROM_CACHE=()
if [[ -n "${SVAL_UPSTREAM_CACHE:-}" ]]; then
  CACHE="$SVAL_UPSTREAM_CACHE"
  # The cache can belong to another user, because CI hands its volume to an
  # unprivileged test user after the build, so git must be told it is safe.
  # `-c` covers commands run in the cache. A fetch from it runs upload-pack,
  # which does not inherit `-c` over a local transport, so that gets its own.
  # git runs that command through a shell, so the path in it is quoted.
  SAFE=(-c "safe.directory=$CACHE")
  FROM_CACHE=(--upload-pack "git -c $(printf '%q' "safe.directory=$CACHE") upload-pack")
  # CI keeps each cache where one job runs at a time, a linux job's mozbuild
  # slot or a runner of capacity one, so nothing locks it.
  [[ -d "$CACHE" ]] || git init -q --bare "$CACHE"
  if ! git "${SAFE[@]}" -C "$CACHE" cat-file -e "$UPSTREAM_REF^{commit}" 2>/dev/null; then
    echo "==> Filling the upstream cache at $CACHE"
    git "${SAFE[@]}" -C "$CACHE" fetch --depth "$DEPTH" "$UPSTREAM_REMOTE" "$UPSTREAM_REF"
    # A fetch by SHA creates no ref, and gc deletes what no ref reaches.
    git "${SAFE[@]}" -C "$CACHE" update-ref refs/sval/pin "$UPSTREAM_REF"
    drop_old_pins "${SAFE[@]}" -C "$CACHE"
  fi
  # Lets a fetch name the pinned commit by SHA, as the fetches below do.
  git "${SAFE[@]}" -C "$CACHE" config uploadpack.allowAnySHA1InWant true
  SOURCE="$CACHE"
  echo "==> Using the upstream cache at $CACHE"
fi

if [[ -d "$DEST/.git" ]]; then
  echo "==> Existing checkout found at $DEST"
  # A checkout that already holds the pinned commit has nothing to fetch. A
  # shallow fetch of it anyway renegotiates the shallow boundary and re-sends
  # objects the checkout already has, on every run of the Windows CI runner,
  # whose tree persists between jobs.
  if git -C "$DEST" cat-file -e "$UPSTREAM_REF^{commit}" 2>/dev/null; then
    echo "    $UPSTREAM_REF is already present; resetting to it (applied patches will be lost)."
  else
    echo "    Fetching $UPSTREAM_REF and resetting to it (applied patches will be lost)."
    git -C "$DEST" fetch ${FROM_CACHE[@]+"${FROM_CACHE[@]}"} --depth "$DEPTH" "$SOURCE" "$UPSTREAM_REF"
    git -C "$DEST" reset --hard "$UPSTREAM_REF"
    drop_old_pins -C "$DEST"
  fi
  git -C "$DEST" reset --hard "$UPSTREAM_REF"
  # scripts/build.sh puts a mozconfig and objdir-<target> build directories in
  # this checkout, and a bare `clean -fdx` would delete an object directory
  # that took a long build. scripts/apply-patches.sh excludes the same paths.
  git -C "$DEST" clean -fdx -e mozconfig -e 'objdir-*'
else
  echo "==> Cloning $UPSTREAM_REF from $SOURCE (shallow, depth $DEPTH)"
  mkdir -p build
  # UPSTREAM_REF is a commit SHA, which `git clone --branch` cannot take, so
  # the checkout is fetched by hand. core.autocrlf=false keeps upstream files
  # LF on Windows, where Git for Windows and MozillaBuild default to
  # autocrlf=true, which breaks `git apply` of Sval's LF patches.
  git -c core.autocrlf=false init -q "$DEST"
  git -C "$DEST" remote add origin "$UPSTREAM_REMOTE"
  git -C "$DEST" fetch ${FROM_CACHE[@]+"${FROM_CACHE[@]}"} --depth "$DEPTH" "$SOURCE" "$UPSTREAM_REF"
  git -C "$DEST" checkout -q FETCH_HEAD
fi

echo "==> Upstream ready at $DEST"
echo "    HEAD: $(git -C "$DEST" rev-parse HEAD)"
# version_display.txt carries the "esr" suffix and version.txt does not, so
# printing it makes a wrong-channel checkout visible. Sval is based on ESR
# (spec §3.1).
echo "    Firefox version: $(cat "$DEST/browser/config/version_display.txt")"

actual_head="$(git -C "$DEST" rev-parse HEAD)"
if [[ "$actual_head" != "$UPSTREAM_REF" ]]; then
  echo "error: checked-out HEAD ($actual_head) does not match UPSTREAM_REF ($UPSTREAM_REF)" >&2
  exit 1
fi
