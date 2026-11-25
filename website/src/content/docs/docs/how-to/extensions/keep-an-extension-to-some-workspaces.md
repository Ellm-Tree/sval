---
title: Keep an extension to some Workspaces
description: Keep an extension away from your pages everywhere but the Workspaces you choose.
since: 0.1.0-rc.11
---

You can keep an extension to the Workspaces you choose. Anywhere else the
extension can't read or change the pages in your tabs, and you won't see its
button or menu items or use its keyboard shortcuts.

You use React Developer Tools for work and want it in your Work Workspace
alone, away from your personal browsing.

## Steps

1. Open Settings › Extensions.
2. Under Installed, select the extension's name.
3. Under Run in these Workspaces, uncheck each Workspace you want to keep the
   extension out of.

Sval reloads the tabs whose pages the extension can now reach, or can no
longer reach.

## Details

- The extension still runs in the background in every Workspace. Your
  history, bookmarks, downloads, and cookies don't belong to one Workspace,
  so an extension that can see them still sees all of them. An extension
  allowed to see your tabs still sees the address of every tab.
- A tab you move into another Workspace keeps what the extension already
  put on its page until the page loads again.
- An extension you keep to some Workspaces can't reach a page in a Peek
  window, because a Peek window doesn't belong to a Workspace.
- When you delete every Workspace you chose, the extension runs in every
  Workspace again.
- Your choice syncs to your other devices.

## Related pages

- [Show a pinned extension in some Workspaces](/docs/how-to/extensions/pin-an-extension-to-the-toolbar/)
- [Turn an extension off on a site](/docs/how-to/extensions/turn-an-extension-off-on-a-site/)
- [Extension settings and controls](/docs/reference/extensions/)
