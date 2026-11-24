#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Sync added files, then apply the patch series in order.
#
# The series names two kinds of entry. A `.patch` is applied with `git apply`.
# A `.delete` lists Mozilla files a removal deletes, one path per line relative
# to the tree; the files go at that point in the series. A list carries no file
# contents, which a deletion in a patch would.
#
# Stops at the first patch that neither applies nor merges, which names the
# Mozilla file that moved under it, and at the first listed file that does not
# exist, which names a file an upstream update moved or removed.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"
SERIES="$REPO_ROOT/patches/series"

if [[ ! -d "$SRC/.git" ]]; then
  echo "error: no upstream checkout at $SRC — run scripts/fetch-upstream.sh first" >&2
  exit 1
fi

# shellcheck disable=SC1091
source "$REPO_ROOT/upstream.txt"

echo "==> Resetting upstream tree to pristine state"
# `reset --hard` to the pinned commit rather than `checkout -- .`: the end of
# this script commits the applied series, so the tree's HEAD moves and
# discarding modifications alone would leave that commit in place. Untracked
# files are left alone, which is what preserves the object directory.
git -C "$SRC" reset --hard "$UPSTREAM_REF" >/dev/null
git -C "$SRC" clean -fd -e 'objdir-*' -e mozconfig

"$REPO_ROOT/scripts/sync-files.sh"

applied=0
touched_files=()
while IFS= read -r line; do
  [[ -z "${line// }" || "$line" == \#* ]] && continue
  patch_file="$REPO_ROOT/patches/$line"
  if [[ ! -f "$patch_file" ]]; then
    echo "error: $line listed in patches/series but not found at $patch_file" >&2
    exit 1
  fi
  if [[ "$line" == *.delete ]]; then
    echo "==> Deleting $line"
    while IFS= read -r path; do
      [[ -z "${path// }" || "$path" == \#* ]] && continue
      if [[ ! -e "$SRC/$path" && ! -L "$SRC/$path" ]]; then
        echo "error: $line lists $path, which is not in $SRC." >&2
        echo "  An upstream update moved or removed it: find where it went and" >&2
        echo "  update the list, or drop the line if the file is gone." >&2
        exit 1
      fi
      rm -f "$SRC/$path"
      # A directory left empty goes too, as `git apply` removes one when a
      # patch deletes its last file.
      dir="$(dirname "$path")"
      while [[ "$dir" != "." ]] && rmdir "$SRC/$dir" 2>/dev/null; do
        dir="$(dirname "$dir")"
      done
      touched_files+=("$path")
    done < "$patch_file"
    applied=$((applied + 1))
    continue
  fi
  echo "==> Applying $line"
  # A patch that does not apply is tried once more as a three-way merge,
  # which works when the tree holds the blobs the patch was made against
  # (fetch the previous upstream pin into $SRC during a rebase). A clean merge
  # carries on with a warning; a conflict leaves markers in the files.
  if git -C "$SRC" apply --verbose "$patch_file"; then
    :
  elif git -C "$SRC" apply --3way "$patch_file"; then
    echo "warning: $line applied only as a three-way merge. Regenerate it:" >&2
    echo "         ./scripts/make-patch.sh ${line%.patch} <path...>" >&2
  else
    echo "" >&2
    echo "error: $line FAILED to apply." >&2
    echo "  This is the annual rebase telling you something moved upstream." >&2
    echo "  Fix:" >&2
    echo "    1. Reset the tree: ./scripts/apply-patches.sh will have already" >&2
    echo "       left earlier patches in the series applied — re-run this script" >&2
    echo "       after fixing, or 'git -C $SRC checkout -- .' to start clean." >&2
    echo "    2. Re-apply ONLY the failing patch by hand in $SRC (do not touch" >&2
    echo "       files owned by other patches in the series)." >&2
    echo "    3. Regenerate with an EXPLICIT pathspec, scoped to this patch's" >&2
    echo "       own files, or you will silently capture every other applied" >&2
    echo "       patch's changes into this one:" >&2
    echo "       ./scripts/make-patch.sh ${line%.patch} <path...>" >&2
    echo "  For a three-way merge instead, fetch the commit the series was made" >&2
    echo "  against and re-run: git -C $SRC fetch --depth 1 origin <old pin>" >&2
    exit 1
  fi
  applied=$((applied + 1))
  # The paths come from the "diff --git" headers because `git apply
  # --numstat` needs them to exist relative to the current directory, and they
  # are relative to $SRC. Collected across the series, they give the count of
  # distinct Mozilla files, which patches share.
  while IFS= read -r path; do
    touched_files+=("$path")
  done < <(sed -n 's|^diff --git a/\(.*\) b/.*|\1|p' "$patch_file")
done < "$SERIES"

if [[ ${#touched_files[@]} -gt 0 ]]; then
  surface=$(printf '%s\n' "${touched_files[@]}" | sort -u | wc -l | tr -d ' ')
else
  surface=0
fi

# Commit the applied series so `make-patch.sh` diffs against "pristine plus
# every existing patch". Without this, editing a file another patch already
# touches, such as browser/base/jar.mn, produces a diff carrying that patch's
# lines too, and the captured patch has to be trimmed by
# hand. Only the files the series touches are staged: `git add -A` here would
# stage the object directory. The identity is given here because a fresh tree,
# a CI container especially, has none configured, and a commit that fails
# leaves every later `make-patch.sh` diffing against the wrong base. The paths
# reach git on stdin because together they outgrow the 32767-character
# command line Windows allows a process.
if [[ ${#touched_files[@]} -gt 0 ]]; then
  printf '%s\n' "${touched_files[@]}" | sort -u |
    git -C "$SRC" add --pathspec-from-file=-
fi
git -C "$SRC" -c user.name=sval -c user.email=sval@localhost \
  commit -q --allow-empty -m "sval: patch series applied" >/dev/null

echo "==> Applied $applied patch(es) and deletion list(s)"
echo "    Patch surface: $applied entries touching $surface Mozilla file(s)"
