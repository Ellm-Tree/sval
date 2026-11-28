# 0032. The sync limits are the owner's

**Status:** Accepted on 2026-10-07.

## Context

A step needs a deadline, the exchange needs a period, and an outage needs a
threshold before the user hears of it. A step also copies what it reads from
the folder into the profile and hands it to the engine, whose WASM memory
never shrinks, so anyone who can write to the folder decides how much that is
unless a step has a ceiling.

A folder that is missing is no blip: a drive that is unplugged or a folder
that is renamed stays missing until someone acts. A folder that is there and
does not answer is often a blip that the next try clears.

## Decision

20 seconds a step. An exchange with the folder every 30 seconds.

A step that does not reach the folder is retried 5 seconds later, once
(`SvalEngine.SHARED_RETRY_MS`). A folder that is there and does not answer
shows as unreachable from the second failed step in a row
(`SvalPanelModel.FOLDER_UNAVAILABLE_AFTER_STEPS`), as a notice and never as
an alert, and the steps go back to every 30 seconds. A chosen folder that is
not there, or holds none of Sval's files, shows from the first step that
finds it so. A pass someone waited on, as Sync now is, shows its answer at
once, from a step that starts after the question. The first step that
reaches the folder clears the notice.

A folder is missing only when the system says nothing is at the path, or a
part of the path is not a directory. A look that fails any other way is an
I/O error, which counts as a failed reach. A step that never had its turn at
the helper asked the folder nothing, so it changes nothing and is retried
within seconds. A second such step in a row is the helper ahead stuck in the
folder, and counts. A slow folder that answers within the step's 20 seconds
is reached.

A wait measured in minutes is rejected: it shows "Synced" over a folder that
is missing, and a Sync now pressed during it changes nothing on screen.

A step reads at most 256 MiB from the folder in all. A folder holding more is
not synced: the step reads nothing past the limit, and the indicator says the
folder is too large, never that it is unreachable.

## Consequences

20 seconds keeps a dead mount from holding the exchange. 30 seconds keeps
local saves immediate and the network quiet. Blips are normal on every
backend Sval supports, and one quick retry tells a blip from an outage within
seconds. A sustained outage is worth knowing about but never alarming.
Counting steps holds however the clock moves. 256 MiB is far above any real
profile's files, and it bounds the disk, memory and time one step can be made
to spend.
