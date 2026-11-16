# Sval — Split view: pages side by side in one window

**Status:** Built: `SvalSplits`, `sval-panel-splits.js`.
**Date:** 2026-10-18
**Author:** John Postlethwait

---

## 1. What this is

A split shows two to four tabs side by side in one window, with a splitter
between each two. The user reads documentation in one pane and works in the other, or
compares two pages without switching tabs.

Zen, Vivaldi and Arc all have it. Sval builds on Firefox ESR's own split
view, with `browser.tabs.splitView.enabled` at its upstream value, true
(`browser/app/profile/firefox.js`). Firefox's entry points in the tab strip
are unreachable, because Sval hides the strip (decision 0049), so Sval adds
its own in the panel (§6.3).

**Success looks like:** a user right-clicks a link and chooses "Open Link in
Split View". The page opens beside the current one, and Sval's panel shows the
two as one row. They quit and relaunch, and the split comes back. Their other
device shows the same split in the same workspace. An Arc or Zen user's
splits of up to four panes import as splits.

## 2. Hard rules

- **The tree is the one source of truth.** Split state lives in sval-core's
  tree and syncs with it. Nothing infers, caches or forks it. Sval's restore
  rebuilds splits from the tree, never from Firefox's SessionStore, as it
  restores tabs (decision 0050). A writer waits for or handles its own tree
  write.
- **Use what exists.** Sval builds on Firefox's split view:
  `gBrowser.addTabSplitView`, the `<tab-split-view-wrapper>` element and its
  splitter, the urlbar's `split-view-button` and `split-view-menu`, the
  `split-view-footer`, the link context menu's "Open Link in Split View", and
  the `about:opentabs` picker. There is no parallel implementation of panes,
  splitters or layout.
- **One atomic write for a multi-step tree change.** Creating, separating,
  moving a pane, moving or closing part of a split is one engine call
  (`applyBatch`, which lands every operation or none). Nothing is rolled back
  by hand, retried on a clock or swept later.
- **Every claim about Firefox's behaviour is read from its code.** §4
  records it. Code that says otherwise wins, and this spec is corrected.

## 3. Rules

| Rule | Reason |
|---|---|
| **Up to four panes, side by side.** No top/bottom or grid layout. | Firefox's `addTabSplitView` and `addTabs` take any number of tabs. What assumed two is a short list of layout and sizing code (§4.3), which Sval patches. Its panes, splitters and layout stay Firefox's. |
| **A split is one row in the panel, with Separate and Move Pane Left/Right actions.** | The panel is the only place a tab appears (decision 0049). |
| **Sval adds entry points to the panel:** a row context-menu item, Alt-click on a second tab, and a default keyboard shortcut. | Firefox's own tab-strip entry points cannot be reached in Sval (§4.2). |
| **Split state persists and syncs through Sval's tree.** | A split is part of how the user arranged a workspace, like a group. |
| **Import: an Arc or Zen split of two to four panes imports as one split** (§7). | Sval's split holds what those browsers' splits hold. |
| **A split is a node of its own kind, `split`, holding its tabs** (§5). | The split is one thing in the tree, as it is one row in the panel. It gives a pane waiting for a pick, and a split's name, a place to live. |
| **`browser.tabs.splitView.enabled` keeps its upstream value, true, unlocked.** | It is Firefox's own gate on its entry points (§4.2), so "Open Link in Split View" and the picker appear with no code. |
| **Split view has no switch in Settings.** Sval's own entry points do not read the pref and add no switch of their own. | A user who does not want splits does not make one. |
| **Firefox's `about:opentabs` picker stays.** | It is how Firefox lets the user choose the second pane, and the split node gives the waiting pane a place in the tree (§5.1). |
| **The panes' widths are stored on the split as percentages, one per pane, and sync.** | A share of the window carries across screens of any size. Firefox keeps panel widths in pixels and in memory only (`#storedPanelWidths`), so the tree holds them and Sval applies them (§6.2). |
| **The default shortcut is Control+Plus on macOS and Control+Shift+Plus on Windows and Linux, on Firefox's own `key_addTabSplitView`.** | It is Arc's key on a US layout, and on macOS it also works where Plus has its own key. On Windows and Linux it takes Ctrl+Shift+= from zoom in, as Arc did, and Ctrl+= still zooms (§8). |

