# Sval — Import from other browsers

**Status:** Built.
**Date:** 2026-10-08
**Author:** John Postlethwait

---

## 1. What this is

Sval's target users arrive carrying something: windows full of tabs, tab groups,
Arc Spaces, years of bookmarks. An empty panel on day one loses them. Import reads what another browser on this computer holds and puts it where
Sval keeps that kind of thing. It runs from first run and from Settings.

**Success looks like:** a Chrome user with a Personal and a Work profile, three
windows and a dozen tab groups opens Sval, ticks Chrome, and lands in a panel
with a Personal and a Work workspace holding those windows and groups with
their names and colours, Work keeping its own sign-ins. Their bookmarks
are in Favorites, their history completes in the address bar, and Sval has
shown them how to move their passwords into the manager they chose. Sval read no
password and contacted no host.

## 2. Decisions and the reasons for them

| Decision | Reason |
|---|---|
| **Sources: Chrome, Edge, Brave, Vivaldi, Arc, Dia, Safari, Orion, Firefox, Zen, and a bookmarks file**, each browser listed once, however many profiles it keeps. | A browser is one application, and the user moves from the whole of it. |
| **Workspaces and Favorites are two kinds of saved thing, each with one job.** A workspace holds the tabs being worked with. Favorites are links that open from any workspace. | Arc puts everything in Spaces and has no bookmarks. Vivaldi keeps the two apart. Edge and Zen bolt per-workspace bookmark folders onto both. Sval tabs already persist until closed and restore on every launch (decision 0050), so a workspace is already the saved set, and per-workspace bookmark folders would duplicate it. |
| **Arc's pinned tabs arrive as ordinary tabs. Arc's Favorites and Zen's Essentials arrive as pins** (pins spec §10). | A tab in a workspace already stays until the user closes it. Arc's Favorites and Zen's Essentials are what Sval's pins are. |
| **Favorites are the engine's `favorites` document** (favorites-native spec), reached from the panel's Favorites menu. A favorite always opens a new tab in the current workspace, even when one with the same URL is already open. | One menu keeps Favorites out of the panel's tab tree. |
| **Each profile becomes one workspace**, holding its windows. What a browser already keeps as a workspace (an Arc or Zen Space, a Vivaldi or Edge Workspace, a Safari Tab Group) stays one workspace. | A profile is the workspace's analog, a set of tabs with sign-ins of its own. A browser's own workspaces are already that set. |
| **Bookmarks go where the user says, per source:** Favorites (default), a workspace (folders become groups), or not imported. | Some people use bookmarks as a library and some as project folders. Import explains the two kinds in two lines and lets the user decide. |
| **Imported bookmark folders fold** into Favorites' one tree (decision 0123). | A browser that imported from another keeps that import as a chain of wrapper folders. |
| **A Chromium browser's profiles keep their cookie jars apart.** When an import takes workspaces from two or more of one Chromium browser's profiles, every profile's but `Default`'s starts isolated (isolated workspaces spec §8). Each line's switch overrides it. The bookmarks workspace, holding every profile's bookmarks, is shared. | A second profile exists to keep its sign-ins apart. |
| **Names come from the source, else a suggestion the user sees and edits** ("Chrome Window 1", "Edge Workspace 2"). | Decision 0087. |
| **History is imported by default**, with a checkbox to leave it out. | It makes the address bar useful on day one. Firefox's own limits apply: 180 days, and at most 2,000 URLs from a Chromium browser. |
| **Sval reads no password.** Logins move by a guided hand-off: the source's own CSV export, the chosen manager's own import, then delete the CSV. | Sval keeps no credentials (decision 0078). Recent Chrome and Edge on Windows encrypt passwords with app-bound encryption another app cannot decrypt. On macOS, reading them needs a Keychain prompt and leaves Sval holding every password in plaintext. Every source can export a CSV, and every manager Sval offers imports one. |
| **Cookies are not imported.** | Cookies are bearer tokens that skip the second factor. Chromium's are Keychain- or app-bound-encrypted. A workspace may have its own isolated jar, so an imported cookie has no correct home. The user signs in again. |
| **Form data, extensions and payment methods are not imported.** | Form autofill is off in Sval. Extensions and payment methods are outside import's purpose. |
| **Bookmarks are read by Sval's own readers. Chromium and Safari history goes through Firefox's own migrators.** | Firefox's migrators insert bookmarks straight into Places (`MigrationUtils.insertManyBookmarksWrapper`), where Sval keeps none. Their history resources insert through `PlacesUtils.history.insertMany`, which merges by URL, and touch nothing but `History` and `Favicons`. |
| **Firefox's Chromium migrator is kept away from passwords.** Its `getResources` builds every resource before `migrate` filters them, so for a history import Sval shadows its passwords and payment-method resources on the instance, and `browser.migrate.chrome.extensions.enabled` is locked off. | With that pref on, the migrator lists the real Chrome profile's extensions whatever it is asked for. |
| **Importing twice adds workspaces again and skips any bookmark whose URL is already in Favorites.** | A second import of the same windows is a deliberate act. A second copy of every bookmark never is. |
| **Import contacts no host.** | Design spec §10.9. Edge Workspace names live only in Microsoft's cloud, so they arrive as suggestions. |
| **"Move to workspace ›" joins the row menu.** | After import, a Chrome user will reorganise a lot, and the panel can only move rows within one workspace. |

