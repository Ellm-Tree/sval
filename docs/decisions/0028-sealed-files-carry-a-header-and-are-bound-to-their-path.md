# 0028. Sealed files carry a header and are bound to their path

**Status:** Accepted on 2026-10-07.

## Context

Encrypted files sit in a folder any provider, and anyone with write access to
it, can rearrange. A bare ciphertext can be passed off as another device's or
another workspace's file, and garbage cannot be told from a newer format.

## Decision

Each sealed file starts `svl`, a version byte and a 12-byte nonce, then
AES-256-GCM ciphertext. The header and the file's storage path are associated
data. The user's key is only a root: HKDF-SHA256 derives the cipher key and a
separate HMAC-SHA256 key for directory names, so no key serves two
algorithms. A pairing file binds its plain fields the same way, so its expiry
cannot be extended. A newer version byte reports `schema_too_new` (engine/CLAUDE.md
rule 11). Spec §6.5.

## Consequences

A provider cannot swap files undetected, and a file from a newer format is
told from garbage.
