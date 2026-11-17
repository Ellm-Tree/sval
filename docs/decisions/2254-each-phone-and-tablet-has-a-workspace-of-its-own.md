# 2254. Each phone and tablet has a Workspace of its own

**Status:** Accepted on 2026-11-13.

## Context

A phone opens tabs in whichever Workspace is in front, so the tabs a user
opens on the go land among the ones they keep at their desk, and the phone's
own reading has no home. An agent's Workspace already shows how the tree can
mark a Workspace as belonging to something other than the user: its node
carries a mark set once, at creation, which every device reads.

## Decision

Each phone or tablet keeps one Workspace of its own, marked in the tree as
that device's. The mark is a node field set when the Workspace is made and
never edited, as an agent's is. Apart from the mark it is an ordinary
Workspace: it syncs, holds groups and splits, and can be renamed, recoloured,
emptied and deleted from any device.

Every device lists the device Workspaces under a Devices heading, after the
user's own Workspaces. Desktops keep none of their own.

A device whose Workspace is missing after a sync, because another device
deleted it, makes a new, empty one under a new id.

A device that stops syncing keeps its Workspace until the user deletes it.
Sval has no signing out or unpairing, so a stale device's Workspace stays as
it was.

Closing a tab deletes it, as everywhere else. Only the idle-tab archive puts
tabs in the Archive (decision 0136).

## Consequences

- A build that doesn't know the mark keeps it as an unknown field and shows
  the Workspace as an ordinary one.
- Recreating under a new id keeps the absence rule's verdict on the deleted
  Workspace intact: the old id stays deleted on every device.
- A phone's Workspace never comes back with its old tabs: the user deleted
  them along with it.
