# 0016. Unattributed is news

**Status:** Accepted on 2026-10-07.

## Context

The absence rule checks a group's timestamp against its writer's watermark
([0014](0014-absence-is-judged-per-node-and-fact-group-against-the-group-writers-watermark.md)).
A node can hold a group nobody has written, with no timestamp and no writer,
such as a group added to the model after the node was written. A group can
also carry a timestamp with no writer: on a byte-identical tie an
unattributed writer wins the tie-break, so a merge can strip a group's
writer. Neither has a watermark to check.

## Decision

A group never written, with no timestamp and no writer, is skipped. A group
with a timestamp and no writer is news, and any one group being news keeps the
whole node. A node with every group unwritten is news. Sval never deletes on a
watermark it cannot check (`is_news_to` in `engine/src/merge.rs`).

## Consequences

An unattributed group can delay a deletion. It can never cause a wrong one.
Skipping unwritten groups keeps every node that lacks a newer group as
droppable as it was before the group existed.
