# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# The client for Forgejo's generic package registry, sourced by the scripts
# that publish and fetch Sval's Gecko, engine and toolchains.
#
# registry_open makes a scratch directory, REGISTRY_TMP, that an EXIT trap
# removes, and writes the credential there as a file curl reads, so the token
# is never on a command line. A script that sources this sets no EXIT trap of
# its own; its scratch files go in REGISTRY_TMP.
#
#   SVAL_PACKAGES_TOKEN  the token, with read:package or write:package on the
#                       Sval organisation
#   SVAL_PACKAGES_URL    default https://git.ellmtree.ai/api/packages/Sval/generic

REGISTRY="${SVAL_PACKAGES_URL:-https://git.ellmtree.ai/api/packages/Sval/generic}"

# registry_open <user> required|optional
# Without SVAL_PACKAGES_TOKEN, `required` fails and `optional` lets curl read
# the registry host's entry in ~/.netrc, if there is one.
registry_open() {
  REGISTRY_TMP="$(mktemp -d)"
  trap 'rm -rf "$REGISTRY_TMP"' EXIT
  REGISTRY_AUTH="$REGISTRY_TMP/auth"
  if [[ -n "${SVAL_PACKAGES_TOKEN:-}" ]]; then
    printf 'user = "%s:%s"\n' "$1" "$SVAL_PACKAGES_TOKEN" > "$REGISTRY_AUTH"
  elif [[ "$2" == required ]]; then
    echo "error: SVAL_PACKAGES_TOKEN is not set" >&2
    exit 1
  else
    printf 'netrc-optional\n' > "$REGISTRY_AUTH"
  fi
}

api() { curl -sS -K "$REGISTRY_AUTH" "$@"; }

# registry_host: the host the registry's URL names.
registry_host() {
  local rest="${REGISTRY#*://}"
  rest="${rest%%/*}"
  echo "${rest%%:*}"
}

# registry_netrc_entry: whether ~/.netrc, the file curl's netrc-optional reads,
# names the registry's host or has a default entry, so curl sent a credential.
registry_netrc_entry() {
  [[ -f "$HOME/.netrc" ]] &&
    awk -v host="$(registry_host)" '
      { for (i = 1; i <= NF; i++) if ($i == "default" || ($i == "machine" && $(i + 1) == host)) found = 1 }
      END { exit !found }' "$HOME/.netrc"
}

# status <url>: the HTTP status of a HEAD request.
status() { api -o /dev/null -w '%{http_code}' -I "$1"; }

sha256() {
  if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi
}

# sha256_check <sums file>, run in the directory the file names files in.
sha256_check() {
  if command -v sha256sum >/dev/null; then
    sha256sum --quiet -c "$@"
  else
    shasum -a 256 --quiet -c "$@"
  fi
}

# A version is complete once its marker, the file a publisher uploads last, is
# there. The registry refuses to overwrite a file, so a complete version never
# changes. Two runs can publish one version at once, so a version holding files
# but no marker is either another run's publish in flight or one that died
# part-way.
#
# await_marker <version url> <marker>: waits while another run is still adding
# files, and returns 1 once the version has gone fifteen minutes with no new
# file and no marker. The version's file list comes from Forgejo's package API,
# which sits beside the registry's own.
await_marker() {
  local files="${1%%/api/packages/*}/api/v1/packages/${1#*/api/packages/}/files"
  local seen="" now quiet=0
  while ((quiet < 60)); do
    [[ "$(status "$1/$2")" == 200 ]] && return 0
    now="$(api "$files" 2>/dev/null | cksum || true)"
    if [[ "$now" != "$seen" ]]; then
      seen="$now"
      quiet=0
    else
      quiet=$((quiet + 1))
    fi
    sleep 15
  done
  return 1
}

# claim_version <version url> <marker> <first file> <label>
# Returns 0 when the version is complete, so there is nothing to publish, and 1
# when the caller is to upload it, marker last. A partial version (its first
# file there, no marker) is waited for, and deleted when nobody completes it.
claim_version() {
  local code
  if [[ "$(status "$1/$2")" == 200 ]]; then
    echo "==> $4 is already published"
    return 0
  fi
  if [[ "$(status "$1/$3")" == 200 ]]; then
    echo "==> $4 holds a partial publish; waiting for the run uploading it"
    if await_marker "$1" "$2"; then
      echo "==> $4 was published by another run"
      return 0
    fi
    echo "==> $4 is still partial; deleting it"
    code="$(api -o /dev/null -w '%{http_code}' -X DELETE "$1")"
    [[ "$code" == 204 ]] || { echo "error: delete returned $code" >&2; exit 1; }
  fi
  return 1
}