### 2.1 Rejected approaches

- **Arc's model, where bookmarks become pinned tabs in workspaces.** A
  thousand-bookmark library would flood the panel.
- **Per-workspace bookmark folders,** as Edge and Zen have. They duplicate what a
  workspace already is.
- **Opening the existing tab when a favorite is already open.** A favorite
  always opens a new tab.
- **Reading Chrome's encrypted session or passwords through a Keychain prompt.**
  The key that decrypts the session also decrypts every saved password and
  cookie, and the prompt asks for the login password on the user's first
  screen with Sval. It also does nothing for Windows.
- **Running Firefox's migration wizard.** It writes logins into the login
  store Sval turned off (decision 0078), and it inserts bookmarks into Places.
- **Firefox's own Firefox migrator.** It copies whole profile files and is
  meant for a profile refresh. It cannot merge into a live profile.

## 3. Where each kind of thing lands

| Source data | Lands in |
|---|---|
| A profile's open windows | One workspace, named for the profile, or for the browser when it keeps one profile. One window's tab groups become groups and its other tabs sit at the workspace's top level, in source order. With several windows, each is a group, "Window 1" onwards, holding its own groups and tabs. |
| An Arc or Zen Space, a Vivaldi or Edge Workspace | One workspace of its own, with its name, emoji and colour where it has them. Its profile's windows still land in the profile's workspace. |
| A tab group | A group, with its title and the nearest of Sval's colours (decision 0057). Chromium's and Firefox's nine colours map one to one, with Chromium's grey to `gray`. |
| An Arc or Zen folder | A group, nested as deep as the source nests it. |
| Arc pinned and unpinned tabs | Ordinary tabs in the Space's workspace, pinned ones first. |
| An Arc or Zen split view | A Split. |
| A Safari named Tab Group | One workspace with the group's name. |
| A tab | A tab, with the title and URL of its current history entry. Back and forward history is not carried. |
| A browser's several profiles' bookmarks | One tree, each root the profiles' roots in order, taking the bookmarks choice below once. Favorites skips a URL already there, so a bookmark the profiles share arrives once. |
| Bookmarks, "Favorites" chosen | The `favorites` document, in one batch with their pins. The source's toolbar is Favorites' top level, and its menu and other bookmarks arrive as folders named "Bookmarks Menu" and "Other Bookmarks" (decision 0123). Safari's Reading List arrives as a folder of its own, with the name Firefox's own Safari import gives it in the user's language. |
| Bookmarks, "a workspace" chosen | One new workspace, each folder a group and each bookmark a tab. Its name is suggested as "Chrome Bookmarks" in an editable field beside the choice (decision 0087). |
| Arc Favorites, Zen Essentials | Favorites, pinned in every workspace (pins spec §10). |
| Arc's archived tabs | The Archive (idle-tab archive spec §7.6, decision 1702). |
| History | Places, through `PlacesUtils.history.insertMany`. |

