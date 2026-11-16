# Sval — Favorites without Places

**Status:** Built, the extensions' `bookmarks` API (§8) included.
**Date:** 2026-10-21
**Author:** John Postlethwait
**Decisions:** 0099, 0108 and 0123 record the core.
**Builds on:** design spec §5.6 (bookmarks reuse the workspace tree's
structure), `2026-10-20-pins-design.md`, `2026-10-19-idle-tab-archive-design.md`
(the Archive, an engine-only document with no Firefox store behind it).

---

## 1. What this is

Sval's Favorites live in one place: the engine's `favorites` document. Places
holds no bookmarks, and nothing copies Favorites into it.

Everything that reads or writes a favorite talks to the document: the
Favorites menu, the star and ⌘D, the address bar, the pins row and home
tiles, Undo, import and export. Places keeps history, and the favicons it
stores for history.

**Success looks like:** a user sees Firefox's bookmark behaviour. ⌘D stars
the page, typing "gma" in the address bar offers their Gmail favorite with its
star, the Favorites menu shows their folders with their icons, drag and drop
reorders them, Undo takes back the last change, and export writes the file.

## 2. Why

- **One store of one thing.** The pin flag, pin order and pin scope live only
  in the document. A second copy of the name, address and tree in Places
  needs a rule for every difference, waits on every crossing, and lets a
  delete made while the copy was not running come back.
- **Firefox's bookmark product is mostly gone.** Sval hides the Library
  (0099), drops tags and keywords, reads every import itself
  (`SvalImportHtml` and the other readers), writes its own export
  (`SvalExportModel.bookmarksHtml`), and shows one root (0123). What Places
  gave is listed in §4, and each item has a small replacement.
- **One write.** Making a pinned favorite is one document batch.

## 3. Rules and the reasons for them

