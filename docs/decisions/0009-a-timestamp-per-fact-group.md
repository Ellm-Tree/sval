# 0009. A timestamp per fact group

**Status:** Accepted on 2026-10-07.

## Context

One timestamp per node made renaming, moving, pinning and recolouring compete,
and a rename lost to an unrelated pin.

## Decision

Content, placement, lifecycle and appearance each carry their own timestamp
and merge separately (spec §5.1, engine/CLAUDE.md rule 5). Appearance (colour, emoji)
is its own group for the same reason as lifecycle.

## Consequences

Unrelated acts on two devices never lose to each other. Every group carries
its own writer too (see [0011](0011-attribution-is-per-fact-group.md)).