Tabs are created unloaded. Imported workspaces are inactive and are data only
until visited.

A window, Space or Tab Group left empty once unimportable tabs are dropped is
not offered, so no blank workspace arrives.

**A file brings web addresses alone.** A bookmarks file or Arc's export
carries http, https and ftp addresses, and its other entries join the
skipped count. Anyone can write such a file, and a `file:` address in it
would arrive marked local, opening with this device's trust (decision 1372).
A `file:` address comes only from a browser profile on this device.

**The first-launch workspace is reused.** On first run the profile's unnamed,
empty first workspace takes the first imported window, so no blank workspace
is left behind.

## 4. Sources

Paths are per platform. A source or profile that is not present is not listed.
Nothing is written under the directory a reader reads (`SvalImportFiles`):

- A plain file (JSON, a property list, a session log) is read where it is.
- A SQLite database the page only counts from is opened where it is,
  immutable and unlocked, through `MigrationUtils.getRowsFromDBWithoutLocks`.
- A SQLite database whose rows are imported is copied with its `-wal` and
  `-shm` into a temporary directory, and the copy is opened, so a running
  browser's lock never matters. The copy is deleted when the read ends,
  whether it succeeded or not.

### 4.1 Chrome, Edge, Brave, Vivaldi and Dia

`SvalImportChromium` reads them all. Brave's and Vivaldi's layout is Chrome's
under their own data paths. Vivaldi's Workspaces arrive as workspaces with
their emoji. Dia keeps its open tabs in an encrypted database of its own, so
only its bookmarks, history and login count import, and it is listed on macOS
alone.

- **Profiles:** `Local State`'s `profile.info_cache` gives each profile directory
  and its display name, under Chrome's data path (macOS
  `~/Library/Application Support/Google/Chrome`, Windows
  `%LOCALAPPDATA%\Google\Chrome\User Data`, Linux `~/.config/google-chrome`) and
  Edge's (`Microsoft Edge`, `Microsoft\Edge\User Data`, `microsoft-edge`).