| Decision | Reason |
|---|---|
| **The `favorites` document is the only store.** Nothing of Sval's writes or reads Places' bookmarks. | Decision 0108. The document syncs, holds pins, and is merged by the engine's tested rules. |
| **The document has the tree's shape,** with one extra content field, `added` (§8.4). Kinds `favorite`, `folder`, `separator`; the three roots; content, placement and lifecycle groups as they are. | The engine's merge, absence rule and repairs already cover it. |
| **A favorite keeps a twelve-character guid as its key**, minted by Sval with `PlacesUtils.history.makeGuid()`, and its node id stays `favoriteId(guid)`. | Pins, pin pages (`SvalPinTab`), the home page's messages and the engine's `addFavorite` all key by guid. `makeGuid` is Places' random id, used only as a generator. |
| **The address bar's favorites come from a Sval `UrlbarProvider`**, registered with Firefox's `UrlbarProvidersManager`, whose results carry `RESULT_SOURCE.BOOKMARKS`. | Firefox's own view, muxer, search mode and restrict token then treat them as bookmarks: the row gets `type="bookmark"` (`UrlbarView.mjs`), `*` and the Favorites search mode reach it, and the home page's field gets it through the same providers (`SvalHomeSearchParent`). No second search UI. |
| **Favorites autofill as bookmarked origins do,** through a Sval heuristic provider and a one-line patch that gives it the autofill group. | Firefox autofills a bookmarked origin regardless of frecency (`UrlbarProviderAutofill`, `n_bookmarks > 0`). Without it, "gma" stops completing to a favorite the user rarely visits. A heuristic from an unknown provider falls to `HEURISTIC_FALLBACK` with a console error (`UrlbarUtils.getResultGroup`), so only a patch reaches the group. |
| **The star and ⌘D read and write the document.** The header's button follows the document. It ignores `#star-button[starred]`. The star adds or removes; ⌘D only adds, and on a page that is a favorite already removes nothing. Every add and removal, the page menu's Add Link to Favorites included, shows Firefox's `ConfirmationHint` on the star: "Added to Favorites", "Removed from Favorites" or "Already in Favorites", from Sval's own `sval/favorites.ftl`. | `BookmarkingUI` reads Places, which holds nothing. Sval answers ⌘D itself (`SvalFavorites.mount`, `Browser:AddBookmarkAs`). Firefox's ⌘D on a bookmarked page opens its edit panel and never removes it (`PlacesCommandHook.bookmarkPage`), and a removal made silently by a key is one the user does not see happen. |
| **The Favorites menu is drawn by Sval from the document,** as native XUL menus, with drag and drop. | `PlacesMenu` draws only Places queries. The panel's other menus are Sval's own. |
| **Undo is one Sval stack of document writes.** Each entry is one batch that restores what the change replaced. | One store, one stack. Other devices' changes stay off it. |
| **Opening a favorite goes through `PlacesUIUtils.openNodeWithEvent` and `openNodeIn`,** given a node-shaped object `{ type: RESULT_TYPE_URI, uri, bookmarkGuid }`. | That function holds `browser.tabs.loadBookmarksInTabs`, the empty-tab reuse, Sval's history-in-tabs patch, `markPageAsFollowedBookmark`, bookmarklet principals and background loading. `PlacesUtils.nodeIsBookmark` accepts any object with a `bookmarkGuid` and `PlacesUIUtils.isURILike` any with a `uri`. Use what exists. |
| **Each device keeps its favorites' icons in a small local store**, read before `page-icon:`. Icons do not sync (0108). | Places stores an icon only for a page in `moz_places`, and copies a redirect target's icon to a bookmarked source (`FetchPageInfo` in `FaviconHelpers.cpp`). Without bookmarks, a favorite saved as `gmail.com` gets no icon, icons expire with history (`PlacesExpiration`'s `foreign_count = 0` clauses), clearing history on quit (a synced setting) clears them, and with history off Places stores none ("a privacy leak" unless bookmarked). §5.4. |
| **Import and export use Sval's own readers and writer,** pointed at the document. | `SvalImport` plans favorites from every reader and writes them as one batch. Export writes its own HTML. |

### 3.1 What syncs, and what is never deleted

- **The engine's favorites document is the only copy** (0108). Places stays
  for history only.
- **What syncs per Favorite** is its name, address, folder, pinned and
  "Show in", plus its order: the document's content, placement and lifecycle
  groups (§16). The guid is the node's key, not user data.
- **A pin's open page is local to the device and never syncs.** Navigating
  within a pin, Gmail to Calendar, is a local concern. A restart, a close or
  an idle unload resets the pin to its saved address, as Arc does (pins spec
  §5).
- **Nothing is deleted for being unrecognised.** A pin page, an icon or
  anything else keyed by a Favorite the document does not hold yet is left
  alone. Only an explicit action deletes: the user's delete, unpin or scope
  change on this device, or one made on another device that a pass reports
  as removed (`removedIds`). Absence from a read is never a delete (§5.5).
- **Extensions keep the `bookmarks` API,** backed by the document (§8).
- **Same-named folders and same URLs from two devices are not combined.**
  Two devices that first share a folder keep both devices' favorites, as they
  keep both devices' tabs.

### 3.2 Rejected approaches

- **A two-way mirror between the document and Places.** Two stores of one
  thing (§2).
- **A one-way projection, document to Places, never read back,** so Firefox's
  address bar, star, autofill and icon anchoring work unchanged. It is a
  second store with an echo rule and an apply queue, and it drifts after a
  crash. The replacements in §4 are smaller.
- **A Sval search list beside the address bar's.** Two search UIs. Firefox's
  provider API gives one.
- **Dropping favorites from the address bar.** Firefox users expect them, and
  Settings already has the switch (`browser.urlbar.suggest.bookmark`,
  labelled Favorites).
- **Syncing icons.** Decision 0108.

## 4. What Places gave, and what replaces it

| Firefox's feature | Where Firefox has it | Sval's replacement |
|---|---|---|
| **⌘D and the star.** | `BookmarkingUI`, `PlacesCommandHook` | The header button's `toggle` asks the document whether the page's exposable URL is a favorite, and adds or removes in one write; ⌘D's `addPage` only adds. The button's state comes from the document on tab select, location change and `sval-favorites-changed`. |
| **"Add Link to Favorites"** in the page menu. | `SvalFavorites._mountLinkItem` | Calls the same `add`. |
| **Address bar suggestions.** `UrlbarProviderPlaces` matches bookmark titles and URLs, marks them `RESULT_SOURCE.BOOKMARKS`, and fills the Favorites search mode and `*`. | `UrlbarProviderPlaces`; `favorites-wording.patch` names them | `SvalFavoritesProvider` (§5.2). |
| **Autofill of bookmarked origins** regardless of frecency. | `UrlbarProviderAutofill` (`n_bookmarks > 0`) | A heuristic provider for favorites' origins and URLs, plus a patch to `UrlbarUtils.getResultGroup` (§5.2). |
| **Frecency weight for favorites' pages.** A visit from a bookmark (`visit_type` 3) or to a bookmarked page (`source` 2) weighs high; an unvisited bookmark gets one sample. | `calculate_frecency` in `SQLFunctions.cpp` | Opening a favorite calls `markPageAsFollowedBookmark` (through `openNodeIn`), so those visits keep their weight. Link visits to a favorite's page lose the bookmarked weight in history ranking; the provider ranks the favorite itself (§5.2), so the row still shows. |
| **The bookmarks menu.** `PlacesMenu` over a `place:` query: nesting, live updates, icons, drag and drop, middle-click, keyboard. | `PlacesMenu` | Sval's own menu builder (§5.3). |
| **Bookmark edits** as `PlacesTransactions`. | `PlacesTransactions` | Document writes with Undo entries (§5.1). The context menu finds its target by the builder's `data-guid`. |
| **Undo.** | `PlacesTransactions` | One stack (§5.1). |
| **Open, Open All, `browser.tabs.loadBookmarksInTabs`, bookmarklets.** | `PlacesUIUtils.openNodeWithEvent`, `openNodeIn` | The same `PlacesUIUtils` calls with a node-shaped object. Open All reads the folder's favorites from the document. |
| **Favicons.** Places keeps a bookmarked page's row and icon from expiring. | `PlacesExpiration`, `FaviconHelpers.cpp` | `page-icon:` and the favicon service answer for history. The local icon store (§5.4) covers what bookmarks anchored. |
| **HTML import** into Places. | `BookmarkHTMLUtils.importFromFile` | One document batch: the folders, the favorites and their pins. Known URLs come from the document. |
| **Export.** | `BookmarkHTMLUtils` | `SvalExport.readFavorites` walks the document's three roots. |
| **Home tiles moved into a folder.** | | A document move, pin and unpin in one batch (`SvalHomeFavoritesParent`). |
| **Pinning a tab** makes a favorite and pins it. | | One batch: add and pin (`SvalPinsRow`). |
| **Settings › Home › "Use Favorite…"** opens Firefox's `selectBookmark.xhtml`, a Places tree. | Firefox `home.js`; `favorites-wording.patch` | The button opens Sval's Favorites menu as a popup at the button, from the same builder (`settings-favorites.js`). A favorite sets the home page; a folder sets each favorite in it, as Firefox's dialog does. |
| **Extensions' `browser.bookmarks`.** | `ext-bookmarks.js` | The same API over the document (§8). |
| **`default-bookmarks.html`** fills a new profile's Places. | `jar.mn` override | Sval's empty override keeps Places empty. |
| **Places' roots and guids,** which Mozilla's backup, import and undo code expect. | Places | Places keeps its roots, empty. Nothing of Sval's reads them. |

Firefox's own bookmark entry points (`SvalFavorites` `HIDDEN_ITEMS`,
`HIDDEN_PLACES_ITEMS`, `DISABLED_KEYS`, `_replaceLibrary`) stay hidden: they
would show an empty store.

