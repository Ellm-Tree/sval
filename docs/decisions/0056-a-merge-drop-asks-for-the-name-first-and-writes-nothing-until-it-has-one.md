# 0056. A merge drop asks for the name first and writes nothing until it has one

**Status:** Accepted on 2026-10-07.

## Context

Dropping a tab onto a tab, or a group onto a group, makes a new group. Sval
never names a group itself. The engine has no single "group these" call.

## Decision

The name prompt comes before any write. The mutations then go to the engine
as one batch, which it applies whole or not at all, so a refusal leaves the
tree as it was.

## Consequences

Cancel is a true "never mind", and no device is ever sent a half-built group.
