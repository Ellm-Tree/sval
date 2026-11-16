#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
# Copyright 2026 Ellm Tree, Inc.

"""Check Kagi's live Privacy Pass challenge is one Sval's engine can use.

Kagi documents Privacy Pass only through its extension's source, so a change
on Kagi's side would break private windows silently (Kagi Privacy Pass spec).
The engine's `kagiTokenRequest` accepts exactly one `PrivateToken` challenge of
the batched ristretto255 type, 0xF91A, with a 32-byte issuer key. This asks
`https://kagi.com/pp/wwwa` the way Sval does and checks the answer has that
shape. It needs no account. Run nightly.
"""

import base64
import re
import sys
import urllib.error
import urllib.request

URL = "https://kagi.com/pp/wwwa"
TOKEN_TYPE = 0xF91A
KEY_BYTES = 32

PARAM = re.compile(r'([A-Za-z-]+)="?([A-Za-z0-9_=+/-]+)"?')


def fail(message):
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def b64url(text):
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def main():
    request = urllib.request.Request(
        URL, headers={"X-Kagi-PrivacyPass-Client": "true"}
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            headers = response.headers
    except urllib.error.HTTPError as err:
        headers = err.headers
    values = headers.get_all("WWW-Authenticate") or []
    if not values:
        fail(f"{URL} sent no WWW-Authenticate header")

    challenges = [
        part
        for value in values
        for part in re.split(r",\s*(?=PrivateToken\b)", value)
        if part.strip().startswith("PrivateToken")
    ]
    if len(challenges) != 1:
        fail(f"expected one PrivateToken challenge, got {len(challenges)}")

    params = dict(PARAM.findall(challenges[0][len("PrivateToken") :]))
    try:
        challenge = b64url(params["challenge"])
        key = b64url(params["token-key"])
    except (KeyError, ValueError) as err:
        fail(f"the challenge does not decode: {err.__class__.__name__}")

    token_type = int.from_bytes(challenge[:2], "big")
    if token_type != TOKEN_TYPE:
        fail(f"token type is {token_type:#06x}, expected {TOKEN_TYPE:#06x}")
    if len(key) != KEY_BYTES:
        fail(f"issuer key is {len(key)} bytes, expected {KEY_BYTES}")
    print(f"ok: one challenge of type {token_type:#06x} with a {len(key)}-byte key")


if __name__ == "__main__":
    main()