## 5. Architecture

### 5.1 `SvalFavoritesStore.sys.mjs`, one per profile

- **Reads** the document through `engine.favorites("favorites")` after each
  pass that changed it and after each of its own writes, and keeps that read
  whole, as the panel keeps the tree's (0055). It never edits the read.
  `FAVORITES_CHANGED_TOPIC` fires after each.
- **Answers** `isFavorite(url)`, `favoritesWithUrl(url)`, `children(guid)`,
  `folders()` (Move to), `home()`, `isPinned`, `pinScopeOf`, and `all()` for
  the provider and export.
- **Writes** add, rename, set address, move, delete, new folder, new
  separator, pin, unpin and scope as engine batches, each one write. A
  deletion is `remove(id)` (0115).
- **Undo.** Before each write it reads what the write replaces, and pushes
  the batch that puts it back: a rename's old name, a move's old parent and
  neighbours, a delete's whole subtree as `addFavorite`s with their guids,
  each pin's `setHomePin` and `setPinScope`. Undo posts that batch. Re-adding a
  removed id at a new stamp is news to every peer (0014, 0016); an engine test
  proves it. A pin-a-tab's undo still hands the page back first.
- **Ready** is one promise: the document is registered and this device's
  copy has been read (`engine.profilePass`). Writes wait on it.
