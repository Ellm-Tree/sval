#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# List what a developer's Mac can reclaim from Sval's checkouts and mach's state
# directory, with sizes, and remove it with --apply. Without --apply nothing is
# removed. --apply measures nothing: du over a worktree's build tree walks
# millions of files, and removing needs no size. new-worktree.sh runs it.
#
#   scripts/reclaim-dev.sh            # list
#   scripts/reclaim-dev.sh --apply    # remove every "reclaim" line
#   scripts/reclaim-dev.sh --count    # print how many worktrees are reclaimable
#
# Each line is one of:
#   reclaim  regenerable or finished with; --apply removes it
#   keep     a worktree left alone, with the reason
#   manual   reclaimable by hand if you decide to; never removed here
#
# The scope is the git checkouts beside this one (the directory holding the
# main checkout) and mach's state directory (MOZBUILD_STATE_PATH, default
# ~/.mozbuild), and on macOS the Launch Services registrations of Sval builds
# that are gone. Docker, VMs, and the Local Network rules of Sval builds that
# are gone are reported as manual lines only.
#
# Sizes are apparent sizes. build-worktree.sh clones build/firefox copy-on-write,
# so removing a worktree frees less than its size says.
#
# A worktree under <checkout>/.worktrees/ is reclaimed when its branch was
# merged into origin's default branch, it has no changes git would show, and no
# process has a file, binary or working directory inside it. lsof is read for
# paths only: process command lines can carry tokens. "Merged" means the
# branch's tip is reachable from the default branch but is not on that branch's
# first-parent line: a branch just created from it, with no commit of its own,
# is someone's new work and is kept. A squash-merged branch, or one whose
# origin branch was deleted unmerged, is listed as manual, because only its
# owner knows whether its commits are needed.
set -euo pipefail

usage() {
  echo "usage: $0 [--apply | --count]" >&2
}

MODE=list
case "$#:${1:-}" in
  0:) ;;
  1:--apply) MODE=apply ;;
  1:--count) MODE=count ;;
  *)
    usage
    exit 1
    ;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
COMMON="$(cd "$SCRIPT_DIR" && cd "$(git rev-parse --git-common-dir)" && pwd -P)"
MAIN="$(dirname "$COMMON")"
DEV="$(dirname "$MAIN")"
STATE="${MOZBUILD_STATE_PATH:-$HOME/.mozbuild}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
: >"$TMP/doomed"   # worktree paths classified reclaim
# One removal per line: kind, repo, path, branch. The separator is not
# whitespace, so read keeps an empty field.
US=$'\x1f'
: >"$TMP/removals"
TOTAL_KB=0
COUNT=0

say() {
  [[ "$MODE" == count ]] || printf '%s\n' "$*"
}

human() {
  awk -v k="$1" 'BEGIN {
    if (k >= 1048576) printf "%.1fG", k / 1048576
    else if (k >= 1024) printf "%.0fM", k / 1024
    else printf "%dK", k
  }'
}

size_kb() {
  [[ "$MODE" == apply ]] && return
  local kb
  kb="$(du -sk "$1" 2>/dev/null | cut -f1)" || true
  echo "${kb:-0}"
}

# line <action> <kb or ""> <text>
line() {
  local size=""
  [[ -n "$2" ]] && size="$(human "$2")"
  say "$(printf '%-8s %7s  %s' "$1" "$size" "$3")"
  if [[ "$1" == reclaim && -n "$2" ]]; then
    TOTAL_KB=$((TOTAL_KB + $2))
  fi
}

# Paths every process of this user has open, its working directory and
# executables included. Only lsof's name field is kept.
snapshot_open() {
  lsof -w -Fn 2>/dev/null | sed -n 's/^n\(\/.*\)$/\1/p' >"$TMP/open" || true
}

in_use() {
  awk -v d="$1" 'index($0, d "/") == 1 || $0 == d { found = 1; exit }
    END { exit !found }' "$TMP/open"
}

dirty() {
  [[ -n "$(git -C "$1" status --porcelain 2>/dev/null || echo error)" ]]
}

rel() {
  echo "${1#"$DEV"/}"
}

sha256() {
  if command -v sha256sum >/dev/null; then
    printf '%s' "$1" | sha256sum | cut -d' ' -f1
  else
    printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1
  fi
}

snapshot_open

# --- Worktrees ---------------------------------------------------------------

