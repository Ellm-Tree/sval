# Sval — Favorites on the home page

**Status:** Built.
**Date:** 2026-10-16
**Author:** John Postlethwait
**Builds on:** `2026-10-21-favorites-native-design.md` (the Favorites
context menu, §3, §15; the favorites document, §16), `2026-10-20-pins-design.md`
(a pin is the same state, shown in the panel too).

---

## 1. What this is

A row of site tiles under the home page's search field, holding the favorites
and folders the user pinned. It looks like the tiles Firefox's new tab
shows under its search box. The user pins from the Favorites menu ("Pin",
pins spec) and turns the whole row on or off from the home page itself. A
pin shows on this device and on every device sharing the folder. A device
that shares no folder can pin too, because the favorites document exists
either way (favorites-native spec §16).

## 2. Rules

- **Pins are made from the Favorites context menu**, the one place a
  favorite is managed (favorites-native spec §15.1): "Pin" on an unpinned
  favorite or folder, "Unpin" on a pinned one.
- **Favorites and folders can both be pinned.** A separator, the Favorites
  root and a bookmarklet cannot. A bookmarklet acts on the selected tab's
  page, which on the home page is the home page itself.
- **A pin is state of the favorite, and syncs with it.** Deleting a favorite
  or folder removes its tile on every device. A pin stored apart from its
  favorite would drift as soon as the favorite is edited.
- **Pins have their own order, separate from the folder tree.** A new pin
  goes at the end of the row. Dragging a tile on the home page reorders the
  row. Moving a favorite between folders never moves its tile.
- **The row wraps onto more rows, centred under the search field. There is
  no cap**, so nothing pinned is ever hidden.
- **A folder tile opens a panel below the row** showing the folder's
  contents as smaller tiles (§4), which keeps the user on the home page.
- **Right-clicking a tile opens the Favorites context menu** (favorites-native
  spec §15.2) in place of the page's. On a tile of the row it adds Move Left
  and Move Right, so a pointer that cannot drag can reorder.
- **The row has an on/off switch on the home page itself**, at the page's
  bottom corner, labelled "Favorites". It is on by default and is also a
  setting in Settings.
- **Turning the row off hides it and keeps every pin.**
- **The switch is a synced setting**, as Firefox Sync syncs
  `browser.newtabpage.activity-stream.feeds.topsites`.
- **Private windows show no row.** `about:privatebrowsing` stays as it is.
- **With the switch on and nothing pinned, the row shows one quiet line**
  saying where pins come from, without a button that pins for the user.

## 3. The row

- Sits under the search field in `home.html`, inside `main`, below the
  suggestions list. The suggestions list draws over the row while it is open.
- A **favorite tile** shows the site's icon through `page-icon:`, which the
  page's CSP already allows, and the favorite's name below it, truncated to
  one line. A favorite with no icon gets a letter tile.
- A **folder tile** shows up to four of its favorites' icons in a 2×2 grid,
  with the folder's name below it.
- **Clicking a favorite tile** opens it through `SvalFavorites.open`, the
  Favorites menu's path, so `browser.tabs.loadBookmarksInTabs` applies. By
  default that is this tab. A middle-click or Cmd/Ctrl-click opens a new tab,
  as a link would.
- **Reordering:** drag a tile within the row. The keyboard can reorder too:
  with a tile focused, Ctrl+Shift+Left and Ctrl+Shift+Right move it, and the
  move is announced ("Moved to position 4 of 12"). Alt+arrows would take the
  browser's Back and Forward. The new order syncs.
- **Filing:** dropping a favorite tile on the middle half of a folder tile
  moves the favorite into that folder, at its end, as a `PlacesTransactions`
  move the Favorites menu's Undo reverses. Its tile leaves the row, because
  the folder tile now reaches it. A folder dropped on a folder moves the same way. A
  folder is never dropped into itself or a folder inside it.
- **Keyboard and assistive technology:** the row is a list of links. Tab
  reaches the row, and the arrow keys move between tiles. A folder tile is a
  button with `aria-expanded`.
- The row updates live while the page is open: a pin, unpin, rename, icon
  change or delete on any device shows without reloading the tab.

