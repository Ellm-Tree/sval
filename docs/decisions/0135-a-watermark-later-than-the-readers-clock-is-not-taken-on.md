# 0135. A watermark later than the reader's clock is not taken on

**Status:** Accepted on 2026-10-19.

## Context

Every peer that reads a device's file records its `written_at` as that
device's watermark (spec §5.4). A device whose clock runs fast publishes a
watermark in the future. Once its clock is put right, its edits are stamped
below that watermark, so no peer takes a new node as news, and the device
deletes its own new nodes on reading any peer's file, until real time passes
the fast reading.

engine/CLAUDE.md rule 10 governs a fact's timestamp in conflict resolution. A
clock reading stuck in synced bookkeeping may be bounded on read.

Sval stamps with corrected time (decision 1714), and two corrected clocks
still differ by the `Date` header's one-second precision and the request's
latency. A bound at the reader's exact time drops truthful watermarks, and a
peer's close goes unhonoured until it next writes.

## Decision

On the sync read path, never inside `merge` (engine/CLAUDE.md rule 8), a reader
drops every peer watermark more than one minute past its corrected time: a
watermark in a peer's `seen`, and a peer file's own `written_at`, which is then
recorded as no watermark at all. It is the same bound as decision 0134's, with
the reader's clock as one more limit.

A minute is far wider than the difference between two corrected clocks, and a
fast clock less than a minute ahead costs at most a minute of the harm this
decision guards against.

## Consequences

A corrected device loses nothing: its new nodes are news to every peer. The
cost is in the keep direction. A node it stamped while fast and closes after
the correction stays open on its peers until real time passes the fast
reading and the device writes again. A fact stamped by a fast clock that was
not yet corrected wins conflicts for that long, as spec §5.3 accepts.

A device's own stamps move forward past its own watermark within the same
minute (decision 1714), so a watermark this bound keeps never hides the
device's next edit.
