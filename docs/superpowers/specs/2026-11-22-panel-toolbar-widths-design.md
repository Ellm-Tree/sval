# Sval — The toolbar in the Workspace panel at every width

**Status:** Decided.
**Date:** 2026-11-22
**Author:** John Postlethwait
**Builds on:** the Claude Design handoff `handoff/panel-toolbar/` (round 1,
`to-code.md` F1–F2), which sets the rows, the widths and the 48px column.

---

## 1. What this is

With Settings › Appearance › Toolbar set to In the Workspace panel, the
header's controls stand at the top of the Workspace panel and the records in
its footer. The panel's width is the person's to drag, from its narrowest to
75% of the window. This spec says how the controls lay out at any width, and
how the layout is checked.

A pill is drawn by one element. Every group of controls that reads as one
pill is one element holding its buttons, and layout moves whole pills. A pill
cannot split across rows, because nothing inside it wraps.

## 2. The sets

Each set is a toolbar area registered with `CustomizableUI`, so the widgets
keep their own code, their customization and their keyboard navigation. Each
area draws its own pill: background, border, rounded ends, padding.

| Set | Holds, in order | Leaves to | Never leaves |
|---|---|---|---|
| Window | window buttons (macOS), panel toggle | — | all |
| Navigation | Back, Forward, Reload/Stop, Home | » | Back, Forward, Reload/Stop |
| Address | Privacy and Security, the site's address, Launcher key | Launcher key: hidden | Privacy and Security, the site's address |
| Site controls | live devices, location, media, JavaScript, Remove, Snip, Colorshift, site menu | hidden, in the set's own order, since the site menu offers each of them | live devices, site menu |
| Page | Translate, Reader View, Favorite | » | — |
| Tools | Split (in a Split), pinned extensions, extensions button | pinned extensions: the Extensions panel; Split: » | extensions button |
| Records (footer) | Favorites, notices, Downloads, History | » | notices while one shows, Downloads while one runs |
| Private badge | the badge, in a private window | — | all |

A set declares, for each item, where it goes when the set runs out of room:
», the Extensions panel, or hidden. A hidden item is reached another way,
as the site menu reaches every site control, so it leaves no entry in ».
Each set also declares the order its items leave in.

» is one overflow button and list for the whole toolbar. A set that no
longer fits its row sends its items there one at a time, last in its order
first, and takes them back in reverse as the panel widens. The list keeps
the toolbar's order, and a folded item that has a dot puts the dot on » too.
Items bound for » leave in the header's overflow order: Split, History,
Downloads, Reader, Favorite, Translate, Home, then Favorites. » shows only
while it holds something; it stands before Tools in rows, and after the
site menu in the column.

## 3. The rows

The toolbar is a fixed stack of rows, top to bottom. Each row lays out its
sets side by side with a 6px gap. A set never moves to another row as the
panel narrows; it is given less width, and gives items up to fit it.

1. **Window row**, 44px: Window, then Navigation at the row's end while
   both fit whole.
2. **Navigation row**, once Navigation leaves the window row: Navigation,
   then Page.
3. **Address row**: Address, the row's full width.
4. **Site row**: Site controls, joined with Page while Page is not with
   Navigation, the divider between them.
5. **Tools row**: », then Tools. It shares the site row while all of them
   fit there whole.

A row too narrow for its sets takes room from them in turn, each down to
its narrowest: Tools, then Page, then Site controls; on the Navigation row,
Page, then Navigation. A set given less than its whole width sends items
out one at a time (§2), and one given no width sends out all it may and
takes no room.

On Windows and Linux the caption buttons take the window row's end, so
Navigation always takes a row of its own below it.

## 4. Widths

The panel's inner width is its width less 16px. Rows stand 11px from the
window's edge and 5px from the panel's page side, past which the page's
frame leaves 6px, so the rows stand as far from the window's edge as from
the page. The window row stays where the hidden panel's corner keeps it.