classify_worktree() {
  local repo="$1" default="$2" wt="$3" branch="$4" locked="$5" kb
  case "$wt" in
    "$repo/.worktrees/"*) ;;
    *) return ;;
  esac
  if [[ -z "$branch" ]]; then
    line keep "" "$(rel "$wt") (detached HEAD)"
  elif [[ -n "$locked" ]]; then
    line keep "" "$(rel "$wt") (locked)"
  elif in_use "$wt"; then
    line keep "" "$(rel "$wt") (in use: a process has files open in it)"
  elif dirty "$wt"; then
    line keep "" "$(rel "$wt") (uncommitted changes)"
  else
    local head track
    head="$(git -C "$repo" rev-parse --verify --quiet "refs/heads/$branch")" || head=""
    track="$(git -C "$repo" for-each-ref --format='%(upstream:track)' "refs/heads/$branch")"
    if [[ -z "$head" ]]; then
      line keep "" "$(rel "$wt") (branch $branch not found)"
    elif git -C "$repo" merge-base --is-ancestor "$head" "$default"; then
      if grep -qx "$head" "$TMP/first-parent"; then
        line keep "" "$(rel "$wt") (branch $branch has no commits of its own)"
      else
        COUNT=$((COUNT + 1))
        [[ "$MODE" == count ]] && return
        kb="$(size_kb "$wt")"
        line reclaim "$kb" "$(rel "$wt") (branch $branch merged into $default)"
        printf '%s\n' "$wt" >>"$TMP/doomed"
        printf "worktree$US%s$US%s$US%s\n" "$repo" "$wt" "$branch" >>"$TMP/removals"
      fi
    elif [[ "$track" == "[gone]" ]]; then
      [[ "$MODE" == count ]] && return
      kb="$(size_kb "$wt")"
      line manual "$kb" "$(rel "$wt") (branch $branch deleted on origin, not merged into $default)"
    else
      line keep "" "$(rel "$wt") (branch $branch not merged)"
    fi
  fi
}

