# 0137. A pin is its own tab, kept apart from Favorites

**Status:** Accepted on 2026-10-20. Specified in 2026-11-12-pins-root-design.md,
§3.

## Context

Arc users miss Arc's Favorites: an icon row of sites, each its own tab, that
go back to their saved page. Zen users ask for pins per workspace and for
pins that are bookmarks, and Zen's several reset settings for pins conflict.
Sval's Favorites are its synced bookmarks, and a favorite opens a new tab.

## Decision

- A pin is a node of the favorites document under a root of its own, the
  pins root, beside the Favorites root.
- Pins and Favorites are separate collections. An address can be a pin, a
  favorite, both or neither. A change to a pin never touches a favorite, and
  a change to a favorite never touches a pin.
- The pins root holds pins and folders of pins. Its order is the pins row's
  order, and the home page's tiles show the same list.
- A pin's icon is its tab. Clicking it shows the pin's page, which never
  appears in the tab list. A favorite opens a new tab.
- A pin stays on its saved address's site: a link to another site opens in a
  Quick Peek. Another host of the same site, such as `www.` beside `app.`, is
  the pin's. Returning to a pin never resets it. Going back to the saved page
  is a button the user presses. Closing or an idle unload resets it.
- A pin shows in every Workspace unless the user limits it to some
  Workspaces. The scope syncs with the pin.
- ⌘1–9 (Ctrl+1–9 on Windows, Alt+1–9 on Linux) select pins in the row's
  order.
- Arc's Favorites and Zen's Essentials import as pins. Arc's pinned tabs
  import as ordinary tabs.

## Consequences

- Pins share sync, merge, renaming, folders and Undo with Favorites, because
  pins and favorites live in the same document.
- The favorite button, the Favorites menus and the extensions' bookmarks API
  read only the Favorites root. A pin's page shows the button unlit until its
  address is also a favorite.
- "Pin" on a favorite copies it into the pins root, and "Move to Favorites"
  on a pin moves it into the Favorites root.
- There is no separate pinned-tab kind. Pins give the tree's `pinned`
  lifecycle field (0024) no UI.
- Firefox's ⌘1–9 tab selection is replaced.
- A pin's page lives in a window without being a tree node.

A pin as a flag on a Favorite is rejected: the favorite button and every
other Favorites control then act on pins too, so taking a page out of
Favorites deletes its pin.