| Panel width | Layout |
|---|---|
| 248px and wider | As in §3. |
| Below 248px | Navigation leaves the window row for its own row under it, and Page joins it. The toggle ends the window row. |
| Below 240px | The Launcher key leaves the address. |
| Window row too narrow for both | The toggle wraps under the window buttons, each where the row starts them. |
| 192px | The narrowest panel in rows: a pill of six circles fills the inner width. The window row holds the window buttons and the toggle; Navigation and Page share the next row; the address is whole, without its key; site controls are one pill of six; Tools holds the extensions that fit and the Extensions button; New tab, New group and Favorites show their icons alone. |
| Any width | Each row's sets give up room as §3 says. Pinned extensions go to the Extensions panel, Split and Page's items to », site controls hide. |
| Too narrow for their labels | New tab, New group and Favorites show their icons alone. |
| The column | One vertical column of circles: the window buttons, the toggle; a vertical Navigation pill (Back, Forward, Reload/Stop); Privacy and Security as a circle of its own, then the site's icon as the address (a click opens the Launcher); the live cell, the site menu and »; the extensions button; in the footer, notices while one shows, Downloads while one runs, the sync circle and Feedback. Every item in the column, the footer's included, stands as far from the window's edge as from the page. The address is the Launcher's glass, which opens the Launcher with the field's text and its switch. Everything else is in » or hidden, as §2 declares. Popovers open beside the column, toward the page, their stem from the button's side. |

The column is the narrowest panel, 48px on every platform. On macOS the
window buttons stand stacked, close over minimize over zoom, at the
column's start. The window places each of its three standard buttons from a
rect and an orientation the chrome passes, and the titlebar's height covers
the whole stack. Apple's Human Interface Guidelines say nothing of the
buttons' orientation; they ask that the system's own buttons are used, which
these are. In rows the buttons stand in their usual row.

The whole panel turns to the column at once: the toolbar's column and the
panel's own 48px layout (`sval-panel.css`) are the same width. With the
toolbar in the panel, no width stands between 48px and 192px, the rows'
narrowest: a width between snaps to the column as the panel narrows and to
192px as it widens. A window whose sets at their narrowest need more than
192px takes that width as the rows' narrowest instead.

In rows, a set that no longer fits gives items up by its own order (§2):
Navigation gives up Home, then Forward, then Reload, keeping Back; the
column keeps Back, Forward and Reload.

## 5. How the layout is decided

- **Overflow within a set** is Firefox's `OverflowableToolbar`, one per set
  that can lose items. It already takes its overflow list, its button and
  the extensions' list from attributes on each toolbar, honours
  `overflowpriority` (`header-overflow.patch`), and lists what left in the
  row's order. It measures on a window resize and on an item's resize. A
  panel drag resizes neither, so a patch has it watch its own toolbar's size
  too.
- **The column and the width bands** are one function of the panel's width
  and each set's measured natural width. It returns which form each set
  takes: in the window row or its own, key shown or hidden, Site controls
  and Page joined or parted, column or rows. CSS draws each form from
  attributes on the toolbar. The function has no other inputs, so it is
  tested on its own at every width.
- **Measuring.** Each resize, and each change to a set's content (a widget
  added, removed, shown or hidden, an extension pinned), measures every set
  and calls the function. An item that has left a set for » keeps the width
  it had when it left. Applying a form is
  done outside the resize observer's delivery, since it changes the panel's
  height.
- **The column's folding** is the same overflow: a set in the column is
  one circle wide, so every item that can leave it does, and the items that
  never leave stay. » is the same list and button at every width.

## 6. While the panel is hidden

Unchanged from the handoff (F4): the corner holds the window buttons and the
toggle, the live chip rides beside them while a device is in use, a line
along the page's top shows loading, and a prompt slides the panel in.

## 7. How it is checked

A layout is done when all three pass, at every width below.

- **The function's tests** (xpcshell): every width from the narrowest to
  600px, with 0, 4 and 12 pinned extensions. At each: no set is split; every
  row's sets fit the inner width; every control is shown, in », in the
  Extensions panel, or hidden by its own rule in §2; the bands of §4 hold.
- **The rendered toolbar's tests** (browser-chrome): at 48, 72, 73, 120,
  191, 192, 200, 239, 240, 247, 248, 280, 400 and 600px, with the panel on the left and
  on the right. Rows stand as far from the window's edge as from the page.
  Each set's box is one pill tall in rows and one circle wide
  in the column, no box crosses the panel's edge or another box, and the
  toolbar matches the function's result. Each runs with the setting on when
  the window opens and with it turned on in an open window, and fails on any
  console error.
- **The contact sheet**: a script draws the whole window at the column's
  48px and at every 20px from 200px to 400px, beside each width where the
  layout changes, with the panel shown and hidden, into one image. It is read before any build is shown.
