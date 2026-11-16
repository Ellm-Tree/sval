---
title: Import and export
description: What each control in Settings › Workspaces › Import and export, the import dialog, and the export dialog does.
---

Import brings your tabs, bookmarks, and history from another browser into
Sval. Export saves your Workspaces and Favorites for another browser. It
can also save everything Sval keeps, as plain JSON.

## Settings › Workspaces › Import and export

- **Import data.** The import dialog opens.
- **Export data.** The export dialog opens.
- **Export all Sval data.** The export dialog opens with Sval (complete
  data) chosen. That's your Workspaces, Favorites, history, and settings
  from this device, unencrypted.

In the menu bar, **File › Import From Another Browser…** opens the import
dialog too.

## The import dialog

The dialog lists the browsers it finds on this computer. Each browser gets
one row, however many profiles it has. Sval can read Chrome, Edge, Brave,
Vivaldi, Arc, Dia, Safari, Orion, Firefox, and Zen. The browser you used
last starts checked.

- **A browser's row.** The row shows what the browser holds, like the
  number of Workspaces, tabs, and bookmarks. Checking the row opens its
  choices. The arrow folds the choices into one line that says what will
  import.
- **Import a bookmarks file…** Sval adds a row for a bookmarks HTML file.
  The file can also be the `Arc Data Export.md` file that Arc's data export
  makes.
- **Workspaces.** This lists each profile, Space, Workspace, or Tab Group
  the browser holds. Each one has a checkbox, a name you can change, and
  **Isolated**. It also has a count of its tabs, which shows a preview of
  those tabs.
- **Isolated.** The new Workspace gets its own cookies and sign-ins.
- **Choose how to import.** This sets where the browser's bookmarks go:
  **Into Favorites**, into a Workspace of their own with a name you give
  it, or **Don't import**.
- **Also import history from.** Sval brings in the browser's recent
  history.
- **Archive tabs you haven't used, like Arc did.** This shows for Arc. It
  turns on Archive idle tabs with the time Arc used. You can change that
  time next to the checkbox.
- **Move your passwords to your password manager.** This shows when a
  checked browser has saved passwords. Sval doesn't import passwords.
  **Show steps** lists how to export the passwords from that browser and
  import them into your password manager.
- **Open System Settings.** This shows for Safari until Sval has Full Disk
  Access on your Mac.
- **Import.** Sval imports what's checked. **Cancel** closes the dialog.

While the import runs, the dialog shows each browser's progress. When the
import ends, the dialog says what arrived, with **Done** to close it. A
browser that failed gets its own line, with **Try Again**,
**Import Bookmarks File…**, or **Send Report…**.

When you first set up Sval, the Import from another browser step offers
the same choices.

## The export dialog

- **The browser you're moving to.** This lists Chrome, Edge, Brave,
  Vivaldi, Opera, Arc, Dia, Firefox, Zen, Safari, **Another browser**, and
  **Sval (complete data)**.
- **What to export.** This lists your Workspaces, each checked, then
  **Favorites**. For Safari, **History** shows too. Agent Workspaces aren't
  listed.
- **Export…** Sval asks where to save the file. Once the file is saved,
  the dialog says where to import it in the browser you chose. **Done**
  closes the dialog.
- **Cancel.** The dialog closes.

Each Workspace becomes a folder of bookmarks. Your Favorites go to the new
browser's favorites bar. **Sval (complete data)** saves a ZIP of plain
JSON with a README. The ZIP holds no key.

## Related pages

- [Import from another browser](/docs/how-to/import-export/import-from-another-browser/)
- [Import a bookmarks file](/docs/how-to/import-export/import-a-bookmarks-file/)
- [Export to another browser](/docs/how-to/import-export/export-to-another-browser/)
- [Export all your Sval data](/docs/how-to/import-export/export-all-your-data/)
