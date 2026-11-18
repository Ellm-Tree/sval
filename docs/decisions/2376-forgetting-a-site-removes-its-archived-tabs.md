# 2376. Forgetting a site removes its archived tabs

**Status:** Accepted on 2026-11-17.

## Context

Forget this site clears everything Sval keeps for a site, in every Workspace.
An archived tab holds a page's address and title, and the Archive is a synced
document that the History sidebar lists (decision 0136). An entry leaves it
only when its retention period ends, which can be 90 days away.

## Decision

- **Forget this site removes the site's Archive entries,** those of every
  host under it included (decision 1980), on every device. The confirm counts
  them as Archived tabs, among the parts removed from every device.
- **The entry is deleted as a closed tab is:** the record goes, with no
  tombstone. A device that still holds the entry drops it at its next pass,
  because the entry is no news to the device that removed it.
- **The host decides which entries are the site's.** The engine has no
  Public Suffix List, so the host lists the entries, picks by `siteOf` and
  removes them by id.
- **A split's other pane stays** when it is another site's tab. It restores
  as a tab on its own.
- Keeping the entries until they expire is rejected: Forget would leave the
  site's addresses listed on every device for up to the retention period.

## Consequences

- An entry removed on one device and restored on another before the two
  sync comes back, since the restore is news to the device that removed it.
- A device whose sync key is not settled has no Archive to remove from, and
  its Forget leaves entries other devices hold.
