#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Proves from outside the browser that a private session leaves nothing on
# disk, crash included (private-windows spec, test 23).
#
# Twice: private windows opened from a normal session that syncs to a shared
# folder, and "Always use private browsing mode". Each run drives a private
# session through Marionette with marker strings in its URLs, titles and a
# group name, kills the browser with SIGKILL, relaunches it once and quits it
# normally, then searches every file in the profile and the shared folder for
# the markers and the private node ids, decompressing SessionStore's mozLz4
# files and reading Sval's sealed files through the relaunched browser. A
# normal tab's own marker must turn up in those, or the search could not see
# into them. Always-private also requires that Sval created no identity and no
# local copy.
#
# A browser-chrome test cannot kill its own browser, which is why this exists.
# It takes a few minutes, so CI runs it nightly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DRIVE="$REPO_ROOT/scripts/private-browsing/drive.py"
WORK="$(mktemp -d)"
STATUS=0

cleanup() {
  pkill -9 -f -- "--profile $WORK/" 2>/dev/null || true
  if [[ "${SVAL_PRIVATE_KEEP:-}" == "1" ]]; then
    echo "private-browsing: kept $WORK"
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

# shellcheck source=scripts/lib/launch.sh
source "$REPO_ROOT/scripts/lib/launch.sh"

launch() {
  local profile="$1" port="$2" log="$3"
  SVAL_DEV_PROFILE="$profile" \
    "$REPO_ROOT/scripts/run.sh" --headless --marionette --remote-allow-system-access \
    >>"$log" 2>&1 &
}

run_mode() {
  local mode="$1"
  local dir="$WORK/$mode"
  local profile="$dir/profile" shared="$dir/shared" port
  mkdir -p "$profile" "$shared"
  port="$(free_port)"
  {
    base_prefs "$port"
    if [[ "$mode" == permanent ]]; then
      echo 'user_pref("browser.privatebrowsing.autostart", true);'
    fi
  } >"$profile/prefs.js"

  echo "private-browsing: $mode: drive a private session"
  launch "$profile" "$port" "$dir/browser.log"
  local how=(--shared "$shared")
  [[ "$mode" == permanent ]] && how=(--permanent)
  python3 -I "$DRIVE" drive --port "$port" --profile "$profile" \
    --out "$dir/markers.json" "${how[@]}"

  echo "private-browsing: $mode: SIGKILL"
  pkill -9 -f -- "--profile $profile" || true
  # The relaunch must not find the killed browser still holding the profile.
  local gone=""
  for _ in $(seq 1 50); do
    if ! pgrep -f -- "--profile $profile" >/dev/null; then
      gone=1
      break
    fi
    sleep 0.2
  done
  if [[ -z "$gone" ]]; then
    echo "private-browsing: FAIL $mode: the browser outlived SIGKILL"
    exit 1
  fi

  echo "private-browsing: $mode: relaunch and quit"
  launch "$profile" "$port" "$dir/browser.log"
  local opened=() roots=("$profile" "$shared")
  if [[ "$mode" == window ]]; then
    opened=(--open "$dir/opened")
    roots+=("$dir/opened")
  fi
  python3 -I "$DRIVE" relaunched --port "$port" --profile "$profile" "${opened[@]+"${opened[@]}"}"
  for _ in $(seq 1 30); do
    pgrep -f -- "--profile $profile" >/dev/null || break
    sleep 1
  done
  pkill -9 -f -- "--profile $profile" 2>/dev/null || true

  local premise=()
  [[ "$mode" == window ]] && premise=(--opened "$dir/opened")
  python3 -I "$DRIVE" scan --markers "$dir/markers.json" "${premise[@]+"${premise[@]}"}" "${roots[@]}" || STATUS=1
  if [[ "$mode" == permanent ]]; then
    for name in sval sval-identity.json sval-local-settings.json; do
      if [[ -e "$profile/$name" ]]; then
        echo "private-browsing: FAIL always-private created $name"
        STATUS=1
      fi
    done
  elif [[ ! -d "$shared/sval" ]]; then
    echo "private-browsing: FAIL the normal window never synced, so the run proved nothing"
    STATUS=1
  fi
}

run_mode window
run_mode permanent
exit "$STATUS"
