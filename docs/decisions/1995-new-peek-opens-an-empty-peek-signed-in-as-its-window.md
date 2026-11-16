# 1995. New Peek opens an empty Peek signed in as its window

**Status:** Accepted on 2026-11-04.

## Context

A new window takes a Workspace of its own
([0079](0079-a-workspace-has-at-most-one-window.md)), so a page meant to be
looked at once, such as a video call next to a Workspace's window, ends up
filed in a Workspace. A Peek, the quick window, is a window that belongs to
no Workspace and is never restored, but only a link from another app opens
one.

## Decision

New Peek opens an empty Peek on the page a new tab shows, with the address
bar focused. Its key is Accel+Alt+N: Accel+N and Accel+Shift+N stay a new
window and a private window, and Arc gave Accel+Alt+N to its own window of
this kind. The File menu and the Launcher offer it.

Its page is in the cookie jar of the window it was opened from, so it is
signed in as that window's Workspace, isolated or not. A Peek opened from a
private window uses the shared jar, because a Peek is never private.
Moving a Peek's page into a Workspace whose jar is another loads it again
there, after the Peek says so, as a page from another app moving into an
isolated Workspace does.

A Peek opens where the Peek closed last was, at its size, when that place is
on the screen, so one the user keeps next to a window stays there.

## Consequences

New Peek works whatever Settings › Links says, because that setting chooses
where links from other apps open. A page from another app still opens in the
shared jar, since no window asked for it.
