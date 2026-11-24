#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Print the Gecko key: a SHA-256 over every input that reaches Sval's compiled
# Gecko. Two commits with one key build the same binaries, so a Gecko package
# published under a key serves every commit that has it, and an artifact build
# fetches its Gecko by key.
#
# The inputs are the upstream pin, the mozconfig identity and gecko fragment,
# scripts/build.sh (which writes the tree's mozconfig, a target's lines
# included, and runs mach), the CI image's Dockerfile and rust-toolchain.toml
# (the compilers), the branding files a compiler reads, every patch and
# deletion list that touches a file outside the front end, the two
# scripts that lay the tree out from them (scripts/apply-patches.sh and the
# scripts/sync-files.sh it runs), every file under chrome/ that a compiler
# reads, and the NSIS plugins under chrome/ that the compile's installer
# carries. sync-files.sh copies all of chrome/ into the tree, so a C++, Rust or
# IDL source, a components.conf that StaticComponents compiles into libxul, or
# an executable's manifest that config/create_rc.py compiles in as a resource,
# reaches the binaries from there. The rest of chrome/, its JS, markup and the
# moz.build and jar.mn that list them, is what artifact builds package
# themselves.
#
# The branding files a compiler reads are configure.sh, whose confvars
# configure passes to the compilers as defines (MOZ_APP_DISPLAYNAME reaches
# nsWindowsShellService.cpp and splash.rc), and the .ico files the Windows
# executables compile in as resources: browser/app/moz.build's *_ICO defines,
# browser/app/pbproxy's PBMODE_ICO and browser/app/desktop-launcher's
# FIREFOX_ICO. An artifact build takes only binaries from a Gecko package
# (python/mozbuild/mozbuild/artifacts.py), and packages the rest of the
# branding directory from source: its jar.mn content, the images moz.build
# lists, the macOS .icns that browser/app/Makefile.in copies into the bundle,
# and the installer art, firefox64.ico among it.
#
# scripts/artifact-gecko.sh is the part of the build only an artifact build
# sources, so it is left out. A patch or deletion list counts as front end
# only when every file it touches is JS, CSS, markup, Fluent, a .properties
# file or an image, which artifact builds package themselves. Anything else, a moz.build, a .configure file, a
# Makefile.in, the package manifest, counts as native, and so does any file
# under js/src/: SpiderMonkey compiles its self-hosted JS into libxul
# (selfhosted_inputs in js/src/builtin/moz.build).
#
# This script's own text is not an input: what it hashes names every input,
# so the same hashed text is the same Gecko. KEY_VERSION is hashed instead.
# Raising it moves every key at once, which compiles every platform afresh;
# raise it when a published Gecko must not be reused, as when this script is
# found to have left out something that reaches the binaries.
#
# The rule errs one way on purpose. Counting a front-end file as native costs
# one extra Gecko build. Counting a native file as front end pairs a tree with
# the wrong libxul, silently.
#
# Usage: ./scripts/gecko-key.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The chrome/ inputs are the files git tracks, so an untracked file there
# cannot move the key, and every input is hashed as git stores it
# (git hash-object), so a Windows checkout's CRLF line endings do not move it
# either. Without git there is no such list or normalisation, and a key
# computed without them would name a Gecko nobody built.
if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: $REPO_ROOT is not a git checkout; the Gecko key needs git's file list" >&2
  exit 1
fi

KEY_VERSION=1

frontend='\.(js|mjs|css|ftl|xhtml|html|properties|svg|png)$'

native_source='\.(c|cc|cpp|cxx|h|hh|hpp|mm|m|rs|idl|webidl|ipdl|ipdlh|S|s|asm|der|inc|dll)$|\.exe\.manifest$|(^|/)(components\.conf|Cargo\.toml|Cargo\.lock|build\.rs)$'

inputs=(scripts/build.sh scripts/apply-patches.sh scripts/sync-files.sh mozconfig mozconfig.gecko .forgejo/docker/Dockerfile rust-toolchain.toml)
while IFS= read -r line; do
  [[ -z "${line// }" || "$line" == \#* ]] && continue
  if [[ "$line" == *.delete ]]; then
    paths="$(grep -v '^#' "patches/$line")"
  else
    paths="$(awk '/^diff --git / { print $3 }' "patches/$line" | sed 's|^a/||')"
  fi
  if grep -Evq "$frontend" <<<"$paths" || grep -q '^js/src/' <<<"$paths"; then
    inputs+=("patches/$line")
  fi
done < patches/series
inputs+=(branding/sval/configure.sh)
for icon in document document_pdf firefox newtab newwindow pbmode; do
  inputs+=("branding/sval/$icon.ico")
done
while IFS= read -r f; do
  inputs+=("$f")
done < <(git ls-files chrome | grep -E "$native_source" | LC_ALL=C sort)

# shellcheck source=scripts/lib/registry.sh
source ./scripts/lib/registry.sh

{
  . ./upstream.txt
  printf 'version %s\n' "$KEY_VERSION"
  printf 'upstream %s\n' "$UPSTREAM_REF"
  for f in "${inputs[@]}"; do
    printf 'file %s %s\n' "$f" "$(git hash-object -- "$f")"
  done
} | sha256 | cut -d' ' -f1
