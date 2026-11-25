# 2625. An extension can be kept to some Workspaces and off by default

**Status:** Accepted on 2026-11-24.
Specified in `docs/superpowers/specs/2026-11-24-extension-workspaces-design.md`.

## Context

A Workspace is a context, such as work or home, and some extensions belong
to one context. A developer tool has no business in a personal Workspace, and
a shopping extension has none in a work one. Some extensions are for a few
sites, and others are for every site but a few. The site switch of decision
1659 starts every extension on everywhere, so an extension meant for a few
sites needs a switch on every other site the user visits.

Gecko installs an extension for the whole profile, and every Workspace
shares the profile. Two windows can show two Workspaces at once (decision
0051), and both run the same extension. An extension can't be installed in
one Workspace and missing from another.

## Decision

- **Each extension is available in every Workspace, or in the Workspaces the
  user picks.** Outside them it reaches nothing in a tab, by the cut a site
  switch makes (decision 1659), and its button, its row in the extensions
  menu, its context menu items and its shortcuts leave the window. What it
  reaches outside tabs is untouched, as with the site switch: its background
  page runs, and its history, bookmarks, downloads, cookies and `tabs`
  permissions reach every Workspace.
- **A tab's Workspace is the one the tree files it in**, or the one its
  window shows. A Peek has none. An extension kept to some Workspaces is off
  in a tab with none, so a page loads without it until its Workspace is
  known.
- **A pinned extension's button shows in every Workspace it is available
  in, unless the user picks some**, with a "Show in" choice like a pin's
  (decision 0137). Unpinning clears the choice.
- **Each extension is on for all sites or off for all sites.** Sites
  switched the other way are its exceptions. A default-off extension is off
  on every site no switch decides.
- **All three choices sync**, one pref per extension. A Workspace that is
  gone counts for nothing, and a choice left with none is every Workspace.

## Consequences

Each tab's top-level browsing context carries its Workspace
(`SvalWorkspace`), a parent-only field the chrome sets as it sets
`svalAgentTab`. A policy's `blockedSites` names the Workspaces the extension
is available in and holds `*` for a default-off extension, so the policy
reaches every process the way the site switches do
(`extension-workspaces.patch`). An input of the Gecko key changes. Gecko
compiles once for it.
