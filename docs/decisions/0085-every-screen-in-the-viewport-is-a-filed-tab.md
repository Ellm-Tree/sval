# 0085. Every screen in the viewport is a filed tab

**Status:** Accepted on 2026-10-08.

## Context

Sval has no tab strip. The panel is the only place a tab can be seen, selected
or closed, so a tab that has no node draws no row and the user cannot reach or
close it. A screen in the viewport with no row in its workspace is one the user
has no way back to.

## Decision

Every tab showing something is filed in its workspace like any other tab:
web pages, error pages, the home page, settings, `about:addons`,
`about:downloads`, `about:config`, and an `about:blank` the user opened. A tab
is left unfiled only while it is a bare `about:blank` with no history that Sval
or the window opened, which covers three internal cases:

- a new tab whose first load has not committed yet, because `TabOpen` fires
  before the load starts;
- the window's startup tab, which restore replaces with the workspace's own
  tabs once it has any;
- an agent window's keeper, the blank page that keeps the window open when the
  agent has no tab, which would otherwise be a tab in the agent's workspace that
  the agent never opened.

Opening settings from the panel brings forward a settings tab already open in
the window, which holds only the shown workspace's tabs, at the category asked
for. It opens a new tab, filed by its `TabOpen`, only when there is none. A
workspace switch releases a settings tab like any other, although Firefox's
discard refuses parent-process pages, because such a page holds no content
process to release.

## Consequences

A settings tab is a row in its workspace, syncs to other devices, and is
restored on launch like any tab. The user closes it like any tab. Two devices
that each open settings in one workspace before syncing get two settings rows,
the same cosmetic duplicate as two home tabs before a sync. Nothing in the
document identifies Sval's own pages, so no rule outside `SvalTabs` has to
stay in step with the settings address.
