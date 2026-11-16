# 0021. One synced document under a fixed key

**Status:** Accepted on 2026-10-07.

## Context

The engine's document name is an arbitrary string, and one document can hold
every workspace as a root. Spec §6.2 keeps one document per workspace, under
`ws/<hashed workspace id>/` with an index document, as the move if scale
demands it.

## Decision

The workspace tree is one document under a fixed key, `workspaces`. Settings,
favorites ([0108](0108-favorites-sync-as-a-third-document-and-places-holds-none.md)),
history ([0109](0109-history-syncs-by-week-and-each-visit-belongs-to-its-device.md))
and the archive ([0136](0136-idle-tabs-are-archived-to-a-synced-list-that-expires-itself.md))
are documents of their own, on the same pass and key.

## Consequences

The whole tree is rewritten on any change to it, so a user with thousands of
tabs pays for every edit. Per-workspace documents stay on the shelf, and the move
to them is additive when scale demands it.
