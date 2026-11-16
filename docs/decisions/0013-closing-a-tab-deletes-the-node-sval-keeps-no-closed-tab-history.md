# 0013. Closing a tab deletes the node; the tree keeps no closed-tab history

**Status:** Accepted on 2026-10-07.

## Context

A closed record, kept to out-argue a device whose file predates the close,
destroys data once a retention window strips it: the device holding the older
file brings the tab back live on every later sync, and it republishes itself
everywhere. Kept forever, it is a permanent graveyard of everything every
device ever closed.

Prior art agrees. Firefox's tab engine has one writer per record and never
merges; remote tabs are a list you click. Chromium's saved tab groups keep
tombstones in a server, whose docs admit an entity "can be revived if it had
been deleted on another client". Sval has no server.

## Decision

`Document::remove` removes the record. No closed state, no tombstone, no
retention window (engine/CLAUDE.md rule 5). Firefox's own recently-closed list is how
a tab the user closed comes back, locally. A tab Sval archives for being idle
is kept in the Archive, a separate synced list
([0136](0136-idle-tabs-are-archived-to-a-synced-list-that-expires-itself.md)).
Deletion propagates through the version vector (spec §5.4), where a node's
absence can be read as a deletion instead of ignorance.

## Consequences

Do not reintroduce a closed record or `retention`. Some deletes lose to
concurrent edits (see [0017](0017-the-bias-is-toward-keeping-data.md)).
