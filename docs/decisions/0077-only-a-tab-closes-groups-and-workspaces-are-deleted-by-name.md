# 0077. Only a tab closes; groups and workspaces are deleted by name

**Status:** Accepted on 2026-10-08.

## Context

Closing a tab deletes its node
([0013](0013-closing-a-tab-deletes-the-node-sval-keeps-no-closed-tab-history.md)),
and that is right for a tab. A group or a workspace is something the user
built and named. An X on its row would remove the node and every tab inside
it, and "close" carries no warning that it is about to go. Closing a workspace
should put it away.

## Decision

Only a tab closes. A group toggles, has no X, and is deleted by "Delete group",
which asks whether its contents move up a level or go with it. A workspace is
closed by closing its window, which saves it, agents' workspaces included, and
deletes nothing unless nobody touched it
([0101](0101-closing-a-window-deletes-its-workspace-if-nobody-touched-it.md)).
"Delete workspace" is on its right-click menu, and its confirmation says that
its tabs go too, with no option to keep them. Spec §5.4 has the details.

## Consequences

No row other than a tab carries an X, and closing a window removes nothing
but an untouched workspace. A gesture that deletes a container names the
deletion.
