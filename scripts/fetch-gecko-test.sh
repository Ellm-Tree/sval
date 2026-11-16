#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Checks that scripts/fetch-gecko.sh fails on a credential the registry
# refuses, and lets the build fall back to Mozilla's Gecko only when there is
# no credential at all. A refused credential that fell back would build every
# tree on Mozilla's Gecko, where Sval's front end calls native methods that do
# not exist. This runs fetch-gecko.sh against a local registry that refuses
# every request.
#
# Needs bash, curl and python3. It runs from scripts/lint.sh.
set -euo pipefail

FETCH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fetch-gecko.sh"

work="$(mktemp -d)"
server=""
cleanup() {
  if [[ -n "$server" ]]; then
    kill "$server" 2>/dev/null || true
    wait "$server" 2>/dev/null || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

# The registry records each request's credential, so a check can tell a
# refusal from a failure that never reached it, which also exits 1.
python3 -I -c '
import base64, http.server, sys

class Refuse(http.server.BaseHTTPRequestHandler):
    def refuse(self):
        sent = self.headers.get("Authorization", "")
        if sent.startswith("Basic "):
            with open(sys.argv[2], "a") as f:
                f.write(base64.b64decode(sent[6:]).decode() + "\n")
        self.send_response(401)
        self.send_header("Content-Length", "0")
        self.end_headers()

    do_GET = do_HEAD = refuse

    def log_message(self, *args):
        pass

httpd = http.server.HTTPServer(("127.0.0.1", 0), Refuse)
with open(sys.argv[1], "w") as f:
    f.write(str(httpd.server_port))
httpd.serve_forever()
' "$work/port" "$work/sent" &
server=$!
for _ in $(seq 100); do
  [[ -s "$work/port" ]] && break
  sleep 0.1
done
[[ -s "$work/port" ]] || { echo "fetch-gecko-test: the local registry did not start" >&2; exit 1; }

port="$(cat "$work/port")"
export SVAL_PACKAGES_URL="http://127.0.0.1:$port/api/packages/Sval/generic"
mkdir -p "$work/bare" "$work/netrc"
printf 'machine 127.0.0.1 login sval password refused\n' > "$work/netrc/.netrc"

failed=0
# expect <exit status> <what> <credential the registry must have seen, or
# "-" for none> <env...>
expect() {
  local want="$1" what="$2" sent="$3" got=0
  shift 3
  rm -f "$work/sent"
  env "$@" "$FETCH" --check linux64 key >/dev/null 2>&1 || got=$?
  if [[ "$got" != "$want" ]]; then
    echo "fetch-gecko-test: $what exited $got, expected $want" >&2
    failed=1
  fi
  if [[ "$sent" == - ]]; then
    if [[ -s "$work/sent" ]]; then
      echo "fetch-gecko-test: $what sent a credential" >&2
      failed=1
    fi
  elif ! grep -qxF -- "$sent" "$work/sent" 2>/dev/null; then
    echo "fetch-gecko-test: $what never asked the registry with $sent" >&2
    failed=1
  fi
}
expect 3 "no credential" - -u SVAL_PACKAGES_TOKEN HOME="$work/bare"
expect 1 "a refused ~/.netrc entry" "sval:refused" -u SVAL_PACKAGES_TOKEN HOME="$work/netrc"
expect 1 "a refused SVAL_PACKAGES_TOKEN" "sval:refused" SVAL_PACKAGES_TOKEN=refused HOME="$work/bare"

[[ "$failed" == 0 ]] && echo "fetch-gecko-test: ok"
exit "$failed"
