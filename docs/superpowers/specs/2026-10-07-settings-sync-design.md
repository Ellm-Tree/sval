# Sval — Settings sync

**Status:** Built.
**Date:** 2026-10-07
**Author:** John Postlethwait

---

## 1. What this is

The settings that express what a person wants follow them to every device
that shares their folder: their search engine, how much Sval blocks, and the
browser preferences Firefox Sync has always treated as device-independent.
Settings that describe a device stay on it (design spec §5.6): panel side, window geometry,
the storage folder, which groups are collapsed.

**Success looks like:** a user switches to Kagi and turns on HTTPS-only mode on
their laptop, and their desktop has both within one sync pass, with nobody
pressing anything. A new device that joins never changes a setting the user
already chose elsewhere, and a fresh device writes nothing until its user
changes something.

## 2. Decisions and the reasons for them

| Decision | Reason |
|---|---|
| **Settings are a second document, synced by the same engine under the fixed name `settings` and the same key.** | The engine already takes a document name and has no idea which document is which (§6.2). A settings change rewrites only the small settings file, never the tree. |
| **One node per setting, of a new `setting` kind, with the value in its `content` group.** | Each setting then has its own timestamp and writer, so changing the search engine never competes with changing autoplay, and merge, the absence rule, attribution and canonical-JSON tie-breaks are the existing code. |
| **A setting's node id is a UUIDv5 of its key under a fixed Sval namespace, computed by the engine (`setting_id`).** | Two devices that each set the same key for the first time must write the same node, or the document holds two of that setting forever. The engine computes it so desktop, iOS and Android derive the same id. UUIDv5 is a pure hash and needs no clock or entropy on wasm32. |
| **`Content` gains `value`, optional and skipped when absent.** A node without a value means "reset to default"; no node means "never set". | A reset must sync as a change rather than look like ignorance. The field is additive, so only `SCHEMA_MINOR` moves. |
| **Every document lives at `sval/ws/<hashed name>/`, settings included.** | It is where the engine puts every document, and a reader of the folder cannot tell which directory holds settings and which holds tabs. |
| **A device writes a setting only when its user changes it.** A fresh device never seeds its defaults. | Seeding defaults with the current time would overwrite every real choice made elsewhere, the same hazard first run's join path avoids. |
| **Applying an incoming value never writes it back.** | An echo would stamp a new timestamp and writer on a value this device did not choose. |
| **Values a user had already set before settings sync first ran on a profile are written once with timestamp 0, before this device first publishes the settings document.** | Firefox does not record when a pref changed. Timestamp 0 lets any real change on any device win, and two seeded devices still converge through the canonical-bytes tie-break. The ordering matters: the absence rule adopts a node only when its writer's watermark on the receiving side is older than the node's timestamp (`merge::is_news_to`), and no watermark is older than 0. A seed that appears after a peer has incorporated this device's file is therefore never adopted by that peer. Written before the first publication, it reaches every peer with no watermark for this device yet. |
| **Locked prefs are never applied and never written.** | Sval's own locks and enterprise locks both mean "not the user's to change". Applying over a lock fails, and writing one would sync a value the user never chose. |
| **The synced pref list is Firefox Sync's `services.sync.prefs.sync.*` list, trimmed** (§5). | Mozilla has spent years deciding which prefs are device-independent. Sval re-decides only where Sval has changed the ground under a pref. |
| **No toggle to turn settings sync off.** Choosing a shared folder syncs workspaces and settings together. | Device-specific settings already stay local (design spec §5.6). |
| **A synced ad-blocking level applies as it arrives.** | Blocking is Sval's own (`2026-10-12-protections-design.md` §1), so a level installs nothing. |
| **Search engine is synced by identifier (`ddg`, `kagi`), through `SearchService`.** | Firefox keeps the default engine in `SearchService`, not a plain pref, and an identifier holds across locales where a display name does not. |

### 2.1 Rejected approaches

- **Setting nodes inside the workspace document.** Every settings change would
  rewrite the whole tree, and setting nodes would sit among workspaces in a
  document the panel walks.