## 4. What Firefox does, as read in ESR 153.5

### 4.1 The split itself

- `gBrowser.addTabSplitView(tabs, { id, insertBefore, trigger })`
  (`tabbrowser.js`) makes a `<tab-split-view-wrapper>`, inserts it in
  `tabContainer` and moves the tabs into it through `moveTabToSplitView`,
  which goes through `#handleTabMove` and so raises `TabMove`. It then
  dispatches `SplitViewCreated`. It does not read
  `browser.tabs.splitView.enabled`.
- `MozTabSplitViewWrapper.addTabs` (`tabsplitview.js`) stops at the first
  pinned tab, so a pinned tab cannot be split. Sval pins no Firefox tabs
  (`SvalRestore.sys.mjs`), so this never applies.
- The wrapper's `MutationObserver` dispatches `SplitViewTabChange` whenever
  its children change. When one tab is removed and one remains, it calls
  `unsplitTabs("tab_close")`. **Closing one pane separates the other.**
- `disconnectedCallback` dispatches `SplitViewRemoved` whenever the wrapper
  leaves the document. That includes a move, because moving a connected
  element disconnects and reconnects it. **`SplitViewRemoved` alone does not
  mean the user separated the split.**
- Selecting a tab in a split dispatches `TabSplitViewActivate` and shows its
  panels (`#activate`, `showSplitViewPanels`). Selecting a tab outside it
  dispatches `TabSplitViewDeactivate` (`#suspend`).
- `moveTabTo` moves the whole wrapper when it is asked to move one of its
  tabs. `#handleTabMove` moves both tabs when `shouldMoveAllTabsAtOnce` is
  set, which `reverseTabs` clears while it swaps them.
- `replaceTab(old, new)` removes `old` and adds `new` at its index. The
  `about:opentabs` picker uses it.
- `gBrowser.adoptTab` has no split handling. `adoptSplitView` moves a whole
  split to another window. Adopting one pane alone empties the wrapper by
  one, which separates the other.
- `gBrowser.hideTab` knows nothing of splits. It hides one tab, and refuses
  the selected tab and a tab sharing the camera, microphone or screen. The
  wrapper's `visible` is true only while every one of its tabs is visible.
- SessionStore records `splitViewId` per tab and `splitViews` per window.
  Sval reads none of it (decision 0050).

### 4.2 The entry points, and which reach the user in Sval

| Entry point | Gated on the pref | Reachable in Sval |
|---|---|---|
| Tab context menu: Add Split View, Separate, Reverse (`TabContextMenu.updateContextMenu`) | yes | no: it opens from the strip |
| Alt-click a second tab (`MozTabbrowserTab.on_click`) | yes | no: it is the strip's tab |
| Link context menu "Open Link in Split View" (`nsContextMenu.initOpenItems`, `openLinkInSplitView`) | yes | yes |
| `about:opentabs` picker (`opentabs-splitview.mjs`) | no | yes, as a pane |
| Urlbar `split-view-button` and `split-view-menu` (Separate, Reverse, Close both) | no | yes |
| `split-view-footer` in each pane | no | yes |
| `key_addTabSplitView`, `key_separateTabSplitView` (`browser-sets.inc.xhtml`) | no | yes, once bound. Both ship with no key, and `about:keyboard` lists them as unassigned. |

- `openLinkInSplitView` opens the link with the current tab's
  `userContextId`, so its pane is in the workspace's jar.
- `BrowserCommands.addTabSplitView` and the tab context menu's single-tab
  path open `about:opentabs` through `addTrustedTab` with no
  `userContextId`, so in an isolated workspace that pane starts in the
  default jar (§9.3).
