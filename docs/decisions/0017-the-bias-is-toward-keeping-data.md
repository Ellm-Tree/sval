# 0017. The bias is toward keeping data

**Status:** Accepted on 2026-10-07.

## Context

Some concurrent edit-and-delete shapes cannot be decided without remembering
deletions forever, which [0013](0013-closing-a-tab-deletes-the-node-sval-keeps-no-closed-tab-history.md)
removed.

## Decision

An edit never loses to a stale absence. A delete can lose to a concurrent edit
the deleting device never saw: a device holding genuine unsynced edits to a
node deleted elsewhere brings it back, carrying its edit.

## Consequences

A tab can reappear. Real work is never lost silently. A lost delete in that
shape is the trade, and the fix is not a tombstone (spec §5.4).
