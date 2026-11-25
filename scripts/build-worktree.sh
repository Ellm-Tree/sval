#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Give the checkout this script is in its own build tree, patched and built.
#
#   scripts/build-worktree.sh
#
# new-worktree.sh runs it, and a worktree made with --no-build runs it the
# first time it needs the browser. It keeps a build/firefox that exists.
#
# Every script resolves build/firefox against its own repository root, so a
# worktree with a real build/ of its own is isolated from every other agent's
# syncs, patches and builds. A worktree whose build/ points at the main
# checkout's is not: two agents syncing into one tree test each other's files.
#
# The upstream tree is copied rather than fetched. On APFS `cp -c` clones
# files copy-on-write, so the tree costs almost no disk. The source of every
# copy is an unpatched tree at the pin in the common git directory, which no
# checkout builds in. The object directory is built fresh, because it holds
# absolute symlinks into the tree it was built from.
set -euo pipefail

WT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
# The whole setup holds one light build slot (scripts/build-slot.py), and the
# build.sh it runs builds under it.
if [[ " ${SVAL_BUILD_SLOT_HELD:-} " != *" light "* ]] && python3 -c 'import fcntl' 2>/dev/null; then
  exec python3 -I "$WT/scripts/build-slot.py" light bash "${BASH_SOURCE[0]}" "$@"
fi
# The main checkout is the parent of the common git directory.
COMMON="$(cd "$(git -C "$WT" rev-parse --git-common-dir)" && pwd -P)"
MAIN="$(dirname "$COMMON")"
MAIN_SRC="$MAIN/build/firefox"
SOURCE="$COMMON/sval-upstream/firefox"

# A worktree's build grows to 6-12 GB, and a build that runs the disk out of
# space fails partway and leaves both trees hard to trust. SVAL_MIN_FREE_GB sets
# the floor below which this warns.
MIN_FREE_GB="${SVAL_MIN_FREE_GB:-40}"
free_gb="$(df -Pk "$MAIN" | awk 'NR == 2 { print int($4 / 1048576) }')"
if [[ "$free_gb" -lt "$MIN_FREE_GB" ]]; then
  stale="$("$WT/scripts/reclaim-dev.sh" --count 2>/dev/null || echo "?")"
  echo "warning: $free_gb GB free, under ${MIN_FREE_GB} GB. $stale worktree(s) can be reclaimed:" >&2
  echo "         scripts/reclaim-dev.sh lists them and more; --apply removes them." >&2
fi

case "$(uname -s)" in
  Darwin) clone=(cp -cRp) ;;
  Linux) clone=(cp -Rp --reflink=auto) ;;
  *) clone=(cp -Rp) ;;
esac

# A copy keeps each file's mtime and size but has a new inode and ctime, which
# git's default stat check treats as a change, so the first `git reset --hard`
# would rehash the whole tree. With these settings git compares the
# whole-second mtime and the size alone (core.checkStat in git-config(1)), and
# trusts the copied index. A copy of a tree carries its settings.
trust_copied_index() {
  git -C "$1" config core.checkStat minimal
  git -C "$1" config core.trustCtime false
}

mkdir -p "$WT/build"
skip_bootstrap=1
if [[ -d "$WT/build/firefox/.git" ]]; then
  echo "==> Keeping $WT/build/firefox"
elif [[ "$WT" != "$MAIN" ]]; then
  # shellcheck disable=SC1091
  source "$WT/upstream.txt"
  # One setup at a time brings the source tree to its pin, holding the lock
  # exclusively, and copies share it. `flock` is util-linux and absent on
  # macOS, so the lock is taken through Python's fcntl on this shell's fd 8,
  # as scripts/test.sh takes its own.
  exec 8>"$COMMON/sval-upstream.lock"
  python3 -I -c 'import fcntl; fcntl.flock(8, fcntl.LOCK_EX)'
  if [[ ! -d "$SOURCE/.git" ]]; then
    # Built beside its final path and moved into place, so a setup that
    # stops partway leaves no half-made source for the next one.
    rm -rf "$SOURCE.new"
    mkdir -p "$SOURCE.new"
    if [[ -d "$MAIN_SRC/.git" ]]; then
      echo "==> Cloning $MAIN_SRC into $SOURCE"
      find "$MAIN_SRC" -mindepth 1 -maxdepth 1 ! -name 'objdir-*' -exec \
        "${clone[@]}" {} "$SOURCE.new/" \;
      trust_copied_index "$SOURCE.new"
    else
      skip_bootstrap=0
    fi
    "$WT/scripts/fetch-upstream.sh" "$SOURCE.new"
    trust_copied_index "$SOURCE.new"
    mv "$SOURCE.new" "$SOURCE"
  elif [[ "$(git -C "$SOURCE" rev-parse HEAD)" != "$UPSTREAM_REF" ]]; then
    "$WT/scripts/fetch-upstream.sh" "$SOURCE"
  fi
  python3 -I -c 'import fcntl; fcntl.flock(8, fcntl.LOCK_SH)'
  echo "==> Cloning $SOURCE"
  mkdir -p "$WT/build/firefox"
  find "$SOURCE" -mindepth 1 -maxdepth 1 -exec "${clone[@]}" {} "$WT/build/firefox/" \;
  exec 8>&-
else
  "$WT/scripts/fetch-upstream.sh"
  skip_bootstrap=0
fi

# The engine artifact is gitignored, so a new worktree does not have it. Without
# it sync-files.sh stubs the engine out and every engine test fails. CI's engine
# job publishes the engine built from each engine key (scripts/engine-key.sh),
# so a worktree whose engine/ CI has built fetches those bytes. One whose
# engine CI has not built yet builds it from its own engine/, which is what CI's
# engine job builds. The main checkout's artifact is only as new as its last
# build, and may come from another engine, so it is the last resort.
ENGINE="chrome/browser/components/sval"
build_engine() {
  # Cargo rebuilds whatever in a copied target directory is stale, so starting
  # from the main checkout's leaves it the worktree's own crate to compile.
  if [[ -d "$MAIN/engine/target" && ! -e "$WT/engine/target" ]]; then
    "${clone[@]}" "$MAIN/engine/target" "$WT/engine/target"
  fi
  "$WT/scripts/build-core-wasm.sh"
}
if "$WT/scripts/fetch-engine.sh" "$("$WT/scripts/engine-key.sh")"; then
  echo "==> Fetched the engine CI built from this engine/"
elif ! build_engine; then
  echo "warning: could not build engine/; copying the main checkout's engine," >&2
  echo "         which may not be the engine CI tests against." >&2
  for f in sval_core.mjs sval_core_bg.wasm; do
    if [[ -f "$MAIN/$ENGINE/$f" && "$WT" != "$MAIN" ]]; then
      cp "$MAIN/$ENGINE/$f" "$WT/$ENGINE/$f"
    fi
  done
fi

"$WT/scripts/apply-patches.sh"
# A cloned or kept tree is already bootstrapped, and the toolchains live in
# ~/.mozbuild, which every tree shares. A fetched one has never been.
SVAL_SKIP_BOOTSTRAP="${SVAL_SKIP_BOOTSTRAP:-$skip_bootstrap}" "$WT/scripts/build.sh"

# eslint and prettier live in the tree's node_modules, which the main
# checkout's tree need not hold, so lint.sh would otherwise install them in
# the middle of a worktree's first lint.
if ! (cd "$WT/build/firefox" && ./mach lint --setup); then
  echo "warning: could not install the linters; lint.sh installs them on its first run." >&2
fi

echo "==> Build tree ready at $WT/build/firefox"
