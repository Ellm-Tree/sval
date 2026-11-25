/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Firefox's own UI that Sval removes or points at Sval: links to Mozilla's
// sites, Firefox's tab settings, and the profiler. docs/outbound-links.md
// lists every link and what became of it.
//
// The filename sorts before "firefox.js", which is what lets these defaults
// win; see the top of app-sval-prefs.js. It shares no pref with
// app-sval-prefs.js, so the order between the two does not matter.
//
// A locked pref's control is hidden from settings
// (settings-hide-removed-features.patch), which is how the tab settings below
// leave about:preferences.

// ---------------------------------------------------------------- links

// Every "Learn more" link in settings, permission prompts, error pages,
// about:privatebrowsing and Help > Get Help is this base plus a topic slug
// (`getHelpLinkURL`, `moz-support-link`). It must stay a real URL: an empty
// base leaves every link in place with a bare slug as its address, and the
// network error page treats every address as starting with it
// (`aboutNetError.mjs`, `net-error-card.mjs`).
pref("app.support.baseURL", "https://sval.app/support/");

// Help > Share Ideas and Feedback goes to Mozilla's feedback site; Sval hides
// the item (sval-panel.js `_hideMozillaEntryPoints`), and an empty URL makes a
// stray caller do nothing (`openLinkIn` returns on an empty URL).
pref("app.feedback.baseURL", "");

// Permission prompts drop their "Learn more" link when these are empty
// (`PopupNotifications` ignores an empty `learnMoreURL`).
pref("browser.geolocation.warning.infoURL", "");
pref("browser.xr.warning.infoURL", "");
pref("browser.lna.warning.infoURL", "");

// about:addons: the Recommendations pane and the theme footer are Mozilla's
// suggestions, fetched from Mozilla. The pane pref is the one enterprise
// policy uses to remove it; the footer row is hidden when its URL is empty
// (`recommended-themes-footer`). Add-ons themselves still come from
// addons.mozilla.org, which is where Sval installs password managers from.
pref("extensions.getAddons.showPane", false);
pref("extensions.recommendations.themeRecommendationUrl", "");

// The PDF viewer's comment sidebar drops its "Learn more" link when this is
// empty (`CommentManager`'s `#createZeroCommentElement`): Sval's site has no
// page on PDF comments.
pref("pdfjs.commentLearnMoreUrl", "");

// Links for features Sval turns off (data collection), so a page that still
// reaches for them has no Mozilla address to show.
pref("toolkit.datacollection.infoURL", "");

// ------------------------------------------------------------- profiler

// Firefox's profiler toolbar button and devtools Performance panel open their
// results on profiler.firefox.com, so Sval offers neither; Sval's own
// recordings save to a file (decision 2428). With the feature flag false the
// toolbar button is never registered (DevToolsStartup
// `hookProfilerRecordingButton`), so a placement left in a profile's toolbar
// draws nothing; locked, because profiler.firefox.com and about:logging set
// it to put the button back (`ensureButtonInNavbar`). The devtools
// Performance panel is the other way in, and this is its visibility switch
// (devtools/client/definitions.js).
pref("devtools.performance.popup.feature-flag", false, locked); // upstream: true in Nightly and debug builds
pref("devtools.performance.enabled", false, locked);           // upstream: true

// ----------------------------------------------------------------- tabs

// Sval's workspace panel is the only place a tab is drawn, so settings for
// Firefox's tab strip have nothing to act on. Each lock also removes the
// setting from about:preferences.
//
// Vertical tabs would draw a second strip, in Firefox's sidebar, that Sval does
// not hide, and the revamped sidebar carries the switch for it.
pref("sidebar.verticalTabs", false, locked);               // upstream: false
pref("sidebar.revamp", false, locked);                     // upstream: false on ESR
// Dragging one tab onto another in the strip to make a tab group.
pref("browser.tabs.dragDrop.createGroup.enabled", false, locked); // upstream: true
// Closing a window keeps its workspace, so there are no tabs to warn about.
pref("browser.tabs.warnOnClose", false, locked);           // upstream: false
// A link asking for a new window opens a tab instead, from a page or from
// another app: a new window takes another of the user's workspaces, or a new
// nameless one (Sval spec §10.7).
pref("browser.link.open_newwindow", 3, locked);            // upstream: 3
pref("browser.link.open_newwindow.override.external", -1, locked); // upstream: -1

// ----------------------------------------------------------- containers

// A workspace is Sval's unit of isolation: an isolated workspace's tabs share a
// cookie jar of their own, and no tab has a jar apart from its workspace's
// (isolated workspaces spec §2). Firefox's per-tab containers would put a
// second, conflicting jar on a tab, so every way to reach them is off.
// Locked, because an add-on with the contextualIdentities permission turns
// the first two back on at startup (ext-contextualIdentities.js, onStartup).
//
// Every container menu item, the File menu's New Container Tab, the new-tab
// button's container menu and the contextualIdentities add-on API.
pref("privacy.userContext.enabled", false, locked);        // upstream: true
// Settings > Tabs "Enable Container Tabs" and the Containers pane.
pref("privacy.userContext.ui.enabled", false, locked);     // upstream: true
// The new-tab button asking which container to open in.
pref("privacy.userContext.newTabContainerOnLeftClick.enabled", false, locked); // upstream: false
// The add-on that claimed the containers setting, if any.
pref("privacy.userContext.extension", "", locked);         // upstream: ""

// ------------------------------------------------------------- favorites

// A plain click on a favorite opens it in a new tab in the workspace, or in
// the selected tab when that one is empty (PlacesUIUtils.openNodeWithEvent),
// so opening a second favorite never replaces the first.
pref("browser.tabs.loadBookmarksInTabs", true);            // upstream: false

// ---------------------------------------------------------------- header

// The downloads button sits in the header's page pill between the favorite
// and history buttons (SvalHeader.sys.mjs), so it shows before the first
// download too.
pref("browser.download.autohideButton", false);            // upstream: true