- The picker lists `gBrowser.visibleTabs` of its own window that are not
  pinned and not already in a split. In Sval that is the shown workspace's
  tabs. With none to list, it loads the new-tab page instead.

### 4.3 What assumes two panes, which Sval patches

`addTabSplitView` and `MozTabSplitViewWrapper.addTabs` take any number of
tabs. These assume two:

- **One splitter, after the first panel.** `tabbox.js` makes a single
  `split-view-splitter` (`#splitViewSplitter`'s getter, with `resizebefore`
  `sibling`), and `setSplitViewActive` orders only `splitViewPanels[0]` and
  `[1]` and puts the splitter after the first.
- **Sizing the right panel.** `tabsplitview.js`'s `resetRightPanelWidth`
  clears `#storedPanelWidths` for `panels[1]` alone.
- **Reverse.** `reverseTabs` swaps the first two tabs and sets `#tabs` to
  those two, so with more panes it drops the rest from the wrapper's list.
- **Margins.** `content-area.css` widens the splitter's margin on the side
  of `.split-view-panel[column="0"]` or `[column="1"]` when that one is
  selected, and gives the two columns their own rules.

`split-view-four-panes.patch` makes one splitter after each panel but the
last, reverses every tab, keeps the wrapper's list following its children,
and gives each column the margin rule. Sval sizes each panel from the tree's
`shares` (§6.2). A patch that touches split code lists Firefox's tests for
that code (§10).

## 5. The tree

### 5.1 The model

sval-core has a node kind, `split` (`NodeKind::Split`, serialised `"split"`).
A split node sits in a workspace or a group, at the place the split's row
holds. Its children are the panes, as tab nodes, in their sibling order. The
first is the left pane.

- **A split holds tabs only, and at most four** on any local edit. The
  engine refuses anything else (§5.2).
- **A split has a name**, `content.name`, empty by default. The panel shows
  the name when it is set, and the pages' titles when it is empty. Import
  keeps a source split's name (§7).
- **A pane waiting for a pick** is an ordinary tab child loading
  `about:opentabs`. It syncs and restores like any tab. On another device it
  shows that device's picker, listing that window's tabs, which is what the
  picker always lists (§4.2). Picking a tab replaces it (§5.2).
- **A split holding one tab** is drawn and restored as that tab, an ordinary
  row with no split. A merge can leave one (§5.3), and so can a close or a
  drag out on a device whose write lost. Nothing removes the split node in
  the background. The next act the user takes on that tab removes it in the
  same batch (§5.2).
- **A split holding no tab** draws no row and restores nothing. It stays in
  the document until a user act removes it.
- **A split holding more than four tabs**, which only a merge produces
  (§5.3), is drawn and restored in chunks of up to four, in order. A single
  tab left over is an ordinary tab. Five tabs show as a split of four and a
  tab, six as a split of four and a split of two. The next split act on it
  (Separate, moving a pane, a pick, a close or a drag) writes those chunks
  as split nodes of their own, beside the first, in the same batch.
- **The panes' widths** are `content.shares`: one percentage per pane, in
  pane order, summing to 100. Absent means equal widths. A host write sets
  the whole list (§5.2). A list whose length is not the number of panes,
  which a merge or a change of panes can leave, is drawn as equal widths.
- One function in `SvalPanelModel.sys.mjs` answers "which panes does this
  split show". The panel and the restore both call it.

Moving a split is one placement fact on one node. Its tabs follow because
they are its children. Moving a pane left or right is a placement fact on
that tab. The two never contend, so a move of the split on one device and of
a pane on another both survive (§5.3).

The kind is additive (main spec §5.5).

### 5.2 Writes

