# 0109. History syncs by week, and each visit belongs to its device

**Status:** Accepted on 2026-10-16. Specified in
2026-10-16-history-sync-design.md, §2.

## Context

Sharding history by month fails: a heavy user's month of visits comes close
to the shared-folder helper's 32 MB file limit once every device's visits are
merged into each file. The folder's hashed directory names mean a device
cannot list which shards exist. History also needs a rule for deletion across
devices.

## Decision

- One node per visit, of a `visit` kind, with an id derived from the
  visiting device, the URL and the time. A visit carries the id of the
  device that made it.
- History is sharded by ISO week. A `history-index` document lists the
  shards and is touched when a shard is written. A pass runs the index, the
  current week and the shards that changed.
- A visit belongs to the device that made it. Deleting a visit deletes it on
  every device. Clear Recent History asks between this device's history
  (default) and all devices' history. Clearing on shutdown clears this
  device's visits.
- Expiration stays local. A device inserts only visits new to its document,
  so it never re-adds what it expired.
- Every device has a name, a synced setting written by that device, shown on
  history from other devices and on other devices' agent workspaces.

## Consequences

- A device with less room shows less old history. Nothing is lost elsewhere.
- Delete Page and Forget About This Site remove other devices' visits too.
- The engine gains `visit` and `shard` kinds.
