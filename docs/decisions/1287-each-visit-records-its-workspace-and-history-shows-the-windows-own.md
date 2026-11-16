# 1287. Each visit records its workspace, and History shows the window's own

**Status:** Accepted on 2026-10-23.

## Context

A History sidebar that lists every workspace's pages mixed does not say which
workspace a page was visited in. Places stores no context with a visit
(`moz_historyvisits` in `toolkit/components/places/nsPlacesTables.h`), and
an isolated workspace's container tab writes to the same table. The synced
`visit` node of
[0109](0109-history-syncs-by-week-and-each-visit-belongs-to-its-device.md)
carries the device. The Downloads panel shows "This workspace" and "All
workspaces".

## Decision

- **A visit records the workspace it was made in, in its synced `visit`
  node** (`Visit::workspace`). Workspaces sync, so every device can scope
  another device's visits by the same id. A device-local table alone would
  leave another device's visits in no workspace there.
- **Places keeps the same fact on this device**, in `sval_visit_workspaces`
  in `places.sqlite`: one row per visit made in a workspace, deleted with
  its visit by a foreign key. It sits outside Places' schema versions, so no
  Mozilla migration meets it. The sidebar's queries read it in SQL, which a
  JSON file beside the profile could not serve.
- **Places writes the row as it writes the visit.** `History::VisitURI`
  asks the browser's window which workspace the browser is in, through the
  `sval-visit-workspace` notification, and inserts the row in the visit's own
  transaction. So a visit's workspace is exact for redirects, background
  tabs and one page open in two workspaces, and a view never sees the visit
  without it. No chrome API sees a visit with its browser: `page-visited`
  carries neither the browser nor the tab (`PlacesVisit` in
  `PlacesEvent.webidl`).
- **Which workspace a browser is in:** its tab's node's workspace. A tab no
  node describes yet, such as an open link peek, is in the workspace its
  window shows, so an Alt-click peek's visits take the tab's workspace. A
  quick window's page (a link from another app) is in none, and once moved
  into a workspace its later visits take that one; earlier ones keep none.
  An isolated workspace is a workspace like any other.
- **A private window records nothing**, as Places records no private visit.
- **A visit has a workspace or it has none.** An import's visit (below) and
  one another device made in no workspace have none. The sidebar names none for it.
- **A query names the workspace it lists** (`nsINavHistoryQuery.svalWorkspace`,
  carried in `place:` URIs as `svalWorkspace`). It lists a page when one of
  its visits is in that workspace or in none, and a time limit applies to
  that same visit. A day or site folder shows only when it holds such a page.
- **The History sidebar lists the history of the workspace its window
  shows**, with the pages of no workspace, in every view and in a search.
  "All workspaces" lists every page, with a Workspace column naming the
  workspace of each page's latest visit. Every view keeps its Visited column.
  A window that comes to show another workspace goes back to "This
  workspace". A private window lists all history with no switch and no
  Workspace column, as Firefox's does.
- **Visits whose workspace is deleted keep its id.** They show only under
  "All workspaces", labelled "Deleted workspace", as the Downloads panel
  labels such a download.
- **A visit stays in the workspace it was made in.** A tab moved to another
  workspace takes its later visits there; its earlier ones stay. A visit is a
  fact about a moment, and history is never rewritten.
- **A page shows by any one visit in scope.** Its Visited time, visit count
  and position are the page's own across workspaces, as Places keeps them
  per page. A per-workspace time would mean a second copy of Places' page
  statistics.
- **Imports:** a browser keeps one history store per profile, for all its
  windows. A profile's plain windows become one workspace (import spec §2),
  so that profile's visits take that workspace. A profile that also holds
  Arc or Zen Spaces, Safari Tab Groups, or Edge or Vivaldi Workspaces sends
  its history to none: no history an import reads names one of those per
  visit (Firefox's Chromium and Safari migrators, which Sval runs, and Sval's
  Firefox, Zen and Orion readers read a page, a time and a transition). Nor
  does a profile whose windows were not imported. Safari's one store
  (`~/Library/Safari/History.db`) goes to the workspace of its plain windows
  on the same terms.

## Consequences

- `History.cpp`, `Database.cpp`, `nsNavHistory.cpp`, `nsNavHistoryQuery.*`,
  `nsNavHistoryResult.cpp` and `nsINavHistoryService.idl` carry the patch
  `places-visit-workspaces.patch`, an input of the Gecko key.
- A query with a workspace refreshes on every visit (`QUERYUPDATE_COMPLEX`),
  since only the database knows a visit's workspace. A row written outside a
  visit, for another device's visit or an import's, is followed by
  `purge-caches`, which every Places view answers by reading again.
