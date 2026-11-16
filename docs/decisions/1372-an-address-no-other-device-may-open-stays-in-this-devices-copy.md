# 1372. An address no other device may open stays in this device's copy

**Status:** Accepted on 2026-10-24.

## Context

A pin opens with `addTrustedTab` and the system principal
(`SvalPinPages.sys.mjs`), and a favorite through `PlacesUIUtils`, which
trusts every bookmark. Any device holding the sync key writes the
`workspaces`, `favorites` and `archive` documents, so it can plant a `data:`,
`file:`, `chrome:` or `about:` address that opens with browser authority on
every device. A tab is gated: `SvalRestore.restorePrincipal` opens a tree
address only where a web page could navigate.

Firefox's tab engine refuses the schemes in
`services.sync.engine.tabs.filteredSchemes` (`data`, `file`, `chrome`,
`about`, `blob`, `resource`, `moz-extension`). `javascript:` syncs, as Firefox
Sync syncs bookmarklets. On the device that made it, an item with any scheme
is a tab, pin or favorite and opens as any other does.

Pins and favorites are nodes of the synced `favorites` document, and tabs of
`workspaces`, so an item that may not sync needs somewhere on the device to
live. The tree is the one source of truth (0050), and validation lives on the
local edit path and never inside `merge` (0020).

## Decision

- **`syncableAddress(url)` is one function in chrome JS**, which the writer
  and the reader both use. It parses with
  Gecko's own parser (`Services.io.newURI`), so it reads an address as a load
  would, follows a nested address to its innermost (`view-source:`, `jar:`),
  and refuses a scheme Firefox's pref lists. An address that does not parse
  is not syncable. The engine never parses addresses.
- **An address it refuses is local: held in the same document, in this
  device's own profile copy only.** The node's content group carries a
  `local` mark, which the host sets on every write that carries an address,
  from `syncableAddress`. The profile copy, sealed under this device's local
  key, holds local nodes as it holds every other. A file written to the
  shared folder holds none. Every tree rule, from parent checks and sibling
  order to pin order, scope and repair, works on the one document.
- **A shared exchange leaves local nodes out of the merge.** It sets them
  aside, merges peers' files as `merge` does, puts them back, and then
  repairs. A peer's file can therefore never delete a local node by its
  absence, and repair still files a local favorite whose folder a peer
  deleted. A `local` mark read from any file but the profile copy is
  dropped. When a peer's file holds an id this device holds as local, the
  local node stands.
- **The mark follows the address.** A content write whose address crosses
  the line moves the node, keeping its id. Going local, the node leaves the
  published file, and peers read its absence as a close or delete. Going
  back, it returns with its content stamped now, so it is news to every
  peer.
- **The reader is the read path.** A node without the mark whose address
  `syncableAddress` refuses came from another device. It stays in the
  document, as 0020 requires, and is drawn where the user manages it so it
  can be deleted. It never opens, never becomes a pin tile, and is never
  offered by the address bar or the launcher.
- **The Archive follows the tab.** A local tab archives to a local entry and
  restores to a local tab. An entry the reader refuses cannot be restored.
- **A visit to such an address is never written to its week of history**,
  as Firefox's history engine keeps `file:` visits to itself, and one read
  from another device's week is not put in Places.
- **Reader view records the article.** A tab in reader view commits the
  address of the article it shows (`ReaderMode.getOriginalUrl`), as Firefox's
  tab engine records it, so entering reader view never takes a tab off the
  other devices.
- **The host marks every address write in one place**, `SvalEngine.mutate`,
  so no caller can write an address without its mark. Only an address this
  device produced, the user's input or a page a tab committed, is marked
  there. A write that copies an address out of a node (Undo putting a
  Favorite back, pinning a tab from its row) carries that node's mark, and
  the engine keeps a node's mark on a write that sends back the address it
  holds. So an address another device wrote stays refused however it is
  copied, and Pin is not offered for its tab.

## Consequences

- `merge` and the tree's rules know nothing of local nodes. The sync pass has
  two targets, the profile copy and the shared folder, and the engine has the
  `local` content field and a flag on each write that carries an address.
- Another device never sees a local item, and gets nothing in its place.
  A tab that moves to a local page goes from other devices as if closed
  there, and returns at its place once it shows a web page again.
- A new tab on the home page (`about:home`, `about:newtab`) and a settings
  tab are local. Each device fills an empty workspace with its own home tab.
- An edit made on another device to a tab that has since gone local is lost
  once the devices exchange files. The tab is kept on the device where it is
  local.
- A refused address stays in the folder for as long as the device that
  planted it keeps it there. Every reader ignores it.
- A local item is lost with its profile. Export carries it.

### Rejected

- **A second, profile-only document for local items.** A local tab's parent,
  its siblings' order, its pin order and the repair of a deleted folder all
  live in the synced document. Every tree operation would need both.
- **The node synced and its address kept on the device.** That forks a
  node's content, and every other device would get an entry with no address.
- **Refusing the address inside `merge`.** That deletes another device's
  data on this build's opinion (0020).
- **Writing the last syncable address instead.** The tab would restore on
  this device at a page it left, against 0050.
- **A new id at each crossing.** Selection, last-active time, agent tab
  records, pin pages and extensions' bookmark ids are keyed by node id or
  guid, and would all have to follow it.
