#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Build the installer's ServicesHelper NSIS plugin from the patched tree, into
# chrome/other-licenses/nsis/Plugins/ServicesHelper.dll, which sync-files.sh
# puts in place of the prebuilt copy Mozilla ships.
#
# The plugin's PathToUniqueRegistryPath answers with an installation's
# certificate key, which it takes from pathhash.cpp's
# CalculateRegistryPathFromFilePath, compiled into the DLL. Mozilla's copy
# carries Mozilla's service key, and the installer writes the certificates the
# update service checks at whatever key the plugin answers, so the plugin is
# rebuilt whenever update-service-name.patch changes that key.
#
# NSIS loads plugins into its own 32-bit process, so the DLL is x86. It is
# built as ServicesHelper.vcproj's Release|Win32 configuration builds it:
# Unicode, the static CRT, Services.cpp and pathhash.cpp. The version
# resource is left out: its script includes MFC's afxres.h, which the
# toolchain does not have, and NSIS reads nothing from it.
#
#   scripts/build-serviceshelper.sh [<vs toolchain directory>]
#
# The vs toolchain is the one a Windows Gecko compile bootstraps
# (<mozbuild state>/vs; scripts/toolchains.sh restore win64 puts it there),
# and the default is ~/.mozbuild/vs. clang-cl and lld-link come from
# ~/.mozbuild/clang/bin, or CLANG_BIN.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"
VS="${1:-$HOME/.mozbuild/vs}"
CLANG_BIN="${CLANG_BIN:-$HOME/.mozbuild/clang/bin}"
OUT="$REPO_ROOT/chrome/other-licenses/nsis/Plugins/ServicesHelper.dll"

if [[ ! -d "$SRC/other-licenses/nsis/Contrib/ServicesHelper" ]]; then
  echo "error: $SRC has no ServicesHelper source; run scripts/build-worktree.sh" >&2
  exit 1
fi
msvc="$(find "$VS/VC/Tools/MSVC" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
sdk="$(find "$VS/Windows Kits/10/Include" -mindepth 1 -maxdepth 1 -type d | sort | tail -1)"
if [[ -z "$msvc" || -z "$sdk" ]]; then
  echo "error: $VS is not a vs toolchain directory" >&2
  exit 1
fi
sdkver="$(basename "$sdk")"
sdklib="$VS/Windows Kits/10/Lib/$sdkver"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A path under /Users reads as clang-cl's /U, so the sources follow "--".
# The overlay maps the headers' mixed-case includes onto the toolchain's
# files, for a case-sensitive file system.
cflags=(
  --target=i686-pc-windows-msvc /nologo /O2 /MT /W3 /EHsc
  -Xclang -ivfsoverlay -Xclang "$VS/overlay.yaml"
  /DWIN32 /DNDEBUG /D_WINDOWS /D_USRDLL /DAPPLICATIONID_EXPORTS
  /DUNICODE /D_UNICODE /DMOZ_MAINTENANCE_SERVICE /D_CRT_SECURE_NO_WARNINGS
  -imsvc "$msvc/include"
  -imsvc "$sdk/ucrt" -imsvc "$sdk/um" -imsvc "$sdk/shared"
  /I "$SRC/toolkit/components/maintenanceservice"
)
for f in other-licenses/nsis/Contrib/ServicesHelper/Services.cpp \
  toolkit/mozapps/update/common/pathhash.cpp; do
  "$CLANG_BIN/clang-cl" "${cflags[@]}" /c \
    /Fo"$work/$(basename "$f" .cpp).obj" -- "$SRC/$f"
done
mkdir -p "$(dirname "$OUT")"
"$CLANG_BIN/lld-link" /nologo /DLL /SUBSYSTEM:WINDOWS /MACHINE:X86 \
  /OPT:REF /OPT:ICF /Brepro \
  /LIBPATH:"$msvc/lib/x86" /LIBPATH:"$sdklib/ucrt/x86" /LIBPATH:"$sdklib/um/x86" \
  "$work/Services.obj" "$work/pathhash.obj" \
  advapi32.lib kernel32.lib user32.lib /OUT:"$work/ServicesHelper.dll"
cp "$work/ServicesHelper.dll" "$OUT"
echo "==> Wrote $OUT"
