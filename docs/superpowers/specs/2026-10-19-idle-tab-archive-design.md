# Sval — Archiving idle tabs

**Status:** Built. Decision 0136.
**Date:** 2026-10-19
**Author:** John Postlethwait
**Rests on:** `2026-10-16-history-sync-design.md` (decision 0109), whose
pattern the Archive follows. Decisions 0013, 0017, 0024, 0106, 0126, 0135.

---

## 1. What this is

A tab nobody has used for a while leaves the tree by itself and goes to the
Archive. The Archive is a list of the tabs Sval put away, kept for a month and
shown in the History sidebar. One click there brings a tab back where it was.

Sval's is off until the user turns it on, and nothing it puts away is lost
for a month, on any device. The tree keeps no closed record (decision 0013),
and the Archive is a separate document.

**Success looks like:** a user turns on "Archive idle tabs" at 7 days. A week
later the loose tabs they have not looked at on any device are gone from
their workspaces, on their laptop and their desktop alike. On the desktop
they open History, choose "Archived tabs", type part of a title, and click
the row. The tab opens in its workspace, beside the tabs it sat between.

## 2. Rules

Decision 0136 holds the core rules and their reasons: an idle tab is archived
in one engine call; only tabs Sval archives go in the Archive, and a tab the
user closes is deleted as decision 0013 says; the Archive is its own synced
document, `archive`; entries are only added, and the restored mark is their
one later write; each device drops entries older than the retention period
inside each sync pass; a restore creates a new tab with a new id.

The rest:

- **The retention period is a synced setting:** 7, 30 or 90 days, 30 by
  default. A device's drop deletes the entry everywhere through the absence
  rule (main spec §5.4), so one period on every device makes every device
  drop an entry at the same moment. A per-device period would let the
  shortest win everywhere.
- **One document, never sharded.** The retention period bounds it. An entry
  is about 600 bytes, so 90 days of a heavy user's Archive is about 11 MB,
  under the helper's 32 MB file limit. History needs weekly shards because it
  never expires.
- **A device never re-adds an entry it has expired.** The expiry runs inside
  each sync pass, after the merge and before the write (§3.3), so an entry a
  peer wrote to later is never published or shown.
- **Entries can never become live tabs by merging.** An entry is a node of
  its own kind, `archived`, in its own document, and nothing in a merge moves
  a node between documents or changes its kind.
- **An entry records** the URL, title and icon; the workspace's id and name;
  its neighbours in sibling order; split membership; when it closed; and the
  device that archived it (§3.1). It records no group, because tabs in groups
  are never archived (§4.3).
- **An entry's id is derived from the tab's id,** so two devices that archive
  the same tab at once write one entry.
- **Private windows never archive** (main spec §5.7).
- **A restore** goes back to the original workspace, between the same
  neighbours where they still exist. With neither neighbour there it goes at
  the end of the workspace. With the workspace gone it goes at the end of the
  workspace the user is in. The new id never meets the original delete
  (§6.4).
- **The entry is marked restored, the mark syncs, and the entry stays until
  it expires.** Clicking it again opens another copy.
- **A split restores as a split.** Each pane has its own entry, so search and
  a row's title work as for a tab. Restoring any pane restores all the
  split's panes, in their order.
- **Idleness is the latest use on any device.** Using a tab stamps its touch
  (decision 0106), at most once an hour per tab (§4.1). The touch holds no
  value, so it costs no edit made elsewhere, and its merge keeps the later
  stamp. It also lets a peer that archived a tab without seeing that use lose
  its delete (decision 0017).
- **The sweep uses the latest of the tab's touch, its device-local
  `lastActive` (decision 0024) and its `placement_at`.** A tab nobody has
  selected has neither of the first two, so an imported or background tab
  gets its full time from when it was opened or last moved.
- **A time later than this device's clock counts as now,** for touch stamps,
  `placement_at` and closed times. This is the bound decision 0135 puts on
  watermarks. There is no other skew protection.