Each act is one `applyBatch`. The engine operation that creates a split is
`addSplit` (`Op::AddSplit`, beside `AddGroup` in `wasm.rs`): `{ kind:
"addSplit", parent, name?, id, before?, after? }`. It adds an empty split
between `before` and `after`, as `addTab` places a tab, and the panes are
moved in after it. The widths are written by `setContent`, which carries the
whole content group, with `shares` beside `name`, `url` and `icon`
(`docs/host-contract.md` §3). Everything else uses operations that exist.

| Act | The one write |
|---|---|
| Split X with Y | `addSplit` at X's place in X's parent (`before` X), then `moveNode` X and then Y into it. |
| Add a pane | `moveNode` the tab into the split, after the last pane. |
| Separate | `removeKeepingChildren` on the split. Its tabs land at its place, in order. |
| Move a pane left or right | `moveNode` the pane within the split, to before its left neighbour or after its right one. |
| Move the split (drag, Move to group, Move to workspace) | `moveNode` the split. |
| Close one pane | `remove` the pane. If one tab is left, also `removeKeepingChildren` on the split. |
| Close all | `remove` the split, which takes its tabs with it. |
| Pick a tab in the picker | `remove` the picker's tab, then `moveNode` the chosen tab into the split at the picker's place. |
| Drag one pane out | `moveNode` the pane to where it was dropped. If one tab is left, also `removeKeepingChildren` on the split. |
| Rename the split | `rename` on the split. |
| Let go of a divider | `setContent` on the split, with its name and the whole `shares` list. |

An act that changes the panes leaves `shares` as it was, and the engine
refuses a list whose length is not the pane count. So the batch also writes
the new list, or `setContent` without one for equal widths, after the moves.
Any act on a split that holds one tab, or more than four, also brings it
back to shape in the same batch, as §5.1 says.

Structural validation stays on the local-edit path (decision 0020).
`tree::validate_parent` is the one check, and `tree::move_node` and every
add (`addSplit`, `addGroup`, `addTab`, `addFavorite`) call it. Beside an
absent parent and a tab as parent, which an add is refused for too, it
refuses:

- a node other than a tab put into a split (`only_tabs_in_a_split`);
- a fifth tab put into a split that holds four (`split_is_full`). A pane
  moved within its own split is not counted;
- a split put anywhere but a workspace or a group (`split_outside_a_place`).

`merge` validates nothing.

### 5.3 Merge, absence and repair

`merge` treats a split node as a node like a group. The absence
rule (decision 0014) judges it per node and fact group, and placement merges
by its own timestamp (decisions 0009, 0010).

**Repair** (`tree.rs`, read path only) handles the kind in three places:

- **`KnownPlaces` records splits as it records groups,** so a tab filed into
  a split another device deleted lands at the split's place (decision 0121).
  `place_for` accepts a split as the holder only when the orphan is a tab.
- **A node of a known kind other than a tab, under a split,** is lifted
  beside the split, as what is under a tab is lifted beside the tab
  (`lift_misfiled`). No build creates this shape, but a hand-edited file
  can deliver one, as with a tab as parent. A kind this build does not know
  stays where it is, since only its own build knows whether it belongs in a
  split. A favorite under a split is a break, as under a tab.
- **A split with no parent** is broken, as a parentless group is.
  `is_a_root` stays false for it.

A repaired node keeps the placement stamp of the write that won the merge
(decision 0121). The conflicts below depend on it: a repair stamped lower
would lose to a peer's older but sound placement, and the devices would
settle on different results by the order they synced in.

In the panel, `KNOWN_KINDS` holds `split`. `CONTAINER_KINDS` does not: a
split is never collapsed and is never a drop target. `descendantIds` walks
through any kind, so restore, close and the tab counts reach a split's tabs.

**Conflicts**, each settled by the existing rules:

- **A moves a pane while B moves the split into a group.** A wrote the
  pane's placement and B wrote the split's. Both survive.
- **A separates while B moves a pane.** A deleted the split and B never wrote it, so
  it stays deleted. Each tab's placement goes to the later writer. A tab whose
  winning parent is the deleted split lands at the split's place (decision
  0121). Two ordinary tabs are left, side by side where the split was.
