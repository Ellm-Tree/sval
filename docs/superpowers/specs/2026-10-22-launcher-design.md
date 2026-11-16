# Sval — Launcher

**Status:** Built: `SvalLauncher` and the `SvalLauncher*` modules.
**Date:** 2026-10-22
**Author:** John Postlethwait
**Builds on:** the address bar (Firefox's urlbar, as Sval styles it), the home
page's search field (`SvalHomeSearchParent`, decision 0098), pins
(`2026-10-20-pins-design.md`), split view (`2026-10-18-split-view-design.md`),
private windows (`2026-10-07-private-windows-design.md`) and Sval's shortcuts
(`SvalShortcuts.sys.mjs`).

---

## 1. What this is

The Launcher is the address bar, grown into one place to go anywhere and do
anything. ⌘L (Ctrl+L on Windows and Linux) floats it in the middle of the
window with the current address selected. Typing finds open tabs in every
workspace, pins and Favorites, Sval's commands, history and the web. Enter
takes you there: to the tab that is already open, to the workspace it lives
in, or to the page in this tab.

It is not a second search box. It is Firefox's urlbar, its view and its
providers, with Sval's providers added for what Firefox cannot know, Sval's
sections and Sval's placement (§6).

**Success looks like:** a user in their Work workspace presses ⌘L, types
"ca" and presses Enter. Their Calendar tab, open in the Home workspace, comes
up, and the window has switched to Home. They press ⌘L again, type "new
wor", and Enter runs New workspace. They press ⌘L, type a URL and press
Shift+Enter: it opens in a new tab and the current page stays put. They
never reach for the mouse, and a screen reader announces every row as they
arrow through it.

## 2. Why

Arc users valued its command bar above all for switching tabs: two letters of
an open tab and Enter. They disliked its hidden address, a bar nothing
pointed to, and ⌘T no longer opening a new tab. Chrome's and Firefox's
@tabs, @history and @bookmarks go little used because hardly anyone finds
them. Vivaldi's Quick Commands lag with large bookmark sets. SigmaOS shows
each command's key in its list, so the list teaches the keys. §3 answers
each of these.

## 3. Rules and their reasons

| Decision | Reason |
|---|---|
| **It is called the Launcher.** | ⌘L, and it fits Sval's space theme. |
| **⌘L (Ctrl+L) opens it, with the current address selected. There is no second shortcut.** | ⌘L already means "go somewhere" in every browser, so there is nothing to learn and nothing taken from pages. ⌘K is the page's own palette in Slack, Notion, Linear and GitHub. |
| **⌘T stays New Tab, which opens Home. ⌘⇧T stays Reopen closed tab.** | Both are decades of habit. Arc's ⌘T takeover is a top complaint. |
| **Opened with ⌘L it floats, centred over the page. Clicked, it stays in the toolbar.** | Zen's split. A float has room for tabs from every workspace and for commands; a click on the toolbar means the user wants the toolbar. |
| **The address is always visible in the toolbar.** | Arc's hidden address was its most common complaint. The float is a view of the same field, not a replacement for it. |
| **Enter goes where the row is.** An open tab: switch to it, changing workspace if needed. A pin or Favorite: select its tab, as clicking it in the panel does. A command: run it. A URL, history entry or search: load it in this tab. | A tab row never opens a duplicate. ⌘L has always loaded in place. ⌘T then typing on Home is Arc's ⌘T, because Home is the tab being replaced. |
| **Two places where loading in place would be destructive:** on a pin, a URL on another site opens in a new tab; in a split, Enter loads in the focused pane. | A pin always shows its own site (pins spec §3). Swapping a pane with ⌘L is how Arc worked. |
| **Shift+Enter opens a new tab. ⌘⇧Enter (Ctrl+Shift+Enter) opens a new window. ⌥Enter (Alt+Enter) opens beside this tab in a split.** | Firefox uses Shift+Enter for a new window and ⌥Enter for a new tab; Sval moves them. ⌥ for a split matches the panel's Alt-click on a second tab (split view spec). |
| **⌘Enter does not complete `example` to `www.example.com`.** `browser.urlbar.ctrlCanonizesURLs` is off. | Firefox checks that before the other modifiers, so it would swallow ⌘⇧Enter. History autofill covers what it did. |
| **The Launcher teaches its keys.** Every row makes clear what Enter does on it and what its modifiers do, and each command row shows its key. | Hidden modes are why @tabs goes unused. SigmaOS's shortcut hints teach the keys. |
| **Rows come in a fixed order** (§5), under one flexible top area. | Fixed places let hands learn the list. Arc's blended list made two-letter switching depend on ranking luck. |
| **The top area works as Firefox's address bar does:** the row Enter takes, then recents and strong matches. | Users know it. |
| **The first row is always what was typed:** the web search, or the visit when it is an address, as Firefox's address bar decides. An open tab never takes it. When an open tab matches strongly, Open tabs follows that row, each tab labelled with its workspace. | Enter must always do what was typed: "google" searches and "google.com" goes to google.com, even with a Google tab open. Making the open tab Enter's row left no way to search or visit. The open tab stays one ↓ away. |
| **Every tab in the panel's tree counts as open,** loaded or not, in every workspace. Archived tabs do not; they come back through history. | The panel lists them as open, so the Launcher must too. The Archive is a separate list (idle-tab archive spec). |
| **Modifiers on a row that is not a page:** on an open tab, ⌥Enter splits this tab with it and other modifiers switch as Enter does; on a pin or Favorite, Shift+Enter and ⌘⇧Enter open its address in a new tab or window; on a command, modifiers do nothing extra. | A modifier must never duplicate an open tab. Firefox turns a modified Enter on a switch-to-tab row into a new tab; Sval does not. |
| **What floats:** ⌘L (Ctrl+L), and the menu's Open Location, including when the field is already focused in place. F6 and a click do not. Alt+D, Firefox's second key for the address bar on Windows and Linux, runs the same command, so it floats too; Sval does not show it. | ⌘L is the Launcher's key on every platform. Alt+D is the address-bar key in Chrome, Edge and Firefox on Windows, so taking it away would break a habit. F6 cycles address bar, panel and page (`SvalShortcuts`); floating there would break the cycle. |
| **Commands are Sval's and most of Firefox's quick actions** (§4). | Commands and Sval's own things (workspaces, pins, splits, agents) as first-class rows are the answer to "how is this better than the omnibox". |
| **Rename workspace opens the Edit workspace sheet.** | One way to edit a workspace. |
| **The Launcher, Home's search field and the toolbar's address bar look and behave the same:** the same rows, sections, keys and modifiers, commands included. Home's field draws every row the address bar's view does (commands, other providers' rows such as the calculator, tips, and the search-mode offers "@" lists), autofills as it does, and takes its keys: the arrows, Tab, Page Up and Down, ⇧Delete and a row's menu. The toolbar's address bar keeps its own site, media and navigation controls and its search-mode button. | Home's field runs on the address bar's providers (decision 0098). ⌘T then typing should not find less than ⌘L. Home's page is content, so it draws the rows `SvalHomeSearchParent` describes; a row a provider acts on is handed to that provider, as the view hands it. |
| **The list wears the window's workspace colours** on all three: the card is the surface the header's popups take, a step off the workspace's tint, and its rows take that surface's scheme. | The list is part of the window, as the header's menus are. Sval's own blue on a green workspace reads as another window's. |
| **⌘⇧N opens a new private window; ⌘⇧P does too.** | Chrome's key, which Chrome users know. It takes Firefox's Reopen closed window, which ⌘⇧T still covers: Firefox's `key_restoreLastClosedTabOrWindowOrSession` reopens whichever closed last. |
| **⌘N opens a window on the next workspace down from this window's,** wrapping at the bottom. | The main spec's rules stand (§5): it skips workspaces another window shows and agents' workspaces, and makes a new nameless workspace when all of the user's are open. |

### 3.1 Rejected approaches

- **A new search UI** beside the urlbar, as Vivaldi's F2 is. It would rank
  differently, duplicate Firefox's providers and drift.
- **⌘T opening the Launcher,** as Arc and Zen do.
- **⌘K, ⌘⇧K, ⌘⇧L, ⌘E, Ctrl+Space or ⌘⇧A** as the key. Each is taken by
  Firefox, devtools, the OS, IMEs, or common web apps.
- **@-modes as the way to reach tabs and commands.** They stay, as Firefox
  has them, but nothing depends on users finding them.

## 4. Commands

A command row says what it does in Sval's words and shows its key, read
live from its `<key>` through `SvalShortcuts.shortcutText`, so a key the
user changed in Settings › Keyboard shows as changed. A command with no key
shows none. Commands that do not apply now are not listed: Close split
without a split, Unpin on a tab that is not a pin. Each command's name and
synonyms are in `locales/en-US/launcher.ftl`, and the list is
`SvalLauncherCommands.sys.mjs`. They fall in these groups:

- **Workspaces:** each of the user's workspaces by name (switch to it, or
  bring forward the window that shows it); New workspace; Rename workspace;
  Move this tab to another workspace (then pick one).
- **This tab:** Pin or Unpin; Add to Favorites; Copy address; Duplicate;
  Archive; Reopen closed tab; Mute or Unmute; Reader view.
- **Split:** Split with… (then pick a tab); Close split; Swap panes.
- **Panel:** Show or hide the panel.
- **This site:** Privacy and Security; Clear site data; Allow or Block
  JavaScript.
- **Agents:** Give control back, in an agent's window you have taken
  control of; Agent access settings.
- **Settings:** each Settings pane by name ("Favorites settings").
- **Firefox's quick actions, less Firefox View, Themes, Labs and Help:**
  Downloads, Extensions, Logins, New private window, Print, Save as PDF,
  Screenshot, Translate, Refresh, Clear history, Restart, Inspect, View
  source, Color picker. Sval adds History (the history sidebar).

A command that picks something ("Move this tab to…", "Split with…") keeps
the Launcher open and lists the choices in it. Escape steps back to the
first list, and Escape again closes.

## 5. Rows and their order

**The top area** is Firefox's address bar's:

1. **The row Enter takes:** the autofilled site, the address typed, or the
   web search, as Firefox decides. Never an open tab.
2. **Open tabs, when one matches strongly,** on a word start of its title
   or the start of its host ("ca" → Calendar, "gi" → GitHub): the section
   moves up here, strong matches first.
3. **Recents and strong matches,** as Firefox's address bar shows them.

**Then fixed sections, always in this order,** each with a heading and each
shown only when it has rows:

| Section | At most | Order within |
|---|---|---|
| Open tabs | 4 | This workspace's first, then others, each labelled with its workspace; most recently used first |
| Pins and Favorites | 3 | Pins first, then Favorites; Firefox's frecency |
| Commands | 3 | Only when the text matches a command's name or a synonym |
| History | 5 | Firefox's frecency |
| Search suggestions | 3 | The engine's order |

A row shows once, in the first place it qualifies: an open tab is never also
a history row, and a pin's open tab is a pin row.

**Empty Launcher** (⌘L, nothing typed): the most recently used tabs across
every workspace, as a ⌃Tab list would, labelled by workspace.

**Removing a row:** ⇧Delete removes a history row or a suggestion, as in
Firefox. Open tabs, pins, Favorites and commands cannot be removed
there.

The section limits and the order are settings (decision 0126),
`browser.sval.launcher.order` and `browser.sval.launcher.limit.*`,
defaulting as above. A section with more matches than its limit shows its
limit and no more.

## 6. How it is built

The Launcher is Firefox's urlbar: one input, one view, one query. Nothing
here is a second search UI. Where Firefox's providers cannot know Sval's
state, Sval adds a provider that reads it from where it lives.

- **Firefox's providers stay:** places, bookmarks, input history, search
  suggestions, `SvalFavoritesProvider`, the calculator and unit conversion.
- **Open tabs are Sval's provider, read from the tree.** An inactive
  workspace is data only (main spec §10.4): its tabs are tree nodes, not
  Firefox tabs, so `UrlbarProviderOpenTabs` and `switchToTabHavingURI`
  cannot see them. Sval's provider matches the tree's tabs in every
  workspace (title and address, on word starts) and yields switch-to-tab
  rows that carry the node. Picking one goes through the panel's own select:
  it switches workspace through the one place a window changes workspace
  (decision 0079) and materialises the tab as a click in the panel does. It
  creates no tab the tree does not hold. Firefox's own open-tab rows are
  turned off, so a tab shows once. The tree is the one source of truth: the
  provider reads it at query time and caches nothing.
- **A strong open-tab match moves Open tabs up.** Its rows take a group of
  their own, placed after the heuristic group by the sections patch, through
  `UrlbarUtils.getResultGroup`'s `result.group` branch.
- **Commands are rows, from Sval's provider.** Firefox's quick actions
  (`UrlbarProviderGlobalActions`, `ActionsProviderQuickActions`) draw one row
  of buttons with no key and no sub-list, so they cannot be §4's rows. Sval's
  commands provider yields one row per command, with its key and a sub-list
  for commands that pick, and covers Firefox's quick actions by calling the
  same commands they call. Firefox's button row is turned off.
- **Sections are a patch.** Groups come from `makeDefaultResultGroups()`
  through `UrlbarPrefs.getResultGroups`; there is no pref for them. Sval
  patches that function for §5's sections, reading their order and limits
  from Sval's settings. Headings use the view's existing group labels.
- **Floating** is a presentation of the same `#urlbar`. Opened from
  `Browser:OpenLocation` (§3), it is positioned centred over the content
  area, wider, with a scrim; Escape, a click outside or picking a row returns
  it to the toolbar.
- **Where Enter goes** is `UrlbarInput._whereToOpen`, with Sval's mapping for
  Shift, ⌘⇧ and ⌥, and the pin and split cases.
- **Private windows** keep Firefox's rules: open tabs are that window's own,
  there are no workspace or agent commands (private windows spec §2), and
  history and Favorites show as Firefox shows them in a private window.
- **Agents' workspaces:** their tabs are listed, labelled with the agent;
  switching brings the agent's window forward and never moves the user's
  window onto it.
- **Speed:** opening must feel instant. The first rows show within a frame of
  ⌘L, from what is in memory; history and suggestions fill in after, without
  moving the rows above them. It stays so with thousands of tabs and
  Favorites (Vivaldi's complaint): the open-tab provider reads every tab of
  the tree for each query and hands over no more rows than its section's
  limit.

## 7. Accessibility

The urlbar is already an ARIA combobox with a listbox of options. The
Launcher keeps that and adds:

- Section headings exposed as groups, so a screen reader says "Open tabs,
  group" on entering one.
- Each open-tab row's workspace in its accessible name: "Calendar, in Home,
  switch to tab".
- Each command's key in `aria-keyshortcuts`, through
  `SvalShortcuts.ariaShortcut`.
- Opening and closing the float moves focus into and back out of the field,
  and the float is announced as the address bar, not as a dialog.
- Every action has a keyboard path. Nothing needs a mouse.

## 8. Discoverability

- The address bar's field and Home's say what the Launcher finds, and a key
  cap at the field's end names the Launcher's key as the user has it, while
  the field is empty (and in the address bar, unfocused). File › Launcher…
  names it in the menu bar.
- The first-run tour shows ⌘L once.
- Every row shows what Enter and its modifiers do there (§3).
- Settings › Keyboard lists the Launcher, and the Enter modifiers as text.

## 9. Tests

Each asserts what a user sees, on Sval's real defaults.

- ⌘L, Alt+D and Open Location float the Launcher with the address
  selected; a click on the address bar and F6 open it in place; Escape
  returns focus to the page and changes nothing.
- Two letters of a tab's title in another workspace, with the tab not
  loaded: the top row is that tab, over an autofill match; Enter switches the
  window to that workspace and selects the tab, which loads as a panel click
  loads it, and the tree holds no new tab.
- ⌥Enter on an open-tab row splits this tab with it; Shift+Enter on it
  switches and opens nothing new. ⌥Enter switches instead of splitting when
  the tab or the window belongs to an agent's workspace, and asks first when
  the split would move a tab into or out of an isolated workspace.
- An archived tab is not an open-tab row.
- A tab in a workspace another window shows: Enter brings that window
  forward and leaves this one where it was.
- A URL and Enter loads in this tab; Shift+Enter in a new tab; ⌘⇧Enter in a
  new window; ⌥Enter in a split with this tab.
- On a pin, a URL on another site opens in a new tab and the pin keeps its
  page. In a split, Enter loads in the focused pane only.
- Typing "new wor" lists New workspace with its key; Enter makes a
  workspace. A key the user changed shows as changed.
- Rename workspace opens the Edit workspace sheet.
- Sections appear in the fixed order, within their limits, and a page shows
  in one section only.
- An empty Launcher lists recent tabs from every workspace.
- ⇧Delete removes a history row and it does not come back.
- Home's field shows the same rows for the same text.
- In a private window: only that window's tabs, no workspace commands.
- ⌘⇧N opens a private window. ⌘⇧T reopens a closed window when a window
  was closed last.
- ⌘N from the second of four workspaces opens the third; from the last, the
  first that no window shows; with all open, a new nameless workspace.
- A screen reader hears each section as a group and each row's workspace
  and key.
