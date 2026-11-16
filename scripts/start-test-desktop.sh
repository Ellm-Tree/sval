#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Give a Linux CI job's container a desktop for the suites: an X display on
# DISPLAY, a session bus, a window manager, a sound sink and XDG user
# directories. Run as root, after the tree is handed to the test user
# (scripts/as-test-user.sh).
#
# Everything started here outlives the step, because every step runs in the
# same container. Each step is its own shell, so the bus address reaches later
# steps through GITHUB_ENV. Xvfb and mutter run as root: they own the display,
# and the tests only need to connect to it.
#
# Xvfb runs with -noreset, as Mozilla's own test image starts it
# (taskcluster/docker/recipes/xvfb.sh). Without it the server resets each time
# its last client disconnects, and a client connecting during that reset is
# refused: the probe below disconnects just before mutter connects. Its log
# goes to /tmp/xvfb.log, printed when the desktop does not come up.
#
# The window manager activates each window as it maps, as a desktop does, so a
# dialog the browser opens takes the focus (the Dockerfile says why mutter). It
# is up once it has set _NET_SUPPORTING_WM_CHECK on the root window.
#
# The sound sink lets an audible tab become audible, and the XDG user
# directories let Gecko's BackupService resolve a Documents path on idle instead
# of throwing into whichever test is running.
#
# A desktop Linux has /etc/machine-id, which systemd writes at first boot and
# Sval reads to tell which computer a profile runs on. Debian's dbus package
# writes only /var/lib/dbus/machine-id and nothing in a container boots
# systemd, so the desktop writes it here as dbus-uuidgen does for D-Bus
# (machine-id(5)).
#
# Usage: DISPLAY=:99 ./scripts/start-test-desktop.sh
set -euo pipefail

: "${DISPLAY:?DISPLAY is not set}"
: "${GITHUB_ENV:?GITHUB_ENV is not set: this is for a CI job}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

dbus-uuidgen --ensure=/etc/machine-id
test -s /etc/machine-id || { echo "no /etc/machine-id was written"; exit 1; }

Xvfb "$DISPLAY" -screen 0 1600x1200x24 -ac -noreset >/tmp/xvfb.log 2>&1 &
for _ in $(seq 1 30); do
  xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 && break
  sleep 1
done
xdpyinfo -display "$DISPLAY" >/dev/null 2>&1 || { echo "Xvfb never came up"; cat /tmp/xvfb.log; exit 1; }
bus="$(dbus-launch --sh-syntax | sed -n "s/^DBUS_SESSION_BUS_ADDRESS='\(.*\)';$/\1/p")"
[[ -n "$bus" ]] || { echo "dbus-launch gave no session bus address"; exit 1; }
export DBUS_SESSION_BUS_ADDRESS="$bus"
echo "DBUS_SESSION_BUS_ADDRESS=$bus" >> "$GITHUB_ENV"
mutter --x11 --replace --sm-disable >/tmp/mutter.log 2>&1 &
wm_up() { xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; }
for _ in $(seq 1 30); do
  wm_up && break
  sleep 1
done
wm_up || { echo "mutter never came up"; cat /tmp/mutter.log /tmp/xvfb.log; exit 1; }

"$REPO_ROOT/scripts/as-test-user.sh" xdg-user-dirs-update
"$REPO_ROOT/scripts/as-test-user.sh" pulseaudio --daemonize --exit-idle-time=-1 \
  --load="module-null-sink sink_name=sval"
"$REPO_ROOT/scripts/as-test-user.sh" pactl info | head -2