- **A closes pane X of two while B, not yet having seen it, moves X.** B wrote X's
  placement after A last saw B, so X is news to A and comes back (decisions
  0014, 0017). A deleted the split, so it does not. X and Y end up as two
  ordinary tabs at the split's place.
- **A closes X of two and B did nothing to it.** X and the split are
  dropped everywhere, and Y is an ordinary tab.
- **Both devices replace the same pane.** A replaces X with W and B with V.
  The split holds both beside its other panes. A split of four becomes one
  of five, and §5.1's rule for more than four applies.
- **A splits X with Y while B splits X with Z.** X goes to the later writer's
  split. The other split holds one tab and is drawn as that tab (§5.1).
- **A deletes a group while B moves a split into it.** The split lands at the
  group's place with its tabs (decision 0121).

## 6. The browser

### 6.1 One direction for each kind of change

- **A user's act** goes through Firefox's own API: `addTabSplitView`,
  `unsplitTabs`, `reverseTabs`, `replaceTab`, `moveTabTo`. The window's
  `SvalTabs` observer then writes the result to the tree in one batch (§5.2),
  as it mirrors `TabMove` (`SvalTabs.handleEvent`). It reads the
  wrapper's state after the change, never `SplitViewRemoved` alone (§4.1).
- **A change Sval makes to match the tree** writes nothing. These are restore,
  a workspace switch, a reopen in another jar, a hand-over of kept tabs, and
  a pass bringing in another device's split. Each calls the same Firefox API,
  and the events it raises are Sval's own. `SvalTabs` tells its own
  removals from the user's (`#releasing`), and splits use that rule. A split
  Sval rebuilds passes a `TabMetricsContext` through to each `TabMove`
  (`split-view-four-panes.patch`), so it is told from one the user makes.
- **Wherever Sval puts a pane's tab into a window, it rebuilds the split the
  tree records** with `addTabSplitView`. That covers restore, showing a
  workspace, `#keepInJar`'s reopen and `adoptKept`. Any of those may have
  emptied the wrapper, and the tree has not changed, so the tree is what
  rebuilds it.
- The `TabMove` events Firefox raises while it builds or swaps a wrapper are
  part of the act the batch already wrote. They must not add a write of
  their own that reorders the tabs against `gBrowser` neighbours.

### 6.2 Restore and workspace switching

- Restore opens each tab, then calls `addTabSplitView` for each
  split the tree holds, with `insertBefore` the left pane. The panes stay
  lazy until the split is selected. Selecting it inserts every pane's browser
  (`showSplitViewPanels`).
- **The dividers.** When a split is shown, Sval sets each panel's width to
  its entry in `shares` of the wrapper's width, through the panel's `width`
  attribute that Firefox's splitter already uses, with one splitter between
  each two panels (§4.3). When the user lets go of a splitter, Sval writes
  the whole list (§5.2). Shares another device writes apply the next time
  the split is shown, or at once if it is on screen.
- A switch releases a split's tabs together. If either refuses discard
  or does not answer (`releaseTabsOutside`), all stay loaded and hidden, so
  the split comes back as one. A pane that is sharing the camera, microphone
  or screen stays shown, as any such tab does (`SvalFirefox.hideForWorkspace`).
- A workspace has at most one window (decision 0079), so a split's panes are
  always in one window. Moving a kept split to the window that shows its
  workspace rebuilds it there (§6.1).

### 6.3 The panel

**A split is one row.** The model emits one row for the split node, carrying
its name and each pane's id, name, icon and whether it is selected. It sits
where the split node sits, and the tab counts include every pane.
`sval-panel.css` owns its look. It meets these constraints:

- The row shows up to four panes in one row of the panel's normal width.
- Each pane is told apart from the others, is clickable on its own, and is
  shown in screen order, left to right.
- The pane being viewed is visible.
- Each pane's full title can be reached.

