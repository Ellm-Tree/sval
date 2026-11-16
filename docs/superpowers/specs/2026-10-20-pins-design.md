# Sval — Pins

**Status:** Built.
**Date:** 2026-10-20
**Author:** John Postlethwait
**Builds on:** `2026-10-16-home-favorites-design.md` (pins on the home page),
`2026-10-21-favorites-native-design.md` (the Favorites menu) and Peek.
**Decision:** 0137.

---

## 1. What this is

A row of site icons at the top of the panel, one per pin. A pin is a
Favorite marked "Pin". Its icon is its tab: clicking the icon shows the pin's
page, and that page never appears in the panel's tab list. The pin stays on
its own site, and you can always take it back to its saved page.

The same pins are the home page's tiles.

Sval then has three ways to keep a site:

- **Favorites:** links you keep, a folder tree in the Favorites menu. A
  favorite opens a new tab.
- **Pins:** a handful of sites you live in. Each is its own tab.
- **Tabs:** what you're doing now.

**Success looks like:** a user pins Gmail and Calendar. They click Gmail's
icon, read a message, and click a link in it; the link opens in Peek and
Gmail stays put. They move to a tab, come back to Gmail and find it where
they left it. When they want the inbox again, they hover the wide Gmail tile
and press its refresh button. In their Work workspace, a YouTube pin limited
to Home isn't there, and Gmail shows their work account.

## 2. Why

- Arc users miss this most. Arc's Favorites, an icon row of sites that are
  their own tabs and go back to their saved page, are the feature they name
  when they say why they stay or what they lost.
- Zen users ask for two things Zen doesn't do: pins that differ per
  workspace, and pins that are bookmarks so they sync, rename and export.
- Zen's several settings for when a pin snaps back disagree, and a pin can
  save a logout page as its address. Sval has one rule and no reset settings
  (§5).

## 3. Decisions and the reasons for them

| Decision | Reason |
|---|---|
| **A pin is a Favorite with a pin flag.** Pinning makes no new kind of thing; unpinning leaves the Favorite. | Decision 0137. Pins sync, rename, sit in folders and export because they are Favorites. |
| **A pin's icon is its tab.** Clicking selects the pin's page. The page never appears in the tab list. | Decision 0137. A pin that opened a new tab on each click would be a favorite. |
| **Coming back to a pin never resets it.** | Decision 0137. A reset on return would throw away a half-written email. |
| **Going back is deliberate:** a refresh button on the selected pin while it is off its saved page, and "Back to saved page" in its menu. A first click from another tab only selects the pin. | Decision 0137. The button shows before you press it, so a reset is never a surprise. |
| **Links to another site open in Peek.** ⌘-click opens a normal tab. It is a setting (decision 0126); off, links navigate the pin and the refresh button brings it back. | Decision 0137. The pin always shows its own site, so its icon always tells you what is behind it. |
| **Closing a pin, or Sval unloading it after a long idle, returns it to its saved address.** The icon stays. | Decision 0137. It is the only automatic reset. |
| **A pin shows in every workspace by default, and can be limited to some.** | Decision 0137. |
| **A pin's page uses the logins of the workspace it is open in.** | A pin is a tab in that workspace's window, so isolation already applies. Gmail in Work shows the work account. |
| **⌘1–9 select pins 1–9**, counting what shows in this workspace, in the row's order, with a folder as one slot. | Decision 0137. Pins have a fixed order you set, so a number always means the same site. Firefox's default counts tabs, whose order shifts. |
| **A pin in a folder behaves exactly like a pin in the row.** | Anything else invites confusion. |
| **The home page knows its workspace.** It shows that workspace's pins and takes the workspace's colour. | The tiles and the row are one list, so they must filter the same way. The frame is already tinted; the page under it was not. |
| **Delete removes the Favorite at once, with no dialog.** The Favorites menu's Undo brings it back. | Sval asks only when there is a choice to make. |
| **Unpinning an open pin turns its page into a normal tab** at the top of the tab list. | Unpinning should not throw a page away. |
| **The row shows at most 4 lines; past that the last slot is "+N".** The limit is a setting. | 30 pins would push the tabs off screen. Every default is a setting (decision 0126). |
| **Arc's Favorites and Zen's Essentials import as pins in every workspace. Arc's pinned tabs stay ordinary tabs.** | Decision 0137. Arc's pinned tabs are per-space named rows, often dozens in folders; Sval tabs already last until closed. |

