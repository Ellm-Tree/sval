# 0050. Tabs restore from the tree

**Status:** Accepted on 2026-10-25.

## Context

Session restore and Sval's tree could each claim to be the record of what was
open. The tree is the record, so what it says a tab shows is what every
device brings back, and a wrong address in it is a page lost everywhere.

With Firefox's session restore off, a launch brings back one window showing
the first workspace, whatever windows the user quit with. Firefox's session
file already holds each window and the workspace it showed.

## Decision

Tabs restore from Sval's tree on every launch, crash or not, with prefs alone
and no patch.

Firefox's session restore brings back the windows: every launch resumes the
last session (`browser.startup.page` 3), so each window returns with its
place, its size, its stacking and the workspace it showed. The tabs the
session brings back with them are held to the tree. A tab whose node is in
the window's workspace stays, pointed at the node's address if it has not
loaded yet. A node with no tab gets one. A tab whose node is gone closes, and
one whose node is in another workspace goes as a switch lets it go.

A tab node's content, its url and name, is written in exactly two places:

1. The acts Sval files for the user: open, close, move, rename and the rest.
   An open writes the address the tab was opened at.
2. A page the tab commits: a top-level location change Firefox reports once
   it has committed a new document, an error page or a same-document change
   of address, with the title that page then sets.

Nothing else writes a tab's address. Sval never reads back what a tab is
showing on any other event, and never infers it from restoring state or
blankness. A load that is refused, cancelled or still restoring, a discard, a
blank placeholder and a hidden page commit nothing, so they write nothing.

## Consequences

A tab the session restores keeps its back and forward history while its
address matches its node.

A tab comes back at the last page it committed. A tab left on a blank page by
a load that never committed keeps its address, and the next restore loads the
page again. A reload commits the address the node holds, so it writes nothing
until the page's title changes.
