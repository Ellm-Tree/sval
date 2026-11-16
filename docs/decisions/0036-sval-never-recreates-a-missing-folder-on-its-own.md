# 0036. Sval never recreates a missing folder on its own

**Status:** Accepted on 2026-10-07.

## Context

Sval cannot tell an unmounted share from a folder the user moved or deleted.
Recreating it unasked is wrong in the first case, and waiting forever is wrong
in the second.

## Decision

A chosen folder whose `sval/` is gone counts as unreachable and receives
nothing. Settings offers to use the folder again or to choose another, and
the user picks. Sval never leaves a chosen folder unreachable by
its own doing.

## Consequences

An unmounted mount point never fills with a stray copy that the real share
then shadows.
