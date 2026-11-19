#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Prove that the iPhone app contacts only the hosts it names (spec §10.9).
#
#   scripts/network-contact-ios.sh <simulator udid>
#
# Installs the app fresh on the booted simulator, captures every packet the
# Mac sends while mobile/ios's NetworkContactTests drives a first session
# (setup, a local page, a search typed in the Launcher, then an idle while the
# blocking lists download), and fails on any host the app's processes reached
# that scripts/network-contact/allowed-hosts.txt does not list, or on an
# opt-in host. scripts/network-contact-test.sh reads Gecko's own logs, which
# WKWebView and URLSession do not write, so this one reads the packets.
#
# The capture is tcpdump on pktap, whose metadata names each packet's
# process; check.py keeps the simulator's Sval and WebKit processes and reads
# their TLS server names, HTTP hosts and DNS lookups. tcpdump needs root, so
# it runs under `sudo -n`, and nothing else does, so a sudoers rule for
# /usr/sbin/tcpdump alone is enough.
#
# SVAL_NETWORK_STRICT=1 picks Strict blocking in Settings before the page
# loads, so Strict's lists download, and allows opt-in hosts.
# SVAL_NETWORK_IDLE_SECONDS is the idle, 150 by default.
#
# The engine and the Xcode project must be built first:
# mobile/ios/build-engine.sh, then xcodegen generate in mobile/ios.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UDID="${1:?usage: network-contact-ios.sh <simulator udid>}"
IOS="$REPO_ROOT/mobile/ios"
IDLE="${SVAL_NETWORK_IDLE_SECONDS:-150}"
DERIVED="$IOS/build/network-contact"

[[ -d "$IOS/Sval.xcodeproj" ]] \
  || { echo "error: no mobile/ios/Sval.xcodeproj; run build-engine.sh and xcodegen first" >&2; exit 1; }
sudo -n -l /usr/sbin/tcpdump >/dev/null 2>&1 \
  || { echo "error: tcpdump needs root, and sudo asks for a password for it here" >&2; exit 1; }

# The device's launchd_sim starts its processes; check.py keeps its children.
LAUNCHD="$(ps -axo pid=,command= | awk -v plist="/Devices/$UDID/data/var/run/launchd_bootstrap.plist" \
  '$2 ~ /launchd_sim$/ && index($0, plist) { print $1 }')"
[[ -n "$LAUNCHD" ]] || { echo "error: simulator $UDID is not booted" >&2; exit 1; }

WORK="$(mktemp -d)"
SITE="$WORK/site"
mkdir -p "$SITE"
cat > "$SITE/index.html" <<'HTML'
<!doctype html><title>sval network-contact test</title><p>A page with nothing on it.</p>
HTML

# shellcheck source=scripts/lib/launch.sh
source "$REPO_ROOT/scripts/lib/launch.sh"
SITE_PORT="$(free_port)"
python3 -I -m http.server --bind 127.0.0.1 --directory "$SITE" "$SITE_PORT" \
  >"$WORK/site.log" 2>&1 &
SITE_PID=$!

CAPTURE_PID=""
WATCH_PID=""
cleanup() {
  [[ -n "$CAPTURE_PID" ]] && kill -TERM "$CAPTURE_PID" 2>/dev/null || true
  [[ -n "$WATCH_PID" ]] && kill "$WATCH_PID" 2>/dev/null || true
  kill "$SITE_PID" 2>/dev/null || true
  if [[ "${SVAL_NETWORK_KEEP:-}" == "1" ]]; then
    echo "network-contact: capture kept in $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

echo "network-contact: building the app and its UI tests"
xcodebuild build-for-testing -project "$IOS/Sval.xcodeproj" -scheme Sval \
  -destination "id=$UDID" -derivedDataPath "$DERIVED" -quiet >"$WORK/build.log" 2>&1 \
  || { tail -50 "$WORK/build.log"; exit 1; }

# A fresh install, so the run is a first launch: no downloaded lists, no
# cached pages, no WebKit state.
xcrun simctl uninstall "$UDID" app.sval.ios 2>/dev/null || true

# The capture file is made first, so it stays this user's when root writes
# it. The capture ends on SIGTERM, which sudo relays to tcpdump. A sudo
# started in the background never relays SIGINT.
: > "$WORK/capture.pcapng"
# shellcheck disable=SC2024
sudo -n /usr/sbin/tcpdump -i pktap,all -k -U -w "$WORK/capture.pcapng" >"$WORK/tcpdump.log" 2>&1 &
CAPTURE_PID=$!
for _ in $(seq 50); do
  [[ -s "$WORK/capture.pcapng" ]] && break
  sleep 0.2
done
[[ -s "$WORK/capture.pcapng" ]] || { cat "$WORK/tcpdump.log"; echo "network-contact: tcpdump never started"; exit 1; }

# Processes come and go through the session, so their names are taken every
# second.
( while :; do ps -axo pid=,ppid=,comm= >>"$WORK/processes.txt"; sleep 1; done ) &
WATCH_PID=$!

echo "network-contact: driving the app${SVAL_NETWORK_STRICT:+ on Strict blocking}, then idle for ${IDLE}s"
STATUS=0
TEST_RUNNER_SVAL_NETWORK_PAGE="http://127.0.0.1:$SITE_PORT/" \
TEST_RUNNER_SVAL_NETWORK_IDLE="$IDLE" \
TEST_RUNNER_SVAL_NETWORK_STRICT="${SVAL_NETWORK_STRICT:-}" \
  xcodebuild test-without-building -project "$IOS/Sval.xcodeproj" -scheme Sval \
    -destination "id=$UDID" -derivedDataPath "$DERIVED" \
    -only-testing:SvalUITests/NetworkContactTests -resultBundlePath "$WORK/result.xcresult" \
    >"$WORK/test.log" 2>&1 || STATUS=$?
# The app is still running here; its last packets reach the capture first.
sleep 3
kill "$WATCH_PID" 2>/dev/null || true
WATCH_PID=""
kill -TERM "$CAPTURE_PID" 2>/dev/null || true
wait "$CAPTURE_PID" 2>/dev/null || true
CAPTURE_PID=""
xcrun simctl terminate "$UDID" app.sval.ios 2>/dev/null || true

if [[ "$STATUS" != 0 ]] || grep -q "testSession\]' skipped" "$WORK/test.log"; then
  grep -E "error:|XCTAssert|failed|skipped" "$WORK/test.log" | tail -20
  echo "network-contact: FAIL     the session did not run to its end, so the capture is incomplete"
  exit 1
fi

OPT_IN=()
[[ "${SVAL_NETWORK_STRICT:-}" == "1" ]] && OPT_IN=(--opt-in-allowed)
python3 -I "$REPO_ROOT/scripts/network-contact/check.py" \
  --capture "$WORK/capture.pcapng" --processes "$WORK/processes.txt" --launchd-pid "$LAUNCHD" \
  --allowed "$REPO_ROOT/scripts/network-contact/allowed-hosts.txt" \
  ${OPT_IN[@]+"${OPT_IN[@]}"}
