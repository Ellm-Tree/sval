# 0025. Groups first is a default, never a rule

**Status:** Accepted on 2026-10-07.

## Context

New groups usually belong above loose tabs.

## Decision

Groups first decides only where a node lands when the user named a parent and
no position. A drop between rows goes exactly where it was aimed, and nothing
is re-sorted.

## Consequences

Enforcing it would re-sort an order the user chose, on every device.
