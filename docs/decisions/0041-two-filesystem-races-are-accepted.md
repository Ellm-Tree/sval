# 0041. Two filesystem races are accepted

**Status:** Accepted on 2026-10-07.

## Context

The helper works on the shared folder by path, through Rust's `std::fs`,
which has no directory-relative open. Before it writes or moves a file it
checks every directory on the way for a link, so the check and the operation
it guards are separate path lookups.

## Decision

Two races are accepted. A directory swapped for a link between the check and
the rename can redirect that one write: it needs write access to the share and
a won race, and the worst case is this device's encrypted file at a fixed name
in another directory. Hard links are accepted, because reads of a hard-linked
file only feed undecryptable bytes to the engine, and a write replaces the
directory entry by rename and never writes through a link. `write_atomically`
in `tools/sval-folder/src/ops.rs` documents both.

## Consequences

No plaintext is exposed. The residual risk needs an attacker who can already
write to the share.
