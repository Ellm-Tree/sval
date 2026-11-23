#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Authenticode-sign a packaged Windows release: every executable and DLL in
# the zip, then the installer, rebuilt from the signed zip around a signed
# setup.exe.
#
# The installer is a 7-Zip self-extractor holding the zip's files and
# setup.exe, so signing only its outside would leave everything it installs
# unsigned. `mach package` builds it in one go from instgen/setup.exe, so this
# signs the files `mach package` produced and rebuilds the installer with
# `mach repackage installer`, the arguments makensis.mk's installer rule
# gives it.
#
# jsign signs with Ellm Tree's certificate from SSL.com, whose key is held in
# Google Cloud KMS and signs there. SSL.com's timestamp server countersigns
# every signature, so a release stays valid after the certificate expires. A
# file that already carries a signature is left as it is: the Visual C++
# runtime ships signed by Microsoft.
#
# Usage: ./scripts/sign-windows.sh OBJDIR
#   JSIGN_JAR                  jsign's jar
#   WINDOWS_SIGNING_KEY        the key version's resource name,
#                              projects/.../cryptoKeys/<key>/cryptoKeyVersions/<n>
#   WINDOWS_SIGNING_CERTS      the certificate and the CAs above it, PEM
#   GOOGLE_CLOUD_ACCESS_TOKEN  a token allowed to sign with the key
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$REPO_ROOT/build/firefox"
OBJDIR="$(cd "$1" && pwd)"
DIST="$OBJDIR/dist"
SETUP="$OBJDIR/browser/installer/windows/instgen/setup.exe"

for v in JSIGN_JAR WINDOWS_SIGNING_KEY WINDOWS_SIGNING_CERTS \
  GOOGLE_CLOUD_ACCESS_TOKEN; do
  if [[ -z "${!v:-}" ]]; then
    echo "error: sign-windows.sh needs $v" >&2
    exit 1
  fi
done
for f in "$DIST/target.zip" "$DIST/target.installer.exe" "$SETUP"; do
  if [[ ! -f "$f" ]]; then
    echo "error: $f is missing; run mach package first" >&2
    exit 1
  fi
done

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
printf '%s\n' "$WINDOWS_SIGNING_CERTS" > "$work/certs.pem"

# Prints each named PE file whose security directory is empty, which is
# where Authenticode keeps a signature.
unsigned() {
  python3 -I - "$@" <<'EOF'
import struct, sys
for path in sys.argv[1:]:
    with open(path, "rb") as f:
        data = f.read(4096)
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    magic = struct.unpack_from("<H", data, pe + 24)[0]
    # The security entry is the fifth data directory, after a 96- or
    # 112-byte PE32 or PE32+ optional header.
    directory = pe + 24 + (96 if magic == 0x10B else 112) + 4 * 8
    size = struct.unpack_from("<I", data, directory + 4)[0]
    if size == 0:
        print(path)
EOF
}

# jsign takes the key ring as the keystore and the rest of the key's name as
# the alias, and the token from the environment, out of the process list.
sign() {
  java -jar "$JSIGN_JAR" \
    --storetype GOOGLECLOUD \
    --keystore "${WINDOWS_SIGNING_KEY%%/cryptoKeys/*}" \
    --alias "${WINDOWS_SIGNING_KEY#*/cryptoKeys/}" \
    --storepass env:GOOGLE_CLOUD_ACCESS_TOKEN \
    --certfile "$work/certs.pem" \
    --tsaurl http://ts.ssl.com --tsmode RFC3161 \
    "$@"
}

echo "==> Unpacking $DIST/target.zip"
mkdir "$work/pkg"
unzip -q "$DIST/target.zip" -d "$work/pkg"
pkg_name="$(ls "$work/pkg")"
if [[ "$(wc -l <<<"$pkg_name")" -ne 1 ]]; then
  echo "error: target.zip should hold one directory, and holds: $pkg_name" >&2
  exit 1
fi
cp "$SETUP" "$work/setup.exe"

# One jsign run for every file, so Java starts once.
mapfile -t pe < <(find "$work/pkg" -type f \( -iname '*.exe' -o -iname '*.dll' \) | sort)
unsigned "${pe[@]}" "$work/setup.exe" > "$work/to-sign"
echo "==> Signing $(wc -l < "$work/to-sign") of $((${#pe[@]} + 1)) files"
sign "@$work/to-sign"

