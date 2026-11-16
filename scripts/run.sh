#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Launch the built browser with a dedicated profile so it never touches
# your real Firefox or Sval profile.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/lib/launch.sh
source "$REPO_ROOT/scripts/lib/launch.sh"
SRC="$REPO_ROOT/build/firefox"
if [[ ! -f "$SRC/mach" ]]; then
  echo "error: no build tree at $SRC; scripts/build-worktree.sh makes one" >&2
  exit 1
fi
# The default profile and data directories here are the ones the sval-mcp
# staged in this build starts it on (tools/sval-mcp/src/install.rs,
# dev_build_dir).
PROFILE="${SVAL_DEV_PROFILE:-$REPO_ROOT/build/dev-profile}"

# An explicit --profile keeps dev runs off the real Firefox profile: an
# artifact build's compiled-in app identity is Mozilla's, so the default profile
# root resolves to ~/Library/Application Support/Firefox.

# run.sh launches from build/firefox, so each path it is given is made absolute
# against the caller's directory first.
mkdir -p "$PROFILE"
PROFILE="$(cd "$PROFILE" && pwd)"

# --profile moves the profile and nothing else. Everything Gecko keeps beside
# the profiles (the "UAppData" directory: Crash Reports, Pending Pings,
# the background tasks' profiles) still resolves from the compiled-in identity, which in an
# artifact build is Firefox's, so the crash manager reads and writes
# ~/Library/Application Support/Firefox. MOZ_APP_DATA and MOZ_LOCAL_APP_DATA
# replace that directory and its cache counterpart outright
# (nsXREDirProvider::GetUserDataDirectory).
export MOZ_APP_DATA="${MOZ_APP_DATA:-$REPO_ROOT/build/dev-appdata}"
export MOZ_LOCAL_APP_DATA="${MOZ_LOCAL_APP_DATA:-$REPO_ROOT/build/dev-appdata-local}"
mkdir -p "$MOZ_APP_DATA" "$MOZ_LOCAL_APP_DATA"
MOZ_APP_DATA="$(cd "$MOZ_APP_DATA" && pwd)"
MOZ_LOCAL_APP_DATA="$(cd "$MOZ_LOCAL_APP_DATA" && pwd)"

# Dev-only profile prefs; never shipped in Sval's branding prefs.
#
#  - layers.gpu-process-executable.enabled: Gecko launches a GPU helper whose
#    name comes from MOZ_GPU_PROCESS_NAME_BRANDED, a compile-time define. An
#    artifact build links Mozilla's libxul, so the name it asks for is not the
#    one this bundle contains. Disabling the path uses the child process
#    bundle, MOZ_CHILD_PROCESS_BUNDLENAME.
#
# Nothing here may set a pref Sval itself ships
# (branding/sval/pref/app-sval-prefs.js): a user-branch value overrides the
# default, so a dev profile that repeated one would hide a change to Sval's
# default.
cat > "$PROFILE/user.js" <<'USERJS'
user_pref("layers.gpu-process-executable.enabled", false);
USERJS

cd "$SRC"
# -purgecaches: Gecko keeps a profile's script cache until the build ID
# changes, and a front-end-only build keeps the same build ID. Without it, a
# dev profile goes on running the chrome JS it cached before the last rebuild.
#
# Everything after `--` is forwarded straight to the browser binary.
#
# On macOS a browser for a person to use is started by LaunchServices
# (`open`), which makes it the active app. `mach run` starts it as a child of
# this shell, and since macOS 14 an app becomes active only when the app in
# front gives way ("cooperative activation"), so the `-foreground` mach passes
# is ignored when this shell is not in front: the window draws but takes no
# click until the user switches away and back. `open` hands the app none of
# this shell's environment, so what `mach run` would set goes through
# `--env`, and `-W` keeps this script running until the browser quits.
# A headless or Marionette run is a child the caller watches and stops, and
# needs no activation, so it keeps `mach run`.
if [[ "${1:-}" == "--" ]]; then
  shift
fi
interactive=1
for arg in "$@"; do
  case "$arg" in
    --headless | -headless | --marionette | -marionette) interactive=0 ;;
  esac
done
if [[ "$(uname)" == "Darwin" && "$interactive" == 1 ]]; then
  OBJDIR="$(./mach environment --format json 2>/dev/null |
    python3 -c 'import json, sys; print(json.load(sys.stdin)["topobjdir"])')"
  APP="$(built_app "$OBJDIR")"
  if [[ ! -d "$APP" || "$APP" != *.app ]]; then
    echo "run.sh: no built app in $OBJDIR/dist; run scripts/build.sh first" >&2
    exit 1
  fi
  # A dev build never carries the installed Sval's identity (sign_dev_bundle).
  #
  # An ad-hoc signature's designated requirement is the build's own hash, so
  # the keychain takes each rebuild for a new app and asks again for "Sval
  # secrets". The identity scripts/dev-signing.sh makes gives every dev build
  # one requirement, so it is made here when the keychain lacks it.
  if ! dev_signing_identity >/dev/null; then
    "$REPO_ROOT/scripts/dev-signing.sh" >&2 || true
    dev_signing_identity >/dev/null ||
      echo "run.sh: signing ad hoc, so this build asks for the keychain again" >&2
  fi
  if ! give_dev_identity "$APP"; then
    echo "run.sh: could not give $APP the dev identity" >&2
    exit 1
  fi
  # MOZ_MARIONETTE starts Marionette as --marionette does (Marionette.sys.mjs),
  # for an agent to drive a browser launched as a person's is: macOS asks for
  # camera and microphone access on behalf of the app that launched a process,
  # so a browser started by `mach run` would ask as the terminal.
  marionette=()
  if [[ -n "${MOZ_MARIONETTE:-}" ]]; then
    marionette=(--env "MOZ_MARIONETTE=1")
  fi
  exec open -n -W -a "$APP" ${marionette[@]+"${marionette[@]}"} \
    --env "MOZ_DEVELOPER_REPO_DIR=$SRC" \
    --env "MOZ_DEVELOPER_OBJ_DIR=$OBJDIR" \
    --env "MOZ_APP_DATA=$MOZ_APP_DATA" \
    --env "MOZ_LOCAL_APP_DATA=$MOZ_LOCAL_APP_DATA" \
    --env "MOZ_CRASHREPORTER_DISABLE=1" \
    --args --profile "$PROFILE" -purgecaches "$@"
fi

exec ./mach run -- --profile "$PROFILE" -purgecaches "$@"