### 3.1 Rejected approaches

- **Opening a new tab on each click.** That is a favorite. A pin would then
  have nothing to return to.
- **Resetting on a second click with no warning,** or on return. Both lose
  state by accident.
- **Zen's reset settings** (on startup, on unload, on return). They conflict,
  and its users disagree on them.
- **A separate pinned-tab kind,** as Zen and Firefox have. It duplicates
  Favorites and can't sync or export as bookmarks.
- **Folding Arc's pinned tabs into pins.** They become a wall of icons.

## 4. The pins row

- **Place:** in the panel under the workspace switcher, above New tab, then a
  hairline, then the tab list. Pins can be limited per workspace, so they sit
  under the workspace that decides which show.
- **Lines:** `P = max(2, floor((panelWidth − 16 + 4) / 44) − 2)` pins per
  line: 4 at 280px (the default), 8 at 480px. Lines fill by order alone, so
  selection never moves a pin to another line. A short last line keeps its
  empty columns.
- **The selected pin widens** within its own line to three shares; the
  others in that line share the rest. At 280px it is 126px and its
  neighbours 42px; tiles on other lines are 63px. It shows the pin's name,
  and " / Inbox" in muted ink while off its saved page. Only its own line
  changes. With a tab selected, no pin is wide.
- **"+N":** after the line limit (default 4, so 16 slots at 280px), the last
  slot becomes "+N" and opens a popover of the hidden pins. It looks selected
  when the selected pin is among them.
- **The 48px panel:** one column of small tiles, six slots, no widening.
  Names are in tooltips.
- **No pins:** no row and no hairline. Dragging a tab over that space shows a
  "Drop to pin" zone.
- **Names** of pins that aren't selected show in the tooltip.
- **The window title** keeps the workspace first, as every tab's does:
  "Work — Gmail / Inbox" while a pin is selected.

## 5. A pin's life

- **Selecting:** clicking a pin, or ⌘1–9, selects its page. A pin that
  isn't loaded loads its saved address. Selecting never navigates a loaded
  pin.
- **Within its site:** navigation stays in the pin. "Its site" is its saved
  address's site, as `siteOf` answers it (§14). Off the saved page, the tile shows a small dot when not
  selected, and the " / title" suffix when selected.
- **Off its site:** a link to another site opens in Peek, with a "From Gmail"
  chip. Peek's "Open as tab" puts the page where Sval puts new tabs.
  Redirects the pin's own page makes (a login bounce) stay in the pin; only
  a navigation the user starts from a link goes to Peek.
- **Back to the saved page:** the refresh button at the end of the wide tile,
  shown while the pin is off its saved page and the tile is hovered or
  focused. Its name is "Back to Gmail". A click on the rest of the wide tile
  does nothing. A fast double-click from another tab only selects: the
  button acts only if the pin was already selected when the click began.
  Keyboard: Right from the wide tile moves to the button; Enter presses it.
- **Saving a new address:** "Save current page as this pin" in the menu.
- **Closing:** ⌘W or the close action on a selected pin unloads it and
  returns it to its saved address. The icon stays. Selection moves as when a
  tab closes.
- **Idle:** when Firefox discards a pin's page under memory pressure, the
  same reset applies.
- **Per workspace:** a pin's page belongs to the pin and the workspace it
  is open in. Gmail in Work and Gmail in Home are two pages with two sets of
  logins. Switching a window to another workspace leaves the outgoing
  workspace's pins loaded as it leaves its tabs, and unloads them with its
  tabs once the workspace has been out of sight for three hours (§14),
  keeping where each was: switching back then reloads Gmail on Calendar,
  not on its saved page. A
  pin selected after every tab there is selected again on the way back, as
  the last tab looked at is. Only closing and a long idle reset.
- **The saved page** is the address a fresh load of the saved address
  reaches before the user first presses a key or a button in the page,
  redirects included, fragment included. That is what "off its saved page"
  compares against. The saved address itself changes only through "Save
  current page as this pin" or "Edit address…", never on its own, so a pin
  can't save a logout page.
- **Quitting:** a pin survives quitting, as a Favorite does. Its page is not
  restored mid-site: after a restart each pin starts at its saved address.
  A pin selected after every tab of a workspace is selected again when the
  workspace's window launches, at that address.
