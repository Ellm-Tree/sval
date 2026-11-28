# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Pieces the scripts that launch a built Sval share. Sourced; it sets nothing
# but these functions.

# free_port: a TCP port on 127.0.0.1 that nothing listens on at the moment.
free_port() {
  python3 -I -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])'
}

# base_prefs <marionette port> [first-run]: the prefs.js lines every driven
# profile starts with. Marionette's recommended prefs would switch off much of
# what is under test. First run is off because each profile driven is a fresh
# one, and its window-modal dialog would stand between the run and the browser
# it drives. `first-run` leaves it on, for a run that answers the dialog.
base_prefs() {
  cat <<PREFS
user_pref("remote.prefs.recommended", false);
user_pref("marionette.port", $1);
PREFS
  if [[ "${2:-}" != first-run ]]; then
    echo 'user_pref("browser.sval.firstRun.enabled", false);'
  fi
}

# copy_app_from_dmg <dmg> <dir>: copies the app a .dmg holds into <dir>. The
# image is detached and its mount point removed however the copy ends.
copy_app_from_dmg() (
  mnt="$(mktemp -d)"
  trap 'hdiutil detach -quiet "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true' EXIT
  hdiutil attach -quiet -readonly -nobrowse -mountpoint "$mnt" "$1"
  cp -R "$mnt"/*.app "$2/"
)

# dev_signing_identity: prints the identity scripts/dev-signing.sh makes, when
# the keychain has it. It stays the same across rebuilds, so the keychain keeps
# trusting a build signed with it with Sval's secret; an ad-hoc signature is a
# new app to the keychain every time.
dev_signing_identity() {
  security find-identity -p codesigning 2>/dev/null | grep -qF '"sval dev signing"' || return 1
  echo "sval dev signing"
}

# sign_dev_bundle <app> <identity, or - for ad hoc>: gives a macOS dev bundle
# the dev identity and signs it. The app becomes app.sval.dev, each helper
# whose id starts app.sval. moves under app.sval.dev., and each of those
# executables gets a fixed UUID derived from its new id (lib/macho-uuid.py).
#
# macOS keeps one Local Network decision per signing identifier, and maps that
# identifier to the UUIDs of one main executable
# (/Library/Preferences/com.apple.networkextension.uuidcache.plist). A dev
# build carrying a release's identifier takes that mapping from the installed
# Sval, whose connections to the local network are then refused until it is
# launched again. Dev builds share one identifier and one UUID, so any number
# run at once under one decision, whichever Gecko each was built on.
#
# The bundle id in Info.plist is the only identity changed. The build's
# compiled-in MOZ_MACBUNDLE_ID (AppConstants) stays app.sval.sval, because
# changing it in mozconfig would change the Gecko key, so what must tell a dev
# build apart reads the running bundle: SvalSecretStore's keychain label,
# nmhproxy, and sval-mcp, which reads the bundle's MozillaDeveloperRepoPath.
#
# codesign refuses a bundle holding the build's stray moz.build, empty
# MacOS/.app and, in a compiled Gecko's bundle, gtest's unsigned test files
# in MacOS/gtest, so those go first. Signing the bundle binds Info.plist, which
# the linker's signature does not, so macOS names the app Sval in its prompts.
sign_dev_bundle() {
  local app="$1" identity="$2" plist id exe file
  local lib
  lib="$(dirname "${BASH_SOURCE[0]}")"
  rm -f "$app/Contents/moz.build"
  rmdir "$app/Contents/MacOS/.app" 2>/dev/null || true
  rm -rf "$app/Contents/MacOS/gtest"
  for plist in "$app"/Contents/MacOS/*.app/Contents/Info.plist "$app/Contents/Info.plist"; do
    [[ -f "$plist" ]] || continue
    # An artifact build links some helpers' Info.plist and executable into the
    # objdir. codesign refuses a bundle whose main executable or Info.plist is
    # a symlink, and PlistBuddy would write through the link into the objdir.
    exe="$(dirname "$plist")/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$plist")"
    for file in "$plist" "$exe"; do
      if [[ -L "$file" ]]; then
        cp "$file" "$file.copy" && mv -f "$file.copy" "$file" || return 1
      fi
    done
    id="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$plist")"
    case "$id" in
      app.sval.sval | app.sval.dev) id=app.sval.dev ;;
      app.sval.dev.*) ;;
      app.sval.*) id="app.sval.dev.${id#app.sval.}" ;;
      *) continue ;;
    esac
    /usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $id" "$plist"
    python3 -I "$lib/macho-uuid.py" "$exe" "$id" || return 1
    # The app's own bundle is signed last, over its signed helpers.
    if [[ "$plist" != "$app/Contents/Info.plist" ]]; then
      codesign --force --sign "$identity" "$(dirname "$(dirname "$plist")")" 2>/dev/null || return 1
    fi
  done
  codesign --force --sign "$identity" "$app" 2>/dev/null
}

# built_app <objdir>: the bundle configure named in <objdir>/dist, which can
# hold a stale one built under an earlier display name beside it.
built_app() {
  echo "$1/dist/$(sed -n 's/^MOZ_MACBUNDLE_NAME = //p' "$1/config/autoconf.mk" 2>/dev/null)"
}

# dev_signed <app> <identity, or - for ad hoc>: whether <app> already carries
# the dev identity under that signature, unchanged since it was signed.
#
# Signing rewrites the main executable (lib/macho-uuid.py) and the bundle's
# signature. A dev build already running from the bundle then no longer
# matches its code on disk, and the keychain refuses it the secret the build
# reads (SvalSecretStore), so a second launch of one bundle must leave a
# signed bundle as it is. A rebuild changes the sealed executable or
# Info.plist, which fails the check and signs again. `--deep` and `--strict`
# refuse an artifact build's bundle as signed, for its links into the objdir.
dev_signed() {
  local info
  codesign --verify "$1" 2>/dev/null || return 1
  info="$(codesign -dvv "$1" 2>&1)" || return 1
  grep -qx "Identifier=app.sval.dev" <<<"$info" || return 1
  if [[ "$2" == - ]]; then
    grep -qx "Signature=adhoc" <<<"$info"
  else
    grep -qxF "Authority=$2" <<<"$info"
  fi
}

# give_dev_identity <app>: sign_dev_bundle with the dev signing identity when
# the keychain has it, and ad hoc when it does not or that signing fails.
#
# Launching a bundle registers it with Launch Services, and the default
# browser is a bundle id there, so every build that ran as app.sval.sval is
# one macOS may open a link from another app in.
give_dev_identity() {
  local identity
  identity="$(dev_signing_identity)" || identity=-
  dev_signed "$1" "$identity" && return 0
  sign_dev_bundle "$1" "$identity" && return 0
  [[ "$identity" != - ]] && echo "could not sign as \"$identity\"; signing ad hoc" >&2
  sign_dev_bundle "$1" -
}
