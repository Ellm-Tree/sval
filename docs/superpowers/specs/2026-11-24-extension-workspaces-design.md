# Extensions per Workspace, pins per Workspace, and a default for all sites

**Status:** Built. Decision 2625.
**Date:** 2026-11-24
**Author:** John Postlethwait
**Builds on:** decision 1659 (an extension can be turned off on a site),
decision 1980 (a site rule can cover one host), decision 0137 (pins and their
"Show in"), decision 0051 (a window shows one Workspace),
`2026-10-31-extension-controls-design.md` Part 2.

## Why

A Workspace is a context: work, home, a client. Some extensions belong to one
context. React Developer Tools is for the Work Workspace, and a shopping
extension has no business reading work tabs. Some extensions are for a few
sites and nothing else, while others, like a password manager, are for every
site but a few. Sval's site switch (decision 1659) starts every extension on
everywhere, so the first kind needs a switch on every site the user visits.

## 1. Available in

1. Each extension has an "Available in" scope: every Workspace (the default),
   or the Workspaces the user ticks. The list offers the user's own
   Workspaces, in the switcher's order, as a pin's "Show in" does. An agent's
   Workspace is never offered.
2. An extension is unavailable in a tab whose Workspace is outside its scope.
   There it reaches nothing, by the same cut as a site switch that is off
   (decision 1659): no content script in any frame, no request in webRequest,
   filterResponseData or declarativeNetRequest, no activeTab grant, no
   capture, no tab URL through host permission, no webNavigation event, no
   find, no page data in `menus.onShown`.
3. A tab's Workspace is the one the tree files it in (`homeOf`), or for a tab
   the tree does not hold yet, the one its window shows. A Peek shows no
   Workspace, and a tab whose Workspace is not known yet has none. An
   extension with a scope is unavailable in a tab with no Workspace, so a
   page loads with it absent until its Workspace is known.
4. Sval tells Gecko each tab's Workspace through a parent-only
   `BrowsingContext` field, `SvalWorkspace`, set on the tab's top-level
   context as `svalAgentTab` is (`SvalAgentTabRegistry`), and carried across a
   replacement of the context. A policy's `blockedSites` carries an entry
   `%<workspace id>` for each Workspace the extension is available in, and
   none for every Workspace. Where it carries one, Gecko refuses the
   extension in a tab whose top-level context's `SvalWorkspace` has no entry,
   wherever it checks the top-level host (`extension-workspaces.patch`). The
   JS checks of `extension-blocked-sites-js.patch` do the same through the
   tab's `svalBlocked` (`extension-workspaces-js.patch`). A tab moved to
   another Workspace keeps what the extension put on its page until the page
   loads again.
5. In a window whose Workspace is outside an extension's scope, the extension
   leaves the extensions menu and the toolbar, it puts no item in the page's
   or a tab's context menu, and its keyboard shortcuts do nothing.
6. What an extension reaches outside tabs is untouched, as with the site
   switch: its background page runs, and permissions not tied to a page
   (`history`, `bookmarks`, `downloads`, `cookies` of any site, the `tabs`
   permission's addresses) reach every Workspace. Settings says so where the
   scope is chosen.
7. Changing the scope reloads the tabs it changes, so scripts that must go
   go and scripts that may now run run.
8. The scope is one synced pref per extension,
   `browser.sval.extensions.workspaces.<id>`, a JSON list of Workspace ids.
   No pref is every Workspace. A Workspace that is gone counts for nothing,
   and a scope left with none is every Workspace, as a pin's is
   (`showsIn`). An id whose extension is not installed keeps its pref.
9. The scope is chosen on the extension's page in Settings, as a checklist
   under "Available in".

## 2. Pins per Workspace

1. A pinned extension's button shows in every Workspace the extension is
   available in, unless the user limits it to some of them.
2. The extension's context menu, on its toolbar button and its row in the
   extensions menu, has "Show in" while the extension is pinned: Select all,
   Deselect all, and a checkbox per Workspace the extension is available in,
   as a pin's "Show in" (`SvalPinsRow.fillShowIn`). Every box ticked is every
   Workspace. None ticked drops the change.
3. Pin and Unpin keep their meaning: Pin puts the button on the toolbar of
   every Workspace in its "Show in", and Unpin takes it off everywhere and
   clears the scope.
4. In a window whose Workspace is outside the pin's scope, the button is
   hidden, and the extension's row in the extensions menu shows it as not
   pinned there. Pressing its pin there adds the window's Workspace to the
   scope.
5. The scope is one synced pref per extension,
   `browser.sval.extensions.pinWorkspaces.<id>`, read as §1.8 reads its
   scope. The toolbar placement itself stays CustomizableUI's.

## 3. A default for all sites

1. Each extension is "On for all sites", the default, or "Off for all
   sites". The site switches are exceptions to it: on a default-off
   extension, a site switched on.
2. The default is one synced pref per extension,
   `browser.sval.extensions.siteDefault.<id>`, holding `"off"`. No pref is
   on.
3. A name with no switch of its own and no name above it with one takes the
   default (`SvalExtensionSites.isOff`, `inheritedOff`). The switches keep
   their pref and their format, so a site switched on under a default-off
   extension holds `~id`.
4. A default-off extension's policy holds the entry `*`, which Gecko reads as
   a name above every host (`SvalHostInSites`). A page with no host, such as
   a `file:` page, is never blocked by it.
5. Changing the default drops every switch of the extension's that the new
   default makes redundant, from the broadest name down, and reloads the
   tabs whose answer changed.
6. The extension's page in Settings shows the default as a choice at the top
   of its sites card. The card lists the exceptions: "Sites where this
   extension is off" under the on default, "Sites where this extension is
   on" under the off default, with an entry to add one.
7. The extensions menu's switch, the site's page and the site menu answer by
   `isOff`, so they show the default where a site has no switch.

## Tests

- xpcshell: the scope and default prefs read, write and sync
  (`SYNCED_BRANCHES`); `blockedSitesFor` carries `*` and `%` entries;
  redundant switches go when the default changes.
- browser-chrome: a content script of a test extension runs in a tab of a
  Workspace in its scope and not in one outside it, and moves with a tab
  moved between them; a default-off extension runs on a site switched on and
  nowhere else; a pin scoped to one Workspace shows in its window and not in
  another's; the extensions menu leaves out an unavailable extension.
