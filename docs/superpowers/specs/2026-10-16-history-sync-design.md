# Sval — History sync, and device names

**Status:** Built. Decisions 0109, 1287 and 1549.
**Date:** 2026-10-16
**Author:** John Postlethwait
**Builds on:** `2026-10-07-settings-sync-design.md`,
`2026-10-21-favorites-native-design.md` §16 (decision 0108).

---

## 1. What this is

The history each device keeps follows the user to every device sharing their
folder, and shows in the history UI Sval already has: the History sidebar and
the address bar's suggestions. Nothing about how history is shown changes,
apart from one label: an entry that came from another device names that
device.

To name a device, every device gets a name. The same names finish the agent
workspace label the agent-control spec describes.

**Success looks like:** a user reads an article on their laptop, then types
part of its title into the address bar on their desktop and it is suggested.
In the desktop's History sidebar the entry reads "· MacBook Pro". They delete
it there, and it is gone from the laptop's history too.

## 2. Decisions and the reasons for them

- **History syncs what Firefox's history engine syncs** (decision 1549). A
  visit carries its URL, the page's title, its time and its transition type.
  Hidden pages, framed-link visits and downloads stay on their device
  (`IGNORED_TRANSITIONS_AS_SQL_LIST` in `PlacesSyncUtils.sys.mjs`). Each
  device keeps its newest 20 visits to a page in each week, and a week that
  loads holding more is trimmed to them.
- **An incoming visit is inserted as Firefox's history engine inserts one**
  (decision 1549): not where Places holds a visit to the page at that time
  with that transition, and not when it is older than the page's 20 newest
  visits in Places (`HistoryStore` in
  `services/sync/modules/engines/history.sys.mjs`). Places stays the store
  everything reads, so what it already holds decides.
- **History is sharded by ISO week** (UTC) of visit time: one engine document
  per week, named `history-YYYY-Www` (decision 0109). A week of a heavy
  user's visits stays well under the helper's 32 MB `MAX_FILE_BYTES`.
- **A small `history-index` document lists every shard**, one node per shard,
  touched whenever a device writes to that shard. Document directories are
  hashed under the key, so a device cannot list the folder by week. The index
  is how a new device finds older history, and how any device learns that a
  cold shard changed.
- **A pass runs the index, the current week, and only the shards that
  changed.** Running every shard on every pass would break the shared step's
  20-second deadline (`SHARED_STEP_TIMEOUT_MS`) after a year of history.
- **One node per visit, of a `visit` kind.** Its id is a UUIDv5 of the
  visiting device's id, the URL and the visit time, computed by the engine. A
  visit never changes, so it needs no merge beyond presence. The id is the
  same on every device, so a visit is never counted twice.
- **Each device's own expiration decides what it keeps** (design spec §5.6).
  A visit Places expires (`PlacesVisitRemoved.REASON_EXPIRED`) is not deleted
  from the documents. Incoming apply inserts only visits new to this device's
  document, so an expired visit is never put back. A small disk on one device
  never shortens history on the others.
- **A visit belongs to the device that made it, and deleting a visit deletes
  it everywhere** (decision 0109), whichever device deletes it. Its node is
  removed, and the absence rule carries the delete to every device (design
  spec §5.4). There is no device-local hiding.
- **Delete Page and Forget About This Site delete every matching visit, from
  every device, and ask nothing.** They name records the user is looking at.
- **Clear Recent History asks: "This device's history" (default) or "All
  devices' history"** (decision 0109). The first deletes every visit this
  device made in the range. The second deletes every visit in the range.
- **Clearing history on shutdown clears this device's own visits.** A setting
  that runs on every quit never wipes every device.
- **"Never remember history" stops this device both publishing and inserting
  visits.** A device set never to remember history does not fill up with
  other devices' history.
- **Every device has a name** (decision 0109), defaulting to the computer's
  name and changeable in Settings. Names sync.
- **An entry from another device shows its device's name in a column of the
  History sidebar** (§4.3). Entries from this device show none. There is no
  filter by device.
- **Agent workspaces from another device show "label · device name"**
  (agent-control spec §3.5).
- **No switch turns history sync off**, as for settings and Favorites.
- **Private windows never sync**, and nothing they visit is in Places (design
  spec §5.7).

### 2.1 Rejected approaches

- **History in the favorites or workspace document.** History is far larger
  than either and grows without end. Every visit would rewrite them.
- **One node per page with a list of visits.** Two devices visiting one page
  would compete for the same node, and a delete of one visit would rewrite the
  others.
- **Firefox Sync's history engine.** It needs a Firefox Account and Mozilla's
  servers (design spec §10.9).

## 3. Engine (`sval-core`, in `engine/`)

- `NodeKind::Visit`, serialised as `visit`. An older build holds it as
  `Unknown` and writes it back.
- `visit_id(device, url, visit_time) -> NodeId`, UUIDv5 under its own
  namespace.
- A visit node's content holds `url`, `title`, the transition type, the
  id of the device that made it, and the id of the workspace it was made in,
  absent for a visit made in none (decision 1287). It has no parent, and is
  a legitimate root, as a setting is. Placement is fixed.
- Documents are named by week.
- `history-index` holds one node per shard, of a new `shard` kind, with id a
  UUIDv5 of the shard's name and the name in its content. A device that
  writes to a shard touches its index node (decision 0106) in the same pass.
  A week with no visits on any device has no shard and no index node.

### 3.1 Device names

A device name is a setting in the `settings` document, one per device: key
`sval.device.name.<device id hex>`, written by that device alone. A device
writes its own name on first run and when the user changes it. Settings
merge, absence and attribution handle it, so a handful of names needs no
document of its own.