say "Worktrees"
for gitdir in "$DEV"/*/.git; do
  [[ -d "$gitdir" ]] || continue
  repo="$(dirname "$gitdir")"
  if ! git -C "$repo" fetch --quiet --prune origin 2>/dev/null; then
    say "warning: could not fetch $(rel "$repo"); judging by its last fetch"
  fi
  default="$(git -C "$repo" symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null)" ||
    default=origin/main
  if ! git -C "$repo" rev-parse --verify --quiet "$default" >/dev/null; then
    continue
  fi
  git -C "$repo" rev-list --first-parent "$default" >"$TMP/first-parent"

  wt="" branch="" locked="" prunable=""
  while IFS= read -r entry || [[ -n "$wt" ]]; do
    case "$entry" in
      "worktree "*) wt="${entry#worktree }" ;;
      "branch refs/heads/"*) branch="${entry#branch refs/heads/}" ;;
      locked*) locked=1 ;;
      prunable*) prunable=1 ;;
      "")
        if [[ -n "$prunable" ]]; then
          line reclaim "" "$(rel "$repo"): stale entry for missing worktree $wt"
          printf "prune$US%s$US$US\n" "$repo" >>"$TMP/removals"
        elif [[ -n "$wt" ]]; then
          classify_worktree "$repo" "$default" "$wt" "$branch" "$locked"
        fi
        wt="" branch="" locked="" prunable=""
        ;;
    esac
  done < <(git -C "$repo" worktree list --porcelain)

  [[ "$MODE" == count ]] && continue
  if [[ -d "$repo/.worktrees" ]]; then
    git -C "$repo" worktree list --porcelain | sed -n 's/^worktree //p' >"$TMP/registered"
    for d in "$repo/.worktrees"/*; do
      [[ -d "$d" ]] || continue
      if ! grep -qxF "$d" "$TMP/registered"; then
        line manual "$(size_kb "$d")" "$(rel "$d") (not a registered worktree)"
      fi
    done
  fi
done

if [[ "$MODE" == count ]]; then
  echo "$COUNT"
  exit 0
fi

# --- mach's state directory --------------------------------------------------

doomed() {
  local p="$1" d
  while IFS= read -r d; do
    case "$p" in "$d" | "$d"/*) return 0 ;; esac
  done <"$TMP/doomed"
  return 1
}

if [[ -d "$STATE" ]]; then
  say ""
  say "mach state ($STATE)"

  # mach keeps one directory per source tree, holding that tree's virtualenvs,
  # named after the tree and a hash of its path (get_state_dir in
  # python/mach/mach/util.py). One whose tree is gone is never read again.
  : >"$TMP/live-trees"
  for d in "$STATE"/srcdirs/*/; do
    [[ -d "$d" ]] || continue
    d="${d%/}"
    if [[ ! -f "$d/topsrcdir.txt" ]]; then
      line manual "$(size_kb "$d")" "srcdirs/$(basename "$d") (names no source tree)"
      continue
    fi
    top="$(cat "$d/topsrcdir.txt")"
    if [[ -d "$top" ]] && ! doomed "$(cd "$top" && pwd -P)"; then
      printf '%s\n' "$top" >>"$TMP/live-trees"
    else
      line reclaim "$(size_kb "$d")" "srcdirs/$(basename "$d") (virtualenvs of $(rel "$top"), which is gone)"
      printf "path$US$US%s$US\n" "$d" >>"$TMP/removals"
    fi
  done

  # The web-platform-tests manifest cache is keyed by a hash of each tree's
  # testing/web-platform path (load_and_update in
  # testing/web-platform/manifestupdate.py).
  : >"$TMP/live-wpt"
  while IFS= read -r top; do
    sha256 "$top/testing/web-platform" >>"$TMP/live-wpt"
  done <"$TMP/live-trees"
  for d in "$STATE"/cache/wpt/*/; do
    [[ -d "$d" ]] || continue
    d="${d%/}"
    if ! grep -qxF "$(basename "$d")" "$TMP/live-wpt"; then
      line reclaim "$(size_kb "$d")" "cache/wpt/$(basename "$d" | cut -c1-12)… (wpt manifests of a tree that is gone)"
      printf "path$US$US%s$US\n" "$d" >>"$TMP/removals"
    fi
  done

  # Sval's Gecko packages, one directory per key (scripts/artifact-gecko.sh).
  # A key is in use while a checkout's last build chose it or its object
  # directory holds it. fetch-gecko.sh fetches any other again on demand. A
  # directory touched in the last day may be a fetch in progress.
  : >"$TMP/gecko-keys"
  git -C "$MAIN" worktree list --porcelain | sed -n 's/^worktree //p' >"$TMP/sval-checkouts"
  while IFS= read -r c; do
    doomed "$c" && continue
    for f in "$c/build/firefox/.sval-gecko-source" "$c"/build/firefox/objdir-*/.sval-gecko-installed; do
      [[ -f "$f" ]] && awk '$1 == "sval" { print $2 }' "$f" >>"$TMP/gecko-keys"
    done
  done <"$TMP/sval-checkouts"
  for d in "$STATE"/sval-gecko/*/*/; do
    [[ -d "$d" ]] || continue
    d="${d%/}"
    key="$(basename "$d")"
    grep -qxF "$key" "$TMP/gecko-keys" && continue
    [[ -n "$(find "$d" -maxdepth 0 -mmin -1440)" ]] && continue
    line reclaim "$(size_kb "$d")" "sval-gecko/$(basename "$(dirname "$d")")/$(echo "$key" | cut -c1-12)… (no checkout builds on it)"
    printf "path$US$US%s$US\n" "$d" >>"$TMP/removals"
  done

  # mach's toolchain download cache, named <hash of URL>-<archive name>
  # (ArtifactCache in python/mozbuild/mozbuild/artifact_cache.py). bootstrap
  # unpacks each archive into its own directory; an older download of the same
  # archive name is a superseded version.
  : >"$TMP/seen-archives"
  # shellcheck disable=SC2012 # names are <hex>-<url-encoded path>, no newlines
  while IFS= read -r f; do
    case "$f" in *-*) ;; *) continue ;; esac
    archive="${f#*-}"
    if grep -qxF "$archive" "$TMP/seen-archives"; then
      line reclaim "$(size_kb "$STATE/toolchains/$f")" "toolchains/$f (superseded download)"
      printf "path$US$US%s$US\n" "$STATE/toolchains/$f" >>"$TMP/removals"
    else
      printf '%s\n' "$archive" >>"$TMP/seen-archives"
    fi
  done < <(ls -t "$STATE/toolchains" 2>/dev/null)
fi

# --- Launch Services (macOS) -------------------------------------------------

