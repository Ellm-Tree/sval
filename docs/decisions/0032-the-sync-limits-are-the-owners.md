# 0032. The sync limits are the owner's

**Status:** Accepted on 2026-10-07.

## Context

A step needs a deadline, the exchange needs a period, and an outage needs a
threshold before the user hears of it. A step also copies what it reads from
the folder into the profile and hands it to the engine, whose WASM memory
never shrinks, so anyone who can write to the folder decides how much that is
unless a step has a ceiling.

## Decision

20 seconds a step. An exchange with the folder every 30 seconds. Three minutes
of silence before the footer's sync indicator shows the folder as offline, as
a notice and never as an alert.

A step reads at most 256 MiB from the folder in all. A folder holding more is
not synced: the step reads nothing past the limit, and the indicator says the
folder is too large, never that it is unreachable.

## Consequences

20 seconds keeps a dead mount from holding the exchange. 30 seconds keeps
local saves immediate and the network quiet. Blips are normal on every backend
Sval supports, and a sustained outage is worth knowing about but never
alarming. 256 MiB is far above any real profile's files, and it bounds the
disk, memory and time one step can be made to spend.