The rest of this section holds:

- **Clicking a pane selects that tab.** Firefox then activates the split.
- **Row context menu.** A tab row has "Split View" and a split row has
  "Separate", "Move Pane Left", "Move Pane Right", "Rename Split" and
  "Close All". Move Pane Left and Right act on the clicked pane and are
  hidden at the ends. "Close All" is "Close Both" when there are two. Rename Split sets
  the split's name, and clearing it shows the pages' titles again. Move Pane
  Left and Right also have keys, Alt+Left and Alt+Right. Rename, Move to group, Move to
  workspace and Close act on the clicked pane, except that a move moves the
  split. The menu is `_buildContextMenu`'s fixed set, toggled on
  `popupshowing`. "Split View" on one tab opens the picker as Firefox's
  `TabContextMenu.moveTabsToSplitView` does, so the user picks the other
  pane.
- **Alt-click a second tab** splits the selected tab with it, placed beside
  the selected tab. This matches `MozTabbrowserTab.on_click`. Both tabs are
  in the shown workspace, because that is all the panel draws. When the
  selected tab is in a split with fewer than four panes, the clicked tab
  joins it as the rightmost pane.
- **Firefox's split menu Reverse** reverses every pane (§4.3).
- **Drag.** Dragging a split row moves the split. A drop on a split row goes
  before or after it, never into it. Dragging one pane out takes it out of
  the split and moves that tab, in one write. A split left with one tab is
  separated in the same write.
- **ARIA.** The split row is a `treeitem` whose panes are child
  `treeitem`s at the next `aria-level`. It is always expanded and cannot be
  collapsed. Each of N panes reads "1 of N" to "N of N" (`aria-posinset`,
  `aria-setsize`), as Firefox labels split tabs (`updateSplitViewAriaLabel`).
  It is drawn as one visual row.
- **Keyboard.** Up and Down move between rows. Right and Left move between
  the panes of a split row. The existing row keys (Enter, F2, Delete,
  the context-menu key) act on the focused pane. Type-ahead matching either
  pane finds the row.

### 6.4 Entry points in the content area

The link context menu, the split button and menu, the footer and the picker
are Firefox's own (§4.2). Sval's header carries the split button under the id
of Firefox's urlbar button (`SvalHeader.sys.mjs`), since the header draws no
copy of the urlbar's. Two patches adjust the footer:
`split-view-pane-footer.patch` makes a click on an inactive pane's footer
activate the pane, names a pane waiting for a pick, and gives the footer's
menu a Close for its own pane; `split-view-footer-reconnect.patch` keeps a
footer following its tab after the footer is moved. Each user act through
them reaches the tree through §6.1.

## 7. Import

- **Arc** (`StorableSidebar.json`) stores a split as an item with
  `data.splitView` (`itemWidthFactors`, `layoutOrientation`,
  `focusItemID`, `customInfo`). Its panes are `childrenIds`, and each pane's
  `parentID` names the split. The fixture's own starter split has three panes
  and `title: null`. The import takes `item.title` as the name, where a folder's
  lives. No export at hand names a split, so this is unconfirmed.
- **Zen** keeps a split as a tab group with `splitView` (or a folder with
  `splitViewGroup`), its panes being the tabs whose `groupId` names it. Zen's
  `ZenViewSplitter.storeDataForSessionStore` stores `groupId`, `gridType`
  (`vsep`, `hsep`, `grid`), `layoutTree` and `tabs`, with `MAX_TABS = 4`. Zen
  makes split groups with an empty label, so a Zen split has no name.
  (Read from Zen's source on GitHub. No repo fixture holds a populated
  `splitViewData`.)
- **Two to four panes** become one split. The harvest shape in
  `SvalImportModel.sys.mjs` has `{ type: "split", name, shares, children:
  [tab, …] }`, and `planTree` emits `addSplit` and the tabs under it, as it
  emits a group. The split takes the source's name when it has one.
  Favorites stay flat: a split among them imports as its tabs.
