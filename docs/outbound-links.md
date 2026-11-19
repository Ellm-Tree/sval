# Outbound links in Firefox's UI

Every link a user can reach in Sval that leads to Mozilla, Firefox or another
third party, and what Sval does with it. A link either goes, or leads to
https://sval.app where a Sval page can answer it. Pref names are
verified against the pinned upstream tree; the prefs are in
`branding/sval/pref/app-sval-firefox-ui.js` unless the table says otherwise.

Clicking a link is the user navigating, so these links are not contacts Sval
makes on its own and add nothing to `scripts/network-contact/allowed-hosts.txt`
(spec §10.9). Turning off about:addons' recommendations pane removes a
contact: the pane fetched Mozilla's suggestions.

## The support base

`app.support.baseURL` builds almost every "Learn more" link: the
`moz-support-link` element and `getHelpLinkURL(topic)` both append a topic slug
to it. Sval sets it to `https://sval.app/support/`, so the site needs a
page, or a catch-all, under that path for each slug (for example `preferences`,
`tracking-protection`, `firefox-help`, `private-browsing-myths`).

The base must stay a real URL. Empty, every link stays on screen with a bare
slug as its address, and the network error page treats every address as
starting with the base (`aboutNetError.mjs`, `net-error-card.mjs`).

## Links

| Surface | Mechanism | Disposition |
|---|---|---|
| Settings "Learn more" links and the settings help button | `app.support.baseURL` | sval.app |
| Help > Get Help, the Help key, settings "Get help" | `app.support.baseURL` | sval.app |
| Permission prompts, add-on install prompts, Page Info, site-protection panel | `app.support.baseURL` | sval.app |
| Network and certificate error pages, blocked-site page | `app.support.baseURL` | sval.app |
| about:privatebrowsing "myths" link | Firefox's private page | Removed: Sval's private page (`chrome/browser/components/sval/home/`) has no links |
| Translations panel's first "Learn more" | `app.support.baseURL` | sval.app |
| Help > Share Ideas and Feedback | `app.feedback.baseURL` | Removed: item hidden (`sval-panel.js` `_hideMozillaEntryPoints`), pref empty |
| Settings "Share ideas" | hardcoded in `about-firefox.mjs` | Removed (`settings-hide-removed-features.patch`) |
| Help > Switching devices | `getHelpLinkURL` | Removed (`_hideMozillaEntryPoints`) |
| Help > Report Broken Site | webcompat | Removed (`no-report-broken-site.patch`) |
| Help > Report Deceptive Site, "This isn't a deceptive site" | `browser.safebrowsing.reportPhishURL`, `...google5.reportPhishMistakeURL` | Kept: Safe Browsing's reporting channel, which Sval uses (spec §10.9) |
| About dialog: community, donate, terms, privacy | hardcoded | Removed (`about-dialog-strip-mozilla-links.patch`) |
| About dialog and settings: release notes | `app.releaseNotesURL`, `app.releaseNotesURL.aboutDialog` | Hidden: Sval's branding defines neither |
| Settings update panel: manual download | `app.update.url.manual` (`app-sval-prefs.js`) | sval.app's download page; it must parse (`update-state` `manualURL`) |
| Geolocation, XR and local-network prompts | `browser.geolocation.warning.infoURL`, `browser.xr.warning.infoURL`, `browser.lna.warning.infoURL` | Removed: empty URL drops the link |
| about:addons recommendations pane and its privacy-policy footer | `extensions.getAddons.showPane` | Removed |
| about:addons theme footer (color.firefox.com) | `extensions.recommendations.themeRecommendationUrl` | Removed: empty URL hides the row |
| about:addons "Find more add-ons", search box, blocked and report links | `extensions.getAddons.*`, `extensions.abuseReport.amoFormURL`, `extensions.blocklist.addonItemURL` | Kept: addons.mozilla.org is where Sval's extensions come from |
| Settings "Find more search engines" | `browser.search.searchEnginesURL` | Kept: addons.mozilla.org |
| Settings and context menu "Download dictionaries" | `browser.dictionaries.download.url` | Kept: addons.mozilla.org |
| about:protections and its "Learn more", Monitor, VPN and mobile links | `browser.contentblocking.report.*` | Removed: Sval does not build about:protections (`no-closed-about-pages.patch`) |
| PDF viewer comment sidebar "Learn more" | `pdfjs.commentLearnMoreUrl` | Removed: empty URL drops the link |
| PDF viewer alt-text "Learn more" | `pdfjs.altTextLearnMoreUrl` | Unused: pdf.js reads it only for its alt-text model, and `pdfjs.enableAltText` is locked off (`app-sval-prefs.js`) |
| about:studies "Learn more" | `app.normandy.shieldLearnMoreUrl` | Removed: empty; studies are off |
| Data-collection notice | `toolkit.datacollection.infoURL` | Removed: empty; its settings group is hidden |
| First-run privacy notice | `datareporting.policy.firstRunURL` | Never opened: data submission is off (`app-sval-prefs.js`) |
| Settings "More from Mozilla", VPN promos, Relay, breach alerts, Firefox Accounts, send-tab and mobile promos | various | Removed by Sval's locked feature prefs (`app-sval-prefs.js`) |
| Profiler results (profiler.firefox.com) | toolbar button and devtools Performance panel | Removed: `devtools.performance.popup.feature-flag` and `devtools.performance.enabled`, locked off |
| about:profiling | its profiles open on profiler.firefox.com | Removed: Sval does not build about:profiling (`no-closed-about-pages.patch`) |
| about:logging profiler output | opens profiler.firefox.com or uploads to api.profiler.firefox.com | Removed: the page logs to a file only (`logging-file-output-only.patch`) |
| about:processes profiler buttons | open profiler.firefox.com | Changed: each button saves its recording to the download folder through `SvalProfiler` (`local-performance-recording.patch`, decision 2428) |
| about:crashes, about:support crash links | `breakpad.reportURL` | Kept: an empty value hides the local crash list, which spec §10.6 keeps; nothing is submitted |
| DevTools error "Learn more" | hardcoded MDN | Kept: MDN documents the web platform, not Firefox |
| about:debugging Setup page's "Troubleshoot" links | hardcoded firefox-source-docs.mozilla.org | Kept: they document DevTools, which Sval ships as Firefox does. The page's Enable USB Devices button is a contact, not a link: it downloads Mozilla's ADB extension from ftp.mozilla.org (spec §10.9) |
| about:logins import-error and breach links | hardcoded support.mozilla.org | Removed: Sval does not build about:logins (`no-closed-about-pages.patch`) |
| Translations panel's second "Learn more" | `app.support.baseURL` (`translations-learn-more-sval-support.patch`) | sval.app |
| about:license "Know your rights" (about:rights) | hardcoded in Firefox's `app-license.html` | Removed: Sval's `app-license.html` replaces that block |
| about:license "instructions on how to download and build the code" | hardcoded firefox-source-docs.mozilla.org | Removed, with the paragraph's pointer to a source URL on about:buildconfig, which Sval's builds do not set (`license-no-source-pointer.patch`); Sval's public source repository will give both a Sval answer |
| about:policies documentation | hardcoded firefox-admin-docs.mozilla.org | Removed: policy names are plain text (`policies-no-mozilla-docs-links.patch`) |
| about:credits, about:rights | their about: modules opened mozilla.org | Removed: neither name is registered (`no-mozilla-credits-rights-pages.patch`) |
| Windows Settings › Apps, Sval's entry: support and about links | `HelpLink` and `URLInfoAbout` in `branding/sval/branding.nsi`, which the installer writes to Sval's uninstall key (`shared.nsh`) | sval.app |
| New tab widgets' "Learn more" | hardcoded in newtab | Removed: about:home and about:newtab show Sval's home page (`sval-home-page.patch`), which has no links |