## 4. A folder tile's panel

- Clicking a folder tile opens a panel below the row's last line, with a
  caret pointing at the folder tile. It is one
  panel at a time, and it pushes nothing else on the page. A panel that
  opens past the bottom of the window scrolls the page to bring it into view.
- The panel's header shows the folder's name and an **Open all** button,
  disabled when the folder has no favorites. Open all opens the folder's favorites in new tabs, with the same rule as the
  Favorites menu's Open All (`favoritesIn` in `SvalFavoritesMenu`): direct
  children only, no bookmarklets.
- The body shows the folder's favorites and subfolders as smaller tiles, in
  folder order.
- Clicking a subfolder moves into it inside the same panel. A back arrow in
  the header returns to the parent, up to the pinned folder.
- Escape, a click outside, another folder tile, typing in the search field,
  or clicking the folder tile again closes the
  panel. Focus returns to the folder tile.
- An empty folder's panel says "This folder is empty."

## 5. Pinning from the Favorites menu

- `SvalFavoritesMenu.attach` has the item `pinHome`, after "Open All". Its
  label is "Pin" or "Unpin" for the target, set in `_showing`. It is hidden
  for separators, bookmarklets and the root.
- Pinning is undoable from the menu's Undo item, like every other change
  there.

## 6. Sync

- Each favorite and folder has a pinned flag and a row position in the
  engine's lifecycle group, synced with the favorite. Pinning writes only
  the lifecycle group, so pinning on one device and renaming on another
  both survive.
- Deleting a favorite or folder deletes its pin.

The on/off switch is `browser.sval.home.favorites`, in
`SvalSettingsRegistry.SYNCED_PREFS`.

## 7. How the page gets its data

`home.js` is unprivileged and talks to the parent through a window actor, as
the search field does through `SvalHomeSearch`. The row has its own actor,
`SvalHomeFavorites`, registered from `SvalHomePage` with the same `matches`
and `remoteTypes`. The parent sends the row's pins, each with its name, URL
or folder contents, and icon, and sends a new list on every change. The
child sends opens, Open All, the context menu's position, reorders, filings
and the switch.

## 8. Settings

The switch appears in Settings › Home as "Show Favorites on the home page".

## 9. Tests

- Browser test: pin a favorite and a folder from the context menu, open a new
  tab, and see both tiles in order.
- Unpin from a tile's context menu.
- The folder panel opens, moves into a subfolder and back, Open All opens the
  right tabs, and Escape returns focus.
- The switch hides and shows the row, and the setting matches it.
- A private window shows no row.
- Reorder by drag and by keyboard.

## 10. Out of scope

- Tiles that are not favorites, such as top sites, history or suggestions.
- Pinning from anywhere other than the Favorites menu, such as the header's
  favorite button or the address bar.

## 11. Visual design

The values, the row's own tokens among them, are in `home/home.css`. The rules a change must keep:

- The row sits below the search field, no wider than the field, and wraps
  with its last line centred. With the row on, the search lockup is
  anchored where the centred layout puts it with the row off, so the field
  never moves as pins change.
- A tile is a well holding the favicon, or for a folder a 2 × 2 grid of its
  first four favorites' icons (depth-first through subfolders), with a
  one-line label. A favorite with no icon shows the first letter of its
  title, else of its host.
- The folder panel is positioned absolutely below the row with a caret on
  its folder tile, so it shifts nothing.
- The row is a `<ul aria-label="Favorites">`. A favorite is a real
  `<a href>`, so middle-click works. A folder tile is a
  `<button aria-expanded aria-controls="fav-panel">`. The row is one tab
  stop (roving tabindex): Left and Right move, Up and Down move by visual
  line, Home and End. Enter on a folder opens it, Tab enters the panel, and
  Escape closes it and returns focus to the folder.
- The suggestions list draws over the panel, which draws over the row.
- Motion stops under `prefers-reduced-motion`. In forced colours, wells get
  a `ButtonText` border, focus and the drop bar use `Highlight`, and shadows
  are off.
- In light, muted home ink is the body text colour, because the muted text
  colour is about 3.5:1 on the light field.
