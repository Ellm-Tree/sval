#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Prove that Sval contacts only the hosts it names (spec §10.9).
#
# Launches the built browser on a fresh profile with Gecko's network logging
# on, drives it through the things a person does in the first minutes (a page
# load, typing in the address bar, a new tab, settings, the add-ons manager),
# leaves it idle, and fails on any host it resolved or connected to that
# scripts/network-contact/allowed-hosts.txt does not list, and on any Remote
# Settings collection it synced that browser.sval.remoteSettings.collections
# does not list.
#
# This cannot be a mochitest: the harness forbids non-local connections and
# overrides Sval's own prefs, which are exactly what is under test.
#
# SVAL_NETWORK_ALL_SWITCHES=1 first collects every boolean a person can turn on
# from Sval's UI (each settings pane's controls and the address bar's
# suggestion types) and runs the measured session with all of them on. That
# finds features that phone home only once a user opts in, which a
# default-settings run never exercises. Locked prefs ignore it, so a feature
# Sval removed stays removed.
#
# SVAL_NETWORK_PRIVATE=1 turns on "Always use private browsing mode", so every
# window is private and Sval runs on its in-memory private session
# (private-windows spec). Not with SVAL_NETWORK_ALL_SWITCHES, whose run is
# about sync.
#
# SVAL_NETWORK_SHARED_FOLDER=1 chooses a shared folder for the measured
# profile as Settings does, which mints the profile's sync key, so Sval's
# shared-folder helper runs during the session, and the run fails if nothing
# was written to the folder. The helper links no network code; whatever the
# operating system's file client contacts for it is outside this check.
#
# SVAL_NETWORK_FIRST_RUN=1 leaves first run on and answers it as a person
# who takes each step's default would, importing nothing and saying no to the
# default-browser question, so the run leaves the machine's browsers alone. The rest of the
# session follows, so the run measures a fresh install from its first window.
# The run fails if first run never shows.
#
# What it cannot see: timers longer than the run (daily update checks), and
# sockets Gecko opens outside its network stack, such as WebRTC's.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# An artifact build on Mozilla's Gecko carries Firefox's identity, and contacts
# Firefox's hosts (its update feed among them), so its contacts say nothing
# about Sval's. scripts/build.sh records the Gecko it chose; a full build
# compiles Sval's own and records nothing.
GECKO_SOURCE_FILE="$REPO_ROOT/build/firefox/.sval-gecko-source"
if [[ -f "$GECKO_SOURCE_FILE" ]]; then
  read -r gecko_source gecko_key < "$GECKO_SOURCE_FILE"
  if [[ "$gecko_source" != sval ]]; then
    echo "error: this build runs on Mozilla's Gecko, so its contacts are Firefox's, not Sval's." >&2
    echo "       Rebuild once CI has published Sval's Gecko for key ${gecko_key:-?}" >&2
    echo "       (SVAL_GECKO_SOURCE=sval ./scripts/build.sh fails rather than fall back)." >&2
    exit 1
  fi
fi

IDLE="${SVAL_NETWORK_IDLE_SECONDS:-150}"

WORK="$(mktemp -d)"
PROFILE="$WORK/profile"
LOGS="$WORK/log"
SITE="$WORK/site"
mkdir -p "$PROFILE" "$LOGS" "$SITE"

# shellcheck source=scripts/lib/launch.sh
source "$REPO_ROOT/scripts/lib/launch.sh"
MARIONETTE_PORT="$(free_port)"
SITE_PORT="$(free_port)"
TLS_PORT="$(free_port)"

cat > "$SITE/index.html" <<'HTML'
<!doctype html><title>sval network-contact test</title><p>A page with nothing on it.</p>
HTML

if [[ "${SVAL_NETWORK_FIRST_RUN:-}" == "1" ]]; then
  base_prefs "$MARIONETTE_PORT" first-run > "$PROFILE/prefs.js"
  FIRST_RUN=(--first-run)
else
  base_prefs "$MARIONETTE_PORT" > "$PROFILE/prefs.js"
fi

python3 -I -m http.server --bind 127.0.0.1 --directory "$SITE" "$SITE_PORT" \
  >"$WORK/site.log" 2>&1 &
SITE_PID=$!
disown "$SITE_PID"

# The same page over TLS, under a certificate from a CA made for this run, so
# loading it shows the certificate error for an unknown issuer: the error a
# page can send the user to, and one Gecko's error page reacts to on its own.
TLS="$WORK/tls"
mkdir -p "$TLS"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=sval network-contact CA" \
  -keyout "$TLS/ca.key" -out "$TLS/ca.pem" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -subj "/CN=127.0.0.1" \
  -keyout "$TLS/site.key" -out "$TLS/site.csr" 2>/dev/null
