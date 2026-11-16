# 0115. A delete is one engine call, with the contents or without them

**Status:** Accepted on 2026-10-17.

## Context

Design spec §5.4 offers "Delete group" and "Delete workspace" with the
contents or without them. If the engine deletes only the id it is given, a
host that deletes a container with its contents names every descendant
itself, and one that moves the contents out moves each child itself before
removing the container. A child the host's walk misses, such as one merged in
after the host last read the tree, is left naming a parent that is gone.
Repair then moves it into the workspace with the lowest id (spec §5.2), which
is unrelated to where it was.

## Decision

The engine offers both deletions the panel asks the user to choose between, and
each is one call.

- `remove(id)` deletes the node and everything beneath it. Closing a tab,
  deleting a group with its contents, deleting a workspace and deleting a
  Favorites folder are all this call.
- `removeKeepingChildren(id, deviceId, now)` moves the container's children to
  its parent, in their order, at the place it held, and then removes it. A
  node with no parent is refused.

Both act on the children the document holds when the call runs.

## Consequences

- No host walks a subtree to delete it.
- Repair handles a child a peer filed under the container that this
  device had not merged before deleting it. That child arrives naming a parent
  that is gone and lands at the deleted container's place
  ([0121](0121-a-node-filed-into-a-deleted-group-lands-at-that-groups-place.md)),
  whichever deletion was chosen. The lowest-id workspace (spec §5.2) takes it
  only when nothing read in the pass places that container, or when the
  container was a workspace.