- **A pin at a local address** (`file:`, `about:` and the other schemes of
  [1372](../../decisions/1372-an-address-no-other-device-may-open-stays-in-this-devices-copy.md))
  is a pin on this device only, and its tooltip ends with "Only on this
  device". Another device's pin at such an address gets no tile, so ⌘1–9
  never reach it and its page never opens.

## 6. Pinned folders

- A pinned folder is one tile: a plate holding its first four icons.
- Clicking it opens a popover of its pins as square tiles. Each is a pin with
  every state in §4–5 except widening. Picking one selects it and closes the
  popover.
- While one of its pins is selected, the folder tile widens with that pin's
  name and refresh button, as a pin does.
- A tab dropped on a pinned folder tile is pinned into that folder.
- Every favorite in a pinned folder is a pin, in subfolders too. A subfolder
  shows as a folder tile inside the popover, and clicking it moves into it,
  with a back arrow, as the home page's folder panel does. The popover has
  no "Open all": its items are pins, which are selected one at a time.
- A pin's page is keyed by its Favorite. A favorite pinned on its own and
  also inside a pinned folder has one page, reached from both places.
- ⌘1–9 counts the folder as one slot and opens its popover.

## 7. Where a pin shows

- **Private windows and agent workspaces show no pins.** A private window
  has no row, no tiles and no ⌘1–9 for pins. "Show in" never lists an
  agent's workspace, so the user's signed-in pins never open where an agent
  acts.

- **Show in › Select all · Deselect all · one checkbox per workspace,** in
  the pin's menu. The submenu stays open while you tick.
- With every box ticked the pin is stored as "all workspaces", so it shows
  in workspaces created later.
- Closing the submenu with nothing ticked drops the change.
- The scope is synced state of the Favorite: `Lifecycle::pin_scope`, a
  sorted set of workspace ids beside `pinned` and `home_order` in the
  engine's favorites document. Reordering the row on one device and changing
  a scope on another at the same time is one lifecycle write each, so the
  later of the two wins.
- A pinned folder's scope applies to everything in it. Pins inside a folder
  have no scope of their own.
- Deleting a workspace removes it from every pin's scope. A pin left with no
  workspace becomes "all workspaces".

## 8. The menu

Native: **Back to saved page · Save current page as this pin ·** separator
**· Show in › ·** separator **· Rename… · Edit address… ·** separator **·
Unpin · Delete**

- The first two are disabled on the saved page.
- Delete removes the Favorite and its pin, with no dialog. The Favorites
  menu's Undo restores both.
- Unpin keeps the Favorite. An open page becomes a normal tab at the top of
  the tab list.
- The Favorites context menu has "Pin" and "Unpin", and a pinned favorite's
  context menu has "Show in ›" too. Its Undo covers pinning and scope. A favorite pinned from the
  Favorites menu leaves it for the row (§8.2).

### 8.1 Pinning a tab

- Dropping a tab on the row, or on a pinned folder tile, makes a Favorite of
  its current URL and title, pinned at the drop point. The Favorite goes at
  the end of the Favorites root, or into the folder it was dropped on. The
  tab leaves the tab list and becomes the pin's page in this workspace, as
  it was.
- "Pin" in the tab's context menu, in place of Firefox's "Pin Tab", does the
  same, with the pin added at the end of the row. Firefox's own pinned tabs
  are not used anywhere.

### 8.2 Pins and the Favorites menus

- The pins row is the only place a pin appears. The panel's Favorites menu
  and the menu bar's leave out every pinned favorite and folder, at every
  level, in every workspace, whatever its scope. A pinned folder is left out
  whole, with its contents. A favorite pinned on its own inside a folder
  that is not pinned is left out of that folder. A pin drawn in a menu of
  Favorites, which belong to no workspace, would raise a question of scope
  and need drag rules of its own.
- Pinning and unpinning never move the Favorite, so an unpinned favorite
  shows again where it was.
- Dragging and Move Up or Down within a folder step over the pins it does
  not draw, so an item lands between the two items it was dropped between.
- The "Use Favorite…" picker in Settings lists every favorite at its place,
  pins included: it picks an address for the home page, and a pinned site
  has nowhere else to be picked from.

## 9. The home page

- The home page asks its parent actor which workspace its tab is in, and
  redraws when that changes: the tab moves, the workspace's colour changes,
  or a pin's scope changes.
- It shows that workspace's pins, in the row's order. A tile click selects
  the pin, the same as the row. Dragging tiles reorders the one shared
  order.