- **Widths.** Arc's `itemWidthFactors` become `shares`, scaled to sum to
  100. Zen's sizes become `shares` for a `vsep` split only. A Zen `hsep` or
  `grid` split lands side by side with equal widths, because Sval has no
  top/bottom or grid layout. A Zen split's size data is read from its source
  (`ZenViewSplitter`), as no repo fixture holds one.
- **More than four panes**, which neither source is expected to hold (Zen's
  `MAX_TABS` is 4), become splits of up to four in order, and a single pane
  left over an ordinary tab, as §5.1 draws a split of more than four.
- **One pane**, which a source can hold after a close, imports as an
  ordinary tab.

## 8. The default shortcut

**Control+Plus on macOS, Control+Shift+Plus on Windows and Linux.**
Arc's help centre lists Add Split View as Control-Shift-Plus on both macOS and
Windows, and zoom in as Command-Plus on macOS and Control-Plus on Windows. The
key is `key="+"` on every platform.

- **macOS.** `modifiers="control"`, shown as ⌃+. Gecko matches Plus with
  Shift ignored (`WidgetKeyboardEvent::GetShortcutKeyCandidates`), as
  Firefox's ⌘+ zoom does, so a US layout presses Control+Shift+= as in Arc,
  and German and Spanish layouts, which have Plus on its own key, press
  Control with that key. Control+Shift+Plus would never match on those, since
  Shift with their Plus key types `*`. Firefox zooms with Cmd
  (`key_fullZoomEnlarge` uses `accel`), and no other `<key>` in the window
  answers Control with Plus or =.
- **Windows and Linux.** `modifiers="control,shift"`. Control is `accel`, and
  Gecko's key matching ignores Shift for a shifted character
  (`GlobalKeyListener.cpp`, `ignoreModifierState.mShift`), so Ctrl+Shift+=
  would zoom in on a US layout. The split key matches the press exactly, so it
  wins over `key_fullZoomEnlarge` and opens a split, as it did in Arc. Ctrl+=
  and the numpad + still zoom in.

`bindSplitViewKey` in `SvalWindow.sys.mjs` gives Firefox's
`key_addTabSplitView` its `key` and `modifiers` before the window's first
layout. The key runs `BrowserCommands.addTabSplitView`, which opens the
picker as the second pane. `CustomKeys` saves a key element's attributes as
its default at the window's load, so with Sval's attributes already on the
element, the keyboard shortcuts settings show Sval's key as the default and
reset to it. `key_separateTabSplitView` stays unassigned. Separate is in the
panel's menu, the split menu and the footer.

## 9. Workspaces, agents, private windows, isolation

### 9.1 Workspaces

A split's tabs share a parent, so they are always in one workspace. A
split cannot span workspaces, and moving one to another workspace moves
every pane. A pass that brings in another device's split, or takes one away,
rebuilds or separates it in the window that shows the workspace (decision
0055, §6.1).

### 9.2 Agents

No agent tool creates or reads a split. An agent's tabs stay tabs: `list_tabs`,
`close_tab` and the rest act on one tab, and an agent closing a pane is a pane
closed (§5.2). The user may split tabs in an agent's workspace while holding
control (decision 0107). A split tool for agents is out of scope.

### 9.3 Isolated workspaces

Both panes share the workspace's jar (isolated workspaces spec §2).
"Open Link in Split View" opens in the current tab's jar. The picker
opened by the shortcut or the single-tab menu item starts in the default
jar. `SvalTabs.#keepInJar` then reopens it in the workspace's jar and releases
the original, which empties the wrapper by one. The rebuild rule (§6.1) puts
the split back. Isolating a workspace, or ending its isolation, reopens every
tab the same way, and the same rule covers it.

### 9.4 Private windows

