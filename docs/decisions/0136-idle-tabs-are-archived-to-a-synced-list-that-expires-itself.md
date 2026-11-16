# 0136. Idle tabs are archived to a synced list that expires itself

**Status:** Accepted on 2026-10-19. Specified in
2026-10-19-idle-tab-archive-design.md, §2.

## Context

A tab Sval closes for being idle stays recoverable (design spec §10.2).
Firefox's recently-closed list cannot hold it: that list is local to one
device, capped at 25 tabs a window, and ages out after 14 days. Most idle
tabs are in workspaces no window shows, so they have no Firefox tab to record
at all (spec §10.4). A tab Sval put away on the laptop would not be found on
the desktop.

The tree cannot hold them either. A closed record in the tree brings tabs back
to life on every sync
([0013](0013-closing-a-tab-deletes-the-node-sval-keeps-no-closed-tab-history.md)).

## Decision

- An idle tab is archived: removed from the tree, and an entry added to the
  Archive, in one engine call. Only tabs Sval archives go there. A tab the
  user closes is deleted as 0013 says.
- The Archive is its own synced document, `archive`, apart from the tree. Its
  entries are nodes of an `archived` kind with no parent.
- Entries are only added. The one later write is a restored mark, in the
  entry's lifecycle group.
- Each device drops entries older than the retention period, measured from
  closed time, inside each sync pass after the merge. The period is one
  synced setting, 30 days by default. So a device never publishes or shows
  an entry it has expired, and a drop on one device is a drop every device
  makes at the same moment.
- A restore creates a new tab with a new id. The archived tab's id stays
  deleted.

## Consequences

- The tree keeps no closed record (0013). Nothing in the Archive can
  become a live tab by merging: it is another document and another kind.
- The sweep removes a tab from one document and adds an entry to another. A
  host writes the Archive first and swaps both in once it is written, so a
  crash leaves a tab in both places, never in neither.
- Selecting a tab touches it (0106), at most once an hour. A tab in use on
  another device whose use this device had not seen when it archived the tab
  comes back to the tree by that touch (0017), and its entry stays in the
  Archive until it expires. The same touch beats a close by the user on
  another device that had not seen it: a use is real work, and 0017 keeps it.
- The engine gains the `archived` kind, `Content::archived`,
  `Lifecycle::restored` and `Lifecycle::auto_archive`.
