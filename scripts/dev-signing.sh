#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.
#
# Create the local code-signing identity scripts/run.sh signs dev builds with.
# macOS only. scripts/run.sh runs it when the keychain lacks the identity; a
# second run changes nothing.
#
# Sval keeps its secrets behind one item in the login keychain ("Sval secrets",
# SvalSecretStore.sys.mjs). macOS lets an app read that item without asking
# when the app's code requirement matches the one the item trusts. An
# ad-hoc signature's requirement is the build's own hash, so every rebuild is
# a new app to the keychain and asks again. A build signed with this identity
# keeps one requirement, its bundle identifier and this certificate, so
# "Always Allow" given once holds across rebuilds and worktrees. Local Network
# privacy keys on the signing identifier and the executable's UUID, which
# lib/launch.sh's sign_dev_bundle sets whether or not this identity exists.
#
# The certificate is self-signed and trusted by nothing. Signing does not need
# trust, and the keychain compares only the certificate's hash.
set -euo pipefail

IDENTITY="sval dev signing"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "dev-signing.sh: only macOS dev builds need a signing identity" >&2
  exit 0
fi

if security find-identity -p codesigning | grep -qF "\"$IDENTITY\""; then
  echo "dev-signing.sh: \"$IDENTITY\" is already in your keychain"
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/cert.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $IDENTITY
[ext]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
EOF

openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -config "$WORK/cert.cnf" -keyout "$WORK/key.pem" -out "$WORK/cert.pem" \
  2>/dev/null

# The keychain imports only the older PKCS#12 ciphers. OpenSSL 3 needs
# -legacy for them; the LibreSSL macOS ships uses them already and has no
# such flag.
PASS="$(openssl rand -hex 16)"
openssl pkcs12 -export -legacy -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
  -out "$WORK/id.p12" -passout "pass:$PASS" 2>/dev/null ||
  openssl pkcs12 -export -inkey "$WORK/key.pem" -in "$WORK/cert.pem" \
    -out "$WORK/id.p12" -passout "pass:$PASS"

# -T lets codesign use the key without asking each time.
security import "$WORK/id.p12" -P "$PASS" -T /usr/bin/codesign >/dev/null

echo "dev-signing.sh: added \"$IDENTITY\" to your login keychain"
echo "The next dev build asks for the keychain once more. Choose Always Allow."