- **A plain last-writer-wins map file outside the engine.** It needs a second
  merge and absence model, built again on iOS and Android, and this project has
  paid for every merge subtlety once already.

## 3. Engine (`sval-core`)

- **`NodeKind::Setting`**, serialised as `"setting"`. A build that lacks it holds
  it as `NodeKind::Unknown("setting")` and round-trips it verbatim, as it does
  for any unknown kind.
- **`tree::repair_unreachable_ancestry` treats a parentless setting as a
  legitimate root**, as it treats a workspace. A setting has no parent and is
  never drawn.
- **`Content.value: Option<serde_json::Value>`**, `#[serde(default,
  skip_serializing_if = "Option::is_none")]`. `content.name` holds the key, so a
  decrypted file read by hand says what each node is.
- **`setting_id(key) -> NodeId`**: UUIDv5 of `key` under a fixed namespace UUID
  defined once in the crate, through the `uuid` crate's `v5` feature.
- **`Document::set_setting(key, value: Option<Value>, now, device)`**: creates the
  node at `setting_id(key)` if absent, otherwise replaces its `content` group
  with the new value, stamping `content_at` and `content_by`. Placement is fixed
  (no parent, `FractionalIndex::default()`) and never rewritten.
- **`Document::settings() -> BTreeMap<String, Option<Value>>`**: every setting
  node's key and value.
- **WASM:** `setSetting(key, valueJson | null, now)` as a mutator, and
  `settings()` returning a JSON object. Both follow `docs/host-contract.md`.

Merge, the absence rule, attribution, tie-breaks and the unchanged-document
write suppression apply to setting nodes as to any other.

## 4. Browser (`sval` fork)

### 4.1 The worker holds documents by name

`SvalSync.worker.mjs` holds a map from document name to document, and every
call names its document. One worker queue orders everything, so key adoption (`setKey`, `holdChanges`) and the shutdown flush,
which already run through that queue, cover both documents: a pairing re-keys
and re-publishes workspaces and settings together.

**Every document rides the same pass.** `SvalEngine` keeps one cadence and one
shared step: the 5-second profile pass and the 30-second shared step of the
local-copy spec each run every registered document in turn, inside the same
deadline and the same single helper. A second, independent clock per document
was rejected: the shared step's state (when it last ran, whether one is
running, what the folder last answered) is one set, and two documents racing
for it would starve one of them or run two helpers. A host that changes a
setting asks for a pass as it does after a tab change.

**An extra document never stops the tree.** A failing settings pass or share
is logged and the tree's pass continues. The change counter advances only
after a pass that ran the tree and every extra document. The settings
document's per-file problems are folded into the report the panel reads, so
a peer on a newer schema is still reported.

Key adoption carries only the tree document through its publish-before-persist
sequence. The settings document is key-independent in memory, like the tree, so
its next pass after adoption merges under the new key and publishes there.
Extra documents are skipped while an adoption is in flight: adoption's own pass
runs under the candidate key, so a settings pass inside it would merge the
other account's settings, and an abandoned adoption restores only the tree.
Because of that skip, the adoption path needs no settings step of its own. An
explicit `sync("settings")` still runs; nothing in the browser makes that
call.

### 4.2 `SvalSettingsSync.sys.mjs`, one per process

`SvalSettingsSync.startFor(engine)` holds the one instance. Windows register a
pass requester and remove it on unload. One instance per window would let
every other window's observer write an applied value back with a newer
timestamp.

- **Registry.** Each entry names a synced key and how to read, write and observe
  it. Most entries are a Firefox pref, typed (`bool`, `int`, `string`). Two are
  Sval's own (§4.3). A setting that is a list or a map is a pref branch, each of
  whose prefs is one entry and syncs as its own setting (§4.4, decision 0117).
