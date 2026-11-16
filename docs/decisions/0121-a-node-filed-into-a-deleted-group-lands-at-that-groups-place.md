# 0121. A node filed into a deleted group lands at that group's place

**Status:** Accepted on 2026-10-17.

## Context

Device A deletes a group with everything in it. Device B has not seen that yet
and files a tab into the group. After the merge the tab's parent is gone.
Moving the tab to the lowest-id workspace puts it somewhere that can be
unrelated to the group. A tombstone would record where the group stood, and
spec §5.4 has none.

## Decision

- **The tab lands where the group was**: in the group's parent, at the
  group's place. If that parent was deleted too, it lands at the place of the
  deleted group directly beneath the first ancestor that still exists.
- **The place comes from the files the sync pass reads.** B's file holds the
  group alongside the tab, with the group's parent and order, because B wrote
  both. `sync` collects every group's placement from this device's document
  and each file it merges, and the repair reads it for a parent the merged
  document lacks. No tombstone is added.
- **Devices agree.** A group's placement that differs between files is
  settled the way the merge settles placement, so what is collected does not
  depend on the order files are read. The repair stays a pure function of the
  merged document and those placements.
- **A split is a place like a group** (split-view spec §5.3). A tab filed
  into a split another device deleted lands at the split's place. Anything
  else filed under a deleted split lands there too, and a split still
  standing holds only a tab.
- **The node keeps the placement stamp it had**: its `placement_at` and
  `placement_by` stay, and only its parent and order change. That stamp is
  the write that won the merge. Lowered, it would lose to a peer's older but
  sound placement, such as where the node stood before it was moved into
  the deleted group, and the devices would settle on different results by
  the order they synced in. Kept, a peer that deleted the node without
  seeing the write still gets it back. The same holds for every other
  repair of an unreachable node.
- **The lowest-id workspace stays the fallback** when no file read in the
  pass places the missing parent, and for a cycle, a parentless group or tab,
  or a deleted workspace. Favorites keep their own rule.

## Consequences

- Several nodes filed into deleted groups that land in one place keep the
  order they held inside those groups, starting at the deleted group's own
  order key.
- The placements live for one sync pass only. A file that brings in a node
  under a deleted group carries the group as well, so nothing needs to be
  remembered between passes.
