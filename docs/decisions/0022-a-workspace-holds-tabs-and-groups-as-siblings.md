# 0022. A workspace holds tabs and groups as siblings

**Status:** Accepted on 2026-10-07.

## Context

Loose tabs need a place beside groups. A catch-all group for loose tabs is
rejected: it puts an unlocalised name inside the synced document, its fixed
node id can converge on one placement across devices, and it is a phantom
group nobody made.

## Decision

A workspace holds tabs and groups as siblings in one ordered list by
fractional index, like loose files beside folders.

## Consequences

A loose tab is an ordinary sibling, so no node exists that the user did not
make.