- **Open windows:** the newest `Sessions/Session_<ts>` holding a marker command
  (id 255), in Chromium's SNSS format: a `SNSS` magic and version 3, then
  commands of a `uint16` size, a `uint8` id and a payload. The reader replays
  the log as Chromium's `CreateTabsAndWindows` does, last write wins, and
  stops cleanly at a truncated tail. It uses commands 0 (tab's window), 2 (tab
  index), 6 (navigation: URL and title, a Pickle), 7 (selected navigation),
  9 (window type; only normal windows import), 16 and 17 (tab and window
  closed), 25 (tab's group token) and 27 (group title and colour, a Pickle).
  Source: `components/sessions/core/session_service_commands.cc`.
- **A running browser on Windows:** Chrome and Edge hold the session log they
  are writing without sharing it for reading, so the read fails with
  `NotAllowedError` until the browser quits (`SvalImportFiles.heldOpen`). The
  row says "Can't read Chrome while Chrome is open. Quit Chrome, then try
  again.", and when only some profiles failed, the profile count is followed
  by "Quit Chrome, then try again."
- **Edge Workspaces:** a window carrying Edge's command 48 (a pickle of the
  window id and the Workspace's id, a string) is an Edge Workspace. A window
  without it is "Edge Window N". This is observed behaviour of an
  undocumented command, seen on Edge for macOS 2026-10 and for Windows
  2026-11. The reader never fails on its absence.
- **Edge Workspace names and colours:** Edge keeps them, by Workspace id, in
  its sync database, a LevelDB at `Sync Data/LevelDB` that a running Edge
  leaves readable (`SvalImportLevelDB`). Each `edge_workspace-dt-<id>` record
  is a protobuf whose field 2 is the Workspace: its field 1 the id, and its
  field 4 the name (field 1) and colour (field 2, ARGB, mapped to the
  nearest token). Records of a Workspace's tabs, under the same prefix, have
  no field 4 and are passed over. A Workspace with no record is suggested
  as "Edge Workspace N". Observed on Edge for Windows 2026-11.
- **Edge's New Tab page** is skipped as an empty tab. Edge logs it as
  `edge://newtab/`, or, signed in with its news feed, as the MSN page it
  shows, `https://ntp.msn.com/edge/ntp`.
- **Encrypted sessions:** Chromium's `kEncryptSessionStorage` writes an
  encrypted copy (`Sessions_Encrypted/`, SNSS version 5) beside the cleartext
  one. Its later stage stops writing the cleartext file. When only the encrypted copy exists, the source's row
  offers bookmarks and history, and for open tabs shows one step: "In Chrome,
  choose Bookmark All Tabs… into a new folder, then import that folder into a
  workspace." That path is the bookmarks-into-a-workspace choice of §3.
- **Bookmarks:** `Bookmarks`, plain JSON with `roots.bookmark_bar`,
  `roots.other` and `roots.synced`.
- **History:** Firefox's `ChromeProfileMigrator` or Edge's `chromium-edge`
  migrator, through `MigrationUtils.getMigrator(key)` and `migrate(HISTORY,
  false, profile)`. That runs only the history resource.

### 4.2 Arc

- **Sidebar:** `StorableSidebar.json` in Arc's root (macOS
  `~/Library/Application Support/Arc/`, Windows
  `%LOCALAPPDATA%\Packages\TheBrowserCompany.Arc_*\LocalCache\Local\Arc\`), plain
  JSON. Its format is undocumented. The reader follows the prior art: Helium's
  `add-arc-importer.patch`, arc2zen and the Raycast extension.
  - The data container is the one after the `{global: {}}` entry in
    `sidebar.containers`. Its `spaces` and `items` are flat arrays of
    alternating id and object.
  - A Space's `newContainerIDs` pairs markers with container item ids:
    `{"pinned": {}}`, and `{"unpinned": {"_0": …}}` whose payload is
    `shared` or a machine's and window's own (`desktop`), so a Space can hold
    several unpinned containers. `containerIDs` is a legacy copy naming one
    of each kind with bare `"pinned"` and `"unpinned"` markers, read when
    `newContainerIDs` is absent. The case names come from Arc 1.169's Swift
    metadata (`SpaceModel`'s `legacyContainerIDs`). Every listed container is
    read, and an item two of them list arrives once. Each container's
    `childrenIds` gives its items in order.
  - A tab is an item with `data.tab`. Its title is `title` when the user
    renamed it, else `data.tab.savedTitle`, and its URL is
    `data.tab.savedURL`. A tab's emoji, which Arc shows in place of its
    icon, is `data.tab.customInfo.iconType.emoji_v2`, and arrives as the
    tab's emoji. A folder is an item with `data.list`. A split view
    (`data.splitView`) holds tabs as its children, which import as ordinary
    tabs in its place. `arc://` URLs are skipped, as are items of any other
    kind (`welcomeToArc`, easels, notes), which are counted and reported.
  - The Space's emoji is `customInfo.iconType.emoji_v2`. A Space may carry an
    SF Symbol name in `iconType.icon` instead, and then arrives with no emoji.
    Its colour is `customInfo.windowTheme.primaryColorPalette.midTone` (RGB,
    0–1), mapped to the nearest of the nine tokens by hue. A Space with no
    `windowTheme` arrives with no colour.
  - Favorites are each profile's container in `topAppsContainerIDs`, matched to
    profiles by `directoryBasename`. The default profile's marker is
    `{"default": true}`.
- **Profiles:** ordinary Chromium profiles under `User Data/`. A Space names
  its profile in `space.profile`.
- **History:** `ChromeProfileMigrator` subclassed in Sval's own module, with
  `_getChromeUserDataPathIfExists` returning Arc's `User Data`. No patch is
  needed.
- **Bookmarks:** Arc's Chromium `Bookmarks` file, when one exists, read as
  Chrome's.
- **Archived tabs:** `StorableArchiveItems.json`, beside the sidebar, arrive
  in the Archive (idle-tab archive spec §7.6, decision 1702).
- A sidebar that fails to parse is reported as "Quit Arc and try again".
- A Space holding nothing importable is not offered.
- **Arc's export file:** Arc's data export, a button in its settings, writes
  `Arc Data Export.md`, which the bookmarks-file picker accepts
  (`SvalImportArcExport`). Each Space is a `#` heading and each folder a
  heading one level deeper than what holds it, so a folder in a folder is
  `###`. Each tab is a `- <address>` line with no title. A Split's tabs are
  listed as plain tabs, and an empty folder, such as a Live Folder with
  nothing fetched, is a heading with nothing under it. The file holds no
  colour, emoji, Favorites, profile or archived tab. Each Space arrives as a
  Workspace, each folder as a group, and each tab with no title, so the panel
  names it by its host until it loads.

### 4.3 Safari (macOS)

- **Full Disk Access:** every Safari file is protected by TCC. Sval checks by
  reading one byte of `Bookmarks.plist`, as Firefox's
  `SafariProfileMigrator.hasPermissions` does. Without access, the row says
  so, and a button opens
  `x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles`.
  The row re-checks when Sval regains focus.
- **Open windows and Tab Groups:**
  `~/Library/Containers/com.apple.Safari/Data/Library/Safari/SafariTabs.db`,
  SQLite. The schema is undocumented. On Safari 26 it is:
  - `windows` (`local_tab_group_id`, `active_tab_group_id`).
  - `bookmarks`, holding tabs (`type = 0`, `parent` = their group, ordered by
    `order_index`, `deleted = 0`) and groups (`type = 1`). Unnamed per-window
    groups have no parent and are titled "Local" or "Private". Named Tab Groups
    are `type = 1, subtype = 0` folders.
  - Private groups are never imported.
  - Where named groups sit under a non-default profile has not been observed.
    The reader is built against a fixture made on a Mac that has some.
- **Bookmarks:** `~/Library/Safari/Bookmarks.plist`, a binary plist, read with
  Firefox's `PropertyListUtils`. Entries marked `ShouldOmitFromUI` are skipped.
- **History:** `SafariProfileMigrator`, history resource only.
- **Passwords:** the hand-off's export goes through the Passwords app, whose
  export is a plain CSV.
- **Orion** (`SvalImportOrion`), also WebKit on macOS, brings open windows,
  bookmarks and history from its own property lists and SQLite history. Its
  passwords sit in its own keychain with no export, so the hand-off leaves
  Orion out.

### 4.4 Firefox and Zen

- **Profiles:** `profiles.ini` under Firefox's root (macOS
  `~/Library/Application Support/Firefox`, Windows `%APPDATA%\Mozilla\Firefox`,
  Linux `~/.mozilla/firefox`, `~/.config/mozilla/firefox`, the Snap's
  `~/snap/firefox/common/.mozilla/firefox`, and the Flatpak's `.mozilla/firefox`
  and `config/mozilla/firefox` under `~/.var/app/org.mozilla.firefox`). Sval's
  own profile is never listed.
