# 0101. Closing a window deletes its workspace if nobody touched it

**Status:** Accepted on 2026-10-14.

## Context

A new window opened while every workspace already has a window gets a new,
nameless workspace
([0079](0079-a-workspace-has-at-most-one-window.md)). If closing that window
kept the workspace, an empty "Untitled workspace" would stay in the document,
which syncs it to every device. Each new window closed unused would add one
more.

Creating the workspace only once something is filed into it does not help: a
new window files its home tab within a second, so the workspace exists almost
at once anyway.

## Decision

Closing a window deletes the workspace it shows, and that workspace's tabs,
when the window created that workspace for itself and the workspace is
untouched. A workspace the user made with New workspace…, or one the window
was handed, is kept, however empty: the user asked for it. The window keeps
which workspace it created with its session, so a window the session brings
back after Sval stopped without closing it still deletes that workspace.

Untouched is the rule a joining device also uses to leave a workspace
behind: no name, colour or emoji, not isolated, no group, and no tab off the
browser's own pages. A tab on an `about:` page, such as the home page, a
blank page or Settings, does not count as using a workspace, however many
there are. A local file is a page the user opened, so it does. Setting a
colour, an emoji or isolation touches a workspace as much as naming it does.

The workspace is kept, whatever it holds, when another window shows it, or
when it is the document's last workspace, which "Delete workspace" also never
deletes. A private window's close writes nothing, and a popup's close deletes
nothing, because a popup shows its opener's workspace.

The window's last content is written before the workspace is judged, so a tab
that left the home page just before the close keeps its workspace. The
deletion is written with that last flush and syncs like any other.

## Consequences

A workspace the user named, coloured, gave an emoji, isolated, browsed in or
built anything in is never deleted by closing its window.