## Firefox's tab notions

Sval's workspace panel replaces Firefox's tab strip, so Firefox's own tab UI
goes wherever it still surfaces.

| Surface | Disposition |
|---|---|
| Settings > Tabs: interaction fieldset (Ctrl+Tab order, tab previews, tab-group suggestions, drag to group, taskbar previews) | Hidden (`settings-hide-firefox-tabs.patch`), each pref locked off |
| Settings > Tabs: confirm before closing multiple tabs | `browser.tabs.warnOnClose` locked off; closing a window keeps its workspace |
| Settings > Tabs: opening links, switching to new tabs, quit warning | Kept: they govern what Sval still does |
| Settings > Tabs: containers | Removed: isolation is per workspace (isolated workspaces spec §9) |
| Settings > Appearance: "Customize browser layout" link | Hidden (`settings-hide-firefox-tabs.patch`): it opens the browser layout group, which the locks below hide |
| Settings > Browser layout (horizontal or vertical tabs, show sidebar) | `sidebar.verticalTabs` and `sidebar.revamp` locked off, so the group hides |
| Settings > Startup "Open previous windows and tabs" | Hidden (`settings-hide-firefox-tabs.patch`): Firefox's session restore would reopen the tabs Sval restores |
| Vertical tabs, revamped sidebar, its Customize panel and open-tabs panel | `sidebar.verticalTabs`, `sidebar.revamp` locked off |
| Tab groups, smart tab groups, hover previews | Off (`app-sval-prefs.js`) |
| Split view | Kept, at upstream's default: the link menu's "Open Link in Split View", the address bar's split menu, each pane's footer and the `about:opentabs` picker work, and Sval keeps each split in its tree; the strip's own entry points are unreachable with the strip |
| Firefox View: button, Tools menu item, about:firefoxview | Hidden: the button in `sval-panel.css`, the menu item in every macOS window's menu bar, the hidden window's included (`no-firefox-tab-menuitems.patch`); Sval does not build about:firefoxview (`no-closed-about-pages.patch`) |
| List-all-tabs button | Hidden in the customize palette (`sval-panel.css`); it cannot open while the strip is hidden |
| History > Restore Previous Session, app menu copy | Hidden (`no-firefox-tab-menuitems.patch`, `sval-panel.css`) |
| History > Recently Closed Tabs and Windows | Kept: Sval reopens closed tabs through it |
| Tab context menu | Unreachable: it opens only on a strip tab |
| Synced tabs, send tab to device | Hidden while Firefox Accounts are off |