## 4. Browser (`sval` fork)

### 4.1 `SvalHistorySync.sys.mjs`

- **Outgoing.** A `PlacesUtils.observers` listener on `page-visited` writes a
  visit node that syncs (§2) into its week's document, and removes this
  device's visit to the page there that falls outside its newest 20. The
  removal reaches the other devices as a deletion of that visit, so they hold
  the newest 20 too. `page-title-changed` updates the
  title on that page's visits in the current week only. Older weeks stay
  cold.
- **Which shards a pass runs.** The index and the current week, every pass.
  Any other shard whose index node is newer than this device last merged it,
  and any shard with local writes waiting (a delete, a seed). A device that
  has not merged a shard yet treats it as changed, so a new device works
  through every week. One pass takes at most four cold shards
  (`COLD_SHARDS_PER_PASS`), newest first, so a pass keeps its deadline.
- **How often the current week is published.** A shared step merges the
  current week every time, and writes this device's file of it to the folder
  at most every 10 minutes (`CURRENT_WEEK_PUBLISH_MS`). The first step after
  the week loads writes it, and so does the next step after a delete. Every
  provider uploads a whole file on each write, and every other device
  downloads it, so a week rewritten for each new visit costs hundreds of KB a
  pass for a few KB of news. The index is touched only once a step has
  published the week (§3), so it follows the same interval. Quitting runs no
  shared step, and the next launch's first step publishes what waited.
- **Incoming.** After a pass merges a shard, visits that merge added to this
  device's document are inserted with `PlacesUtils.history.insertMany`, with
  their original times and transitions. Visits that merge removed, because
  another device deleted them, are removed from Places. Nothing else
  in the document is compared with Places.
- **Echo.** An apply records the visits it is inserting, and the outgoing
  listener ignores those. Places has no sync source for visits, as it has for
  bookmarks.
- **Workspace.** A visit written to its week takes the workspace Places
  recorded for it, and a visit inserted from another device takes the one
  its node names, or none (§4.4).
- **Origin.** A device-local table maps each visit from another device to
  the device id that made it, read from the node. Places has no column for
  this. A page's row in
  the History sidebar names the device of its latest visit, and shows no
  label when that visit was made here.
- **Seeding.** When a profile first publishes to a shared folder, it writes
  what Firefox's history engine first uploads: the pages visited in the last
  30 days, the 5,000 with the highest frecency
  (`PlacesSyncUtils.history.getAllURLs`, `MAX_HISTORY_UPLOAD`), each with its
  newest 20 visits. Each goes to its week's document, newest week first, a
  bounded number of weeks per pass. An interrupted seed resumes on the next
  pass.
- **Logging.** Ids and counts only, never a URL or a title (CONTRIBUTING.md
  rule 10).

### 4.2 Deleting

Every delete removes the matching visit nodes from every week's document
they are in, and removes them from Places here. Other devices remove them
from Places when the delete reaches them.

- **Delete Page** and **Forget About This Site**, in the History sidebar's
  menu: every visit to that page or site, from every device. No question.
- **Clear Recent History** (`Tools:Sanitize`, reached from the History
  sidebar and from Settings): its dialog gains one choice, "This device's
  history" (default) or "All devices' history". It applies to the time range
  the dialog already asks for.
- **Clear history on shutdown**: this device's visits.

A delete from a device that has expired some of the matching visits still
deletes them from the documents, so it reaches devices that kept them.

### 4.3 Device names in the UI

- Settings has a "This device's name" field under "Your devices", filled
  with the computer's name until the user changes it.
- The History sidebar has a **device column**, built the way
  `SvalHistorySidebar` builds its date column: a `treecol` beside the title,
  before the date, styled like the date column (`history-sidebar.css`). A
  page row shows the device name of its latest visit there, and nothing for
  a visit made here. Folder rows show nothing. It shows in every view and in
  search.
- The row's accessible name includes the device: "Article title, visited on
  MacBook Pro".
- Agent workspaces from another device read "label · device name". A device
  whose name has not arrived yet shows its label alone.

### 4.4 Workspaces (decision 1287)

- Places keeps each visit's workspace in `sval_visit_workspaces`, one row per
  visit made in a workspace, removed with its visit. `History::VisitURI`
  writes it with the visit, from the workspace the browser's window says the
  browser is in (`SvalVisitWorkspaces.sys.mjs`).
- A query's `svalWorkspace` lists the pages with a visit in that workspace or
  in none. The History sidebar lists the window's workspace's history by
  default, and every workspace's under "All workspaces", where a Workspace
  column names the workspace of each page's latest visit.
- An import's visits take the workspace made from their profile's plain
  windows, unless the profile also holds Spaces, Tab Groups or Workspaces of
  its browser's own.

## 5. Tests

- Engine: a visit round-trips through an older build. Two devices with the
  same visit converge on one node. A week's document merges and deletes like
  any other. A new device finds and merges every week through the index. A
  heavy week (3,000 visits a day) stays under the helper's file limit.
- Browser: a visit on one profile appears in the other's Places and address
  bar results. Delete Page on either profile removes every device's visits
  to it on both. Clear Recent History with "This device's history" removes
  only this profile's visits, on both profiles, and leaves the other's.
  "All devices' history" removes both. Expiration on one profile leaves the
  other's history alone, and expired visits are not inserted again.
- Device names: a rename on one device shows on the other's History labels
  and agent workspaces.

## 6. Out of scope

- Any change to how history is shown, apart from the device label.
- Filtering history by device.
- Syncing downloads, form data or the recently closed list.