left="$(unsigned "${pe[@]}" "$work/setup.exe")"
if [[ -n "$left" ]]; then
  echo "error: still unsigned after signing:" >&2
  sed 's/^/  /' <<<"$left" >&2
  exit 1
fi

echo "==> Rezipping"
rm "$DIST/target.zip"
(cd "$work/pkg" && python3 -I - "$DIST/target.zip" "$pkg_name" <<'EOF'
import os, sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for root, dirs, files in os.walk(sys.argv[2]):
        dirs.sort()
        for name in sorted(files):
            z.write(os.path.join(root, name))
EOF
)

# makensis.mk passes --use-upx when configure found upx (MOZ_AUTOMATION is
# never set here), and the stub is SFX_MODULE's, Sval's in the branding
# directory (browser/installer/windows/Makefile.in), so the rebuilt
# installer's stub matches the one mach package made.
echo "==> Rebuilding the installer"
upx=()
if grep -Eq '^UPX = .+' "$OBJDIR/config/autoconf.mk"; then
  upx=(--use-upx)
fi
rm "$DIST/target.installer.exe"
(cd "$SRC" && ./mach --no-interactive repackage installer \
  -o "$DIST/target.installer.exe" \
  --package-name "$pkg_name" \
  --package "$DIST/target.zip" \
  --tag browser/installer/windows/app.tag \
  --setupexe "$work/setup.exe" \
  --sfx-stub browser/branding/sval/7zSD.Win32.sfx \
  "${upx[@]}")

echo "==> Signing the installer"
sign "$DIST/target.installer.exe"
if [[ -n "$(unsigned "$DIST/target.installer.exe")" ]]; then
  echo "error: the installer is still unsigned" >&2
  exit 1
fi

# The maintenance service runs an updater only when its signer and issuing CA
# match an entry the installer wrote (AddMaintCertKeys, from the
# CERTIFICATE_NAME and CERTIFICATE_ISSUER defines). A renewed certificate can
# come from another CA, and a release whose CA the installer does not list
# would ask for elevation at every update, so it fails here instead.
echo "==> Checking the updater's signer against the installer's list"
defines="$SRC/browser/installer/windows/nsis/defines.nsi.in"
# MOZ_UPDATER_NAME in toolkit/moz.configure names the updater.
updater="$(find "$work/pkg" -iname sval-update.exe | head -1)"
if [[ -z "$updater" ]]; then
  echo "error: the package has no sval-update.exe" >&2
  exit 1
fi
python3 -I - "$updater" "$work/updater.p7" <<'PY'
import struct, sys
data = open(sys.argv[1], "rb").read()
pe = struct.unpack_from("<I", data, 0x3C)[0]
magic = struct.unpack_from("<H", data, pe + 24)[0]
directory = pe + 24 + (96 if magic == 0x10B else 112) + 4 * 8
offset, size = struct.unpack_from("<II", data, directory)
# A WIN_CERTIFICATE: length, revision and type, then the PKCS#7 blob.
length = struct.unpack_from("<I", data, offset)[0]
open(sys.argv[2], "wb").write(data[offset + 8 : offset + length])
PY
certs="$(openssl pkcs7 -inform DER -in "$work/updater.p7" -print_certs -noout)"
name="$(sed -n 's/^!define CERTIFICATE_NAME *"\(.*\)"$/\1/p' "$defines")"
signer_issuer="$(awk -v name="$name" '
  /^subject=/ { leaf = index($0, "CN=" name) || index($0, "CN = " name) }
  /^issuer=/ && leaf { sub(/.*CN ?= ?/, ""); sub(/,.*/, ""); print; exit }
' <<<"$certs")"
if [[ -z "$signer_issuer" ]]; then
  echo "error: sval-update.exe is not signed by \"$name\":" >&2
  echo "$certs" >&2
  exit 1
fi
if ! grep -qF "\"$signer_issuer\"" <(grep '^!define CERTIFICATE_ISSUER' "$defines"); then
  echo "error: sval-update.exe was signed by a certificate from \"$signer_issuer\"," >&2
  echo "which defines.nsi.in's CERTIFICATE_ISSUER defines do not list" >&2
  exit 1
fi
echo "    signed by \"$name\", issued by \"$signer_issuer\""