- **Open windows:** `sessionstore-backups/recovery.jsonlz4` while Firefox runs,
  else `sessionstore.jsonlz4`, read with `IOUtils.readJSON(path, { decompress:
  true })`. Each window's `tabs` give the entry at `index`. Its `groups` give
  each tab group's name and colour, which are already Sval's tokens, and a
  tab's `groupId` places it.
- **Bookmarks and history:** a copy of `places.sqlite`, opened read-only through
  `Sqlite.sys.mjs`. Bookmarks come from `moz_bookmarks` joined to `moz_places`.
  History comes from `moz_historyvisits` within the same 180-day window, and is
  inserted through `PlacesUtils.history.insertMany`.
- **Zen** (`SvalImportZen`) is a Firefox, read by Firefox's reader. It adds
  its sidebar, `zen-sessions.jsonlz4`: every Space becomes a workspace with
  its name, emoji and colour, its folders become groups, its split views
  become Splits, and its Essentials become pins.

### 4.5 A bookmarks file

The page's "Import a bookmarks file…" takes a bookmarks HTML file
(`SvalImportHtml`, favorites-native spec §15.3) or Arc's `Arc Data Export.md`
(§4.2). Either arrives as a source of its own, with the same bookmarks choice.

## 5. The import page

One page serves both entry points:

