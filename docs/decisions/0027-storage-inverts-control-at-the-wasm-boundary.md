# 0027. Storage inverts control at the WASM boundary

**Status:** Accepted on 2026-10-07.

## Context

A callback design, with the engine calling JS storage functions, fails in
Firefox. `DOMException` does not inherit from
`Error` in Firefox's IDL, so telling "missing file" from "real failure" by
`instanceof` or exception name cannot work there. Privileged chrome code also
has no synchronous storage API to call back into: `IOUtils` is promise-based.
Every WASM consumer in the Firefox tree (translations, ML, pdf.js) runs in a
worker and inverts control.

## Decision

The host does all I/O. It lists and reads, hands the engine a snapshot, and
the engine returns a report plus at most one path and its bytes for the host to
write back atomically (`docs/host-contract.md`). A module `ChromeWorker` owns
the profile's file I/O and drives the engine. Only the helper process reads and
writes the shared folder ([0031](0031-only-a-helper-process-touches-the-shared-folder.md)).

## Consequences

The storage and sync-report logic is natively testable: `PreloadedStore` is a
`BTreeMap`-backed `StorageProvider`. Only the thin `Array`-to-`Vec<u8>` glue at
the edge needs a real JS engine to test. Failures cross the boundary as a JS
`Error` with a stable `.code`.