- **Outgoing.** A pref observer on every registry pref calls `setSetting(key,
  value)` when the user changes it, or `setSetting(key, null)` when it returns
  to its default (`!prefHasUserValue`). Gecko's pref observers match by
  prefix, so the observer filters to exact keys: watching a listed pref also
  fires for its children (for example `accessibility.typeaheadfind.flashBar`).
- **Incoming.** After each pass that changed the settings document, each value
  is applied: `Services.prefs.set*Pref` for a value, `clearUserPref` for `null`.
- **No echo.** While applying, the observer ignores a change whose effective
  value equals the value being applied. Gecko clears a user value set equal to
  the default, so an applied value equal to this device's default reads back
  as a reset. A different value arriving at the same moment is a real user
  change and is written. Applies are serialized, and a pref the user changed
  after an apply read the document is skipped by that apply.
- **Locked prefs** (`Services.prefs.prefIsLocked`) are skipped in both
  directions.
- **Seeding.** The first time this module runs on a profile, every registry pref
  with a user value is written with timestamp 0, and a flag in
  `SvalLocalSettings` records that seeding is done. Seeding completes before
  the settings document's first sync pass (§2). A synced branch is seeded as
  one, by its name, with every entry it holds (§4.4).
- **Unapplicable values** (an unknown engine identifier, a value of the wrong
  type, a pref a newer ESR removed) are skipped and logged at debug with the
  key only. The node stays in the document, so a device that understands it
  still applies it.
- **Keys this build does not know**, written by a newer build, are kept by the
  merge and ignored here.
- **A pref with no default** on the default branch (new-tab prefs whose
  defaults the new-tab code registers at runtime, and user-set-only prefs such
  as `spellchecker.dictionary`) has no type until set, so an incoming value's
  type is taken from its JSON.

### 4.3 Sval's own settings

| Key | Read and write | Values |
|---|---|---|
| `sval.search.engine` | `SearchService` default engine (`SearchService.sys.mjs`, imported directly, since `Services.search` does not exist in this ESR), observed through `browser-search-engine-modified` | a config engine's `id`, its identifier in `SvalSearchConfig` |
| `browser.sval.adblock.level` (a pref) | `SvalBlocking` | `off`, `balanced`, `strict`, `custom` |

The ad-blocking level syncs as the pref `browser.sval.adblock.level`, in the
§5.1 list, so it gets the pref machinery's seeding, echo suppression and
serialized applies. A separate key would duplicate them. The level leaves
Firefox's tracking-protection category alone (protections spec §1.3). A search
service that fails at start is logged and skipped; prefs still seed.

### 4.4 Settings with an entry each

A setting that holds many entries syncs one setting per entry, so two devices
that change different entries both keep their change, and a removed entry is a
reset that stands (decision 0117). Each entry is a pref of its own under a
branch, and `SvalSettingsRegistry.SYNCED_BRANCHES` lists the branches:

| Branch | One pref per | Value |
|---|---|---|
| `browser.sval.protection.site.` | site | the site's protection choices, as JSON |
| `browser.sval.javascript.site.` | site | `allow` or `block` |
| `browser.sval.adblock.customList.` | list in Custom, by id | `true` |
| `browser.sval.adblock.userList.` | list the user added, by id | `{url, category}` as JSON, with `trusted`, which takes effect on a device once its user trusts the list there (design spec §10.3) |
| `browser.sval.adblock.allowedDomain.` | allowed domain | `true` |
| `browser.sval.extensions.offOn.` | site | the ids of the extensions off there, sorted (extension controls spec, Part 2) |
| `browser.sval.adblock.myFilter.` | line of My filters, by its key | `{line, order}` as JSON (§4.5) |

- **The key is the pref's name**, so `setting_id` gives every device the same
  node for the same entry.
- **Outgoing and incoming** treat a branch's prefs as §4.2 treats a listed
  pref: the observer watches the branch, and each pass applies every key in the
  document under a listed branch. A removed entry is a cleared pref, written as
  `null`.
- **Seeding** is per branch name (decision 0113): the first time a branch is
  seeded, every unlocked entry the document lacks is written, and from then on
  the observer writes each change, an entry added later included.