- After a tile click selects a pin, the home tab closes if it has never shown
  another page: it was opened only to get there. A home tab with history
  stays.
- The home page's "Favorites" switch hides only the home tiles. The home
  page has no line limit; its tiles wrap.
- Its background takes the workspace's colour, meeting the frame without an
  edge (§12.5). Private windows show no pins.
- The starfield shows only in dark schemes.

## 10. Import

- **Arc's Favorites and Zen's Essentials** become pins in every workspace, in
  the source's order. The folders, the favorites and their pins are written
  as one batch of the favorites document, so a pin arrives with its favorite.
- **Arc's pinned tabs** stay ordinary tabs, pinned ones first (import spec
  §3).

## 11. Tests

- Pin a favorite from the Favorites menu; its icon appears in the row and its
  tile on the home page, in the same order.
- Click a pin: its page shows and the tab list doesn't change. Click a tab,
  then the pin: the page is where it was.
- Navigate within the site: the wide tile shows " / title". The refresh
  button returns to the saved address. A double-click from a tab does not
  reset.
- A link to another site opens in Peek; ⌘-click opens a tab; with the
  setting off, the link navigates the pin.
- Close a selected pin: the icon stays and the next click loads the saved
  address.
- Limit a pin to one workspace: it leaves the row, the home page and ⌘1–9 in
  another workspace.
- Two workspaces with isolation: one pin, two logins.
- ⌘1–9 select by row order, skipping hidden pins, a folder as one slot.
- A pinned folder's popover selects a pin, and the folder tile widens.
- Unpin an open pin: its page becomes a tab. Delete, then Undo.
- More pins than the line limit: "+N" opens the rest.
- The home page redraws when its tab moves to another workspace.
- Arc and Zen import: Favorites and Essentials arrive pinned; Arc's pinned
  tabs arrive as tabs.

## 12. Visual design

The values live in `sval-pins.css` (the row, tiles, folder popover and their
states), `home/home.css` (§12.5) and `sval-peek.css` (§12.6). The rules they
keep:

- Pin fills are the panel's own `--sval-pin-*` tokens. The selected line and
  drop indicator are `--accent`. Nothing in the row uses the workspace
  colour.
- The selected column widens within its line and animates; nothing animates
  under `prefers-reduced-motion`.

### 12.1 Tile fills

In `sval-pins.css`.

### 12.2 Row and tile

In `sval-pins.css`.

### 12.3 States

Each state in §4 to §6 has its look in `sval-pins.css`. The row is one
`toolbar` tab stop with roving focus. Arrows move between tiles, Enter or
Space selects, Down from the last line enters the tab list.

### 12.4 Folder

In `sval-pins.css`. While the popover is open, arrows move inside it; Escape
closes it and returns focus to the folder tile.

### 12.5 Home page

The home page's field is a radial gradient whose edge is exactly the frame
colour, so the page meets the frame without an edge, in every workspace
colour and in untinted windows. Ink stays neutral on every tint.

### 12.6 Peek from a pin

Peek from a pin carries a "From Gmail" chip at the start of its bar: the
pin's favicon, "From" muted and the pin's name. It is a label and takes no click.
The pin stays selected under the dim.

## 13. A pin's page in the window

A pin's page is a hidden tab of its window, marked with its Favorite's guid
(`SvalPinTab`), which the tab observer files no node for, as it files none
for a peek. A hidden tab can still be the selected one. `SvalPinPages` keys
each page by pin and workspace. The tree stays the one source of truth: a
pin's page is not a tree node, and nothing infers pin state from the tab
strip. A pin that stops showing here (unpinned, deleted or limited
elsewhere) closes its page; only Unpin in this window makes the page a tab.

The prefs are `browser.sval.pins.lines` (4) and `browser.sval.pins.peekLinks`
(true), both synced, in Settings › Workspaces › Pins and Settings › Links ›
Links in pages.

## 14. Links and workspace switches

- **A link leaves the pin** when its site differs from the saved address's.
  The click is taken as it reaches the top of the page, after the page's own
  listeners, so a link the page handles itself stays the page's; Gecko
  follows a link only after that (`Element::PostHandleEventForLinks`). Each
  document of a pin's page is told it is one as the parent creates it, so the
  rule holds from its first click.
- **A workspace switch discards the pages it leaves**, as it does tabs,
  keeping each one's place and history; a page holding typed text or a call
  stays loaded.