# Launching a build registers its bundle with Launch Services, and every build
# carries the bundle id app.sval.sval (mozconfig's --with-distribution-id), or
# app.sval.dev once scripts/run.sh or scripts/test.sh has launched it.
# Deleting a build leaves its registration behind. macOS can resolve the
# default browser's bundle id to a registration whose bundle is gone, and a
# link opened from another app then fails with "The file can't be found."
LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
if [[ -x "$LSREGISTER" ]]; then
  say ""
  say "Launch Services"
  while IFS= read -r app; do
    if [[ ! -e "$app" ]]; then
      line reclaim "" "registration of $app, which is gone"
    elif doomed "$app"; then
      line reclaim "" "registration of $app, in a worktree removed above"
    else
      continue
    fi
    printf "lsregister$US$US%s$US\n" "$app" >>"$TMP/removals"
  done < <("$LSREGISTER" -dump 2>/dev/null | awk '
    /^path:/ { sub(/^path: +/, ""); sub(/ \(0x[0-9a-f]+\)$/, ""); path = $0 }
    /^identifier: +app\.sval\.(sval|dev)$/ && !seen[path]++ { print path }')
fi

# --- Local Network privacy (macOS) -------------------------------------------

# macOS keeps a Local Network rule for each program that asked, some with the
# path it was launched from, in a root-owned file every user may read. Apple
# gives no way to remove one before the remove button System Settings gains in
# macOS 27.2 (TN3179, "Reset local network state"), so these are listed only.
NE_PLIST=/Library/Preferences/com.apple.networkextension.plist
if [[ "$MODE" == list && -r "$NE_PLIST" ]]; then
  python3 -I - "$NE_PLIST" >"$TMP/ne-rules" 2>/dev/null <<'PY' || true
import os, plistlib, sys
objects = plistlib.load(open(sys.argv[1], "rb"))["$objects"]
ref = lambda v: objects[v.data] if isinstance(v, plistlib.UID) else v
for rule in objects:
    if not isinstance(rule, dict) or "SigningIdentifier" not in rule:
        continue
    ident, path = str(ref(rule["SigningIdentifier"])), ref(rule.get("Path"))
    if not ident.startswith("app.sval."):
        continue
    if isinstance(path, str) and path.startswith("/") and not os.path.exists(path):
        print(f"{ident} for {path}, which is gone")
PY
  if [[ -s "$TMP/ne-rules" ]]; then
    say ""
    say "Local Network rules (System Settings > Privacy & Security > Local Network)"
    while IFS= read -r rule; do
      line manual "" "$rule"
    done <"$TMP/ne-rules"
  fi
fi

# --- Elsewhere, by hand ------------------------------------------------------

if [[ "$MODE" == list ]]; then
  say ""
  say "Manual"
  for target in "$DEV"/*/target "$MAIN/tools/sval-mcp/target" "$MAIN/tools/sval-folder/target"; do
    [[ -d "$target" && -f "$(dirname "$target")/Cargo.toml" ]] || continue
    line manual "$(size_kb "$target")" "$(rel "$target") (cargo build output: cargo clean)"
  done
  audit_vms="${BROWSER_AUDIT_HOME:-$HOME/VMs}"
  if [[ -d "$audit_vms" ]]; then
    line manual "$(size_kb "$audit_vms")" "$audit_vms (browser-audit VMs)"
  fi
  if [[ -d "$HOME/.tart" ]]; then
    line manual "$(size_kb "$HOME/.tart")" "$HOME/.tart (tart VMs and images)"
  fi
  if command -v docker >/dev/null &&
    docker system df --format '{{.Type}}|{{.Size}}|{{.Reclaimable}}' >"$TMP/docker" 2>/dev/null; then
    while IFS='|' read -r type size reclaimable; do
      say "$(printf '%-8s %7s  Docker %s (%s reclaimable: docker system prune)' manual "$size" "$type" "$reclaimable")"
    done <"$TMP/docker"
  fi

  say ""
  say "Reclaimable: $(human "$TOTAL_KB") (apparent size)"
  [[ -s "$TMP/removals" ]] && say "Run with --apply to remove every reclaim line."
exit 0
fi

# --- Apply -------------------------------------------------------------------

say ""
# Another session may have started work in a worktree since the listing.
snapshot_open
status=0
while IFS="$US" read -r kind repo path branch; do
  case "$kind" in
    worktree)
      if in_use "$path" || dirty "$path"; then
        say "skipped $(rel "$path"): in use or changed since the listing"
        continue
      fi
      if git -C "$repo" worktree remove "$path" &&
        git -C "$repo" branch -D "$branch" >/dev/null; then
        say "removed $(rel "$path") and branch $branch"
      else
        status=1
      fi
      ;;
    prune)
      git -C "$repo" worktree prune && say "pruned stale worktree entries in $(rel "$repo")"
      ;;
    path)
      rm -rf "$path" && say "removed $path"
      ;;
    lsregister)
      "$LSREGISTER" -u "$path" && say "unregistered $path"
      ;;
  esac
done <"$TMP/removals"
exit "$status"