- **Off by default.** The choices are 12 hours, 24 hours, 7 days, 30 days and
  Never. Turning it on preselects 7 days.
- **The global choice is a synced setting, and each workspace can override
  it** in its lifecycle group beside `isolated`, where the override has a
  timestamp to merge by.
- **Agent workspaces are never auto-archived.** Agents close their own tabs.
- **Every choice is a setting** (decision 0126).
- **Exempt, and never archived:** a tab shown in any window on this device; a
  tab kept loaded; a tab playing audio, in picture-in-picture or a call, or
  using camera or mic; a tab with form data; tabs in groups, at any depth.
  Favorites, pins among them, are their own document (decisions 0108, 0137),
  so they are never in the tree to archive.
- **Loose tabs at a workspace's top level are archived. A split is archived
  whole, only when all its panes are idle.**
- **The sweep runs on each device, after a pass that reached the shared
  folder,** at startup and then at most every 30 minutes, so a device back
  from a week offline merges its peers' touches before it judges anything
  idle.
- **The Archive is shown in Firefox's History sidebar** as an "Archived tabs"
  view beside By Date, By Site and By Last Visited. Entries are listed newest
  first, with their workspace's name. The sidebar's search filters them, and
  clicking one restores it.
- **An Archive item in the panel's menu and in the History menu opens it.**
  There is no default shortcut: Cmd+E is Firefox's Find Selection.
- **The Arc import carries over the user's Arc setting,** where Arc stored
  one, and uses 7 days otherwise (§7.5). The import step's Arc page offers it
  as one checkbox with the time beside it, checked unless Arc's setting was
  Never.

### 2.1 Rejected approaches

- **Recovering archived tabs from Firefox's recently-closed list.** That list
  is local, capped at 25 per window, and ages out after 14 days. Most idle
  tabs are in workspaces no window shows, so they have no Firefox tab to
  record (design spec §10.4).
- **Keeping archived tabs in the tree** with a closed mark. That is the
  closed record decision 0013 removed, and a mark in the tree can come back
  to life by merging.
- **A new lifecycle field for the last-used time.** A write replaces its
  whole group, so stamping lifecycle on every selection would overwrite an
  isolation or pin another device had changed and this one had not seen
  (decision 0106).
- **Unloading idle tabs.** Sval unloads every tab of a workspace no window
  shows (design spec §10.7). Unloading adds nothing.

## 3. The Archive

### 3.1 Its document and its entries

The Archive is one engine document named `archive`, synced like `settings`
and `favorites`. It holds only entries. An entry is a node of the kind
`archived`. It has no parent, as a visit has none, and nothing repairs it.

An entry's id is a UUIDv5 of the archived tab's id, under its own namespace.

| Field | Group | What it is |
|---|---|---|
| `name`, `url`, `icon` | content | The tab's title, URL and icon when it was archived. |
| `archived.tab` | content | The archived tab's id. |
| `archived.workspace`, `archived.workspace_name` | content | The workspace it was in, and that workspace's name then. |
| `archived.before`, `archived.after` | content | The siblings it sat between: the nearest one on each side that the same sweep did not archive too. A pane names its split's neighbours. |
| `archived.split` | content | For a pane, `{ id, pane }`: its split's id, and its place among the split's panes, from 0 at the left. Absent for a tab. A restore groups the panes one sweep archived, which share a closed time. |
| `archived.closed_at` | content | When it was archived. |
| `archived.device` | content | The device that archived it. |
| `restored` | lifecycle | Whether a device has restored it. |

Content is written once, when the tab is archived. The restored mark is the
only later write. It is lifecycle, so it merges by its own timestamp and
never competes with the content.

### 3.2 Merging

The Archive merges like every engine document (spec §5.3, §5.4). Two devices
that archive the same tab write the same id, and the later write's content
wins. A device's new entry is news to its peers, so it spreads.