- **A branch pref's name carries a site**, so a log line names its branch.

A new list-shaped setting is a branch added to `SYNCED_BRANCHES`, never a JSON
pref in the §5 list.

### 4.5 My filters, a line each

My filters is text the user edits as a whole, and syncs a line at a time
(decision 0117). `SvalMyFilters.sys.mjs` keeps it, and the iPhone reads it
by the same rules (`MyFilters.swift`).

- **A line's key** is the first 32 hex digits of the SHA-256 of its text, a
  line break, and how many lines of the same text come before it. Devices
  that add the same line write the same setting, and a line repeated in the
  text keeps every copy.
- **A line's order** is a string of the digits `0`-`9` and `a`-`z` that never
  ends in `0`, read as a base-36 fraction. Lines sort by order, then by key,
  both compared as bytes. A new line takes an order between its neighbours'.
- **An edit writes only what changed.** A line of the new text takes the
  first stored line of the same text not yet taken. The taken lines whose
  orders still rise keep them; every other line is written with an order
  between its neighbours, and a stored line not taken is cleared. An edited
  line is a removal and an addition, so it never competes with another
  device's edit to a different line.
- **A value that is not a line** (not JSON, a line break or control
  character in the line, or an order that breaks the rule above) is left out
  where the lines are read, so a bad value from another device never reaches
  the engine.

## 5. The synced pref list

Firefox Sync's list, every entry with its verdict. **Keep** means it syncs. A
test fails when a kept pref no longer exists in Firefox's pref files, so an ESR
rebase cannot silently orphan one. To it are added Sval's own settings that are
prefs; `SvalSettingsRegistry.SYNCED_PREFS` is the whole list.

### 5.1 Kept

