# 0116. Only a device's file in a document's directory is a peer

**Status:** Accepted on 2026-10-17. Specified in
2026-09-24-sval-browser-design.md, §6.2.

## Context

Listing peers by string prefix on the document's directory name, which has
no trailing `/`, fails. A cloud client that makes `<hashed> (1)/` or
`<hashed>-DESKTOP/` beside it puts those files in the listing, and a stray
file in the directory itself (`.DS_Store`, `<device> (1).json`) is opened too.
Each fails to decrypt and is reported as an error on every pass, forever.

## Decision

The engine lists `<directory>/`, and opens only a device's file: a
`<device>.json` directly in that directory, `<device>` being 32 lowercase hex
characters. Everything else there is passed over without a report. A device
file that will not open is still reported, because it is a peer's state that
this key cannot read or that is damaged.

A host reads the files directly in `syncPrefix`'s directory, and reports a
file it could not read only when `isDeviceFile` says it is one.

## Consequences

- A conflict copy of a peer's file is never merged. A cloud client produces
  one only when two writers raced on one path, which the one-file-per-device
  layout rules out for Sval's own writes.