### 3.3 Expiry

Each sync pass of the Archive drops every entry whose closed time is at least
the retention period before the pass's clock reading. It runs after the
merge and before the write decision, on the sync path and never inside
`merge` (`engine/CLAUDE.md` rule 8).

- A dropped entry is gone from this device's file. Its peers drop it too at
  their next merge, because this device has seen it and no longer holds it
  (spec §5.4). They would drop it at that moment anyway, since the period is
  one synced setting.
- An entry a peer wrote to after this device last saw it, such as a restored
  mark, comes back as news in the merge. The pass drops it again before
  writing, so it is never published or listed.
- An entry closed later than this device's clock counts as closed now
  (decision 0135), so it is kept.

## 4. Idleness

### 4.1 The last-used stamp

Using a tab touches it (decision 0106), at most once an hour per tab:
the engine stamps it only when the tab's touch is an hour old or more.
A use is one of these, followed by 2.5 seconds in which the tab stays the
shown tab of the window the user is in (`Services.focus.activeWindow`):

- the user selecting it: `TabSelect` under the user's input, or a row
  click in the panel, the two places Sval records `lastActive`;
- a click or a key press in its page, which the parent dispatches at the
  page's `<browser>` before it forwards it to the page's process
  (`EventStateManager::PostHandleEvent`).

Each one restarts the wait, so a tab passed on the way to another, as
Ctrl+Tab does, is not used. A tab left selected while the user reads and
clicks through it stays used on every device, though the selection that
showed it is days old. A shown tab is exempt from this device's sweep
(§4.3), but another device sees only the touch. A pane's use is its split's:
selecting a pane touches the split and every pane in it. A split is archived
whole, so a use another device had not seen must bring it back whole. A
touch on one pane alone would bring back that pane without its split.

How the touch behaves:

- `touch` accepts any node (host contract §3). `isUntouchedWorkspace` reads a workspace's own facts and its children's
  kinds and URLs, never a tab's touch, so a touched tab changes nothing
  there.
- A touch merges by keeping the later stamp. That is the latest use on any
  device.
- The absence rule judges the touch like a fact group. A device that removes
  a tab without seeing a peer's newer touch loses its delete, and the tab
  comes back (decision 0017). For a sweep that is the right answer: the tab
  was in use.
- A tab one device closes comes back when another device selected it in the
  hour before and the closing device had not read that yet (decision 0136):
  it is 0017's bias toward keeping data, and a use is real work.
- It costs a tree write per tab per hour of use. A pass with nothing else
  to write writes once.

### 4.2 The sweep

The sweep is one engine call on this device's tree and Archive. The host
hands it the global choice, each tab's `lastActive`, and the ids of the tabs
its live checks exempt (§4.3). The engine:

1. finds each unit at a workspace's top level: a tab, or a split with its
   panes;
2. skips agent workspaces, and every workspace whose effective choice is
   Never: its own choice where it has one, else the global choice. A
   workspace set to 7 days archives while the global choice is Never. An own
   choice this build does not know archives nothing;
3. skips a unit any of whose tabs the host exempted;
4. takes each node's last use as the latest of its touch, its `lastActive`
   and its `placement_at`, each counted as now when it is later than now;
5. archives a unit when every node in it was last used at least the
   workspace's period ago. Each tab gets an entry, and the unit is removed
   from the tree.

It reports the tabs it removed, so the host closes any Firefox tab showing
one, after the write, with `release` (`skipSessionStore`), so Firefox records
no recently-closed entry. A window left with no tab gets a blank one, as
`#releaseOrphans` does for a synced delete.

A tab whose `lastActive` this device never recorded is judged by the tree's
stamps alone. A peer's `lastActive` never reaches this device (decision
0024), so a tab one device uses is kept alive everywhere by its touch.

### 4.3 Exemptions

The engine applies the ones the tree holds:

- tabs in groups, at any depth, because only a workspace's direct children
  are units;
- agent workspaces;
- a workspace set to Never.

The host applies the ones only a live tab can answer, and passes their ids:

- a tab shown in any window on this device: the selected tab of each window,
  and every pane of a split a window shows;
- a tab kept loaded (`undiscardable`);
- a tab playing audio (`soundPlaying`);
- a tab in picture-in-picture, in a call, or using camera or mic:
  `SvalFirefox.isInPictureInPictureOrCall`, which reads
  `webrtcUI.browserHasStreams`;
- a tab with form data: `SvalFirefox.hasFormData`, after
  `SessionStore`'s `flushState`, the checks `discard` in `SvalTabs.sys.mjs`
  makes before it discards. A lazy tab holds no form data. A page whose
  process did not answer the flush in time is kept too.

`liveExemptions` in `SvalArchive.sys.mjs` makes the host's list. Favorites
and pins are never in the tree.

## 5. Settings

| Setting | Where | Default | Choices |
|---|---|---|---|
| Archive idle tabs | synced pref `browser.sval.tabs.autoArchive` | `never` | `12h`, `24h`, `7d`, `30d`, `never` |
| Keep archived tabs for | synced pref `browser.sval.tabs.archiveRetentionDays` | 30 | 7, 30, 90 |
| This workspace | lifecycle `auto_archive` on the workspace | absent: follow the global choice | `12h`, `24h`, `7d`, `30d`, `never` |

Both prefs join `SvalSettingsRegistry.SYNCED_PREFS`, and seed by decision
0113. The engine checks the tokens.

**Settings.** Settings › Workspaces has an Idle tabs card
(`settings-archive.js`) with a checkbox and a menu of the four times beside
it. Checking the box sets 7 days. A second line offers the retention period.
It is always enabled, because a workspace's own choice can archive while the
box is clear. Restore defaults resets both.

**A workspace.** Its context menu has a submenu of radio items: the default,
naming the global choice, then the four times and Never. An agent's
workspace does not show it.

## 6. Engine (`sval-core`)

### 6.1 Types

- `NodeKind::Archived`, serialised as `archived`. An older build holds it as
  `Unknown` and writes it back.
- `Content::archived`, an `Archived` struct with the fields of §3.1.
- `Lifecycle::restored` and `Lifecycle::auto_archive`.
- `archived_id(tab) -> NodeId`, UUIDv5 under `ARCHIVE_NAMESPACE`.
- `ARCHIVE` is the document's name.

### 6.2 Calls

All of these live in `src/archive.rs`, and the WASM boundary exposes each.

- **`mark_used(tree, id, by, now) -> bool`** touches tab `id` when its touch
  is an hour old or more, and says whether it did.
- **`set_auto_archive(tree, workspace, choice, by, now)`** sets or clears a
  workspace's override, stamping lifecycle only. It refuses a node that is
  not a workspace, and an agent's workspace.
- **`archive_idle(tree, archive, sweep, by, now)`** is the sweep of §4.2. It
  changes both documents together or neither.
- **`restore(tree, archive, entry, current, ids, by, now)`** restores entry
  `entry`, and the rest of its split, into the tree, and marks each entry
  restored. It changes both documents together or neither.
- **`add_imported(archive, entries, by, now)`** adds an entry for each tab
  another browser archived (§7.6), on the Archive alone. It refuses a tab
  whose entry is already there, or one the list names twice, before anything
  changes.
- **`archived(archive, now)`** lists the entries, newest first.
- **`ids_needed(archive, entry)`** says how many ids a restore takes: one per
  tab, plus one for the split when it opens a split. The listing carries it
  as `restoreIds`.
- **Expiry** is a parameter of a sync pass: `sync_to(..., retention, target)`,
  with `None` for every document but the Archive.

The WASM names, and the JSON each takes and answers, are in
`docs/host-contract.md` §10, "The Archive".