| Pref | Note |
|---|---|
| `accessibility.blockautorefresh` | |
| `accessibility.browsewithcaret` | |
| `accessibility.typeaheadfind` | |
| `accessibility.typeaheadfind.linksonly` | |
| `browser.sval.adblock.level` | Sval's ad-blocking level (§4.3). |
| `browser.ctrlTab.sortByRecentlyUsed` | |
| `browser.download.useDownloadDir` | The folder itself is device-local and not synced. |
| `browser.formfill.enable` | |
| `browser.menu.showViewImageInfo` | |
| `browser.newtabpage.enabled` | |
| `browser.newtabpage.pinned` | The user's pinned shortcuts. |
| `browser.newtabpage.activity-stream.feeds.section.highlights` | |
| `browser.newtabpage.activity-stream.feeds.topsites` | |
| `browser.newtabpage.activity-stream.section.highlights.includeBookmarks` | |
| `browser.newtabpage.activity-stream.section.highlights.includeDownloads` | |
| `browser.newtabpage.activity-stream.section.highlights.includeVisited` | |
| `browser.newtabpage.activity-stream.section.highlights.rows` | |
| `browser.newtabpage.activity-stream.showSearch` | |
| `browser.newtabpage.activity-stream.topSitesRows` | |
| `browser.safebrowsing.downloads.enabled` | One way: another device can turn it on, never off (decision 0133). |
| `browser.safebrowsing.downloads.remote.block_potentially_unwanted` | One way: another device can turn it on, never off (decision 0133). |
| `browser.safebrowsing.malware.enabled` | One way: another device can turn it on, never off (decision 0133). |
| `browser.safebrowsing.phishing.enabled` | One way: another device can turn it on, never off (decision 0133). |
| `browser.startup.homepage` | |
| `browser.tabs.loadInBackground` | |
| `browser.tabs.warnOnClose` | |
| `browser.tabs.warnOnOpen` | |
| `browser.urlbar.maxRichResults` | |
| `browser.urlbar.showSearchSuggestionsFirst` | |
| `browser.urlbar.suggest.bookmark` | |
| `browser.urlbar.suggest.history` | |
| `browser.urlbar.suggest.openpage` | |
| `browser.urlbar.suggest.searches` | |
| `browser.urlbar.suggest.topsites` | |
| `dom.disable_open_during_load` | Pop-up blocking. |
| `dom.disable_window_flip` | |
| `dom.disable_window_move_resize` | |
| `dom.event.contextmenu.enabled` | |
| `dom.security.https_only_mode` | |
| `dom.security.https_only_mode_ever_enabled` | |
| `dom.security.https_only_mode_ever_enabled_pbm` | |
| `dom.security.https_only_mode_pbm` | |
| `extensions.update.enabled` | One way: another device can turn it on, never off (decision 0133). |
| `general.autoScroll` | Its default differs by platform; a synced user value overrides it everywhere, as in Firefox Sync. |
| `intl.accept_languages` | |
| `intl.regional_prefs.use_os_locales` | |
| `layout.spellcheckDefault` | |
| `media.autoplay.default` | |
| `media.eme.enabled` | Sval's default is off; a user who turns DRM on wants it on every device. |
| `media.videocontrols.picture-in-picture.video-toggle.enabled` | |
| `network.cookie.cookieBehavior` | |
| `permissions.default.image` | |
| `privacy.clearOnShutdown.cache` | |
| `privacy.clearOnShutdown.cookies` | |
| `privacy.clearOnShutdown.downloads` | |
| `privacy.clearOnShutdown.formdata` | |
| `privacy.clearOnShutdown.history` | |
| `privacy.clearOnShutdown.offlineApps` | |
| `privacy.clearOnShutdown.sessions` | |
| `privacy.clearOnShutdown.siteSettings` | |
| `privacy.clearOnShutdown_v2.browsingHistoryAndDownloads` | |
| `privacy.clearOnShutdown_v2.cache` | |
| `privacy.clearOnShutdown_v2.cookiesAndStorage` | |
| `privacy.clearOnShutdown_v2.downloads` | |
| `privacy.clearOnShutdown_v2.formdata` | |
| `privacy.clearOnShutdown_v2.historyFormDataAndDownloads` | |
| `privacy.clearOnShutdown_v2.siteSettings` | |
| `privacy.donottrackheader.enabled` | |
| `privacy.globalprivacycontrol.enabled` | |
| `privacy.reduceTimerPrecision` | |
| `privacy.resistFingerprinting.reduceTimerPrecision.jitter` | |
| `privacy.resistFingerprinting.reduceTimerPrecision.microseconds` | |
| `privacy.sanitize.sanitizeOnShutdown` | |
| `privacy.trackingprotection.cryptomining.enabled` | |
| `privacy.trackingprotection.enabled` | |
| `privacy.trackingprotection.fingerprinting.enabled` | |
| `privacy.trackingprotection.harmfuladdon.enabled` | |
| `privacy.trackingprotection.pbmode.enabled` | |
| `security.default_personal_cert` | |
| `spellchecker.dictionary` | A dictionary not installed on a device falls back as Firefox already does. |

### 5.2 Dropped

