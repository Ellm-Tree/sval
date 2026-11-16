# Sval — Export to other browsers

**Status:** Built.
**Date:** 2026-10-18
**Author:** John Postlethwait
**Builds on:** `2026-10-08-import-design.md`, `2026-10-21-favorites-native-design.md` §15.2 (Export)

---

## 1. What this is

Export writes everything a person has organised in Sval into a file shaped for the
browser they're moving to. That covers their workspaces and their Favorites, plus
their history when the target can take it.

**Why:** Sval has no lock-in. Leaving is as smooth as arriving through
Import.

**Success looks like:** someone moving to Edge opens Export, picks Edge, and saves
a file. Edge imports it. Their Favorites are on the favorites bar, and each Sval
workspace is a folder with that workspace's name. A short notice told them how to
turn each folder back into a tab group or an Edge workspace in a click or two.

## 2. What the targets can take

These facts were checked on 2026-10-18 against current sources.

**No browser imports workspaces, spaces or tab groups from a file.** Every browser
imports bookmarks. So Sval writes each workspace as a named bookmark folder. Then:

- Chrome, Edge and Brave can open a folder as a named tab group ("Open all in
  new tab group").
- Safari can open a folder as a named Tab Group ("Open in a Tab Group").
- Edge can turn a window of tabs into a workspace ("Create workspace with X tabs").

Only Safari imports history from a file. Every other browser imports history only
from another browser installed on the same computer.

Arc and Dia have no file import at all. They import only from an installed browser
such as Chrome.

| Target | File Sval writes | Where Favorites land | History |
|---|---|---|---|
| Chrome, Edge, Brave, Vivaldi, Opera | Bookmarks HTML (Netscape format) | On the bar if the bar is empty, else in an "Imported" folder on the bar (Chromium `profile_writer.cc`) | No |
| Arc, Dia | The same HTML file, imported into Chrome first | Arc turns imported bookmarks into pinned tabs | No |
| Firefox, Zen | Firefox bookmarks JSON | On the toolbar: JSON import keeps the roots, while HTML import puts everything under the Bookmarks Menu | No |
| Safari | Apple's documented export ZIP (`Bookmarks.html`, optional `History.json`) | In an "Imported <date>" folder | Yes, if ticked |
| Other browser | Standard bookmarks HTML | Wherever that browser puts it | No |
| Sval (complete data) | A ZIP of every engine document, decrypted to plain JSON | Everything, lossless | Yes |

References:

- The Safari ZIP format, which Apple invites other browsers to write: https://developer.apple.com/documentation/safariservices/importing-data-exported-from-safari
- Edge favorites import: https://support.microsoft.com/en-us/microsoft-edge/import-your-favorites-and-passwords-in-microsoft-edge-278afd65-2294-9134-005a-ce7b48d868e1
- Firefox file import: `browser/components/migration/FileMigrators.sys.mjs`, `BookmarkJSONUtils.sys.mjs`

## 3. Rules

| Rule | Reason |
|---|---|
| **Stay with what each browser imports.** Sval never writes into another browser's profile files and never ships a helper extension. | Profile writes (Zen sessions, Firefox session store) are undocumented, change between versions and can be broken by sync. |
| **One Export dialog. The user picks a destination browser, and Sval writes the format that browser handles best.** "Another browser" writes standard HTML. | Each target gets its smoothest path, and a generic option covers the rest. |
| **"Sval (complete data)" is also a target.** It writes every document the engine holds (workspaces, favorites, history, settings), each decrypted through `export_json` (`engine/src/sync.rs`) into one ZIP with a `README.txt` describing the format. No key material goes in. | This is main spec §6.8's "export decrypts and saves". A copy of the sync folder is useless without the key. |
| **Each workspace becomes a folder named after it.** Firefox, Zen and "Another browser" keep its groups as subfolders. Chromium targets, Arc, Dia and Safari get one folder per workspace, its tabs in panel order. | Folder to tab group or workspace is the one-step path back in Chrome, Edge and Safari. Chromium's "Open all in new tab group" opens only a folder's own bookmarks (`GetURLsToOpen` in `bookmark_utils_desktop.cc`), and Apple documents no more for Safari, so a nested workspace would reopen with its grouped tabs missing. |
| **A tab on a page only Sval has (`about:`, `chrome:`) is left out**, by Import's own rule (`importableUrl`). A group or workspace left empty is left out with it. | Such a page means nothing in another browser, and an empty folder opens nothing. |
| **Agent workspaces are left out.** They're the ones marked `node.agent` in the tree. | They hold an agent's work, not the person's. The complete-data target still includes them, because it is lossless. |
| **Favorites keep their structure under the target's bar or toolbar root.** In HTML that's the `PERSONAL_TOOLBAR_FOLDER` folder. In Firefox JSON it's the toolbar root. Favorites Menu and Unfiled go to their matching roots. | This lands Favorites where each importer puts toolbar items. |
| **The workspace folders sit outside the bar, inside one "Sval Workspaces" folder**, which goes under Other Bookmarks, Firefox's Unfiled root and Safari's top level. | The bar holds only Favorites, and workspace folders neither mix with Other Favorites (Sval's Unfiled root) nor collide with them by name. |
| **The dialog has the workspaces (all ticked), Favorites (ticked) and History.** History is shown only when Safari is the target, and holds every page Places keeps a visit to. | History can't travel to any other target in a file. |
| **Passwords are not exported.** | Sval stores none (decision 0078). |
| **Bookmark targets drop colours, emoji, isolation and per-workspace settings.** | Bookmark formats can't hold them. The complete-data target keeps them. |
| **After saving, Sval shows a short notice for that target.** It names where to import the file in that browser and gives one line on opening a folder as a tab group or workspace. Arc and Dia get one more line: import into Chrome first, then into Arc or Dia. | A short generic instruction is enough to finish the move. |
| **The suggested file name is the target and the day**: `Sval for <Browser> <YYYY-MM-DD>.<ext>`, or `Sval data <YYYY-MM-DD>.zip` for complete data. | |
| **Export contacts no host and writes only the file the user chose**, in one write. ZIPs are built in memory, stored uncompressed. | Same rule as Import (main spec §10.9). |

## 4. Where it lives

- **Settings:** an Export button next to Import, calling `SvalPanel.openExport`
  (`settings-passwords.js`, `sval-panel-pages.js`). The dialog is
  `export.xhtml`, opened by `SvalExport.askExport`.
- **Favorites menu:** "Export…" (`SvalFavoritesMenu.sys.mjs`) opens the same
  dialog.

## 5. Reading Sval's data

- **Workspaces:** read from the engine tree (`SvalEngine.tree()`) and walked with
  the `SvalPanelModel` helpers (`childrenByParent`, `workspaceIds`).
- **Favorites:** read from the favorites document (`SvalFavoritesStore`), its
  toolbar, menu and unfiled roots.
- **History:** read from Places for the Safari `History.json`.

Every format writer takes one in-memory harvest (`SvalExportModel.sys.mjs`),
built once from these sources. Writers are pure functions from the harvest to
bytes, so each one can be tested on its own.

## 7. Tests

Each test asserts what the person gets in the target browser:

- Writer tests: a known Sval tree and Favorites in, then parse the output with that
  target's real importer rules and check what comes out. Chromium's `Bookmarks`
  heading and toolbar flag, Firefox JSON roots, and the Safari ZIP's file names
  and metadata blocks.
- Round trip: export to HTML and JSON, then run Sval's own Import on the file
  (`SvalImportHtml`). The workspaces and Favorites should come back as folders with
  the same names and URLs.
- Complete data: the ZIP holds one plain-JSON file per engine document, each matching that document's `treeJson()`.
- Dialog: agent workspaces are not listed, the History checkbox appears only
  for Safari, and the notice shown is the chosen target's.
