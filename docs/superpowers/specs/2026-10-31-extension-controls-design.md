# Extension controls: delayed updates and a switch per site

**Status:** Built. Part 1 is decision 1653, Part 2 decision 1659.
**Date:** 2026-10-31
**Author:** John Postlethwait
**Builds on:** decision 1479 (Extensions is a category of Settings), decision
0133 (Safe Browsing and extension updates sync one way), `2026-10-07-settings-sync-design.md` (§4.4,
settings with an entry each), `2026-10-22-site-page-design.md` (the site page),
spec §10.8 and §10.9.

## Why

Two patterns account for most of the harm extensions do to their users:

- **An update turns a trusted extension.** No new permission is asked for,
  so no prompt fires, and an update that installs the day it ships reaches
  users before Mozilla's blocklist (`addons-bloomfilters`, which Sval keeps)
  turns it off. Decision 1653 holds the cases.
- **Broad host access, granted once, reaches everything.** Extensions that
  stole Google OAuth tokens, Telegram sessions and AI chats read them from
  pages they had been allowed to touch at install, on every site.

Sval adds two controls that limit both without limiting what an extension can
do where the user wants it.

## Part 1: Delayed updates

The rules are decision 1653: a background update of an extension waits a set
number of days (default 7, 0 for none) from when the device first saw that
version, and nothing the user starts waits.

### Behaviour

- Firefox checks for updates on `addon-background-update-timer`
  (`extensions.update.interval`, daily). In
  `AddonManagerInternal.backgroundUpdateCheck` (`AddonManager.sys.mjs`), an
  update found for an add-on that `shouldAutoUpdate` lets update is installed
  in `onUpdateAvailable`. Sval holds it there (`SvalUpdateDelay.sys.mjs`,
  `extension-update-wait.patch`).
- The update manifest carries no publish date, so Sval records when it
  first saw each extension id and version, one pref per id under
  `browser.sval.extensions.updateSeen.`, which stays on the device. A
  version is installed on the first check at least the set number of days
  after it was first seen. A newer version replaces the record and starts
  its own wait.
- The blocklist is not delayed.
- Installs the user starts are not delayed: a first install, "Update now",
  and about:addons' "Check for Updates".
- The wait covers add-ons of type `extension` alone.
- `extensions.update.enabled` (Firefox's "update automatically") keeps its
  meaning. Off, nothing is checked, and the wait does not apply.
- 0 behaves as Firefox does.

### Where it shows

- **Settings › Extensions**, a setting above the list: the number of days,
  from 0 to 365, with a description saying why.
- **An extension's page**, when an update waits: a row naming the waiting
  version and the date it installs, with "Update now".

### Sync

The number of days is `browser.sval.extensions.updateWaitDays`, in
`SYNCED_PREFS` in `SvalSettingsRegistry.sys.mjs`. Every change syncs, and the
latest write wins, as for any synced setting.

## Part 2: A switch per site

The rules are decision 1659: each extension has an on/off switch per site
(`siteOf`), on everywhere until the user turns it off, and off cuts what the
extension reaches in a tab showing the site.

### What off covers

Off applies to tabs whose top-level page is on the site. Decision 1659 lists
what the extension cannot reach there. A frame of the site inside another
site's page and the extension's own requests to the site are not tied to a
tab showing the site, so they are left as they are.

The check needs each tab's top-level site where Gecko decides: in
`MozDocumentMatcher::Matches` for scripts and in `ChannelWrapper::Matches` and
`GetTraceableChannel` for requests (C++, `extension-blocked-sites.patch`),
and in the JS paths that decide a tab's access themselves
(`extension-blocked-sites-js.patch`). A content process does not hold a
cross-site top-level document under Fission, so the top-level site is read
from the load's or document's `CookieJarSettings` `partitionKey`, which Gecko
sets for every top-level http(s) load.

Permissions that are not tied to a site (`history`, `bookmarks`,
`downloads`, the `tabs` permission's view of every tab's URL) are
whole-browser grants, and a site switch does not cut them. Each extension's
page lets the user turn optional permissions off.

### The extensions menu

- Sval keeps Firefox's unified extensions panel. Each extension's row gets a
  switch for the site in the current tab. Rows for extensions that cannot
  reach the site at all (`OriginControls` reports no access) show no switch.
- The switch replaces Firefox's origin controls in the row's context menu
  and the panel (`ExtensionsUI.originControlsMenu`,
  `browser-unified-extensions.js`).
- On means the extension has the access Firefox gives it on that site,
  including access it gets only when you click its button (`activeTab`, or
  an MV3 host permission not yet granted). Off blocks everything, the click
  included.
- Turning an MV3 extension on, where its host permission for the site was
  never granted, leaves it on click-only access. Its page's permission card
  still grants the permission. Turning it off adds the block and leaves any
  grant alone. The stored data holds blocks alone.
- Turning a switch either way reloads the site's open tabs, because a running
  content script cannot be taken out of a page, and a newly allowed one runs
  on load.
- Pages that are not on a site (`about:`, `file:`, AMO, other restricted
  domains) show no switches.
- The menu lists every extension, pinned or not. Each row has the site
  menu's pin button (`SvalExtensionsMenu.sys.mjs`,
  `extensions-menu-lists-pinned.patch`).

### Settings

- **An extension's page** (`settings-extensions.js`) has a card listing the
  sites where the extension is off, each with its switch, and a way to add a
  site by typing it (`siteOfEntry`).
- **A site's page** (`settings-site-page.js`) has a card listing every
  installed extension that can reach the site, each with its switch.

### Storage and sync

- One synced pref per site under `browser.sval.extensions.offOn.`
  (`SvalExtensionSites.SITE_BRANCH`, in `SYNCED_BRANCHES`), a JSON value
  with the ids of the extensions off on that site. Settings sync §4.4
  requires a branch for a list-shaped setting.
- Both directions sync. This is a preference, so 0133's one-way rule for
  protections does not apply.
- An id not installed on a device is kept and applies when the extension is
  installed. Removing an extension does not clear its entries, so
  reinstalling it restores them.
- Private windows show no switch. An extension runs there only when its
  page's "Run in private windows" allows it
  (`internal:privateBrowsingAllowed`), and the switches set elsewhere apply
  there too. Nothing from private browsing is stored.

## Tests

- Delay: a found update waits the set days and installs after; a newer version
  restarts the wait; 0 installs at once; "Update now" installs at once; a
  first install is not held; a change on one device reaches the others.
- Switch: in a tab showing a site the extension is off on, it injects no
  content script in any frame, sees none of the tab's requests in
  `webRequest`, its DNR rules act on none of them, its button grants nothing,
  and it cannot capture the tab or read its URL through host permission; on
  again, it does; in a tab showing another site it works as before; both MV2
  and MV3 fixtures; the switch syncs both ways; an entry for an uninstalled id
  applies on install; private windows show no switch.
- Menu: a pinned extension is listed and unpins from its row.
