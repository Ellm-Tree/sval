#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Build Sval. Assumes scripts/fetch-upstream.sh and scripts/apply-patches.sh have run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"

if [[ ! -f "$SRC/mach" ]]; then
  echo "error: no upstream checkout at $SRC — run scripts/fetch-upstream.sh first" >&2
  exit 1
fi

cd "$SRC"

# Bootstrap before the mozconfig is written: `mach bootstrap` writes its own
# mozconfig over ours, and without ours there is no --enable-artifact-builds
# and no MOZ_OBJDIR, so the front-end build becomes a full C++ compile in the
# default objdir.
if [[ "${SVAL_SKIP_BOOTSTRAP:-0}" != "1" ]]; then
  echo "==> Bootstrapping build dependencies"
  ./mach --no-interactive bootstrap --application-choice=browser
fi

# SVAL_MODE selects what is built. "artifact", the default, downloads prebuilt
# Gecko and compiles only the front end: the development and CI loop. "gecko"
# compiles Gecko itself, for packages artifact builds consume.
#
# SVAL_TARGET selects the platform to build for. The default, "host", builds for
# the machine running the script. "win64" cross-builds an artifact build for
# Windows, which works without MSVC or a Windows SDK because artifact builds
# compile no native code: --enable-artifact-builds implies
# --disable-compile-environment (moz.configure), and the artifact job is chosen
# from the target rather than the host (python/mozbuild/mozbuild/artifacts.py,
# Artifacts._guess_artifact_job). configure additionally requires wine for any
# Windows target from a non-Windows host (toolkit/moz.configure).
MODE="${SVAL_MODE:-artifact}"
TARGET="${SVAL_TARGET:-host}"
case "$MODE" in
  artifact | gecko) ;;
  *)
    echo "error: unknown SVAL_MODE '$MODE' (expected 'artifact' or 'gecko')" >&2
    exit 1
    ;;
esac

# The tree's mozconfig is Sval's identity followed by the mode's fragment.
cat "$REPO_ROOT/mozconfig" "$REPO_ROOT/mozconfig.$MODE" > "$SRC/mozconfig"

# A release reads its version files from sval-version/ (the mozconfig's
# release block): version.txt keeps the ESR version the tree carries, and
# version_display.txt is the release's own, which release-channel.sh checks
# is a version Sval displays.
rm -rf "$SRC/sval-version"
if [[ -n "${SVAL_RELEASE_VERSION:-}" ]]; then
  "$REPO_ROOT/scripts/release-channel.sh" "$SVAL_RELEASE_VERSION" > /dev/null
  mkdir -p "$SRC/sval-version"
  cp "$SRC/browser/config/version.txt" "$SRC/sval-version/version.txt"
  printf '%s\n' "$SVAL_RELEASE_VERSION" > "$SRC/sval-version/version_display.txt"
fi
case "$TARGET" in
  host) ;;
  win64)
    # Each target needs its own object directory; sharing one makes the second
    # configure fight the first. The fragment's MOZ_OBJDIR is dropped rather
    # than overridden, because two mk_add_options lines for the same variable
    # do not reliably resolve to the later one. In gecko mode this is a full
    # cross-compile, as Mozilla's own win64 builds are: --enable-bootstrap
    # fetches the MSVC headers and libraries as the "vs" toolchain
    # (build/moz.configure/windows-toolchain.configure, winsysroot).
    objdir=objdir-win64
    [[ "$MODE" == gecko ]] && objdir=objdir-gecko-win64
    grep -v 'MOZ_OBJDIR' "$SRC/mozconfig" > "$SRC/mozconfig.win64"
    mv "$SRC/mozconfig.win64" "$SRC/mozconfig"
    cat >> "$SRC/mozconfig" <<MOZCONFIG_WIN64

mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/$objdir
ac_add_options --target=x86_64-pc-windows-msvc
MOZCONFIG_WIN64
    # A compiled Gecko ships the MSVC runtime DLLs beside its own, as
    # Mozilla's does; without them nothing it built starts on a machine that
    # lacks Microsoft's redistributable. Mozilla's automation turns this on by
    # default (build/moz.configure/windows.configure, win32_redist_dir), and
    # the option exists only for Windows targets.
    if [[ "$MODE" == gecko ]]; then
      printf 'ac_add_options --with-redist\n' >> "$SRC/mozconfig"
    fi
    ;;
  macos-x86_64)
    # Intel Macs, cross-compiled on Apple silicon. The objdir stays the
    # mode's, so the packaging scripts find it where they look.
    printf 'ac_add_options --target=x86_64-apple-darwin\n' >> "$SRC/mozconfig"
    ;;
  *)
    echo "error: unknown SVAL_TARGET '$TARGET' (expected 'host', 'win64' or 'macos-x86_64')" >&2
    exit 1
    ;;
esac

# Only gecko mode compiles Gecko, and it is asked for by name, so an artifact
# mozconfig without --enable-artifact-builds stops here.
if [[ "$MODE" == artifact ]] && ! grep -q 'enable-artifact-builds' "$SRC/mozconfig"; then
  echo "error: $SRC/mozconfig lacks --enable-artifact-builds after copy." >&2
  echo "       Something overwrote it. Refusing to start a full-compile build." >&2
  exit 1
fi

# An artifact build chooses the Gecko it runs on (scripts/artifact-gecko.sh)
# and writes the choice to build/firefox/.sval-gecko-source, for CI to report.
GECKO_SOURCE_FILE="$SRC/.sval-gecko-source"
rm -f "$GECKO_SOURCE_FILE"
if [[ "$MODE" == artifact ]]; then
  . "$REPO_ROOT/scripts/artifact-gecko.sh"
fi

# rust-toolchain.toml pins the Rust every build under the checkout uses, and
# rustup installs it on first use. configure runs rustc and cargo through
# rustup's proxies, and two proxies installing one toolchain at once collide
# ("detected conflict"), so it is installed here first, in one process.
if command -v rustup >/dev/null 2>&1; then
  (cd "$REPO_ROOT" && rustup toolchain install --no-self-update) ||
    echo "warning: could not install the Rust rust-toolchain.toml pins" >&2
fi

echo "==> Configuring (mode: $MODE, target: $TARGET)"
if [[ "${SVAL_FASTER:-0}" == "1" ]]; then
  echo "    (skipped — SVAL_FASTER=1 assumes configure is current)"
else
  ./mach configure
fi

echo "==> Building"
if [[ "${SVAL_FASTER:-0}" == "1" ]]; then
  ./mach build faster
else
  ./mach build
fi

# The browser reads and writes a shared folder only through sval-folder, a
# program beside its own binary, so the build stages it. A failure warns and
# leaves the build standing: the browser runs, and its shared-folder requests
# fail until the program is staged.
echo "==> Staging sval-folder"
"$REPO_ROOT/scripts/stage-sval-folder.sh" ||
  echo "warning: sval-folder was not staged; shared-folder sync fails until scripts/stage-sval-folder.sh runs" >&2

# A macOS artifact build leaves a bundle carrying the installed Sval's identity,
# and any launch of it, scripted or not, takes the installed Sval's Local
# Network permission (lib/launch.sh's sign_dev_bundle). The build gives it the
# dev identity before anything can launch it. A release is a gecko-mode build
# and keeps Sval's identity.
if [[ "$(uname -s)" == Darwin && "$MODE" == artifact && "$TARGET" == host ]]; then
  # shellcheck source=scripts/lib/launch.sh
  source "$REPO_ROOT/scripts/lib/launch.sh"
  OBJDIR="$(./mach environment --format json | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["topobjdir"])')"
  APP="$(built_app "$OBJDIR")"
  echo "==> Giving $APP the dev identity"
  give_dev_identity "$APP"
fi

echo "==> Build complete"