- **First run:** the reserved step after storage (first-run spec §3.1 item 4),
  on the new-user path only, as `SvalFirstRunModel` already gates it.
  `importAvailable` is true when at least one source is detected.
- **Settings:** an Import section in Sval's **Workspaces** category, with "Import
  from another browser…", which opens the page in a dialog over Settings.

From top to bottom:

1. **Two lines:** "Workspaces hold the tabs you're working with. Favorites are
   links you can open from any workspace."
2. **One row per browser**, named for the browser alone, with what it holds:
   "Chrome — 2 workspaces, 84 tabs, 1,210 bookmarks". A profile holding
   nothing brings nothing, and one that cannot be read is left out; the row
   fails only when none can be read. The readable browser whose profile
   directory changed last is ticked, because no browser says portably which
   is the system's default. Every other row starts unticked. With nothing
   ticked, Continue imports nothing, which follows first run's rule that
   Continue keeps the default shown.
3. **A ticked row expands:**
   - One line per workspace the browser brings, one per profile and one per
     Space, Workspace or Safari Tab Group, each with a checkbox (ticked), an
     editable name (decision 0087) and an Isolated switch. Each line expands again to show its
     groups, with names and colours, and its tabs by title, read-only, so the
     user can tell which window is which.
   - The bookmarks choice: Favorites, a workspace, or not imported.
   - A History checkbox, ticked.
   - The source's note when one applies: Safari's Full Disk Access, or Chrome's
     encrypted-session step.
4. **The logins hand-off** (§5.1), under the source rows.
5. **Import** closes the page, and the panel of the window that opened it runs
   the import. The panel's message area says "Importing…", then what arrived
   ("Imported 3 workspaces and 1,210 favorites.") or that some of it could not
   be read. In first run, the flow moves on as soon as Import is pressed.

The dialog is `chrome://browser/content/sval/import.xhtml`, opened through
`gDialogBox`, as first run and the new-workspace dialog are.

### 5.1 The logins hand-off

The hand-off appears for every imported Safari and Firefox source, and for a
Chromium source whose login table has rows. Only that count is read, never a
row.

- **In first run** it is part of the password manager step, which comes after
  import, once a manager is chosen.
- **In Settings** it sits on the import page under the source rows, for every
  ticked source that has logins.

It shows three numbered steps for that source and the manager in
`browser.sval.passwordManager`. Each menu path comes from its vendor's help
pages; Arc has none and uses Chromium's own settings page.

1. Export from the source, with the source's own menu path.
2. Import into the manager, with the manager's own menu path.
3. Delete the exported file.

With no manager chosen, step 2 says to import the file into whichever manager
the user picks. The steps are strings in Sval, one per source and per manager,
and a test checks every pair has both.

## 6. Favorites and Move to workspace

- **Favorites** are reached from the panel's Favorites menu, under the
  workspace (favorites-native spec). A favorite opens like any new tab,
  through `PlacesUIUtils.openNodeIn`, and is filed where a new tab is filed.
- **Move to workspace ›** sits in the row menu after "Move to group ›" on tab
  and group rows. It lists every other workspace and "New workspace…". The row
  lands where a moved row lands when nobody named a place
  (`SvalPanelModel.defaultSlot`): a tab after the target's top-level rows, a
  group, with everything in it, after its groups. The window stays on its
  workspace. A moved tab that was live in this window leaves it, and it
  materialises wherever the target workspace is shown, as a tab arriving by
  sync does.

## 7. Architecture

Every module is an added file in `chrome/browser/components/sval/`, registered
in `moz.build` and in `test_sval_log.js`'s guarded list. No Mozilla file is
patched.