### 6.3 Writing both documents

The sweep and a restore each change two documents in one engine call. Each
document is persisted by its own pass, and Sval's passes write the tree
first. So the sweep is a confirmed swap in one queued worker step:

1. the worker runs `archiveIdle` on copies of the tree and the Archive;
2. it writes the Archive copy to this device's profile file;
3. once that write succeeds, it puts both copies in place of the documents
   it holds. A failed write leaves both documents as they were, and the
   sweep has done nothing.

The tree's removal is then written by its next pass. Whenever the tree's file
lacks an archived tab, the Archive's file holds its entry. A crash before the
tree's write leaves the tab in the tree and its entry in the Archive, and the
next sweep archives it again under the same entry id. A restore needs no
order: a lost mark loses only a label.

### 6.4 A restore never fights the original delete

The original tab's id stays deleted. The restored tab has a new id, which no
device has ever deleted, so no watermark can make it look stale. A device
that still held the original tab when it restored, because the delete had
not reached it yet, drops the original when it does, as for any delete.

## 7. Browser (`sval` fork)

### 7.1 The sweep

`SvalArchive` runs the sweep for the normal tree only, after a pass whose
shared step reached the folder, or after any pass when there is no shared
folder: at startup, then at most every 30 minutes, and again when the clock
goes back. It reads the global choice from the pref, `lastActive` from
`SvalLocalSettings`, and the exempt ids from the windows' tabs (§4.3). The
worker runs it as §6.3 says, through `archiveIdle` on `SvalEngine` and the
worker. Any Firefox tab whose node the sweep removed is then closed, as §4.2
says.

The Archive is an extra document registered like `settings`. Every call that
syncs it passes the retention period as `archiveRetention`: the profile
pass, `mergeSnapshot` and the shared step. Expiry waits for the first pass
this session that merged `settings`, so a device starting with a stale
period does not drop entries a longer period keeps. A device that has not
yet merged a change of the period can still drop entries under the old one.
That is accepted: it lasts one pass, and lowering the period is the only
change that loses entries.

### 7.2 The last-used stamp

`#markActive` and the panel's row click call `markUsed` beside
`setLastActive`.

### 7.3 The Archived tabs view

- The History sidebar's View menu has "Archived tabs", after its own
  items. Choosing it replaces the Places tree's view with one built from
  `archived()`: one row per entry, newest first, a plain `nsITreeView` in
  `SvalHistorySidebar` beside the Places view.
  Choosing any other item puts the Places view back.
- A row shows the entry's icon and title, then its workspace's name in the
  device column, then when it was archived in the date column. A restored row
  shows its title in `--text-color-deemphasized`, and its accessible name
  ends "restored".
- The row's accessible name is its title and its workspace.
- The sidebar's search box filters rows by title and URL, case-insensitively.
  While this view is shown, the view handles the search itself, and the
  Places query is not rebuilt.
- Clicking a row restores it, with `current` the workspace this window
  shows. The restored tab is selected, in the window that shows its
  workspace, or in this window when no window shows it.
- A private window's sidebar does not offer the view. Private windows never
  archive, and their tree is not the one a restore writes to.
- The view redraws when a pass reports a change to the Archive.
- An "Archive" item in the panel's menu, and one in the History menu after
  "Recently Closed Windows", open the sidebar on this view.

### 7.4 Settings and the workspace menu

As §5. The workspace menu calls `setAutoArchive`.

### 7.5 Arc import

Arc keeps its setting in its macOS preferences,
`~/Library/Preferences/company.thebrowser.Browser.plist`:

- `autoArchiveTimeThreshold` holds the global choice, such as `thirtyDays`.
- `autoArchiveTimeThresholdsPerProfile` holds a JSON string, in this form
  in the real file,
  `{"thresholds":[<profile marker>, <choice>, ...]}`, the real one being
  `{"thresholds":[{"default":{}},"thirtyDays"]}`. A choice is a bare
  string. A marker is the one
  Spaces carry, `{"default":{}}` or `{"custom":{"_0":{"directoryBasename":…}}}`,
  which `SvalImportArc` already reads as `spaceProfile`.
