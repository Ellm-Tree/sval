# 0079. A workspace has at most one window

**Status:** Accepted on 2026-10-08.

## Context

Two windows on one workspace, as two views of one tree, leave the user unsure
which window a tab lives in, and an offer to open the workspace you are in a
second time reads as a mistake.

## Decision

A workspace has at most one window. The switcher offers "Open in new window"
only for a workspace no window shows, and choosing a workspace another window
shows brings that window forward. The rule is enforced where a window changes
workspace, so every route obeys it: the switcher, a tear-off, an agent's
window, session restore and a new window. A new window with every workspace
already open gets a new, nameless workspace; a window left with nothing to
show closes, deleting nothing. A popup a page opened is outside the rule.

## Consequences

No window ever holds a second copy of another window's tabs, so a close in one
window has no stale twin elsewhere. Closing a new window that was given a
fresh workspace deletes it while nobody has touched it ([0101](0101-closing-a-window-deletes-its-workspace-if-nobody-touched-it.md)).
