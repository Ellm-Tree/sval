# 0011. Attribution is per fact group

**Status:** Accepted on 2026-10-07.

## Context

The absence rule needs to know who wrote a node. A single writer id per node
would have to be synthesised by `merge`, and both ways of synthesising it are
wrong. Choosing the newer side's writer picks arbitrarily between two devices
on an equal-timestamp tie, and can then delete a node against a watermark for
a device that did not write it. Refusing to attribute makes every node two
devices have touched permanently undeletable.

## Decision

Each fact group records its writer (`content_by`, `placement_by`, ...) beside
its timestamp, and the writer travels with its group atomically. The group
tie-break orders on `(at, canonical bytes, writer)`.

## Consequences

Nothing is invented by merge. The writer decides only between byte-identical
values, and it must be in the order, or two devices with the same value and
different attribution never converge.
