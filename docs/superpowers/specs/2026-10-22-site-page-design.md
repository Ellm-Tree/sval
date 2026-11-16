# A Settings page for each site

**Status:** Built.
**Date:** 2026-10-22
**Author:** John Postlethwait
**Builds on:** `2026-10-22-element-picker-design.md` (the Sites card's
Hidden column, the forget confirm), `2026-10-14-isolated-workspaces-design.md`
(a workspace's jar), decision 0132 (the site menu).

## 1. What it is

The site menu in the address bar shows everything Sval holds for a site,
while that site is open. A site's page in Settings shows and edits the same
things from anywhere, together with the site's cookies and stored data in
each workspace.

## 2. Rules

- **The page holds everything the site menu does**, and edits it:
  protections, video and audio, JavaScript, permissions (the cookie
  exception among them), and hidden elements with no cap.
- **It adds a Cookies and site data section** that names the workspaces
  holding data for the site (§4).
- **Firefox's Manage Data and Manage Exceptions dialogs stay**, for work
  across many sites (sorting by size, clearing several at once). The page
  links to them.
- **Every site Sval holds anything for has a page**: a choice, a
  permission, a hidden-element rule, or stored data in any workspace.
  Whether the site holds anything counts every permission of the site's
  origins outside private windows, those the page has no row for included,
  and the data of every jar, containers and Firefox's internal jars
  included. The permissions Sval writes to apply the site's choices count
  under the choices alone. A site with nothing held shows its page with
  each section empty and a line saying Sval holds nothing for it. Forget
  this site leaves the page in that state.
- **"Forget this site" on the page clears everything** Sval and Firefox
  hold for the site, in every workspace and every jar: Firefox's Forget
  About This Site set (`CLEAR_FORGET_ABOUT_SITE`: history, downloads,
  cookies and site data, caches, permissions, certificate exceptions and
  the rest of that flag), Sval's choices (protections, video and audio,
  JavaScript, fingerprinting exceptions), the site's My filters lines, and
  its Favorites and pins. A confirm lists each part with its count before
  anything goes. Sval keeps no saved logins (`signon.rememberSignons` is
  locked off), so there are none to clear.
- **Forget's confirm groups the parts by reach.** "On every device": the
  site's choices, its fingerprinting exceptions, its My filters lines, and
  its Favorites and pins, because they sync. "On this device": history,
  downloads, cookies and site data, caches, permissions and certificate
  exceptions. Cookie jars never sync (Sval spec §5.7), and settings sync
  carries neither permissions nor certificate exceptions.
- **The Sites row's Reset** keeps a narrower meaning: it clears the site's
  stored rule (`SvalSiteProtections.setRule(site, null)`: protections,
  video and audio and fingerprinting exceptions) and its hidden-element
  lines. JavaScript is not part of it. Its tooltip and its confirm say so,
  and say that the site's cookies and logins stay, so tidying the list
  never signs anyone out. Reset asks first only when it deletes My filters
  lines, because a line may be hand-written. A grant from Sval's defaults
  file stays after Reset, so a row with nothing else has no Reset.
- **"Clear everywhere" asks first**, and its confirm says plainly that it
  signs you out of the site in every workspace. It is the data section's
  only confirm: a workspace's own Clear acts at once.
- **Shared workspaces appear as one entry** in the data section, because
  they share the profile's one jar (`userContextId` 0). Each isolated
  workspace is listed by its name.
- **Clear and Forget report what could not be cleared** and leave the rest
  done. Nothing is rolled back.

## 3. Reaching the page

- Settings › Sites › {site}. The site is `siteOf`'s answer, as
  in the Sites list.
