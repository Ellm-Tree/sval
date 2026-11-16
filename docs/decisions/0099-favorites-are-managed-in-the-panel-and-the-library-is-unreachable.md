# 0099. Favorites are managed in the panel, and the Library is unreachable

**Status:** Accepted on 2026-10-13.

## Context

Workspaces and Favorites are Sval's two ways to keep a link (import spec §2).
Favorites live in the engine's favorites document (0108). Firefox's Library
window, reached from history's and downloads' "show all" commands, would be a
second place to manage favorites, and it brings back Firefox's bookmark
folders, tags, keywords, its import wizard, and on macOS its own copy of
Firefox's menu bar.

## Decision

- **A favorite is managed from a right-click menu on the panel's Favorites
  menu**: open, rename, edit address, move, delete, new folder, open all,
  export, and undo. It is a native menu, so assistive technology and the
  keyboard reach it. There is no Favorites page.
- **No Sval command, key or menu item opens the Library.** History goes to the
  History sidebar, downloads to `about:downloads`.
- **Tags and keywords are not part of sval.** Nothing creates them and import
  ignores them.
- Extensions' `browser.bookmarks` reads and writes Favorites.

Spec: `2026-10-21-favorites-native-design.md` §15.

## Consequences

- Organising many favorites at once waits for multi-select or a page of its
  own; neither is planned.
- Places holds no favorites and keeps no backups of them. Export and import
  of a bookmarks HTML file are the user's way to move or keep Favorites.