| Module | Job |
|---|---|
| `SvalImportSources.sys.mjs` | Finds installed browsers and their profiles on this platform, and counts what each holds. |
| `SvalImportFiles.sys.mjs` | How every reader opens another browser's files (§4). |
| `SvalImportLevelDB.sys.mjs` | A LevelDB database, read-only: its logs and Snappy-compressed tables. Serves Edge's Workspace names (§4.1). |
| `SvalImportChromium.sys.mjs` | SNSS session reader, `Bookmarks` reader, history through Firefox's migrators. Serves Chrome, Edge, Brave, Vivaldi and Dia. |
| `SvalImportArc.sys.mjs` | Sidebar reader, and the Arc history migrator subclass. |
| `SvalImportArcExport.sys.mjs` | Arc's `Arc Data Export.md`. |
| `SvalImportSafari.sys.mjs` | Full Disk Access check, `SafariTabs.db` reader, `Bookmarks.plist` reader, history through `SafariProfileMigrator`. |
| `SvalImportOrion.sys.mjs` | Orion's windows, bookmarks and history. |
| `SvalImportFirefox.sys.mjs` | Session, bookmark and history readers. |
| `SvalImportZen.sys.mjs` | Zen's sidebar, on top of Firefox's reader. |
| `SvalImportHtml.sys.mjs` | A bookmarks HTML file. |
| `SvalImportModel.sys.mjs` | Pure. Every reader returns one shape: windows, each a tree of groups and tabs, and a bookmark tree. The model turns that and the user's choices into tree operations and favorites to add, de-duplicates bookmarks against Favorites, maps colours and numbers suggested names. |
| `SvalImport.sys.mjs` | Runs one import: reads, applies the operations to the engine as one batch, writes the favorites and their pins as one batch, inserts history into Places, and reports counts. |
| `import.xhtml`, `import.js`, `import-picker.js`, `import.css` | The page. |

**One import is one write.** `SvalDocumentOps`' `batch` operation applies a
list of operations under one `mutate`, so an import of hundreds of tabs is one
round trip to the sync worker and one sync pass. Each operation mints its own
id and time.

## 8. Privacy

- **Logs** carry counts, source keys ("chrome") and error names only.
  No URL, title, group, Space or profile name, and no path under a user's home.
- **No network.** Every reader is local file I/O. The nightly network-contact
  check covers an import run.
- **Temporary copies** of imported databases live under the profile's
  temporary directory and are removed in a `finally`.
- **No password is read.** The login count is a `SELECT count(*)` on a copied
  `Login Data`. Safari and Firefox logins are not counted, and their hand-off
  is always offered.

## 9. Testing

- **xpcshell:**
  - Each reader runs against fixtures in `test/xpcshell/data/import/`, all made
    from synthetic browsing: an SNSS file with two windows, a group of each
    colour, a closed tab and a truncated tail; one with only
    `Sessions_Encrypted/`; an Edge session with and without command 48; an Arc
    sidebar with nested folders, two profiles and Favorites; a `SafariTabs.db`
    with a named Tab Group; a `Bookmarks.plist`; a Firefox `recovery.jsonlz4`
    with a tab group, and a `places.sqlite`.
  - `SvalImportModel` on its own: window to workspace, groups and colours,
    bookmarks to a workspace, suggested names, the first-launch workspace
    reused, and a second import skipping known bookmark URLs.
- **Browser tests:**
  - From Settings, against fixture profiles: workspaces appear in the switcher
    with their groups, favorites appear in Favorites and open a new tab in
    the current workspace, and imported history is in Places.
  - The first-run step is shown when a source is found, skipped when none is,
    and never on the joining path.
  - Move to workspace, for a live tab and for a group.
  - The hand-off names the right source and manager.
- **Privacy:** an import of fixtures carrying marker URLs and titles, run at
  log level `All`, leaves no marker in the console.

## 10. Out of scope

- Reading any browser's encrypted session or passwords.
- Opera and other Chromium browsers. Their layout is Chrome's, so each is a
  path entry when wanted.
- Edge Workspace names, which live only in Microsoft's cloud.
- Back and forward history for imported tabs.

## 11. Preselection and empty sources

Covered in §5 (the browser used last is ticked) and §3 (nothing empty is
offered).
