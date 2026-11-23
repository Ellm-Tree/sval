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
# group name, its pages served over http from this machine and each writing
# to IndexedDB, then kills the browser with SIGKILL. It searches every file
# in the profile, the shared folder, the browser's temporary folder and its
# two app data folders for the markers and the private node ids,
# decompressing SessionStore's mozLz4 files: once straight after the kill,
# as a crash leaves the disk, and once more after relaunching the browser and
# quitting it normally, when it also reads Sval's sealed files through the
# relaunched browser. A normal tab's own marker must turn up in those, or the
# search could not see into them. Always-private also requires that Sval
# created no identity and no local copy.
#
# The search after the kill leaves out <profile>/storage/private, where Gecko
# keeps private sites' storage until the next start (drive.py, scan), and
# says so. The search after the relaunch requires that folder to hold nothing.
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
    echo "private-browsing: kept $WORK and ${RUN_TEMP:-}"
  else
    rm -rf "$WORK" ${RUN_TEMP:+"$RUN_TEMP"} ${RUN_CACHE:+"$RUN_CACHE"} \
      ${RUN_USER_DIR:+"$RUN_USER_DIR"}
  fi
}
trap cleanup EXIT

# shellcheck source=scripts/lib/launch.sh
source "$REPO_ROOT/scripts/lib/launch.sh"

# The browser's temporary folder, one for the whole run, so the search reads
# what this run's browsers left there and nothing else. Gecko takes TMPDIR on
# Linux. On macOS it asks NSTemporaryDirectory, which libSystem moves with
# DIRHELPER_USER_DIR_SUFFIX (scripts/test.sh gives the reasons for each).
case "$(uname -s)" in
  Darwin)
    RUN_TEMP="$(mktemp -d "$(getconf DARWIN_USER_TEMP_DIR)sval-private-run.XXXXXX")"
    export DIRHELPER_USER_DIR_SUFFIX="${RUN_TEMP##*/}"
    RUN_CACHE="$(getconf DARWIN_USER_CACHE_DIR)$DIRHELPER_USER_DIR_SUFFIX"
    RUN_USER_DIR="$(getconf DARWIN_USER_DIR)$DIRHELPER_USER_DIR_SUFFIX"
    ;;
  *)
    RUN_TEMP="$WORK/tmp"
    mkdir -p "$RUN_TEMP"
    ;;
esac
export TMPDIR="$RUN_TEMP"

# launch <profile> <port> <log> <app data> <local app data>
launch() {
  local profile="$1" port="$2" log="$3"
  SVAL_DEV_PROFILE="$profile" MOZ_APP_DATA="$4" MOZ_LOCAL_APP_DATA="$5" \
    "$REPO_ROOT/scripts/run.sh" --headless --marionette --remote-allow-system-access \
    >>"$log" 2>&1 &
}

run_mode() {
  local mode="$1"
  local dir="$WORK/$mode"
  local profile="$dir/profile" shared="$dir/shared" port
  local appdata="$dir/appdata" localdata="$dir/appdata-local"
  mkdir -p "$profile" "$shared" "$appdata" "$localdata"
  port="$(free_port)"
  {
    base_prefs "$port"
    if [[ "$mode" == permanent ]]; then
      echo 'user_pref("browser.privatebrowsing.autostart", true);'
    fi
  } >"$profile/prefs.js"

  echo "private-browsing: $mode: drive a private session"
  launch "$profile" "$port" "$dir/browser.log" "$appdata" "$localdata"
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

  local roots=("$profile" "$shared" "$RUN_TEMP" "$appdata" "$localdata")
  echo "private-browsing: $mode: search what the kill left"
  python3 -I "$DRIVE" scan --killed --profile "$profile" \
    --markers "$dir/markers.json" "${roots[@]}" || STATUS=1

  echo "private-browsing: $mode: relaunch and quit"
  launch "$profile" "$port" "$dir/browser.log" "$appdata" "$localdata"
  local opened=()
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
  python3 -I "$DRIVE" scan --profile "$profile" --markers "$dir/markers.json" \
    "${premise[@]+"${premise[@]}"}" "${roots[@]}" || STATUS=1
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
