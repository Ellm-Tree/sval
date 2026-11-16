# 1714. Sval stamps with corrected time

**Status:** Accepted on 2026-11-01. Specified in
2026-09-24-sval-browser-design.md, §5.3.

## Context

Stamping synced documents with the device's raw wall clock fails, because a
wrong clock does not correct itself once fixed:

- A clock that falls back below a reading the device already published, as a
  dual-boot machine or a manual change does, stamps a new tab below every
  peer's watermark for the device. No peer takes the tab, and the device
  deletes it on its next read.
- A clock that runs ahead stamps edits in the future. Fixing the clock leaves
  those stamps in the files, where the edits win every conflict and a tab a
  peer closes comes back, until real time passes them. A clock never fixed
  does this forever.

Other browsers that sync take time from their sync server: Firefox Sync from
`X-Weave-Timestamp`, Chromium from server-assigned versions. Sval syncs
through a folder and has no server of its own.

## Decision

- **Sval's `now` is server time.** Remote Settings measures the
  device's clock against its server's `Date` header on every poll and keeps
  the difference in `services.settings.clock_skew_seconds`
  (`remote-settings.sys.mjs`). Sval subtracts it from the wall clock. The pref
  persists, so a run starts with the last difference measured.
- **Between readings, corrected time follows the monotonic clock**, which a
  change to the wall clock does not move. The two clocks tick at slightly
  different rates, and a synchronised wall clock is slewed toward its
  server's time, at most 500 parts per million under NTP: 1.8 seconds over
  the hour between polls. So a drift of up to two seconds between them is
  followed, keeping corrected time on the wall clock that other code and
  other devices read, and a larger move waits for the next reading. Gecko's
  monotonic clock may not advance while the system sleeps (`TimeStamp.h`), so on
  `wake_notification` corrected time adds the wall-clock time that passed.
- **A device's stamps only move forward.** Each stamp is the later of
  corrected time and one millisecond past the device's previous stamp, as
  Syncthing's version counters are (`lib/protocol/vector.go`). A new reading
  a second lower moves no stamp back. Across restarts the same holds: every
  pass reports the device's own watermark, and its next stamp is above it,
  unless the watermark is more than a minute past corrected time (decision
  0135's margin), which only a fast clock from before the first reading
  leaves. A peer holding that watermark would read a node stamped below it
  as one it had already seen.
- **Edits on two devices within about a second are ordered by the tie-break.**
  The `Date` header has one-second precision, and a person cannot edit one
  tab on two devices faster than that.
- **A device that has never reached Remote Settings uses its wall clock,
  and publishes nothing before its first reading.** It still reads and
  merges what the shared folder holds. When the first reading arrives, the
  device's first pass of each document pulls every stamp of its own later
  than corrected time back to it. Those stamps were never published, so no
  peer sees a difference, and the pref persists, so this happens once. The
  engine records the reading's time and the documents already pulled back
  beside its own files in the profile, so a restart before a document's
  next pass still pulls it back before it publishes. The pull runs on the
  read path, never inside `merge` (engine/CLAUDE.md rule 8). Joining another
  device's key does not wait for the reading: the key is stored and the
  folder read and merged as usual, and the gate holds this device's own
  changes until its first reading, as it does for any device without one.
- **Until the first reading, Sval polls Remote Settings itself.** Its update
  timer polls hourly (`services.settings.poll_interval`), and one failed poll
  must not leave a new device waiting that long to publish. Sval calls
  `RemoteSettings.pollChanges` at startup, again after 30 seconds, then at
  doubling intervals up to 30 minutes, and at once when the network comes
  back or the computer wakes. It never polls inside a backoff the server
  asked for (`services.settings.server.backoff`), and stops at the first
  reading. This contacts no new host.
- **A device whose clock is ahead is reported when it costs something, and
  never refused.** A peer file whose `written_at` is more than ten minutes
  past corrected time comes from a device stamping with an uncorrected clock.
  Sval keeps everything in it and drops its watermark as decision 0135 does.
  It warns the user only when merging that file cost them something: one of
  its facts stamped after corrected time replaced a different value this
  device held, or a node this device's own file holds and it had closed came
  back from that file carrying a stamp after corrected time. The warning
  names the device and says its changes are replacing the user's and closed
  tabs can come back. A file that is merely ahead warns no one. The engine
  decides this on the sync read path, never inside `merge`
  (engine/CLAUDE.md rule 8). Refusing the file would lose real edits, and
  devices with different clocks would refuse different files and never
  converge.
- **A device with no reading warns no one about another's clock.** Its own
  clock may be the wrong one.

## Consequences

Fact timestamps are corrected wall-clock times, never a logical clock
(engine/CLAUDE.md rule 10). Decision 0135 guards against a device stamping
with an uncorrected clock. The ten-minute margin is far wider
than the error between two corrected devices, which is a few seconds.
