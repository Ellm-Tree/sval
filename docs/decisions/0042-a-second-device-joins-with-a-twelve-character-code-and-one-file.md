# 0042. A second device joins with a twelve-character code and one file

**Status:** Accepted on 2026-10-07.

## Context

Spec §6.4 measures download latency at up to 10 minutes on OneDrive and 30 on
SharePoint-backed folders. A PAKE needs two round trips, and a live exchange
would time out over that channel.

## Decision

Device A shows a code, seals its document key under it with Argon2id at 64 MiB,
and writes one file into the folder both devices share. Device B types the
code, unseals it and adopts the key. An interactive handshake is rejected,
because it would time out over that channel.

## Consequences

No server, no account, and the joining device can wait and retry. Twelve
characters from a 32-symbol alphabet is 60 bits, safe only because the KDF is
memory-hard; a known-answer vector pins the derivation's cost. No QR code or
local-network path exists.
