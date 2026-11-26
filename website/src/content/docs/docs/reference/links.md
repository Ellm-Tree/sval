---
title: Links
description: What each control in Settings › Links and in a Peek does.
---

Settings › Links decides where your links open. It covers links from other
apps, links in pages, and Link Docking, which sends a site's links to a
Workspace.

## Links from other apps

- **Open links from other apps in a Peek.** Each link from another app
  opens in a Peek. A Peek is a small window that isn't part of any
  Workspace. This setting is on by default. When it's off, links from
  other apps open as a new tab in the frontmost window.
- **Close an idle Peek after.** Sval closes a Peek you haven't used for
  the time you choose. The choices are 1 hour, 6 hours, 1 day, 1 week, and
  **Never**. It starts at 6 hours. This setting is dimmed while Peeks are off.

Both settings sync to your other devices.

## Links in pages

- **Open a link in a Quick Peek with <kbd>⌥</kbd>-click** (**Alt+click** on Windows and
  Linux). When you <kbd>⌥</kbd>-click a link, it opens over the current tab,
  with the tab's sign-ins. The setting's name shows the click chosen in
  Settings › Keyboard shortcuts. When this setting is off, the click works
  the way it does without Sval, and **Open a link in a Quick Peek** in Settings ›
  Keyboard shortcuts reads **Off**.
- **Open links to other sites from a pin in a Quick Peek.** When a link in a pin
  leads to another site, the link opens in a Quick Peek.
- **When you open a link or media in a new tab, switch to it immediately.**
  Sval shows a new tab as soon as it opens.

## Link Docking

When a link from another app matches a rule, the link docks in the rule's
Workspace as a new tab. Sval tries the rules in order, and the first one
that matches wins. A line under the heading says whether the rules sync.

- **Add rule.** The form for a new rule opens.
- Each rule shows its place in the list and what it matches. It also shows
  the Workspace that the rule's links open in.
- The grip at the start of a rule moves the rule. Dragging the grip moves
  it, and so does the Up or Down arrow key while the grip has focus.
- **This rule never applies.** A rule above this one always matches first.
  The message names that rule.
- **No Workspace.** The rule's Workspace was deleted. Its links open as if
  the rule weren't there.
- The pencil edits the rule, and the × deletes it. **Undo** puts back a
  rule you deleted.

### The rule form

- **Match by.** The choices are **Site** and **Address contains**.
  **Site** matches the site and its subdomains. **Address contains** matches any address
  with the text in it. The text has to be at least 3 characters, with no
  spaces.
- The text field takes the site or the text. For **Site**, you can paste
  a whole address.
- **Workspace.** This lists your Workspaces, except Agent Workspaces. An
  isolated Workspace is marked "(isolated)".
- A line under the form says what the rule will do, or why you can't save
  it. The line warns you when a rule above would always match first. It
  also warns you when the new rule would stop a rule below from ever
  applying.
- **Add.** The rule goes at the end of the list. When you edit a rule, the
  button reads **Save**.
- **Cancel.** The form closes.

## A Peek

- **Peek.** This button sits before the address bar and counts the Peeks
  you have open, and pointing to it tells you when the Peek closes. When you
  have more than one Peek, the button opens a list where you can switch to a
  Peek, close one, or select **Close all peeks**.
- The button after the address bar moves the page into the Workspace of
  the window you used last. The page becomes a tab at the end of that
  Workspace's list, and the Peek closes. When no window shows that
  Workspace, Shift-click opens the Workspace in a new window.
- The arrow next to that button lists your other Workspaces. Next to each
  one, **Open in New Window** opens that Workspace in a new window.
- <kbd>⇧⌘T</kbd> (<kbd>Ctrl+Shift+T</kbd> on Windows and Linux) in a Peek
  reopens the Peek you closed last.

In the menu bar, **File › New Peek Window** opens an empty Peek. The Peek
is signed in as the Workspace you opened it from. Its shortcut is <kbd>⌥⌘N</kbd> (<kbd>Ctrl+Alt+N</kbd> on
Windows and Linux).

## Related pages

- [Keep a page from a Peek in a Workspace](/docs/how-to/links/open-a-peek-in-a-workspace/)
- [Dock a site's links in a Workspace](/docs/how-to/links/send-a-sites-links-to-a-workspace/)
- [Turn Peeks off or change when they close](/docs/how-to/links/change-how-peeks-close/)
- [Open a new Peek window](/docs/how-to/links/open-a-new-peek-window/)