- Arc's binary names the choices `twelveHours`, `twentyFourHours`,
  `sevenDays`, `thirtyDays` and `never`.

The import reads the file with Firefox's `PropertyListUtils`. It uses the
imported profile's entry, else the global choice, and maps the five names to
Sval's five. Anything else, or no file, gives 7 days. On Windows, Arc's
settings are not read and the choice is 7 days.

The import step's Arc page shows the checkbox with the time beside it as a
menu. Leaving it checked sets the global pref when the import runs.

### 7.6 Arc's archived tabs

Arc keeps the tabs it archived in `StorableArchiveItems.json`, beside its
sidebar, as `{ items: [id, entry, …] }`. An entry is `{ reason, source: {
space: { _0: <Space id> } }, sidebarItem, archivedAt }`: `sidebarItem` is the
tab's sidebar item, and `archivedAt` is seconds since 2001-01-01, the
reference date Swift's `Date` encodes from. A real install's file holds that
form.

The Arc reader returns each archived tab with a web or file address as
`{ title, url, closedAt, source }`, `source` being its Space's id while the
sidebar still holds that Space. An entry goes with the profile of its Space,
and with the default profile when its Space is gone. The import plans each
one once the windows have landed (decision 1702):

- one from a Space the import brought names that Space's new workspace;
- one from a Space Arc no longer holds names a workspace no tree holds, so a
  restore puts it in the current workspace;
- one from a Space the user left unticked is left out.

`SvalArchive.importEntries` adds them through the engine's `importArchived`
once the Archive's document is registered, which is past first run. The
worker adds them on a copy of the Archive and writes it before it takes the
Archive's place, as for the sweep (§6.3). An entry keeps Arc's time as its
closed time, so §3.3's expiry counts from it.

## 8. Tests

**Engine:**

- An entry round-trips through an older build, held as an unknown kind.
- Two devices that each archive tabs converge on the same Archive, in both
  merge orders.
- Two devices that archive the same tab write one entry.
- An entry older than the retention period is dropped by a pass, and stays
  dropped when a peer's file still holds it.
- An expired entry a peer marked restored is not added back.
- An entry closed later than the clock is kept, and lists as closed now.
- The sweep removes a tab and adds its entry in one call; a refused sweep
  changes neither document.
- The sweep skips groups, agent workspaces, Never, exempt ids, and a split
  with one pane in use. It archives a split whole.
- A touch later than the clock counts as now: the tab is idle once real time
  has passed it by the period.
- A tab used on another device, whose touch arrives after this device
  archived it, comes back in the tree.
- A restore puts the tab between its neighbours, at the end of the
  workspace without them, and in the current workspace without its own. A
  neighbour counts only while it is still a direct child of the workspace.
  When both are there but out of order, the tab goes right after `before`.
- A use of one pane touches its whole split, so a split a peer archived
  without seeing the use comes back whole.
- A split restores as a split, in pane order.
- A restore never fights the original delete: after both devices sync, the
  old id is gone everywhere and the new tab is present everywhere.
- `markUsed` stamps at most once an hour.
- An imported tab keeps its closed time, restores into its workspace, or
  into the current one when no tree holds that workspace, and expires by its
  own closed time. An import naming a tab already held, or one twice, adds
  nothing.

**Browser:** a tab idle past the period on one profile is gone from both
profiles' trees and listed in both Archives. Exempt tabs stay. Clicking an
entry on the other profile restores it there and marks it restored on both.
The Arc import reads a fixture plist into the pref.

## 9. Out of scope

- Archiving by hand. Only the sweep archives.
- Filtering the Archive by workspace or device.
- Deleting an entry by hand. Entries expire.
