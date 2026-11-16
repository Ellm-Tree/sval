# 0123. Favorites is one tree, and import folds wrapper folders

**Status:** Accepted on 2026-10-18.

## Context

A browser that imported from another keeps that import as a chain of folders
each holding only the next. Vivaldi, after an import from Safari, holds
"Imported bookmarks", "Bookmarks Bar", "Imported From Safari". Copied as it
is, the chain fills Favorites with what look like empty folders. Places' menu
and unfiled roots, shown as "Favorites Menu" and "Other Favorites", stay empty
after an import from a Chromium browser, which has no menu root to fill one
from.

The document has three fixed roots.

## Decision

- Favorites is the document's toolbar root, and Sval shows no other root. The
  Favorites menu and Move to… list Favorites and the folders in it.
- Import writes into Favorites alone. The source's toolbar is its top level,
  and the source's menu and other bookmarks arrive as folders in it, named
  "Bookmarks Menu" and "Other Bookmarks".
- Imported folders, from every browser, fold: a folder whose only content is
  one folder is that folder, all the way down a chain, and the innermost
  keeps its name. A folder left empty is dropped.

## Consequences

- A chain of folders a user built on purpose, each holding only the next,
  arrives as its innermost folder.
- The document's menu and unfiled roots stay, empty.
