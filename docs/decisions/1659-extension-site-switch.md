# 1659. An extension can be turned off on a site

**Status:** Accepted on 2026-10-31. Specified in
2026-10-31-extension-controls-design.md.

## Context

An extension granted access to every site reads every site, the ones a
user would rather it never saw included: a bank, an email account, an AI
chat. Firefox gives MV3 extensions a per-site choice between "Always allow"
and "Only when clicked" (`OriginControls`), and MV2 extensions, whose host
permissions are granted at install, none. Firefox's quarantined domains
(`extensions.quarantinedDomains.list`) block every extension on a list
Mozilla keeps, with one exemption per extension, and Sval leaves that list
empty.

## Decision

- Each extension has an on/off switch for each site, a site being `siteOf`'s
  registrable domain. Each extension is on everywhere until a switch turns
  it off, or off everywhere until a switch turns it on, as its default for
  all sites says (decision 2625).
- The switch is for the site in the address bar. Off, the extension reaches
  nothing in a tab whose top-level document is on the site: no content
  script in any frame, no request the tab makes in webRequest,
  filterResponseData or declarativeNetRequest, no activeTab grant, no
  capture, no tab URL through host permission, no webNavigation event. Its
  cookies API neither reads nor sets the site's cookies, in any tab.
  Everywhere else it works as it does with the switch on; a frame of the site inside another
  site's page is not asked about.
- A switch scoped to one host (decision 1980) holds back the cookies set on
  that host and the names under it. A cookie the host's site sets for every
  host stays in reach, as browsers send it to that host too. So does a
  request with no window, such as a service worker's own fetch, which Gecko
  names only by the site in its partition key.
- Permissions not tied to a site (`history`, `bookmarks`, `downloads`, the
  `tabs` permission) are not cut.
- The switch is in each extension's row of the extensions menu, on the
  extension's page in Settings with the sites it is off on, and on each
  site's page with the extensions that reach it. It replaces Firefox's MV3
  site access items. Changing it reloads the site's tabs.
- Private windows show no switch, and nothing from private browsing is
  stored. The switches set elsewhere apply there.
- The switches sync both ways, one pref per site
  (`browser.sval.extensions.offOn.<site>`). An id whose extension is not
  installed keeps its switches.
- The extensions menu lists pinned extensions. Each row has a pin that pins
  or unpins it, as the site menu's does, and a pinned extension's row opens
  it as its toolbar button does.

## Consequences

Gecko holds each policy's blocked sites (`WebExtensionPolicy.blockedSites`)
and checks a tab's top-level site in content-script matching and
`ChannelWrapper` (`extension-blocked-sites.patch`), an input of the Gecko
key. A content process need not hold a tab's cross-site top-level document,
so the site comes from the partition key Gecko sets for every top-level
http(s) load and every frame inherits. The JS paths that decide a tab's
access themselves (DNR, tab data, activeTab, capture, webNavigation,
cookies) have their own check
(`extension-blocked-sites-js.patch`). A rebase that changes any of these
fails the patches. Mozilla's unified extensions tests
`browser_unified_extensions.js` and `browser_unified_extensions_context_menu.js`
time out in Sval without these patches, so they do not gate them.
