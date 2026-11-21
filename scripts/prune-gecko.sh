#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Delete the registry's Gecko packages (gecko-<platform>) created over 14 days
# ago, except the checkout's own key. A Gecko package is a cache an artifact
# build fetches by key: a key nobody has used for two weeks belongs to a branch
# no run is likely to re-run, and a run that needs it again compiles and
# publishes it. No release reads one, because a release compiles its own
# Gecko. sval-symbols is never touched: it holds released builds' crash
# symbols.
#
# Usage: ./scripts/prune-gecko.sh [--dry-run]
#
# Reads a write:package token from SVAL_PACKAGES_TOKEN.
set -euo pipefail

cd "$(dirname "$0")/.."

API=https://git.ellmtree.ai/api/v1
OWNER=Sval

dry_run=0
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *)
    echo "usage: $0 [--dry-run]" >&2
    exit 2
    ;;
esac

: "${SVAL_PACKAGES_TOKEN:?SVAL_PACKAGES_TOKEN is not set}"

# The token goes to curl in a config file, so it is never on a command line.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf 'header = "Authorization: token %s"\n' "$SVAL_PACKAGES_TOKEN" > "$tmp/auth"
api() { curl -fsS -K "$tmp/auth" "$@"; }

keep="$(./scripts/gecko-key.sh)"
cutoff="$(jq -n 'now - 14 * 86400')"

# Collect every page before deleting, so a deletion never shifts a later page.
page=1
: > "$tmp/versions"
while :; do
  versions="$(api "$API/packages/$OWNER?type=generic&q=gecko-&limit=50&page=$page")"
  [[ "$(jq length <<<"$versions")" -gt 0 ]] || break
  # Forgejo writes created_at with the server's UTC offset, which jq's
  # fromdateiso8601 rejects, so the offset is applied by hand.
  jq -r --arg keep "$keep" --argjson cutoff "$cutoff" '
    def epoch: capture("^(?<t>.{19})(?<s>[-+])(?<h>..):(?<m>..)$")
      | (.t + "Z" | fromdateiso8601)
        - (if .s == "+" then 1 else -1 end)
          * ((.h | tonumber) * 3600 + (.m | tonumber) * 60);
    .[] | select((.name | startswith("gecko-")) and .version != $keep)
    | select((.created_at | epoch) < $cutoff)
    | "\(.name) \(.version)"' <<<"$versions" >> "$tmp/versions"
  page=$((page + 1))
done

echo "keeping key $keep; $(wc -l < "$tmp/versions" | tr -d ' ') versions are over 14 days old"
while read -r name version; do
  if ((dry_run)); then
    echo "would delete $name $version"
  else
    echo "deleting $name $version"
    api -X DELETE "$API/packages/$OWNER/generic/$name/$version"
  fi
done < "$tmp/versions"
