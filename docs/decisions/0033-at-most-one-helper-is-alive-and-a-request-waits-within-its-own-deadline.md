# 0033. At most one helper is alive, and a request waits within its own deadline

**Status:** Accepted on 2026-10-07.

## Context

A stuck helper cannot be killed out of its stuck read. Allowing a second
helper would let stuck helpers accumulate with each folder switch.

## Decision

At most one helper is alive. A stuck helper blocks every later step, including
one for a different folder chosen after the first stuck. A request waits its
turn behind the live helper, and the wait counts against its own 20-second
deadline: one whose turn has not come by then answers "busy".

## Consequences

The user sees the folder as unreachable and then the three-minute notice. A
reboot or a remount frees the helper. A caller waits at most its own 20
seconds behind someone else's step.
