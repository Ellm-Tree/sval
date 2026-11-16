# 0020. Structural validation lives on the local-edit path, never inside `merge`

**Status:** Accepted on 2026-10-07.

## Context

A move can create a shape no downward walk could draw: an absent parent, a tab
as parent, a cycle. A peer on a different build may legitimately hold shapes
this build will not create.

## Decision

`tree::move_node` refuses those moves and returns an error, leaving the
document unchanged. `merge` keeps whatever a peer sends. Unreachable shapes are
repaired on the read path only (engine/CLAUDE.md rule 8) and drawn by the panel.

## Consequences

The same check inside `merge` would delete another device's data on the
strength of this build's opinion about tree shape. A refusal is an error
because a host that shows a move as done when nothing moved is
indistinguishable from data loss to the user.
