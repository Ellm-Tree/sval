#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

# Follows the app's log on a connected iPhone without relaunching the app:
# copies the log file the app keeps in its caches (Diagnostics.swift) every
# few seconds and appends what's new to the file given. It keeps trying
# while the phone is locked, asleep or out of reach.
#
#   ./watch-log.sh <device-id> <output-file> [--launch]
#
# --launch first starts the app, retrying until the phone is unlocked.
set -u
device=$1
out=$2
launch=${3:-}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
note() { printf '%s [watch-log] %s\n' "$(date +%H:%M:%S)" "$1" >> "$out"; }

if [ "$launch" = "--launch" ]; then
  until xcrun devicectl device process launch --device "$device" --terminate-existing app.sval.ios \
      > "$work/launch.txt" 2>&1; do
    grep -q Locked "$work/launch.txt" && note "waiting for the phone to unlock to launch"
    sleep 15
  done
  note "launched"
fi

seen=0
state=""
while :; do
  if xcrun devicectl device copy from --device "$device" --domain-type appDataContainer \
      --domain-identifier app.sval.ios --source Library/Caches/diagnostics.log \
      --destination "$work/log.txt" > "$work/copy.txt" 2>&1; then
    [ "$state" = "up" ] || note "reading the phone's log"
    state=up
    size=$(wc -c < "$work/log.txt" | tr -d ' ')
    # A smaller file is one the app started again.
    [ "$size" -lt "$seen" ] && seen=0
    if [ "$size" -gt "$seen" ]; then
      tail -c +"$((seen + 1))" "$work/log.txt" >> "$out"
      seen=$size
    fi
  else
    [ "$state" = "down" ] || note "can't read the phone's log; retrying"
    state=down
  fi
  sleep 10
done