printf 'subjectAltName=IP:127.0.0.1\n' > "$TLS/ext"
openssl x509 -req -in "$TLS/site.csr" -CA "$TLS/ca.pem" -CAkey "$TLS/ca.key" \
  -CAcreateserial -days 2 -extfile "$TLS/ext" -out "$TLS/site.pem" 2>/dev/null
python3 -I -c '
import functools, http.server, ssl, sys
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
server = http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[2])), handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain(sys.argv[3], sys.argv[4])
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
' "$SITE" "$TLS_PORT" "$TLS/site.pem" "$TLS/site.key" >"$WORK/tls.log" 2>&1 &
TLS_PID=$!
disown "$TLS_PID"

BROWSER_PID=""
cleanup() {
  [[ -n "$BROWSER_PID" ]] && kill "$BROWSER_PID" 2>/dev/null || true
  pkill -f -- "--profile $PROFILE" 2>/dev/null || true
  kill "$SITE_PID" 2>/dev/null || true
  kill "$TLS_PID" 2>/dev/null || true
  if [[ "${SVAL_NETWORK_KEEP:-}" == "1" ]]; then
    echo "network-contact: logs kept in $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

if [[ "${SVAL_NETWORK_ALL_SWITCHES:-}" == "1" ]]; then
  COLLECT="$WORK/collect-profile"
  mkdir -p "$COLLECT"
  base_prefs "$MARIONETTE_PORT" > "$COLLECT/prefs.js"
  SVAL_DEV_PROFILE="$COLLECT" \
    "$REPO_ROOT/scripts/run.sh" --headless --marionette --remote-allow-system-access \
    >"$WORK/collect.log" 2>&1 &
  BROWSER_PID=$!
  python3 -I "$REPO_ROOT/scripts/network-contact/check.py" \
    --port "$MARIONETTE_PORT" --profile "$COLLECT" \
    --log-dir "$LOGS" --collect-switches "$WORK/switches.txt"
  wait "$BROWSER_PID" 2>/dev/null || true
  pkill -f -- "--profile $COLLECT" 2>/dev/null || true
  sed 's/.*/user_pref("&", true);/' "$WORK/switches.txt" >> "$PROFILE/prefs.js"
  OPT_IN=(--opt-in-allowed)
fi

if [[ "${SVAL_NETWORK_PRIVATE:-}" == "1" ]]; then
  echo 'user_pref("browser.privatebrowsing.autostart", true);' >> "$PROFILE/prefs.js"
fi

if [[ "${SVAL_NETWORK_SHARED_FOLDER:-}" == "1" ]]; then
  SHARED="$WORK/shared"
  mkdir -p "$SHARED"
  SHARE=(--shared-folder "$SHARED")
fi

MOZ_LOG="timestamp,sync,nsHttp:3,nsHostResolver:5,nsSocketTransport:4" \
MOZ_LOG_FILE="$LOGS/moz" \
SVAL_DEV_PROFILE="$PROFILE" \
  "$REPO_ROOT/scripts/run.sh" --headless --marionette --remote-allow-system-access \
  >"$WORK/browser.log" 2>&1 &
BROWSER_PID=$!

STATUS=0
python3 -I "$REPO_ROOT/scripts/network-contact/check.py" \
  --port "$MARIONETTE_PORT" \
  --profile "$PROFILE" \
  --log-dir "$LOGS" \
  --page "http://127.0.0.1:$SITE_PORT/" \
  --untrusted-page "https://127.0.0.1:$TLS_PORT/" \
  --allowed "$REPO_ROOT/scripts/network-contact/allowed-hosts.txt" \
  --idle "$IDLE" \
  ${OPT_IN[@]+"${OPT_IN[@]}"} ${SHARE[@]+"${SHARE[@]}"} \
  ${FIRST_RUN[@]+"${FIRST_RUN[@]}"} || STATUS=$?

if [[ -n "${SHARED:-}" ]]; then
  if [[ -z "$(find "$SHARED/sval" -type f -print -quit 2>/dev/null)" ]]; then
    echo "network-contact: FAIL     nothing was written to the shared folder, so the helper did not run"
    STATUS=1
  else
    echo "network-contact: the shared-folder helper wrote to the shared folder"
  fi
fi
exit "$STATUS"
