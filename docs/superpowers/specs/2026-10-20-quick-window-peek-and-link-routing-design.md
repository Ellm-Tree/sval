# Sval — the quick window, link peek and link routing

**Status:** Built.
**Date:** 2026-10-20
**Author:** John Postlethwait
**Builds on:** `2026-10-14-isolated-workspaces-design.md` (a workspace's jar),
`2026-10-19-idle-tab-archive-design.md` (what the Archive holds).

---

## 1. What this is

Three features designed together, because they share one surface and one
routing engine.

1. **The quick window.** A link opened from another app (Slack, Mail, a
   terminal) opens in a small window of its own that belongs to no workspace,
   as Arc's Little Arc did. You read it and close it, or move it into a
   workspace.
2. **Link peek.** Alt-click (Option-click on macOS) on a link in a page opens
   it in an overlay over the current tab, as Arc's Peek and Zen's Glance do.
   You read it and close it, or keep it as a tab or a split.
3. **Link routing.** Rules that send links from other apps for a site straight
   to a chosen workspace, skipping the quick window, as Arc's Air Traffic
   Control did.

**Success looks like:** with Sval as the default browser, a user clicks a
Linear link in Slack. It opens in a quick window over Slack, they read it and
close it, and Slack is where they were. They add a rule in Settings › Links
sending notion.so to Work, and every later Notion link from another app opens
straight in their Work workspace. In Sval, they Alt-click a link in an
article, glance at it in the overlay, and press Escape to go back to the
article.

All three work on macOS, Windows and Linux.

## 2. Decisions and the reasons for them

| Decision | Reason |
|---|---|
| **The quick window, the in-page peek and routing work on all three platforms.** | Arc's Little Arc and routing were macOS-only, and Zen has no quick window at all. |
| **Two surfaces with the same controls. A link from another app opens in the quick window, a small floating window of its own. A peek inside Sval is an overlay over the current tab.** | A link from another app has to appear over that app. A peek is a glance at a link in Sval, and a separate OS window for it would mean managing windows, which was Little Arc's main complaint. |
| **A peek is opened by Alt-click (Option-click on macOS) on a link in a page.** Ctrl/Cmd-click and plain click are unchanged. | Zen's Glance uses the same gesture, and it is free in Sval: Firefox saves a link on Alt-click only under `browser.altClickSave`, which is off by default (`BrowserUtils.whereToOpenLink`). Alt-click on a panel row still splits; that is the panel, not a page. |
| **A link in a pin's page to another host opens in a peek** (pins spec §5, `browser.sval.pins.peekLinks`). **Favorites and other tabs never peek on their own.** | Arc opened a peek automatically for a cross-site link from a pinned tab. A pin always shows its own site. |
| **A quick window's page opens in the shared jar,** the jar of the user's ordinary (non-isolated) workspaces. | The user is signed in as usual. A page's jar is fixed when its tab is made (`addTab`'s `userContextId`; `SvalTabs` `#keepInJar` says Gecko cannot move a live tab between jars), so it has to be chosen before the link loads. |
| **Moving a quick window's page into an ordinary workspace keeps it as it is,** with no reload. **Moving it into an isolated workspace reloads it there, in that workspace's jar, after the quick window says so.** | A page in the shared jar can be adopted into another window without a reload (`gBrowser.adoptTab`), but only into the same jar. An isolated workspace's jar is another jar, so the page is opened again there, which loses its history, what was typed into it, and anything signed in only in the shared jar. Arc warned in the same case when moving between profiles. |
| **A quick window keeps the address it was opened for until its page loads.** A first load that fails shows its error page at that address, so a reload loads it again; one stopped before it commits leaves the address in the address bar. **Moving a page whose load never showed it opens it afresh at that address** in the workspace, whatever its jar. | A link from another app is the one thing the window is for, and a failed or refused load must never leave it with nothing. Firefox keeps a new tab's address the same way until its page loads (`addTab`'s `userTypedValue`), and a failed load's error page keeps the address (`nsDocShell::DisplayLoadError`). Adopting the tab would move a blank or error page in place of the page. |
| **A peek's page opens in the current tab's jar,** so keeping it as a tab or a split never reloads it. | A peek is always about the page under it, in the workspace the window shows. |
| **Each link from another app gets its own quick window.** New ones cascade a little from the last. Each shows how many quick windows are open, with a menu to switch between them. | Replacing a page the user is still reading would lose it, and Little Arc's main complaint was losing windows. |
| **A quick window closes itself after a set idle time, six hours by default,** into history. Idle means the time since the quick window last had focus. | Arc auto-archived its Little Arc windows every six hours for the same reason. Focus is what is timed, because a window the user just glanced at must not close. |
| **A closed quick window or peek goes to history,** like any closed tab, and not to the Archive. A closed quick-window page is found again in browsing history; it is not added to a normal window's undo-close list. | The Archive holds only tabs archived for being idle (idle-tab archive spec). A quick window's own closed-tab list goes with the window, and putting its page in another window's list would say which workspace and jar it reopens in. |
| **Routing rules apply only to links from other apps.** A link the user opens inside Sval, in the current tab, a new tab or a peek, goes where they send it. | Zen applies its Space Routing to every `addTab`, and its bugs came from that: rules overrode tabs the user had put in a container, opened tabs in the background, and froze the browser routing tabs across workspaces (zen-browser/desktop #14242, #14183, #14171). |
| **A link matching a rule skips the quick window** and opens as a new tab in the rule's workspace, in that workspace's jar from the start. | Arc's rules did the same: a rule beat the default, and the default was Little Arc. A rule naming an isolated workspace then never needs a reload. |
| **A rule matches a site, its subdomains included (`notion.so`), or "the address contains" some text, and names a workspace.** | Arc offered "contains" and "is exactly". A site match covers most real cases without making the user write patterns. |
| **Matching on the app a link came from is left out.** | Only macOS can tell, and only partly: link routers read the sender from the Apple Event (`keySenderPIDAttr`), and Velja reports it failing for terminals. Windows and Linux pass nothing. |
| **Rules are made only in the Links pane of Settings,** which lists the rules to add, edit, reorder and delete. The quick window offers no routing controls. | The quick window stays one page and one way out. |
| **Rules sync. When two rules match one link, the first in the list wins. Neither is removed: the Links pane marks the two as colliding and the user decides.** | A rule the user wrote is never deleted behind their back. |
| **A rule is marked as colliding when a rule above it always matches first, so it can never apply:** a site rule under a rule for the same site or a parent site, or an "address contains" rule whose text contains the text of a contains rule above it. Rules that merely overlap are not marked. | Nearly any two "contains" rules can match some link, so marking overlap would mark almost every pair. A rule that can never apply is the one the user needs to know about. |
| **Every choice here is a setting,** in Settings › Links: the quick window on or off, its idle close time, peek on or off, and the rules. | Every default in Sval is a setting. The peek's key is not one: Shift and Ctrl/Cmd already mean a new window and a new tab on a link, so Alt (Option) is the one free modifier. |
| **The quick window is on by default.** It takes effect for links from other apps, which reach Sval when it is the default browser or through a link router. Off, a link from another app opens as a new tab in the frontmost window. Routing rules work whether it is on or off. | It is the point of the feature. |
| **A quick window's page is never written to the tree, and quick windows are not restored after a restart.** | It belongs to no workspace until it is moved into one. Firefox already keeps popup windows out of a restored session (`SessionStore` `isPopup`). |
| **A link routed to a workspace, or a page moved into one, opens in the window showing that workspace, which comes to the front. When no window shows it, the frontmost Sval window switches to that workspace and shows it there.** | The user clicked the link to see it. A switch keeps the other workspace's tabs loaded, so nothing is lost. Arc switched to the link's Space the same way. |
| **A rule whose workspace was deleted is skipped:** a matching link falls through to the next rule, then to the quick window. | The rule is kept for the user to fix (§6), and a link must still open somewhere sensible. |
| **"Open in split" from a peek on a tab that is in no split makes a two-page split,** the tab on the left and the peek on the right. | The same split the panel makes from two tabs. |
| **Escape in a quick window closes its open menu first; with none open, it stops a loading page,** as Escape does in a main window. | The quick window carries the main window's address bar and keys. |
| **A link that opens a new tab from inside a quick window (a `target=_blank` link, Ctrl/Cmd-click, a `window.open` without features) opens another quick window. A page's popup with features (a sign-in flow) opens as Firefox opens it.** | It stays out of every workspace until the user moves it, and sign-ins keep their opener. |
| **Every link that arrives from another app is treated the same, whether the OS sent it because Sval is the default browser or a link router passed it on.** There is no check of default-browser status. | A user who sends links to Sval through Velja, Choosy or `open -a` gets the quick window too. |

## 3. How a link from another app reaches Sval

Every platform delivers it as a command line holding `-url <address>`, to a
running Sval or at a cold start:

- **macOS:** `MacApplicationDelegate` `application:openURLs:` builds an
  `nsCommandLine` of `-url` pairs and runs it. URLs that arrive during launch
  are held and appended to the first command line
  (`CommandLineServiceMac::SetupMacCommandLine`).
- **Windows:** the shell runs `"<exe>" -osint -url "%1"` (registered by the
  installer). A second process hands its command line to the running one over
  `WM_COPYDATA` (`nsWinRemoteClient` → `nsWinRemoteServer`).
- **Linux:** `xdg-open` runs `sval %u` (the desktop entry's `Exec`), a new
  process that hands off over D-Bus (`nsDBusRemoteServer::HandleOpenURL`) or
  X11.

All of them run the `command-line-handler` category, in order of entry name.
Firefox's `nsDefaultCommandLineHandler` ("x-default",
`BrowserContentHandler.sys.mjs`) takes a bare `-url`, and
`handURIToExistingBrowser` opens it as a new tab in the frontmost window.

**Sval adds its own `nsICommandLineHandler`** (`SvalExternalLinks.sys.mjs`),
under an entry name that sorts before "m-browser" (Firefox's taskbar tabs use
"l-taskbar-tabs"). It is registered from JS at `browser-before-ui-startup`,
which runs before the first command line, because a `components.conf` entry
would be compiled into libxul and move the Gecko key. It takes each address
the quick window or a rule handles and leaves the rest of the command line
to Firefox. Because macOS's Apple Events become the same command line, one
handler covers all three platforms.

At a cold start, Firefox opens the first window as usual, with the session
restored, and the taken pages open over it once that has happened. Little
Arc did the same.

A link the handler leaves to Firefox lands in the frontmost window's
workspace and jar:
`browser.link.force_default_user_context_id_for_external_opens` is on, and
`workspace-jar-for-new-tabs.patch` lets `addTab` take
`gBrowser.defaultUserContextId`, which `sval-panel.js` `_setJar` sets per
workspace (`a_link_from_another_app_loads_in_the_workspaces_jar`). That is
the path when the quick window is off and no rule matches.

## 4. The quick window

- **What it is:** a full browser window with one page, belonging to no
  workspace (`SvalQuickWindow.sys.mjs`). It runs no panel and no tab
  observer, so its page is never written to the tree. It is marked unsaved
  (`sessionstore-unsaved-windows.patch`), so no restart, crash or Restore
  Previous Session brings it back. It is never the top window for Firefox's
  "open this in the top window" (`quick-window-not-top-window.patch`).
- **What it offers:** the main window's address bar, "Open in <workspace>"
  with a menu of the other workspaces, the count of quick windows with a
  switcher and "Close all Quick Windows", and close.
- **"Open in <workspace>"** names, by default, the workspace of the most
  recently used normal window. Agent workspaces are never offered; when the
  last-used window shows one, the default is the workspace of the most
  recent window that does not. **The
  button names its workspace in full, as "Open in Home Workspace"**, and its
  menu names the others the same way, so the user reads where the page will
  go before it goes.
- **Moving the page into a workspace** puts it in the window showing that
  workspace, or switches the frontmost Sval window to it, and selects it
  there. Each workspace in the menu has a button that opens it in a new
  window instead, and Shift-click on the button or a menu row does the same,
  so the window the user is in keeps its workspace. The page is adopted without a reload when
  the workspace is ordinary, and opened again in the workspace's jar, after
  the warning, when it is isolated. The quick window then closes.
- **Closing it**, with Cmd/Ctrl+W, its close control, or the idle timer,
  closes the page into history. The idle time is wall-clock time since the
  window last had focus, so a computer's sleep counts, and each wake checks
  again.
- **Several quick windows** cascade, and each shows the count and the
  switcher.
- **A download is never a quick window.** A link whose file extension names
  a type Gecko would not show (a document viewer or a stream converter takes
  it, as `nsDocumentOpenInfo::DispatchContent` decides) opens in the
  frontmost ordinary window. One whose response turns out to be a download
  closes its quick window as the download starts, and the Downloads panel
  announces it in the ordinary window brought to the front. A tab Sval
  opened for such a link, left empty, closes too. Gecko closes a window
  opened for a download only when it has an opener
  (`MaybeCloseWindowHelper`), which a link from another app never has
  (`SvalLinkDownloads`).
- **A private window** never receives a quick-window page, because moving a
  tab between private and normal windows is refused
  (`swapBrowsersAndCloseOther`).

## 5. Link peek

- **What it is:** an overlay over the current tab showing the linked page,
  live and usable, with the page beneath it dimmed (`SvalPeek.sys.mjs`). The
  page is a real tab of the window, opened in the background and hidden from
  everything that walks the window's tabs (`gBrowser.hideTab`). Its own panel
  is drawn over the content area and made active. Keeping it moves no browser
  and swaps no docshell: the same tab is shown and filed through the path
  every new tab takes. Until then it is marked (`SvalPeekTab`) and no node
  describes it.
- **What it offers:** the page's address, "Open as tab" (next to the current
  tab in its workspace), "Open in split" (a split with the current tab, under
  the split view's limit of four panes), and close.
- **Closing it:** Escape, its close control, or a click outside it, and when
  the window shows another tab or the tab under it closes or navigates. The
  page goes to history and to no recently closed list.
- **Its jar** is the current tab's, so keeping it never reloads it.
- **Opening it:** Alt-click (Option-click) on a link, or "Open Link in
  Peek" in the link's context menu, after "Open Link in Split View". The menu
  item shows for exactly the links an Alt-click would peek at, and the
  Settings toggle (§7) turns both off.

## 6. Link routing

- A rule: a site, or "address contains" text, and a workspace.
- Rules are checked in list order. The first match wins.
- A match opens the link as a new tab in the rule's workspace, in that
  workspace's jar: in the window showing the workspace, or in the frontmost
  Sval window switched to it.
- Rules apply only to links from other apps (§3). They apply whether the
  quick window is on or off.
- Rules sync to the user's other devices, as one synced setting holding a
  JSON list (`browser.sval.links.rules`), so a reorder travels with it.
  `SvalLinkRules.sys.mjs` reads each rule's workspace from the tree each time.
- A rule naming a deleted workspace stays in the list, marked as having no
  workspace, until the user edits or deletes it.

## 7. Settings (Settings › Links)

| Setting | Default |
|---|---|
| Open links from other apps in a quick window | On |
| Close an idle quick window after | 6 hours (choices: 1 hour, 6 hours, 1 day, 1 week, never) |
| Peek at a link with Alt-click (Option-click) | On |
| Rules | none |

The Links pane shows each rule's site or text and its workspace, lets the user
reorder, edit and delete them, and marks a rule that a rule above it always
matches first (§2).
