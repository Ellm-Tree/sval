# 0019. `written_by` is optional

**Status:** Accepted on 2026-10-07.

## Context

A document needs to say who last wrote it, and a fresh document has no writer.

## Decision

`written_by` is `Option<DeviceId>`. No all-zero sentinel.

## Consequences

"Never written" is distinguishable from a real device id. A host may hand the
crate sixteen zero bytes as its own device id; `wasm.rs`'s own tests do.
