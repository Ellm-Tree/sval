# Sval — Pins apart from Favorites

**Status:** Proposed.
**Date:** 2026-11-12
**Author:** John Postlethwait
**Builds on:** `2026-10-20-pins-design.md` (pins), whose §4–§7 and §9
stand as written except where this spec says otherwise.
**Decision:** 0137.

---

## 1. What this is

Pins move out of Favorites into a collection of their own. A pin is a node
under the favorites document's pins root, beside the Favorites root. An
address can be a pin, a favorite, both or neither (decision 0137).

**Success looks like:** a user on their Gmail pin sees the favorite button
unlit. They click it, and Gmail is added to Favorites. They click it again,
and Gmail leaves Favorites while the pin stays in the row. They drag the
Calendar pin onto the Gmail pin and get a folder holding both.

## 2. Why

In the pins design, a pin is a Favorite with a pin flag. The Favorites menus
hide pins, so the favorite button is the only place a person meets a pin as
a Favorite. On a pin's page the button shows lit, and clicking it deletes the
Favorite and its pin.

## 3. Decisions and the reasons for them

| Decision | Reason |
|---|---|
| **Pins live under a root of their own in the favorites document.** | Decision 0137. Sync, merge, names, icons, folders and Undo stay shared with Favorites at no cost. |
| **The pins root's order is the row's order.** The tree order replaces the `home_order` field. | One order, kept by the tree's own moves. |
| **The favorite button, the Favorites menus and the extensions' bookmarks API read only the Favorites root.** | Decision 0137. A pin is not a favorite. |
| **"Pin" on a favorite copies it into the pins root.** The favorite stays where it is. | The two collections are independent. |
| **"Move to Favorites" on a pin or a pinned folder moves it into the Favorites root.** It replaces Unpin. | Outside the pins root, the Favorites root is the only place to keep the pin. |
| **Folders are made in the row.** | The Favorites menus don't show pins, so the pins row needs its own way to make folders. |

### 3.1 Rejected approaches

- **A pin as a flag on a Favorite.** Every Favorites control then acts on
  pins too (decision 0137).
- **A separate document for pins.** It needs its own sync, merge and Undo,
  which the favorites document already has.
- **The Favorites Menu or Other Favorites root** (`menu________`,
  `unfiled_____`) as the pins root. A bookmarks HTML file and the
  extensions' API give them meanings of their own.

## 4. The model

- **The pins root** has the guid `pins________`, fixed, so every device
  derives the same node id (favorites-native spec §16). The engine's
  `FAVORITE_ROOT_GUIDS` gains it.
- **A pin** is a favorite node under the pins root, at any depth. A folder
  there is a pinned folder (pins spec §6). A separator there is not drawn.
- **A pin's scope** stays `Lifecycle::pin_scope`. A pinned folder's scope
  applies to everything in it.
- **A pin's page** is keyed by the pin's guid.
- **`isFavorite(url)`, `favoritesWithUrl` and `removeUrl`** consider only
  the Favorites root. The pins row and the home page read only the pins root.

## 5. The pins row

Pins spec §4 stands. Added to it:

- **Drag a pin onto another pin** to make a folder holding both, named
  "Untitled folder", with its name ready to edit. Dropping on the middle of
  a tile makes a folder; dropping on its edge reorders.
- **Drag a pin onto a folder tile** to move it into the folder. Dragging a
  pin out of the popover onto the row moves it to the row.
- **A folder's tile, wide with one of its pins selected,** names the folder
  in a small caption over the pin's name, as a named split does.
- **A folder's popover grows from its tile** through a stem, as the header's
  popovers do, while the tile wears the popover's fill. Beside the 48px
  panel's column it opens to the side with no stem.
- **The row's context menu** has "New Folder…", which adds an empty folder
  at the end of the row.
- **A pin's menu** (pins spec §8) has "Move to Folder ›", listing the row's
  folders, after Show in ›. Its "Unpin" becomes "Move to Favorites".
- **A folder tile's menu:** Show in › · separator · Rename… · separator ·
  Move Contents to Row · Move to Favorites · Delete. Move Contents to Row
  moves the folder's contents to the row where the folder stood, then
  deletes the folder.

## 6. Moving between Pins and Favorites

- **Move to Favorites** moves the pin or folder to the end of the Favorites
  root and clears its scope. The pin's open page becomes a normal tab at the
  top of the tab list, as with Unpin (pins spec §8). Undo reverses the move.
- **Pin**, in the Favorites context menu, copies the favorite or folder into
  the pins root at the end of the row, with new guids. The menu offers no
  "Pin" for a favorite whose address a pin already has.
- **Dropping a tab on the row** makes a pin of it in the pins root, and no
  favorite (replaces pins spec §8.1). The tab becomes the pin's page, as in
  pins spec §8.1.
- **The favorite button** on a pin's page shows whether the page's address
  is a favorite. Clicking the button adds the address to Favorites or
  removes it. The pin is unchanged either way.
- **The Favorites menus** draw the Favorites root with nothing left out
  (replaces pins spec §8.2). `hidePins` and `pinnedGuids` go.
- **The "Use Favorite…" picker** in Settings lists the Favorites root and
  then the pins root, under a "Pins" heading.

## 7. Elsewhere

- **The address bar** lists pins and favorites as it does, each pin with its
  mark. Selecting a pin's result selects the pin.
- **Export** writes the pins root as a folder named "Pins" at the end of
  Favorites, so a pin exports as a bookmark.
- **Import** writes Arc's Favorites and Zen's Essentials into the pins root,
  in the source's order. Nothing else changes in import spec §3.
- **Delete** removes the pin or folder at once. Undo restores it.
- **The extensions' bookmarks API** shows no pins.

## 8. Moving a profile's pins

Sval runs a pass that moves pins into the pins root once at startup, after
the favorites document is ready, as one write of the document. Every device
runs it, and the moves sync.

- Each favorite or folder with `pinned` set moves into the pins root, at its
  place by `home_order`, keeping its guid. Its scope, name, icon and address
  are unchanged.
- A pinned folder moves whole, with its contents.
- A favorite pinned on its own inside a pinned folder stays in the folder.
  The row gets a copy with a new guid at the favorite's place by
  `home_order`, so neither tile is lost.
- The same write clears `pinned` and `home_order` on every moved node.
- With no node marked `pinned`, the pass does nothing. Two devices running
  it at once make the same moves to the same parent, which merge to one
  result.

## 9. Tests

- On a pin's page the favorite button is unlit. Clicking it adds a favorite;
  clicking it again removes the favorite and leaves the pin.
- Drag a pin onto another: a folder of both. Drag one out: back in the row.
  Move Contents to Row puts both back where the folder stood.
- Move to Favorites on an open pin: its page becomes a tab and the favorite
  is at the end of Favorites. Undo restores the pin.
- Pin on a favorite: a copy in the row, and the favorite still in its menu.
- The Favorites menu draws every favorite, a pin's address included.
- The migration pass, in the engine and in xpcshell, moves four cases into
  the pins root in row order. The cases are a pinned favorite, a pinned
  folder, a pin inside an unpinned folder, and a favorite pinned both on its
  own and inside a pinned folder. A second run changes nothing. Two replicas
  running it and merging agree.
- Export writes a "Pins" folder; Arc import writes pins into the pins root.