- The document is registered when the profile's engine starts, as the tree
  is, first run included, so an import there lands in it.
- Private windows read and never write.

`SvalFavorites.sys.mjs` keeps the window's entry points (mount, the link item,
the button, `open`, `addressOf`, `isBookmarklet`) and calls the store.

### 5.2 `SvalFavoritesProvider.sys.mjs`

- A `UrlbarProvider` of type `PROFILE`, registered on the `urlbar`
  providers manager at startup. Active when `queryContext.sources` holds
  `RESULT_SOURCE.BOOKMARKS` and `browser.urlbar.suggest.bookmark` is on, or in
  the Favorites search mode, or after `*`.
- Matches every token against the favorite's name and URL at word
  boundaries, as `UrlbarProviderPlaces` matches bookmarks
  (`MATCH_BOUNDARY`). Leaves out bookmarklets, as Firefox does under
  `browser.urlbar.filter.javascript`.
- Each result is a `URL` result with `source: BOOKMARKS`, title, URL and
  `page-icon:` (or the local icon), and `payload.frecency` so the muxer's
  `orderBy: "frecency"` places it. The score is the page's own `moz_places`
  frecency, raised to what Places gives an unvisited bookmark when that is
  higher (one high-weight sample at the favorite's `contentAt`). The muxer
  then drops the history row for the same URL (same prefix, other provider),
  so one row shows, with the star. A favorite open in a tab yields to the
  switch-to-tab row, as the muxer does already.
- With an empty string in the Favorites search mode it lists favorites by
  that score, as Firefox lists bookmarks.
- **Autofill:** a second, `HEURISTIC` provider in the same file fills an
  origin, then a URL, from favorites when Firefox's autofill found none.
  `patches/favorites-autofill-group.patch` adds its name beside
  `UrlbarProviderAutofill` in `UrlbarUtils.getResultGroup`, with a `Sval:`
  header saying no API assigns a heuristic's group.
- No Sval log line carries a query, a name or a URL (rule 10).

### 5.3 The Favorites menu

- Built from `children(guid)` into XUL `menu` and `menupopup` elements,
  Gecko-drawn (`nonnative`, `toolbar-menupopup`), each folder filled
  on its `popupshowing` and rebuilt on `FAVORITES_CHANGED_TOPIC` while open.
  An empty folder shows the same empty item `PlacesMenu` shows.
- Each item carries `data-guid`. `SvalFavoritesMenu.targetOf` reads it.
- Command, middle-click and modifier clicks go to `SvalFavorites.open`.
- **Drag and drop:** reorder and move into folders, with the drop line
  `places-popup` draws, as one document move. A dragged favorite carries
  `text/x-moz-url` and `text/uri-list`, so dropping it on a page or another
  app works. A link dropped on the menu adds a favorite there, as
  `PlacesControllerDragHelper` does.
- Keyboard, type-ahead and screen readers come with XUL menus;
  `browser_sval_favorites_menu.js` checks accessibility.
- The panel's menu and the menu bar's leave out every pin, which the pins
  row shows (pins spec §8.2).
- The same builder fills the "Use Favorite…" popup (§4).

### 5.4 `SvalFavoriteIcons.sys.mjs`

- A device-local file in the profile, through `SvalJSONFile`: favorite URL
  to a small `data:` icon. Never synced.
- Filled when a tab showing a favorite's URL sets its icon
  (`TabAttrModified`, the tab's `image`, which `LinkHandlerParent` makes a
  `data:` URL), and when a tab Sval opened from a favorite settles after
  redirects, so `gmail.com` gets Gmail's icon. Never from a private window.
- Read first by the menu, pins, tiles and provider, then `page-icon:`.
- An entry goes only when a favorite holding its URL is explicitly deleted
  or re-addressed, here or by a pass's `removedIds`, and no other favorite
  holds the URL (§3.1). A URL the document does not hold yet keeps its icon.

### 5.5 Pins and what is local

- A pin's page (`SvalPinTab`, `SvalPinPages`) stays device-local, keyed by
  the Favorite's guid and the workspace. Its current address within the
  site, its history and its loaded state never reach the document.
- Restart, close and idle unload reset it to the saved address.
- A pin page closes only for an explicit change: Unpin, Delete or a "Show
  in" change on this device, or a pass whose `removedIds` or changed pin
  state names that Favorite. A page whose Favorite the document does not
  hold yet, at launch before the profile copy is read or before a pass
  brings it, is left open and untouched.
- The same holds for the menu, star and provider: a Favorite not yet in the
  document is simply not shown, and nothing is removed for it.
- **A Favorite at an address no other device may open stays on this device**
  ([1372](../../decisions/1372-an-address-no-other-device-may-open-stays-in-this-devices-copy.md)):
  `file:`, `about:`, `chrome:` and the rest of the schemes
  `services.sync.engine.tabs.filteredSchemes` lists. It is a Favorite, a pin
  and a home tile here as any other is, its tooltip in the Favorites menu
  and the pins row ends with "Only on this device", and other devices never
  see it. It can sit in a folder that syncs, which other devices show
  without it. Edited to a web address it joins the other devices at its
  place, and edited away from one it leaves them as if deleted there.
- **One another device wrote at such an address is held and never opened.**
  The store reads it as `refused`. The Favorites menu draws it disabled,
  with Delete its only command; it is no pin, home tile, address-bar result
  or launcher row, Open All leaves it out, and `isFavorite` does not count
  it. No message is shown: only a damaged or hostile device writes one.

## 6. What stays in Places

- History: visits, frecency, origins, input history, the History sidebar,
  history import, history sync (0109) and Clear History.
- The favicon store for history, which `page-icon:` reads.
- `markPageAsFollowedBookmark`, so visits from favorites keep their weight.
- Places' empty bookmark roots, which Sval never reads.

## 8. Extensions' bookmarks API

### 8.1 Where Firefox implements it

`ext-browser.json` registers the `bookmarks` module as
`chrome://browser/content/parent/ext-bookmarks.js`, with its schema
`chrome://browser/content/schemas/bookmarks.json`, in the `addon_parent`
scope, behind the `bookmarks` permission. The module is built on
`PlacesUtils.bookmarks`: `fetch`, `promiseBookmarksTree`, `search`,
`getRecent`, `insert`, `update` and `remove` (with
`preventRemovalOfNonEmptyFolders` for `remove`), and a
`PlacesUtils.observers` listener that feeds the four events. The schema's
functions are `get`, `getChildren`, `getRecent`, `getTree`, `getSubTree`,
`search`, `create`, `move`, `update`, `remove` and `removeTree`; its events
are `onCreated`, `onRemoved`, `onChanged` and `onMoved`, with
`onChildrenReordered`, `onImportBegan` and `onImportEnded` marked
unsupported.

### 8.2 An added file in its place

- **`chrome/browser/components/sval/ext-bookmarks.js`**, registered in Sval's
  `jar.mn` with `% override chrome://browser/content/parent/ext-bookmarks.js
  chrome://browser/content/sval/ext-bookmarks.js`, as Sval already overrides
  `default-bookmarks.html` and Firefox's illustrations. `ExtensionCommon`
  loads the module by that URL (`loadSubScriptWithOptions`), so the override
  replaces the implementation with no patch.
- The schema, the permission and its install prompt stay Firefox's, so the
  API surface is unchanged.
- **The override avoids a patch,** because a patch to `ext-browser.json` or
  to `ext-bookmarks.js` conflicts whenever Mozilla touches either. Only a
  schema change upstream can break the added file, and the tests in §8.5
  catch that.

### 8.3 How each call maps onto the document

A `BookmarkTreeNode` is built from a document row: `id` the guid,
`parentId` the parent's guid, `index` its place among its siblings by order,
`title` the name, `url` the address (`data:` for a separator, as Firefox
reports one), `type`, `dateAdded` the favorite's added stamp, and for a
folder `dateGroupModified`, the latest content or placement stamp among its
children.

- **Roots.** `root________` is reported as a parentless, read-only root
  whose children are, in Places' order, the document's `menu________`,
  `toolbar_____` ("Favorites", as the store names it), `unfiled_____`, and
  an empty `mobile______`, the others named as Places names them. A root is
  never updated, moved or removed, and nothing is created in or moved to
  `root________` or `mobile______`, which the document does not hold: each
  is refused with Firefox's `throwIfRootId` message.
- **`get`, `getChildren`, `getTree`, `getSubTree`:** read from the store.
- **`search`:** a string, or `{ query, url, title }`, as
  `Bookmarks.search` takes it: every word of `query` in the name or address,
  case-insensitive; `url` (normalised as the store stores one) and `title`
  exact. Results come in tree order, depth first; Places gives no order.
- **`getRecent(n)`:** favorites by added stamp, newest first, and of two
  added in one millisecond the later in the tree first.
- **`create`:** one store write. With no `parentId` it lands at the end of
  Favorites, the root Sval shows (0123), where Firefox would use Other
  Bookmarks. A `parentId` of the menu or unfiled root lands there too, and
  the returned node says so.
- **`update`** (title, url) is one `setContent` write, **`move`** (parent,
  index) one `move`. An address must parse as a URL, as Places requires. A
  move's index is where the item lands, as Places counts it, so a move down
  within its folder asks the store for one place further on.
- **`remove`** refuses a non-empty folder; **`removeTree`** removes it with
  its contents (`remove(id)`, 0115).
- Extension writes are not on the Favorites menu's Undo, as Places'
  extension writes are not on `PlacesTransactions`.
- **Events** fire for every change, whoever made it, as Places' observers
  do: the user's, an extension's and another device's. The store's own
  writes know what they did. For a pass, each id in `changedIds` is compared
  with the previous read: new is `onCreated`, a new parent or index is
  `onMoved` with `oldParentId` and `oldIndex`, a new name or address is
  `onChanged`, once for the title and then once for the url when both
  change, as Places fires them. Each id in `removedIds` is `onRemoved` with
  its `parentId`, `index` and node from the previous read, except what was
  inside a removed folder, which Places leaves out too
  (`isDescendantRemoval`). Absence alone fires nothing (§3.1). Pin and "Show
  in" changes fire nothing; the API has no such field. The listener follows
  the process's store, again whenever it is replaced
  (`FAVORITES_CHANGED_TOPIC`).

### 8.4 The `added` field

`contentAt` moves on every rename, so it is no creation time. The content
group holds `added`, written once by `addFavorite` and kept by
`setContent`. It serves `dateAdded`, `getRecent`, and the address bar's
score for an unvisited favorite (§5.2).

### 8.5 Tests

- `test_sval_ext_bookmarks.js` is Mozilla's `test_ext_bookmarks.js` run
  against the override, stated as Sval behaves where Places differs: the
  default parent is Favorites, concurrent creates land in the order asked,
  search is in tree order, and Places' tags and queries are left out. A task
  of Sval's own checks an extension's favorite lands in Favorites and none
  of its changes is on Undo.
- `browser_sval_favorites_extensions.js`: an extension creates, moves,
  renames and removes a favorite and the Favorites menu shows each step; a
  delete in the menu, and an add, rename and delete arriving from a second
  engine, fire the matching events.
- The engine's `favorites_tests.rs` checks `added` survives a rename and a
  re-address on either device.

## 10. Differences from Firefox's address bar

- A favorite reached by adaptive history (`UrlbarProviderInputHistory`, the
  rows from what you picked before) shows as a history row without the star:
  that provider marks a row as a bookmark from `moz_bookmarks`, and the muxer
  keeps its row over Sval's.
- Pages a user reaches by link, never from the favorite, rank a little lower
  among plain history rows. The favorite's own row is unaffected.

## 11. Hazards

- **Address bar fidelity.** The provider reimplements bookmark matching and
  scoring. §12's tests type into the real address bar and the home page
  field, against the real defaults.
- **The autofill patch** touches a function Mozilla edits. It is one line;
  a rebase that moves it fails the patch loudly.
- **Startup.** The document answers after the profile copy is read. The star
  and menu show the document's state once ready, and writes wait for it.
- **Sync extensions** (Floccus and the like) meet Sval's roots: everything
  under Favorites, an empty mobile root, new items without a parent in
  Favorites.

## 12. Tests

- Store: add, rename, move, delete with contents, pin, scope; each undone,
  checked in the document. A deleted, undone favorite reaches a second engine
  (engine test for re-adding a removed id).
- ⌘D and the button on a page, a redirecting page and a private window.
- Address bar and home field: a favorite by name and by URL, with the star;
  `*`; the Favorites search mode, empty and typed; autofill of a never-visited
  favorite's origin; no duplicate row for a visited favorite; switch-to-tab
  wins; `suggest.bookmark` off hides them.
- Menu: nested folders, icons, keyboard, drag reorder, move into a folder,
  link drop, Open All, "Use Favorite…".
- Icons: a favorite saved as a redirecting address shows its target's icon
  after one visit, and after Clear History.
- Import (every reader's fixture) lands in the document with pins; export
  round-trips.
- Nothing for absence: a pin page and an icon whose Favorite is missing from
  the document survive a redraw and a pass; a remote delete closes the page.
- Two devices: an edit on one arrives on the other with no Places write
  (`docs/acceptance-two-devices.md`'s Favorites step, by hand).

## 15. Managing Favorites

Decision 0099 records the core.

### 15.1 Rules and the reasons for them

| Decision | Reason |
|---|---|
| **Favorites are managed from a right-click menu on the panel's Favorites menu.** There is no Favorites page. | Decision 0099. Most people edit one favorite at a time; a page would rebuild the Library. |
| **The menu is a native XUL menu**, opened by right-click, Shift+F10 or the context-menu key. | XUL menus are exposed to assistive technology on every platform and are keyboard-driven. Gecko's menu keyboard handling has no context-menu key (`nsXULPopupManager::HandleKeyboardEventWithKeyCode` closes the menus on F10), so Sval listens for both keys while the Favorites menu is open and opens its menu on the highlighted item. |
| **Sval's own context menu, never Firefox's `placesContext`.** | `placesContext` carries Firefox's bookmark dialog, tags, the Library and container items, none of which Sval has. Hiding its items one by one is a list that grows with every rebase. |
| **Rename… and Edit Address… are separate items**, each a one-field `SvalDialog`. | `SvalDialog` takes one field. Two items keep every Sval dialog the same (rule 12: use what exists). |
| **The menu's first item undoes the last change**, from the one stack of §5.1. | In a browser window Cmd+Z goes to the focused field or page, so the stack is reached from the menu, and Cmd+Z while the Favorites menu or this menu is open, where no field has focus, is the same Undo. "Undo" shows only when there is something to undo. |
| **Tags and keywords are dropped.** Nothing in Sval creates one, and import ignores them. | Decision 0099. Only the Library and Firefox's edit panel could set them. |
| **The Library is unreachable.** | Everything it did has a Sval home: Favorites in the panel, history in the History sidebar, downloads in `about:downloads`. |
| **Firefox's Recently Closed tabs and windows stay**, with Cmd+Shift+T. | Decision 0013 names Firefox's local recently-closed list as how a closed tab comes back. |

### 15.2 The Favorites context menu

`SvalFavoritesMenu.sys.mjs` builds it. It opens on any item of the panel's
Favorites menu, including its empty area, and shows the items that apply to
what is under it, kind by kind between separators:

Undo · Open · Open in New Window · Open in Private Window · Open All · Pin ·
Show in › · Rename… · Edit Address… · Delete · Move to › · Move Up · Move
Down · Move Left · Move Right · New Folder… · New Separator · Export…

- **Open** opens the favorite as choosing it does (§3).
- **Open All** opens every favorite directly inside the folder, in order.
  Above `browser.tabs.maxOpenBeforeWarn` it asks first, with the count.
  Subfolders are not opened.
- **Pin** and **Show in** are the pins spec's (`2026-10-20-pins-design.md`).
  **Move Left** and **Move Right** move a pinned tile along the home page's
  row.
- **Rename…** asks for the name, prefilled. **Edit Address…** asks for the
  address, prefilled, and refuses one Sval cannot open (`SvalFavorites.addressOf`).
- **Move to ›** lists every folder, indented, the item's current folder
  disabled. A folder never lists itself or its descendants.
- **Delete** on a favorite deletes at once; Undo brings it back. Delete on a
  folder that holds anything asks first.
- **New Folder…** asks for a name and creates the folder inside the folder the
  menu was opened in.
- **Export…** opens Sval's export page (`2026-10-18-export-design.md`).
- A **private window** has no Favorites row, so it has no menu.

Every label is Sval's own string. None says "bookmark".

### 15.3 Import from a bookmarks file

Sval's import page has a source for a bookmarks HTML file, which opens a file
picker. `SvalImportHtml.sys.mjs` reads the chosen file into the import model's
bookmark tree (import spec §7), so the per-source choice and de-duplication
apply as for any browser. It parses the Netscape format with `DOMParser` and
ignores `TAGS` and `SHORTCUTURL`. Firefox's `BookmarkHTMLUtils.importFromFile`
is not used: it writes straight into Places, bypassing the choice, and
imports tags and keywords.

### 15.4 The Library and Firefox's other entry points

`SvalFavorites.mount` hides Firefox's bookmark menus and items
(`HIDDEN_ITEMS`) on every `popupshowing`, since Firefox shows some of them
again or makes them late. "Send Page to Device" and "Send Link to Device" are
hidden too, because they need a Firefox Account, which Sval does not have.
The address bar's "Manage bookmarks" and "Open Library" quick actions are
removed (`favorites-settings.patch`). `browser_sval_favorites_menu.js` checks
that no command or key opens the Library.

### 15.5 Settings

`favorites-settings.patch` finishes Firefox's bookmark-era settings: General's
import button opens Sval's import page and its text names what Sval imports;
the address bar's "Shortcuts" setting is named for what it does, since Sval's
new tab draws no tiles; the Appearance link to Firefox Home and Home's copy
of the default-browser group go. General offers the default browser.

## 16. The favorites document

Decision 0108 records it. The engine holds Favorites as a third document,
`favorites`, on the same engine, pass and key as workspaces and settings, with
the workspace tree's structure and merge as they are.

- **Kinds.** `favorite`, `folder` and `separator`.
- **Ids.** A node's id is `favorite_id(guid)`, a UUIDv5 of the guid Sval mints
  (§3), under `FAVORITE_NAMESPACE`, which is distinct from settings', so a
  setting key and a guid with the same text never name the same node. The
  content carries the guid itself.
- **Roots.** Favorites, Favorites Menu and Other Favorites are folders with no
  parent, at fixed ids. Sval shows Favorites (decision 0123).
- **Groups.** Content holds the name, the address, the guid and `added`
  (§8.4). Placement holds parent and order. Lifecycle holds the pin and its
  `home_order`, a fractional index present only on a pinned node.
- **Deletion.** Deleting a favorite deletes it on every device. Deleting a
  folder deletes what is in it. A favorite another device added to that
  folder before it saw the delete is kept, and the repair files it under
  Favorites, else another root, lowest id first. A favorite is never filed
  under a workspace, nor a tab under a folder.
- **Icons do not sync.** Each device keeps its favorites' icons locally
  (§5.4).