A private window's tree is a `SvalDocument` in `SvalPrivate.worker.mjs`
(decision 0074), with the same engine and operations. A private window
splits exactly as a normal one does and saves nothing. The picker in a
private window lists that window's tabs (`getTabsTargetForWindow`).

## 10. Tests

Each test asserts what the user sees, on Sval's real defaults. No test pushes
`browser.tabs.splitView.enabled` or stubs a split into place to reach an
assertion.

**Sval's browser tests**

- Choosing "Open Link in Split View" shows two panes side by side, and the
  panel shows one split row naming both pages.
- The panel's "Split View" item opens the picker beside the tab. Picking a
  tab gives one split row and no picker row.
- Alt-clicking a second row splits it with the selected tab.
- Control+Shift+= opens the picker beside the selected tab, and on Windows and Linux Ctrl+= still zooms in.
- Dragging a divider, then restarting, shows the same widths. A second
  window of a different width shows the same shares.
- A split of three and of four panes shows each pane side by side, with a
  divider between each two, and the panel row shows every pane in order.
- Separate gives a row per pane in the same places. Move Pane Left and
  Right move the pane on screen and in the row.
- Closing one pane of two leaves one ordinary row and one page filling the
  window. Closing one pane of three leaves a split of two.
- Dragging a split row into a group moves every pane. Dragging a pane out
  separates it.
- After a restart (`browser_sval_restore.js`'s path), the split is on screen
  as it was, with every pane in place and lazy until selected.
- Switching away and back brings the split back whole, including when one
  pane stayed loaded.
- In an isolated workspace, a split made through the picker ends up with
  every pane in the workspace's jar, still split.
- A split made in a private window writes nothing to the profile
  (`scripts/private-browsing-test.sh`'s check).
- A document holding a split, merged into a second engine, draws the split
  in the second window, as `docs/acceptance-two-devices.md` would by hand.
- Import: Arc's fixture split (three panes) becomes a split of three, with
  its width factors as shares. Two- and four-pane splits become splits of
  two and four. Zen's synthetic split folder becomes a split, with its sizes
  for `vsep` and equal widths for `hsep` and `grid`. A five-pane source
  becomes a split of four and a tab (`test_sval_import_arc.js`,
  `test_sval_import_zen.js`).

**sval-core**

- Convergence tests run sync for each case in §5.3, in every order, and
  assert both devices hold the same splits. The case of two devices
  replacing the same pane of a split of four leaves five tabs in it.
- A split round-trips through `toJson` and `loadJson`, name and shares
  included.
- `moveNode` and every add refuse each shape §5.2 lists, leaving the
  document unchanged, and a pane moves within a full split.
- `setContent` refuses shares on a node that is not a split, of the wrong
  length, not positive or not summing to 100. `rename` keeps them.
- Repair files a tab moved into a deleted split at the split's place, lifts
  a non-tab out of a split beside it, leaves an unknown kind in it, and
  repairs a parentless split. Every device computes the same result in any
  merge order.

**Mozilla's split view tests.** With the pref at its upstream value, these
run in Sval: `browser/components/tabbrowser/test/browser/tabs/browser_tab_splitview*.js`,
`dragdrop/browser_drag_splitview.js`, `dragdrop/browser_drag_multiselected_splitview.js`,
`dragdrop/browser_drop_link_splitview_unselected.js`,
`statuspanel/browser_show_statuspanel_splitview.js`, the sessionstore
`browser_splitview_*.js` files, and `base/content/test/contextMenu/browser_contextmenu.js`.

- `scripts/upstream-tests.txt` maps a Sval patch to the tests of the code it
  changes. A patch that touches split code lists the tests for that code
  under its name.
- Tests that click or drag in the strip fail because Sval collapses it. That
  is a removal on purpose, so they go in `upstream-test-known-failures.txt`
  with that reason. A split test that fails for any other reason is an issue.

## 11. Out of scope

- Top/bottom and grid layouts.
- An agent tool for splits.
- Firefox's tab-strip entry points, which stay unreachable with the strip.