- From a site's row in the Sites list, which opens its page from anywhere
  but its Reset. A site holding a permission, a JavaScript rule, a choice or
  removed elements has a row (decision 1484). The row holds no control of
  the site's choices: it names the site and says in one line what differs
  from the defaults, and the page is where each is changed. The line reads
  each permission as "label: state" in Firefox's words ("Use the camera:
  allowed"), apart from installing ("Can install extensions"). A
  permission held by another origin under the site names its host ("on
  addons.mozilla.org"), and one the defaults file grants ends "(default)".
- From Add site, which asks for an address, cuts it to its site
  (`siteOfEntry`) and opens that site's page at the defaults. The site joins
  the list once it has a choice.
- From the site menu's "Manage in Settings" and "See all N in Settings"
  links, which open the page in place of the filtered Sites list.
- From the Sites list's search, which lists matching sites that hold only
  stored data as results that open their page. The results show only under
  the "all sites" filter, and each is summed up in Firefox's permission
  labels. A line under the search reads "N of M sites" only while a search
  or filter is on, and the heading carries no count. The search builds its
  list when Settings opens and refreshes it when a source changes:
  protections and JavaScript rules, My filters, the permission manager,
  and `SiteDataManager.updateSites`, whose results join the list when it
  answers. Until it answers, the search and the page's Cookies and site
  data section show that they are still loading.
- The page has a way back to the Sites card. The site goes in the Settings
  URL's hash after the Sites pane's own, so the page survives a reload and
  works from history.
- The page follows changes made elsewhere (the site menu, another window,
  sync) through the observers the Sites card uses, plus the permission
  manager's and site data's notifications.

## 4. Sections

In this order, matching the site menu.

### Protections, video and audio, and fingerprinting exceptions

The site's protections, video and audio and fingerprinting exceptions,
through the setters the protection button uses (`SvalSiteProtections`). The
Protections select offers the Sites card's values: Default, Fingerprinting
protection off, All protections off.

### JavaScript

The site's choice through `SvalJavascript.setEnabled` and `removeRule`. The
JavaScript pane keeps its list of sites.

### Permissions

- Every permission Firefox's Page Info offers for a site
  (`SitePermissions.listPermissions()` with a label, less
  `open-protocol-handler`, which is held per scheme), held or at its
  default: the site menu's always-listed ones first (`LISTED_PERMISSIONS`:
  camera, microphone, location, notifications, pop-ups), the rest by label,
  then any other the site holds, except those the site menu leaves out
  (`UNLISTED_PERMISSIONS`). Installing extensions is one of them, named
  "Install extensions".
- Each select offers Default, then `SitePermissions.getAvailableStates`'
  order (Ask, Allow, Block) less Unknown. Default names what the site gets
  without a choice of its own: the default for every site, or the grant
  Sval's defaults file (`permissions.manager.defaultsUrl`) gives that
  origin, which `nsIPermission.isDefault` tells from the user's. Choosing
  Default removes the user's choice, and the permission manager restores
  the grant.
- The cookie exception (`cookie` permission: allow, allow for the session,
  block), which Firefox's Manage Exceptions edits.
- A permission belongs to a site when `siteOf` of its principal's origin is
  the site. The section lists one row per permission per origin, and names
  the host on a row whose host is not the site itself (`mail.example.com`,
  a port). A change writes to that row's origin alone. A permission not yet
  set is written for the site's own origins (`siteOrigins` in
  `SvalJavascript`, as JavaScript choices are).
- Each permission is read and written through Firefox's `SitePermissions`.
  Permissions are not kept per jar (`permissions.isolateBy.userContext` is
  false), so a permission applies in every workspace; the section says so
  once.

### Hidden elements

Every line of My filters for the site, newest first, with no cap: the rows
and Show again as in the Sites card's panel (element picker spec §6),
and "Open in My filters", which opens My filters with the site's newest
line selected.

### Cookies and site data

- One row for "Shared workspaces" (the profile's jar), then one row per
  isolated workspace that holds data for the site, by the workspace's name.
  A jar with no workspace (its workspace deleted, or not yet synced to this
  device) is listed as "Removed workspace". Each row shows the storage used
  and has Clear. A jar holding only cookies reads "Cookies only" in place
  of a size, because `SiteDataManager` does not measure cookies, and Clear
  everywhere's confirm then gives no size.
- "Clear everywhere" above the rows.
- Storage per jar comes from `SiteDataManager`, which records each site's
  usage by `userContextId` (`containersData`). A jar maps to its workspace
  through `SvalWorkspaceJar`.
- Stored data is read again whenever a site's page opens, Forget's confirm
  opens and the search's query changes. The last answer is drawn while it
  reads, and the confirm waits for the new one. A failed read says "Sval
  couldn't read stored data." with Try again, on the data card and in
  Forget's confirm, whose Forget waits until a read succeeds. A failed read
  is not retried on its own.
- Clear for one row deletes the site's cookies and site data in that jar
  only (`Services.clearData.deleteDataFromSite` with that jar's
  `userContextId` as the pattern). Clear everywhere passes the empty
  pattern, as Firefox's Manage Data does.
- Links to Firefox's Manage Data and Manage Exceptions.

### Forget this site

At the foot of the page, with a confirm (§2).

## 5. Private windows

Private browsing data lives in memory and is never listed. Under "Always
use private browsing mode", where every window is private, Settings
behaves as the Sites card does there: protections,
video and audio and fingerprinting exceptions edit that window's own
choices (`SvalSiteProtections` with the window's session), which last as
long as the window. Everything else (JavaScript, permissions, hidden
elements, site data, Forget) is shown read-only, and nothing that saves to
the profile or deletes from it is offered. Reset there clears that window's
choices alone, with no confirm, and a fingerprinting exception is added and
removed as the Sites card allows in a private window.

## 6. Out of scope

- Replacing Firefox's Manage Data and Manage Exceptions.
- Per-workspace permissions.
- A history of a site's visits.
