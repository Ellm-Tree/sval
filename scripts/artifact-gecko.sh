# shellcheck shell=bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Choose the Gecko an artifact build runs on. scripts/build.sh sources this in
# artifact mode only, after writing the tree's mozconfig, with REPO_ROOT, SRC,
# TARGET and GECKO_SOURCE_FILE set. Nothing here reaches a compiled Gecko, so
# scripts/gecko-key.sh leaves this file out of the key.
#
# An artifact build runs on Sval's own Gecko when the registry holds a package
# for this platform under this tree's key (scripts/gecko-key.sh), and on
# Mozilla's otherwise: a tree whose key is unpublished changes something native,
# and its Gecko does not exist until a CI run compiles it. SVAL_GECKO_SOURCE=sval
# fails when there is none; SVAL_GECKO_SOURCE=mozilla skips the lookup.
# SVAL_GECKO_KEY names a published Gecko to use in place of this tree's own,
# for bisecting or for trying another package. Linux and Windows x86_64 and
# macOS on Apple silicon and Intel are published. SVAL_GECKO_DIR names a directory to
# take the packages from, laid out as scripts/stage-gecko.sh leaves one. The
# choice is written to GECKO_SOURCE_FILE.

want="${SVAL_GECKO_SOURCE:-auto}"
case "$want" in
  auto | sval | mozilla) ;;
  *)
    echo "error: unknown SVAL_GECKO_SOURCE '$want' (expected auto, sval or mozilla)" >&2
    exit 1
    ;;
esac
platform=""
state="${MOZBUILD_STATE_PATH:-$HOME/.mozbuild}"
sep=":"
if [[ "$TARGET" == host ]]; then
  case "$(uname -s):$(uname -m)" in
    Linux:x86_64) platform=linux64 ;;
    MSYS_NT*:x86_64 | MINGW*:x86_64)
      # mach is a Windows Python here: it splits MOZ_ARTIFACT_FILE on ";"
      # and reads C:/ paths, which MozillaBuild's bash reads too.
      platform=win64
      sep=";"
      ;;
    Darwin:arm64) platform=macos-aarch64 ;;
    Darwin:x86_64) platform=macos-x86_64 ;;
  esac
fi
source=mozilla
key=""
if [[ "$want" != mozilla && -n "$platform" ]]; then
  key="${SVAL_GECKO_KEY:-$("$REPO_ROOT/scripts/gecko-key.sh")}"
  dir="${SVAL_GECKO_DIR:-$state/sval-gecko/$platform/$key}"
  if [[ "$platform" == win64 ]]; then
    dir="$(cygpath -m "$dir")"
  fi
  status=0
  "$REPO_ROOT/scripts/fetch-gecko.sh" "$platform" "$key" "$dir" || status=$?
  case "$status" in
    0)
      source=sval
      # A key changes with every native change, so fetched keys fill a disk
      # unless capped. Each use marks its key recent; the four used last stay,
      # and so does any used in the last six hours, which covers a build still
      # running beside this one. fetch-gecko.sh fetches any other on demand.
      if [[ -z "${SVAL_GECKO_DIR:-}" ]]; then
        touch "$dir"
        cache="$(dirname "$dir")"
        ls -t "$cache" | tail -n +5 | while read -r old; do
          if [[ -n "$(find "$cache/$old" -maxdepth 0 -mmin +360)" ]]; then
            rm -rf "${cache:?}/$old"
          fi
        done
      fi
      ;;
    3) echo "==> No sval Gecko is published for $platform under key $key" ;;
    *) exit "$status" ;;
  esac
fi
if [[ "$want" == sval && "$source" != sval ]]; then
  echo "error: SVAL_GECKO_SOURCE=sval, and no sval Gecko is available here" >&2
  exit 1
fi
if [[ "$source" == sval ]]; then
  # mach installs the symbols in dist/crashreporter-symbols
  # (--enable-artifact-build-symbols in mozconfig.artifact), where the test
  # harnesses read a crash's stack from by default.
  files="$dir/target.common.tests.tar.zst$sep$dir/target.xpt_artifacts.zip$sep$dir/target.crashreporter-symbols.zip"
  case "$platform" in
    linux64) files="$dir/target.tar.xz$sep$files" ;;
    win64) files="$dir/target.zip$sep$files" ;;
    # A macOS package carries the updater framework in an archive of its own.
    macos-*) files="$dir/target.dmg$sep$files$sep$dir/target.update_framework_artifacts.zip" ;;
  esac
  export MOZ_ARTIFACT_FILE="$files"
else
  # An artifact build takes its Gecko's identity. Mozilla's packages hold
  # firefox/firefox, which the artifact code looks for under MOZ_APP_NAME, and
  # mach runs dist/bin/$MOZ_APP_NAME. configure takes the later of two values.
  printf 'ac_add_options --with-app-name=firefox\n' >> "$SRC/mozconfig"
fi
echo "==> Gecko: $source${key:+ (key $key)}"
printf '%s %s\n' "$source" "$key" > "$GECKO_SOURCE_FILE"

# mach installs the Gecko binaries only in a full build. A fast build
# (SVAL_FASTER) keeps the ones the object directory has, while mach still
# reconfigures when the mozconfig changed, so the front end follows the Gecko
# chosen here. A front end built for one Gecko can abort the browser at startup
# on another Gecko's binaries. So a fast build on a Gecko other than the last
# full build's builds in full, and a full build that succeeds records its Gecko
# in the object directory.
gecko=mozilla
[[ "$source" == sval ]] && gecko="sval $key"
objdir="$SRC/$(sed -n 's|^mk_add_options MOZ_OBJDIR=@TOPSRCDIR@/||p' "$SRC/mozconfig" | tail -n 1)"
if [[ "${SVAL_FASTER:-0}" == 1 && "$(cat "$objdir/.sval-gecko-installed" 2>/dev/null)" != "$gecko" ]]; then
  echo "==> The Gecko differs from this object directory's last full build: building in full"
  SVAL_FASTER=0
fi
if [[ "${SVAL_FASTER:-0}" != 1 ]]; then
  rm -f "$objdir/.sval-gecko-installed"
  trap '[[ $? -eq 0 ]] && printf "%s\n" "$gecko" > "$objdir/.sval-gecko-installed"' EXIT
fi