| Pref | Reason |
|---|---|
| `app.shield.optoutstudies.enabled` | Locked by Sval. |
| `browser.crashReports.unsubmittedCheck.autoSubmit2` | Locked by Sval. |
| `browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons` | Locked by Sval. |
| `browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features` | Locked by Sval. |
| `browser.newtabpage.activity-stream.feeds.section.topstories` | Locked by Sval. |
| `browser.newtabpage.activity-stream.section.topstories.rows` | Only meaningful with top stories, which Sval locks off. |
| `browser.newtabpage.activity-stream.showSponsored` | Locked by Sval. |
| `browser.newtabpage.activity-stream.showSponsoredTopSites` | Locked by Sval. |
| `browser.urlbar.suggest.engines` | Locked by Sval. |
| `nimbus.rollouts.enabled` | Locked by Sval. |
| `signon.management.page.breach-alerts.enabled` | Locked by Sval. |
| `signon.autofillForms` | Locked by Sval (spec §7.3). |
| `signon.generation.enabled` | Locked by Sval (spec §7.3). |
| `signon.rememberSignons` | Locked by Sval (spec §7.3). |
| `browser.contentblocking.category` | Sval syncs the prefs the category stands for, which Protections' tracking settings write (protections spec §3.3). |
| `browser.contentblocking.features.strict` | Sval syncs the prefs the category stands for, which Protections' tracking settings write (protections spec §3.3). |
| `browser.search.update` | Sval ships its own engine list (`SvalSearchConfig`). |
| `browser.startup.page` | Sval sets it to 3 so every launch brings back the last session's windows, and hides its setting (`app-sval-prefs.js`, `settings-hide-firefox-tabs.patch`). Any other value would open one window on the first workspace. |
| `browser.startup.upgradeDialog.enabled` | Mozilla's upgrade onboarding. |
| `browser.firefox-view.feature-tour` | Mozilla's feature tour. |
| `browser.pdfjs.feature-tour` | Mozilla's feature tour. |
| `browser.link.open_newwindow` | Locked by Sval at 3: a link asking for a new window opens a tab, since a new window takes another workspace (Sval spec §10.7). |
| `browser.taskbar.previews.enable` | Windows taskbar tab previews; Sval's panel is the tab surface. |
| `privacy.userContext.enabled` | Containers are Sval's per-workspace design (§10.1). |
| `privacy.userContext.newTabContainerOnLeftClick.enabled` | As above. |
| `extensions.activeThemeID` | Names a theme add-on, and Sval does not sync add-ons; a device without the theme would be left on none. |
| `addons.ignoreUserEnabledChanges` | Part of Firefox Sync's add-on sync, which Sval does not have. |
| `services.sync.syncedTabs.showRemoteIcons` | Firefox Sync's own UI. |
| `pref.downloads.disable_button.edit_actions` | An administrator's UI lock, not a user choice. |
| `pref.privacy.disable_button.cookie_exceptions` | An administrator's UI lock, not a user choice. |
| `ui.osk.enabled` | The on-screen keyboard depends on the device's hardware. |

## 6. Failure handling

| Situation | Behaviour |
|---|---|
| A value this build cannot apply | Skipped; logged at debug with the key only; node kept. |
| A key this build does not know | Kept by the merge; ignored. |
| Settings document undecryptable, or a newer major schema | Reported as the tree document is. Workspaces keep syncing; the two documents are independent. |
| Applying a pref throws | Logged; the remaining settings still apply. |

**Values are never logged.** A setting's value can be a homepage URL.
`SvalSettingsSync.sys.mjs` is in the privacy guard's file list.

## 7. Testing

**Engine:**

- `setting_id` returns the same id for the same key, pinned by a known-answer
  vector so every platform derives it identically.
- Two devices that each first set one key converge on one node.
- A reset beats an older value and loses to a newer one.
- A timestamp-0 seed loses to any real change; two seeds converge.
- An older build round-trips `setting` nodes and `content.value` verbatim.
- Repair leaves a parentless setting alone.

**Browser:**

- A fresh profile writes nothing to the settings document until the user
  changes something.
- A user change writes; an applied value does not echo; locked prefs are skipped
  both ways.
- Two engines in one process converge: a change on one reaches the other's pref,
  and the other's `SearchService` for `sval.search.engine`.
- Every kept pref exists in Firefox's pref files.
- Seeding writes existing user values once, at timestamp 0, and never again,
  and before the settings document's first pass. An engine test pins why: a
  timestamp-0 node that appears after a peer incorporated the writer's file is
  not adopted by that peer.
- Two devices that change different entries of one branch both keep their
  change, and an entry removed on one is removed on the other.
- A profile's JSON pref is split into its branch once, and the entries reach
  another device without replacing a choice made there.
- A tree pass and a settings pass never run two helpers, and a busy tree
  document does not starve the settings document of shared steps.

## 8. Out of scope

- Syncing add-ons or themes.
- Per-setting or global opt-out.
- Settings UI. Each setting's control in Sval's settings page is first run's and
  each feature's own work.
