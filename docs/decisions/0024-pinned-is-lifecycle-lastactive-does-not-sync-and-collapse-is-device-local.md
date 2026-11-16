# 0024. `pinned` is lifecycle, `lastActive` does not sync, and collapse is device-local

**Status:** Accepted on 2026-10-07.

## Context

Each node property needs a home: a fact group, or nowhere in the synced
document.

## Decision

`pinned` lives in the lifecycle group, because pinning is a state of the node:
in the content group, pinning on one device would collide with a rename on
another. A pin's scope
([0137](0137-a-pin-is-its-own-tab-kept-apart-from-favorites.md)) lives in
the lifecycle group for the same reason.

`lastActive` does not sync, because when a tab was last looked at is a fact
about one device (spec §5.1). Whether a group is collapsed is device-local
(`SvalLocalSettings`).

## Consequences

Two devices can look at the same tree differently without writing anything.
