/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

// Sval default preferences.
//
// These live in the branding directory because it is an added file, so it
// rebases for free.
//
// The filename decides which default wins. pref_LoadPrefsInDir
// (modules/libpref/Preferences.cpp) loads browser/defaults/preferences/ in
// reverse-alphabetical order (pref_CompareFileNames), and each pref() call
// overwrites an earlier default for the same key, so the alphabetically
// smallest filename loads last and wins. firefox.js and debugger.js set some
// of these prefs too, so this file's name must sort before both. A name that
// sorts after them loses those prefs to Firefox's values with no error;
// check the effective values in the packaged app before renaming it.

// Principle 6: your attention is yours. No telemetry, no data reporting.
// Locked: settings offers it as a switch, and turning it on uploads Glean pings
// to incoming.telemetry.mozilla.org. Sending data to Mozilla is not a choice
// Sval offers.
pref("datareporting.healthreport.uploadEnabled", false, locked);
pref("datareporting.policy.dataSubmissionEnabled", false);
pref("toolkit.telemetry.unified", false);
pref("toolkit.telemetry.enabled", false);
pref("toolkit.telemetry.archive.enabled", false);
pref("app.shield.optoutstudies.enabled", false, locked);
pref("browser.discovery.enabled", false, locked);

// A crash report leaves the device only when the user sends it, from a crash
// dialog's box or the Send Feedback form, to feedback.sval.app (feedback spec
// §10). Nothing submits on its own (spec section 10.6).
pref("browser.crashReports.unsubmittedCheck.enabled", false);
pref("browser.crashReports.unsubmittedCheck.autoSubmit2", false, locked);
// The crashed-tab page's "Send crash report" box starts from this, and Restore
// submits whatever it is left at (ContentCrashHandlers.sys.mjs, TabCrashHandler).
// Its include-URL box follows browser.tabs.crashReporting.includeURL, false
// upstream.
pref("browser.tabs.crashReporting.sendReport", false); // upstream: true

// Enhanced Tracking Protection on by default (spec section 10.3). Its
// categories choose Mozilla's tracker lists; ads are blocked by Sval's own
// lists at the ad-blocking level below (protections spec §1.3).
pref("browser.contentblocking.category", "standard");
// Firefox's infobar offering to reload a private page with its tracking
// protection lowered is Enhanced Tracking Protection's own UI. Sval's
// protection button is how a site's protections come off (protection-button
// spec).
pref("privacy.reducePageProtection.infobar.enabled.pbmode", false);

// Fingerprinting protection (protections spec §3.2; the decision for each
// API is in docs/fingerprinting-catalogue.md). FPP runs in every
// window, so normal and private windows read the same and private mode has no
// tell. ContentBlockingPrefs' "standard" category clears these prefs to their
// defaults rather than setting them, so changing the defaults here leaves the
// category "standard".
//
// The overrides apply on top of RFPTargetsDefault.inc:
// - EfficientCanvasRandomization only tags PNG exports, and
//   CanvasUtils::ImageExtractionResult picks it before CanvasRandomization,
//   so it is turned off for real pixel noise to apply.
// - NetworkConnection is left off: it also pins navigator.onLine to true,
//   which offline-first apps need to read truthfully.
// - DiskStorageLimit is left off: it does not only report a fixed quota,
//   it enforces one (QuotaManager's GetTemporaryStorageLimit), capping every
//   site's real storage.
pref("privacy.fingerprintingProtection", true);
pref("privacy.fingerprintingProtection.pbmode", true);
pref(
  "privacy.fingerprintingProtection.overrides",
  "-EfficientCanvasRandomization,+CanvasRandomization,+WebGLVendorSanitize,+WebGPUIsFallbackAdapter,+VideoElementMozFrames,+VideoElementMozFrameDelay,+VideoElementPlaybackQuality,+MediaError,+WebVTT,+PdfjsSpoof,+ScreenPixelDepth,+WindowScreenXY,+WindowInnerScreenXY,+MouseEventScreenPoint,+CSSColorInfo,+CSSVideoDynamicRange,+CSSPrefersReducedTransparency,+CSSInvertedColors,+TouchEvents,+ScreenSizeCommon,+WindowOuterSizeTypical,+LanguagesPrimaryOnly,+MediaDevicesBeforePermission,+GamepadIdGeneric,+PermissionsDefaultDenyPrompt,+SpeechVoicesDefault,+WebGPUTimestampQueryHidden,+AudioOutputRandomization,+NavigatorHWConcurrencyRandomized"
);
// Mozilla's fingerprinting webcompat fixes (decision 1685) are off until the
// user turns them on in Settings.
pref("privacy.fingerprintingProtection.remoteOverrides.enabled", false);
// The ESR's StaticPrefList offers this cipher, and release Firefox's turns it
// off on every channel. Offering it gives the ESR's ClientHello a JA4 release
// Firefox does not send, and eBay's Akamai edge answers that ClientHello's
// first request with a 403 error page.
pref("security.ssl3.ecdhe_ecdsa_aes_256_sha", false); // upstream: true
pref("privacy.globalprivacycontrol.enabled", true);
// A site with no secure version opens only after the person chooses to,
// from the warning page, in every window. Local and loopback addresses are
// exempt (nsHTTPSOnlyUtils::LoopbackOrLocalException).
pref("dom.security.https_only_mode", true); // upstream: false
pref("widget.non-native-theme.use-theme-accent", false);
pref("media.peerconnection.ice.proxy_only_if_behind_proxy", true);
pref("privacy.partition.network_state.connection_with_proxy", true);

// On macOS, MediaManager opens a voice input stream as soon as a page asks
// for the microphone, before the person answers Sval's prompt. Opening it is
// what makes macOS ask for microphone access, so on a first run the system
// dialog comes up ahead of, and over, Sval's prompt. With priming off,
// macOS asks only after Allow (WebRTCParent's checkOSPermission). The content
// process that primes cannot read macOS's answer (nsIOSPermissionRequest is
// parent-only), so priming cannot wait for it.
pref("media.getusermedia.microphone.voice_stream_priming.enabled", false);

// The Picture-in-Picture toggle on a video is the compact icon from the
// start. Until this is set, videocontrols.js draws the first-time card with
// its explainer text in the toggle's place.
pref("media.videocontrols.picture-in-picture.video-toggle.has-used", true); // upstream: false

// A video playing in a tab the user leaves goes on in a Picture-in-Picture
// window, which closes when they come back to the tab (PictureInPicture's
// VideoTabHidden and unpipAutoPipBrowser). Hiding the tab is what starts it,
// so a switch of Workspace does it as a switch of tab does.
pref("media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled", true); // upstream: false

// The media gate (protections spec §4.1): video and audio, Web Audio included,
// play only on a site whose autoplay-media permission is ALLOW. The
// protection button and Settings › Protections › Sites set it per site, and
// each site's choices are a pref under browser.sval.protection.site., which
// SvalSiteProtections writes into the permission manager and the granular
// fingerprinting overrides. Settings › Sites' choice for sites with no choice
// of their own is media.autoplay.site-permission-only.default, which the gate
// reads and which syncs with each site's pref.
pref("media.autoplay.site-permission-only", true);
// Whether this profile's earlier per-site permissions have been brought into
// browser.sval.protection.site. (SvalSiteProtections._migrate). Local.
pref("browser.sval.protection.migrated", false);
// The granular fingerprinting entries SvalSiteProtections derives from the
// choices under browser.sval.protection.site., empty while no site has one.
// It writes them on the default branch alone, so they are never saved.
// Local.
pref("browser.sval.protection.fingerprintingOverrides", "");
pref("browser.sval.protection.baselineFingerprintingOverrides", "");

// Ad blocking (protections spec §1.3, first-run spec §4). The level is
// "off", "balanced", "strict" or "custom", and syncs between devices.
pref("browser.sval.adblock.level", "balanced");
// Custom's lists, the lists the user added in Custom and the domains never
// blocked anywhere are a pref per entry, with no default, under
// browser.sval.adblock.customList., .userList. and .allowedDomain. Each entry
// syncs (SvalBlocking).
// The curated level Custom started from, which keeps Strict's query stripping
// in a Custom set made from Strict. Syncs with the lists (SvalBlocking).
pref("browser.sval.adblock.customFrom", "");
// Whether the lists' page rules (element hiding and scriptlets) apply as well
// as their request blocking (protections spec §5). Syncs (SvalPageRules).
pref("browser.sval.adblock.pageRules", true);
// Whether uBlock Origin's trusted scriptlets run from the lists trusted with
// them: uBlock Origin's own and the added lists the user trusts. Local: trust
// is given on each device (SvalBlocking).
pref("browser.sval.adblock.trustedScriptlets", true);
// The user's own filter rules, one per line ("My filters"), which sync, and
// the SHA-256 of the rules the user trusted on this device to run trusted
// scriptlets, which is local (SvalBlocking).
pref("browser.sval.adblock.myFilters", "");
pref("browser.sval.adblock.myFiltersTrustedHere", "");
// Which buttons are pinned in the site controls, a JSON array of
// "javascript", "remove" (Remove from this site) and "snip" (Snip).
// Global, and synced (SvalSiteControls).
pref("browser.sval.siteControls.toolbarButtons", '["javascript","snip"]');
// The ids of the extensions Sval has warned hide tabs, a JSON array
// (SvalExtensionCompat). Local, as the extensions installed are.
pref("browser.sval.extensions.tabHideWarned", "[]");
// Days a background check holds an extension update before installing it,
// counted from when this device first saw the version; 0 installs at once.
// Synced (SvalUpdateDelay).
pref("browser.sval.extensions.updateWaitDays", 7);
// Whether blocking lists download on their schedule (SvalBlockingLists). Off
// only in test harnesses, which forbid contacting the lists' publishers.
pref("browser.sval.adblock.updates.enabled", true);
// Where each curated list downloads from (SvalBlockingLists, protections
// spec §1.2), read at each download. uBlock Origin's lists are its built
// files, which have their `!#include` lines resolved, since adblock-rust does
// not resolve them; AdGuard's are the builds AdGuard publishes for uBlock
// Origin's syntax. Privacy Badger's groups of the domains one company owns
// come from browser.sval.adblock.source.firstParties (SvalTrackerOwners).
pref(
  "browser.sval.adblock.list.sval-ublock-filters.url",
  "https://ublockorigin.github.io/uAssetsCDN/filters/filters.min.txt"
);
pref(
  "browser.sval.adblock.list.sval-easylist.url",
  "https://easylist.to/easylist/easylist.txt"
);
pref(
  "browser.sval.adblock.list.sval-adguard-base.url",
  "https://filters.adtidy.org/extension/ublock/filters/2_without_easylist.txt"
);
pref(
  "browser.sval.adblock.list.sval-hagezi-light.url",
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/light.txt"
);
pref(
  "browser.sval.adblock.list.sval-hagezi-normal.url",
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/multi.txt"
);
pref(
  "browser.sval.adblock.list.sval-hagezi-pro-mini.url",
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.mini.txt"
);
pref(
  "browser.sval.adblock.list.sval-hagezi-pro.url",
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.txt"
);
pref(
  "browser.sval.adblock.list.sval-hagezi-pro-plus.url",
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/pro.plus.txt"
);
pref(
  "browser.sval.adblock.list.sval-hagezi-ultimate.url",
  "https://raw.githubusercontent.com/hagezi/dns-blocklists/main/adblock/ultimate.txt"
);
pref("browser.sval.adblock.list.sval-oisd-small.url", "https://small.oisd.nl/");
pref("browser.sval.adblock.list.sval-oisd-big.url", "https://big.oisd.nl/");
pref(
  "browser.sval.adblock.list.sval-easyprivacy.url",
  "https://easylist.to/easylist/easyprivacy.txt"
);
pref(
  "browser.sval.adblock.list.sval-ublock-privacy.url",
  "https://ublockorigin.github.io/uAssetsCDN/filters/privacy.min.txt"
);
pref(
  "browser.sval.adblock.list.sval-adguard-tracking.url",
  "https://filters.adtidy.org/extension/ublock/filters/3.txt"
);
pref(
  "browser.sval.adblock.list.sval-ublock-annoyances-others.url",
  "https://ublockorigin.github.io/uAssetsCDN/filters/annoyances-others.txt"
);
pref(
  "browser.sval.adblock.list.sval-fanboy-social.url",
  "https://easylist.to/easylist/fanboy-social.txt"
);
pref(
  "browser.sval.adblock.list.sval-fanboy-annoyance.url",
  "https://secure.fanboy.co.nz/fanboy-annoyance.txt"
);
pref(
  "browser.sval.adblock.list.sval-adguard-annoyances.url",
  "https://filters.adtidy.org/extension/ublock/filters/14.txt"
);
pref(
  "browser.sval.adblock.list.sval-easylist-cookie.url",
  "https://secure.fanboy.co.nz/fanboy-cookiemonster.txt"
);
pref(
  "browser.sval.adblock.list.sval-ublock-cookies.url",
  "https://ublockorigin.github.io/uAssetsCDN/filters/annoyances-cookies.txt"
);
pref(
  "browser.sval.adblock.list.sval-adguard-cookies.url",
  "https://filters.adtidy.org/extension/ublock/filters/18.txt"
);
pref(
  "browser.sval.adblock.list.sval-ublock-badware.url",
  "https://ublockorigin.github.io/uAssetsCDN/filters/badware.min.txt"
);
pref(
  "browser.sval.adblock.list.sval-curben-urlhaus.url",
  "https://malware-filter.gitlab.io/urlhaus-filter/urlhaus-filter-ag-online.txt"
);
pref(
  "browser.sval.adblock.list.sval-curben-phishing.url",
  "https://malware-filter.gitlab.io/phishing-filter/phishing-filter.txt"
);
pref(
  "browser.sval.adblock.list.sval-ublock-unbreak.url",
  "https://ublockorigin.github.io/uAssetsCDN/filters/unbreak.min.txt"
);
pref(
  "browser.sval.adblock.list.sval-ublock-quick-fixes.url",
  "https://ublockorigin.github.io/uAssetsCDN/filters/quick-fixes.min.txt"
);
pref(
  "browser.sval.adblock.list.sval-brave-unbreak.url",
  "https://raw.githubusercontent.com/brave/adblock-lists/master/brave-unbreak.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-ara.url",
  "https://easylist-downloads.adblockplus.org/liste_ar.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-chn.url",
  "https://filters.adtidy.org/extension/ublock/filters/224.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-cze.url",
  "https://raw.githubusercontent.com/tomasko126/easylistczechandslovak/master/filters.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-deu.url",
  "https://easylist.to/easylistgermany/easylistgermany.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-fin.url",
  "https://raw.githubusercontent.com/finnish-easylist-addition/finnish-easylist-addition/gh-pages/Finland_adb.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-fra.url",
  "https://filters.adtidy.org/extension/ublock/filters/16.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-grc.url",
  "https://www.void.gr/kargig/void-gr-filters.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-hun.url",
  "https://cdn.jsdelivr.net/gh/hufilter/hufilter@gh-pages/hufilter-ublock.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-idn.url",
  "https://raw.githubusercontent.com/ABPindo/indonesianadblockrules/master/subscriptions/abpindo.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-ind.url",
  "https://easylist-downloads.adblockplus.org/indianlist.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-irn.url",
  "https://raw.githubusercontent.com/MasterKia/PersianBlocker/main/PersianBlocker.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-isr.url",
  "https://raw.githubusercontent.com/easylist/EasyListHebrew/master/EasyListHebrew.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-ita.url",
  "https://easylist-downloads.adblockplus.org/easylistitaly.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-jpn.url",
  "https://filters.adtidy.org/extension/ublock/filters/7.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-kor.url",
  "https://cdn.jsdelivr.net/npm/@filteringdev/filterslists-ko@latest/dist/filterslist-uBlockOrigin-classic.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-ltu.url",
  "https://raw.githubusercontent.com/EasyList-Lithuania/easylist_lithuania/master/easylistlithuania.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-lva.url",
  "https://raw.githubusercontent.com/Latvian-List/adblock-latvian/master/lists/latvian-list.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-nld.url",
  "https://filters.adtidy.org/extension/ublock/filters/8.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-rou.url",
  "https://raw.githubusercontent.com/tcptomato/ROad-Block/master/road-block-filters-light.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-rus.url",
  "https://cdn.jsdelivr.net/gh/dimisa-RUAdList/RUAdListCDN@main/lists/ruadlist.ubo.min.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-spa.url",
  "https://easylist-downloads.adblockplus.org/easylistspanish.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-por.url",
  "https://filters.adtidy.org/extension/ublock/filters/9.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-svn.url",
  "https://raw.githubusercontent.com/betterwebleon/slovenian-list/master/filters.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-swe.url",
  "https://raw.githubusercontent.com/lassekongo83/Frellwits-filter-lists/master/Frellwits-Swedish-Filter.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-tha.url",
  "https://raw.githubusercontent.com/easylist-thailand/easylist-thailand/master/subscription/easylist-thailand.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-tur.url",
  "https://filters.adtidy.org/extension/ublock/filters/13.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-ukr.url",
  "https://filters.adtidy.org/extension/ublock/filters/23.txt"
);
pref(
  "browser.sval.adblock.list.sval-region-vie.url",
  "https://raw.githubusercontent.com/abpvn/abpvn/master/filter/abpvn_ublock.txt"
);
pref(
  "browser.sval.adblock.source.firstParties",
  "https://raw.githubusercontent.com/EFForg/privacybadger/master/src/js/multiDomainFirstParties.js"
);
// The addresses of lists the user added or allowed on this device, a JSON
// array. Local: a list that arrives only through sync waits for it.
pref("browser.sval.adblock.userListsConfirmed", "[]");
// The addresses of added lists the user trusts on this device, a JSON array.
// Local: a list another device trusts runs trusted scriptlets here only once
// the user trusts it here (SvalBlockingLists).
pref("browser.sval.adblock.userListsTrustedHere", "[]");
// Blocking runs on Gecko's content classifier (protections spec §1.1), in
// normal and private windows, and the URL classifier steps aside for it, so
// one engine matches each request. Safe Browsing does not go through it.
// SvalBlocking writes the engines prefs and each feature's lists from the
// level (decision 1051); these are the defaults until it first runs. The
// annotation engine is the tracker tag Firefox's cookie blocking reads.
pref("privacy.trackingprotection.content.protection.enabled", true);
pref("privacy.trackingprotection.content.annotation.enabled", true);
pref(
  "privacy.trackingprotection.urlclassifier.disable_for_channel_classifier",
  true
);
pref(
  "privacy.trackingprotection.content.protection.engines",
  "allowed-domains"
);
pref(
  "privacy.trackingprotection.content.protection.engines.pbmode",
  "allowed-domains"
);
pref("privacy.trackingprotection.content.annotation.engines", "");
pref("privacy.trackingprotection.content.annotation.engines.pbmode", "");
pref("privacy.trackingprotection.content.ads.list_ids", "");
pref("privacy.trackingprotection.content.trackers.list_ids", "");
pref("privacy.trackingprotection.content.trackers_content.list_ids", "");
// Sval runs none of Disconnect's data (decision 1051), so the URL
// classifier requests none of its tables; Mozilla's harmful add-on table
// is the one it still fetches.
pref("urlclassifier.trackingTable", "");
pref("urlclassifier.trackingAnnotationTable", "");
pref("urlclassifier.trackingWhitelistTable", "");
pref("urlclassifier.trackingAnnotationWhitelistTable", "");
pref("urlclassifier.features.fingerprinting.blacklistTables", "");
pref("urlclassifier.features.fingerprinting.whitelistTables", "");
pref("urlclassifier.features.fingerprinting.annotate.blacklistTables", "");
pref("urlclassifier.features.fingerprinting.annotate.whitelistTables", "");
pref("urlclassifier.features.cryptomining.blacklistTables", "");
pref("urlclassifier.features.cryptomining.whitelistTables", "");
pref("urlclassifier.features.cryptomining.annotate.blacklistTables", "");
pref("urlclassifier.features.cryptomining.annotate.whitelistTables", "");
pref("urlclassifier.features.socialtracking.blacklistTables", "");
pref("urlclassifier.features.socialtracking.whitelistTables", "");
pref("urlclassifier.features.socialtracking.annotate.blacklistTables", "");
pref("urlclassifier.features.socialtracking.annotate.whitelistTables", "");
pref("urlclassifier.features.emailtracking.blocklistTables", "");
pref("urlclassifier.features.emailtracking.allowlistTables", "");
pref("urlclassifier.features.emailtracking.datacollection.blocklistTables", "");
pref("urlclassifier.features.emailtracking.datacollection.allowlistTables", "");
pref("urlclassifier.features.consentmanager.annotate.blocklistTables", "");
pref("urlclassifier.features.consentmanager.annotate.allowlistTables", "");
pref("urlclassifier.features.antifraud.annotate.blocklistTables", "");
pref("urlclassifier.features.antifraud.annotate.allowlistTables", "");

// JavaScript per site (`SvalJavascript`) is a pref per site, with no default,
// under browser.sval.javascript.site.: "allow" or "block", each an exception
// to javascript.enabled. Each syncs between devices.

// First run (first-run spec §3): shown once, on a fresh profile. The test
// suites turn it off, because every harness profile is a fresh one.
pref("browser.sval.firstRun.enabled", true);

// The sync passes Sval runs on its own: the tab observer's debounce and poll,
// and the passes settings, Favorites and history sync ask for. Off, the
// document moves only when someone acts. The browser test suites turn it off,
// so a pass never lands between a test's steps; a test of those passes turns
// it on for itself.
pref("browser.sval.sync.background.enabled", true);

// What the address bar shows until it is focused (`SvalHeader`): "domain",
// the site's host; "path", the host with the path after it, muted; "full",
// the host with the path, query and fragment after it, muted. The field
// itself keeps the full address.
pref("browser.sval.urlbar.display", "domain");
pref("browser.urlbar.trimHttps", true); // upstream: false

// The Launcher's sections after the row Enter takes, in order, and how many
// rows each lists (launcher spec §5). A section left out of the order is not
// shown. Each syncs between devices.
pref(
  "browser.sval.launcher.order",
  "tabs,favorites,commands,history,suggestions"
);
pref("browser.sval.launcher.limit.tabs", 4);
pref("browser.sval.launcher.limit.favorites", 3);
pref("browser.sval.launcher.limit.commands", 3);
pref("browser.sval.launcher.limit.history", 5);
pref("browser.sval.launcher.limit.suggestions", 3);
// Firefox's quick actions draw a row of buttons with no key and no list of
// choices; Sval's commands are rows of their own (launcher spec §6), and run
// the quick actions Sval keeps.
pref("browser.urlbar.suggest.quickactions", false); // upstream: true
// Accel+Enter would complete a word to `www.<word>.com` before any other
// modifier is read (`UrlbarInput.#isCanonizeKeyboardEvent`), taking
// Accel+Shift+Enter, which opens a new window (launcher spec §3).
pref("browser.urlbar.ctrlCanonizesURLs", false); // upstream: true

// A plain click on a history page opens it in a new tab, as
// browser.tabs.loadBookmarksInTabs does for favorites: one choice, so the two
// behave alike (Sval's patch to PlacesUIUtils.openNodeWithEvent reads it).
pref("browser.sval.loadHistoryInTabs", true);

// A favorite whose address is `javascript:`, a bookmarklet, runs on the
// selected tab's page when opened (`SvalFavorites.open`). Settings ›
// Protections › JavaScript turns it off, among the advanced settings.
pref("browser.sval.favorites.bookmarklets", true);
// The home page shows the row of pinned Favorites (home-favorites spec §2).
pref("browser.sval.home.favorites", true);
// The hidden Workspace panel slides in over the page while the pointer rests
// at the window's edge on its side (SvalPanelReveal). Device-local, as the
// panel's side is, since it answers to this device's screen.
pref("browser.sval.panel.revealAtEdge", true);
// Archiving idle tabs (idle-tab archive spec §5), both synced: how long a
// tab goes unused before Sval archives it, one of 12h, 24h, 7d, 30d and
// never; and how many days the Archive keeps it, 7, 30 or 90.
pref("browser.sval.tabs.autoArchive", "never");
pref("browser.sval.tabs.archiveRetentionDays", 30);
// Whether a click on a link in a page opens it in a Quick Peek over the tab
// (SvalQuickPeek), synced, and the click's modifiers, kept on the device as the
// user's keys are: "alt", "accel,alt" or "alt,shift".
pref("browser.sval.quickPeek.enabled", true);
pref("browser.sval.quickPeek.click", "alt");
// Pins (pins spec §4, §5), both synced: how many lines the panel's pins row
// shows before its last slot becomes "+N", and whether a link in a pin's page
// to another host opens in a Quick Peek over the pin.
pref("browser.sval.pins.lines", 4);
pref("browser.sval.pins.quickPeekLinks", true);
// A sideways scroll or two-finger swipe over the Workspace panel moves the
// window to the next or previous workspace. Synced, as the Ctrl+Tab order
// beside it in Settings › Keyboard shortcuts is.
pref("browser.sval.panel.swipeWorkspaces", true);
// The Workspace switcher at the top of the panel: "menu", a button whose
// list unfolds from it, or "strip", every Workspace in a row. The strip shows
// every Workspace's name ("all"), only the current one's ("current") or none
// ("none"), and the wheel over it slides the strip ("slide") or moves the
// window one Workspace a notch ("switch"). Each is this device's own, as the
// panel's side is.
pref("browser.sval.panel.switcher", "menu");
pref("browser.sval.panel.stripNames", "all");
pref("browser.sval.panel.stripWheel", "slide");
// A link from another app opens in a Peek of its own, in no
// workspace (link routing spec §4), which closes once it has gone this many
// minutes without focus: one of 60, 360, 1440, 10080, or 0 for never. Both
// synced.
pref("browser.sval.peek.enabled", true);
pref("browser.sval.peek.idleCloseMinutes", 360);
// Links from other apps that open straight in a workspace (link routing,
// link routing spec §6): a JSON list of rules, the first match winning. Empty
// is none. Synced.
pref("browser.sval.links.rules", "");
// Site styles (site styles spec §2): a JSON list of each site's or host's
// colors, dark look and font. Empty is none. Synced.
pref("browser.sval.siteStyles", "");
// The user's card (`SvalCard`), a JSON record. Empty until the first time
// Settings or an Arc import makes one. Synced.
pref("browser.sval.card", "");
// This device's name, which other devices' history and agent workspaces show
// (history-sync spec §3.1). Empty reads as the computer's name.
pref("browser.sval.device.name", "");

// Sval runs no servers, and someone else's server has no business pushing
// remotely-configured experiments into this browser. Disabling
// app.shield.optoutstudies.enabled above stops Shield opt-out studies, but
// Normandy itself (the recipe client Shield studies ride on) keeps polling
// Mozilla's recipe server unless separately disabled. Empty the API URL too
// so a stray recipe fetch has nowhere to go even if enabled flips back on.
pref("app.normandy.enabled", false);
pref("app.normandy.api_url", "");

// Firefox code reads these unconditionally and upstream defines them in the
// branding pref file this one replaces. Numbers mirror upstream's unofficial
// branding unless a comment gives Sval's reason. The update
// feed itself is application.ini's; the manual download is Sval's download
// page, which settings shows as a link and must parse (`update-state`
// `manualURL`).
// The other URLs are empty: Sval has no pages for them yet.
pref("startup.homepage_override_url", "");
pref("startup.homepage_welcome_url", "");
pref("startup.homepage_welcome_url.additional", "");
pref("app.update.interval", 86400); // 24 hours
// Zero raises the restart notice undismissed as soon as an update is ready,
// so the notices popover opens itself for it (`UpdateListener`).
pref("app.update.promptWaitTime", 0);
pref("app.update.url.manual", "https://sval.app/download/");
pref("app.update.url.details", "");
pref("app.update.checkInstallTime.days", 2);
pref("app.update.badgeWaitTime", 0);
// How often the update service looks for another running copy. The notice
// asking to close it swaps for the restart notice within this time of the
// copy quitting (update-other-instance-recheck.patch); a look is one try at
// a file lock.
pref("app.update.checkOnlyInstance.interval", 10000);
// Release candidates: on, the updater reads the beta feed, which carries every
// release candidate and every release (update-release-candidates.patch); off,
// the release feed alone. Sticky, so a user's off outlasts the first run of a
// candidate, which turns it on (SvalReleaseCandidates.sys.mjs).
sticky_pref("browser.sval.update.releaseCandidates", false);

// Debugging the browser itself is off until a developer turns it on in
// about:config or the DevTools settings. Sval never builds with
// MOZILLA_OFFICIAL (decision 0063), so all.js would give every Sval the
// defaults Mozilla keeps for local builds; these are release Firefox's.
// devtools.chrome.enabled gives the Browser Console a command line that runs
// with the browser's privileges and, with devtools.debugger.remote-enabled,
// opens the Browser Toolbox (`DevToolsStartup._isRemoteDebuggingEnabled`).
// Left on, a page that talks the user into pasting code into the console
// takes over the browser. devtools.chrome.enabled also lifts the Web
// Console's paste guard (`WebConsoleUtils.usageCount`), and so does a
// devtools.selfxss.count of 5. At zero, the Web Console refuses a paste
// until the user types "allow pasting" (`App.onPaste`).
pref("devtools.chrome.enabled", false, sticky); // upstream: true
pref("devtools.debugger.remote-enabled", false, sticky); // upstream: true
pref("devtools.selfxss.count", 0); // upstream: 5

// The rest of all.js's and firefox.js's local-build conveniences, at release
// Firefox's values for the same reason. dump() and chrome console calls stay
// off stdout; the test harness's profile turns both on for its logs.
// about:debugging lists no tabs or hidden add-ons, and about:profiling starts
// from the web developer preset with no developer options. DevTools offers
// its experimental-prefs button in any build without MOZILLA_OFFICIAL
// (`command-button-experimental-prefs` in devtools/client/definitions.js),
// and this switch keeps it hidden.
pref("browser.dom.window.dump.enabled", false, sticky); // upstream: true
pref("devtools.console.stdout.chrome", false, sticky); // upstream: true
pref("devtools.aboutdebugging.local-tab-debugging", false); // upstream: true
pref("devtools.aboutdebugging.showHiddenAddons", false); // upstream: true
pref("devtools.performance.recording.preset", "web-developer"); // upstream: "firefox-platform"
pref("devtools.performance.recording.preset.remote", "web-developer"); // upstream: "firefox-platform"
pref("devtools.performance.aboutprofiling.has-developer-options", false); // upstream: true
pref("devtools.command-button-experimental-prefs.enabled", false); // upstream: true

// Sval's workspace panel is the only place a tab is drawn, so Firefox's own tab
// chrome is turned off. The strip itself is hidden through CustomizableUI at
// window setup: a toolbar's visibility is window state, which a pref cannot
// hold. Firefox's tab hover preview, on by default
// (`browser.tabs.hoverPreview.enabled`), shows beside the panel's tab rows
// (`SvalTabHoverPreview`); the hidden strip has no tab to point at.
//
// Tab groups are Firefox's answer to the problem workspaces exist to solve, and
// a second grouping mechanism inside gBrowser would compete with the tree for
// the same tabs.
pref("browser.tabs.groups.enabled", false); // upstream: true
// Ctrl+Tab goes to the tab used before this one, and holding Ctrl lists the
// window's tabs by use. A hidden tab, another workspace's, is never in that
// list (`ctrlTab.attachTab`). Settings › Keyboard shortcuts turns it off.
pref("browser.ctrlTab.sortByRecentlyUsed", true); // upstream: false
// A link from another app opens in the jar of the workspace its window shows
// (isolated workspaces spec §4; workspace-jar-for-new-tabs.patch). Firefox
// would guess a jar from the tabs open on that host in any window, which in
// Sval is another workspace's.
pref("browser.link.force_default_user_context_id_for_external_opens", true); // upstream: false

// Nothing interrupts a launch. The default-browser check raises a notification
// bar on first run, and Sval has no onboarding tour to show.
pref("browser.shell.checkDefaultBrowser", false); // upstream: true
pref("browser.aboutwelcome.enabled", false); // upstream: true

// The new tab page asks the thumbnail service for a screenshot of every top
// site, and a miss is logged as "getScreenshot(<url>) failed"
// (browser/extensions/newtab/lib/Screenshots.sys.mjs). With capturing
// disabled, BackgroundPageThumbs.captureIfMissing returns without capturing
// and the caller takes the moz-page-thumb URL path, so there is no failure to
// log and no background page loads of the user's sites.
pref("browser.pagethumbnails.capturing_disabled", true); // upstream: false

// Nimbus has three independent reasons to consider itself enabled
// (ExperimentAPI.sys.mjs): Firefox Labs, rollouts, and opt-out studies.
// app.shield.optoutstudies.enabled above covers studies; this covers rollouts.
// Labs is allowed unless an enterprise policy forbids it, so the Remote
// Settings loader still runs.
pref("nimbus.rollouts.enabled", false, locked); // upstream: true

// Messaging: Sval shows no campaigns, no contextual feature recommendations and
// no onboarding, and it fetches none. Three of upstream's four providers pull
// message sets from Remote Settings or from Nimbus, and the fourth is the
// onboarding set; with no messages, ASRouter evaluates no targeting.
//
// A provider whose JSON parses to null is dropped from the list without
// complaint (ASRouterPreferences.sys.mjs `_getProviderConfig`), so each entry
// says "enabled": false and still names what it turns off.
pref(
  "browser.newtabpage.activity-stream.asrouter.providers.cfr",
  '{"id":"cfr","enabled":false}'
);
pref(
  "browser.newtabpage.activity-stream.asrouter.providers.message-groups",
  '{"id":"message-groups","enabled":false}'
);
pref(
  "browser.newtabpage.activity-stream.asrouter.providers.messaging-experiments",
  '{"id":"messaging-experiments","enabled":false}'
);
pref(
  "browser.newtabpage.activity-stream.asrouter.providers.onboarding",
  '{"id":"onboarding","enabled":false}'
);

// Every launch brings back the windows the last session had (spec §10.4):
// each window's place, size, stacking and the workspace it showed. Firefox's
// session restore brings them back, and Sval then makes each window's tabs
// match its tree (SvalRestore), so the tree decides which tabs exist and what
// each shows. These prefs make Firefox resume every launch without asking.
//
// SessionStartup.isAutomaticRestoreEnabled resumes a session at 3, and
// sessionType then answers RESUME_SESSION before it reads anything else, a
// launch after a crash included: SessionFile reads the recovery file when the
// clean one is missing (SessionFile.Paths.loadOrder). A window opened later
// gets the home page at 3 as at 1 (BrowserContentHandler.getNewWindowArgs).
pref("browser.startup.page", 3); // upstream: 1

// resume_from_crash is the one gate on about:sessionrestore: sessionType
// becomes RECOVER_SESSION only when it is true and automatic restore is off
// (SessionStartup.sys.mjs), and willRestoreAsCrashed() is the only way to the
// about:sessionrestore branch (SessionStore.sys.mjs).
pref("browser.sessionstore.resume_from_crash", false); // upstream: true

// Firefox's lists of closed tabs reach every window's, and the closed
// windows' too. A tab reopens in the jar it closed in, and loads there
// before Sval moves it to the jar of the workspace the window shows, so a
// tab closed in an isolated workspace's window and reopened in another's
// would reach its site with both identities. Each window's lists hold only
// its own closed tabs.
pref("browser.sessionstore.closedTabsFromAllWindows", false); // upstream: true
pref("browser.sessionstore.closedTabsFromClosedWindows", false); // upstream: true

// Firefox asks "Close window and quit?" on Cmd+Q because quitting loses the
// tabs. Sval brings back every window and its workspace's tabs on the next
// launch, so the question guards nothing.
pref("browser.warnOnQuitShortcut", false); // upstream: true on macOS

// Firefox also asks about a session in an infobar, which BrowserGlue shows
// unconditionally. Its only gate is this counter:
// SessionWindowUI.maybeShowRestoreSessionInfoBar returns when it is negative or
// at least 2, and a negative count is never written back, so -1 keeps the bar
// away for good.
pref("browser.startup.couldRestoreSession.count", -1); // upstream: 0

// Sval depends on this, so it is stated here. A tab the session or Sval
// restores stays pending until the user selects it; TabRestoreQueue.shift()
// returns nothing for a visible pending tab while this holds, so a large
// workspace costs <tab> elements and no content processes. False would load
// every tab at launch.
pref("browser.sessionstore.restore_on_demand", true); // upstream: true

// TabUnloader discards the least recently used tabs when the system runs low
// on memory, which spec §10.7 relies on before a hidden workspace's three
// hours are up. Firefox sets this on Windows and macOS only.
pref("browser.tabs.unloadOnLowMemory", true); // upstream: false on Linux
// On macOS the memory watcher acts only on the responses this mask names
// (AvailableMemoryWatcherMac.cpp): 1 unloads tabs, 2 sends Gecko's
// "memory-pressure" notification. Firefox sets 3 in Nightly. Only the macOS
// watcher reads it.
pref("browser.lowMemoryResponseMask", 3); // upstream: 0 outside Nightly

// How much Sval says to the console (`SvalLog.sys.mjs`). A `ConsoleLogLevel`
// name, spelled as that enum spells it (dom/chrome-webidl/ConsoleInstance.webidl).
//
// "Warn" so that a person who never opens a console sees nothing new, while
// anything Sval recovered from unexpectedly and anything that failed still
// shows. "Info" and "Debug" are for following a sync problem: at "Debug" Sval
// logs every poll.
pref("browser.sval.loglevel", "Warn");

// Where the Send Feedback form posts a report (feedback spec §5), in every
// build. Sval contacts it only when the user presses Send, so it is listed as
// opt-in in scripts/network-contact/allowed-hosts.txt.
pref("browser.sval.support.reportURL", "https://feedback.sval.app/report");

// Whether local AI agents may connect to Sval (agent-control spec §3.2). Off
// until the user turns it on: while it is off, nothing listens.
pref("browser.sval.agents.enabled", false);

// How many actions a second an agent that is polite may take on one site
// (`SvalAgentPolite.sys.mjs`). "Be polite" is ticked on the agent's overlay
// and the user can untick it there.
pref("browser.sval.agents.politeRate", 1);

// How many seconds an agent's call that reports progress waits for the user's
// answer to an alert (agent-control spec §5.6), set in Settings › Agents.
pref("browser.sval.agents.approvalWaitSeconds", 3600);

// Whether a tab WebDriver opens in one of the user's windows uses that
// window's workspace and its cookies (`SvalWebDriver.sys.mjs`). Off: such a tab
// goes to a window of WebDriver's own, with a cookie jar of its own. No sync
// list names it, so it is this device's alone.
pref("browser.sval.webdriver.useWorkspaceCookies", false);

// Network contact (spec §10.9). Sval contacts nothing it cannot name, and a test
// fails on any host outside that list. Everything below removes or defers a
// contact stock Firefox makes on its own; each was measured on a fresh profile.
//
// `locked` keeps a pref off. Suggest, new-tab weather and the default top
// sites decide their own defaults by region at runtime and write them to the
// default branch; libpref ignores a default-branch write to a locked pref
// (Pref::SetDefaultValue, modules/libpref/Preferences.cpp), so only a lock
// keeps them off. Prefs a user may still choose to
// turn on are left unlocked.

// Remote Settings is kept for what protects the user (certificate revocation,
// extension and driver blocklists, tracking protection, site fixes) and for
// the breach list the Privacy and Security panel matches on the device
// (fxmonitor-breaches, decision 0131). It syncs nothing else. Any collection
// that ships with built-in data syncs whether or not the feature using it is
// on (remote-settings.sys.mjs `_client`), so turning features off is not
// enough; remote-settings-allowlist.patch reads this list. An entry written
// "collection@pref" syncs only while that boolean pref is true, for a
// collection that serves one feature the user can turn off.
//
// The list fails closed, so a protection whose collection is missing here goes
// stale without a sound. Several arrive in the startup bundle
// (bundles/startup.json.mozlz4) and never appear as a sync of their own on a
// fresh profile, so they are listed by consumer. remote-permissions is left
// out: it lets Mozilla grant sites permissions remotely, and the copy bundled
// in the build still applies.
// The Privacy and Security panel's breach warnings (decision 0131). Off, the
// panel looks nothing up and the breach list does not sync: its entry below
// names this pref.
pref("browser.sval.breachWarnings", true);
pref(
  "browser.sval.remoteSettings.collections",
  "cert-revocations,onecrl,intermediates,addons,addons-bloomfilters,gfx,tracking-protection-lists,query-stripping,url-classifier-skip-urls,url-classifier-exceptions,anti-tracking-url-decoration,bounce-tracking-protection-exceptions,fingerprinting-protection-overrides,partitioning-exempt-urls,third-party-cookie-blocking-exempt-urls,cookie-banner-rules-list,webcompat-interventions,hijack-blocklists,password-rules,password-recipes,websites-with-shared-credential-backends,translations-models,translations-wasm,mfcdm-origins-list,fxmonitor-breaches@browser.sval.breachWarnings"
);

// Sval holds a push connection only while some site may notify (spec §10.9),
// so Remote Settings learns of a new revocation when it polls. Every hour puts
// a compromised CA's OneCRL entry on every running Sval within that time. A poll is one request
// for the collection timestamps, carrying no identifier.
pref("services.settings.poll_interval", 3600); // upstream: 86400

// Firefox Accounts and Sync. Sval's sync is its own and runs on storage the user
// picks; Mozilla's is a second one that needs Mozilla's servers.
pref("identity.fxaccounts.enabled", false, locked); // upstream: true

// Mozilla's system add-on updates. Sval's built-in components change only with
// Sval releases.
pref("extensions.systemAddon.update.enabled", false, locked); // upstream: true
pref("extensions.systemAddon.update.url", "", locked);

// Media plugins. With EME off, Widevine is not fetched at first launch: the
// first site that needs DRM asks, and agreeing downloads it (Firefox's Linux
// behaviour, EncryptedMediaParent.ensureEMEEnabled). The version list for
// OpenH264 and Widevine comes from the copy bundled in the build
// (toolkit/content/gmp-sources) once Mozilla's update server is out of reach.
pref("media.eme.enabled", false); // upstream: true
// Firefox asks Google's update service for Widevine's current version on every
// plugin check, before it looks at whether EME is on (GMPInstallManager
// checkForAddons). Without this, the bundled version list is the only source.
pref("media.gmp-widevinecdm.allow-chromium-update", false); // upstream: true
pref("media.gmp-widevinecdm-l1.allow-chromium-update", false); // upstream: true
pref("media.gmp-manager.url", "", locked);

// Region by IP address. Region comes from the operating system instead.
pref("browser.region.network.url", "", locked);
pref("browser.region.update.enabled", false, locked); // upstream: true

// Firefox Suggest and Merino: sponsored and non-sponsored address-bar
// suggestions, and the weather that sent the user's city with every lookup.
pref("browser.urlbar.quicksuggest.enabled", false, locked); // upstream: false, raised by region
pref("browser.urlbar.suggest.quicksuggest.all", false, locked);
pref("browser.urlbar.suggest.quicksuggest.sponsored", false, locked);
pref("browser.urlbar.suggest.quicksuggest.nonsponsored", false, locked);
pref("browser.urlbar.suggest.weather", false, locked); // upstream: true
pref("browser.newtabpage.activity-stream.showWeather", false, locked); // upstream: true
pref("browser.newtabpage.activity-stream.system.showWeather", false, locked);
// The new tab's widget weather is a second weather feature with its own
// switches, and its system switch turns on by region (ActivityStream
// PREFS_CONFIG, `widgets.system.weather.enabled`). Without Merino it shows
// built-in placeholder weather.
pref(
  "browser.newtabpage.activity-stream.widgets.weather.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.widgets.system.weather.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.widgets.weatherForecast.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.widgets.system.weatherForecast.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.system.showWeatherOptIn",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.weather.staticData.enabled",
  false,
  locked
);
pref("browser.urlbar.merino.endpointURL", "", locked);
pref("browser.urlbar.merino.ohttpConfigURL", "", locked);
pref("browser.urlbar.merino.ohttpRelayURL", "", locked);

// Captive-portal and connectivity checks: plain HTTP to Mozilla every few
// minutes. Every platform Sval targets detects captive portals itself.
pref("network.captive-portal-service.enabled", false); // upstream: true
pref("network.connectivity-service.enabled", false); // upstream: true

// A certificate error from an unknown issuer sends a request to Mozilla's
// mitmdetection host to learn whether a proxy intercepts every connection
// (NetErrorParent primeMitm). A page can trigger it by sending the user to
// such a site. The error page itself stays as it is.
pref("security.certerrors.mitm.priming.enabled", false); // upstream: true

// Network geolocation: when the system's location service fails, Gecko posts
// the nearby Wi-Fi access points to Google's geolocation API
// (NetworkGeolocationProvider, the MLS fallback). Sval has no key for it, so
// the answer is an error either way; with no URL nothing is sent. Location
// comes from the operating system alone. Unlocked, because Gecko's own
// geolocation tests point this at their server.
pref("geo.provider.network.url", ""); // upstream: www.googleapis.com

// Add-on metadata sends the full list of installed extensions to AMO daily for
// ratings and screenshots. Extension update checks stay on.
pref("extensions.getAddons.cache.enabled", false); // upstream: true
pref("extensions.htmlaboutaddons.recommendations.enabled", false); // upstream: true
// Reporting an extension opens AMO's abuse form, offered in the removal
// question and Extensions' menus; Sval does not run that service.
pref("extensions.abuseReport.enabled", false); // upstream: true
// Settings' Languages category lists the language packs AMO offers, fetched
// from services.addons.mozilla.org as soon as the category opens. The
// languages Sval ships stay listed.
pref("intl.multilingual.downloadEnabled", false); // upstream: true

// Secure DNS (Sval decision 0105): the network's own DNS until the user picks
// encrypted DNS in Protections, so no automatic rollout and none of its probe
// lookups. Gecko's `network.trr.mode` default, 0, is that choice.
pref("doh-rollout.enabled", false);
pref("doh-rollout.disable-heuristics", true);
// The resolvers Secure DNS offers, Quad9 first and so pre-selected
// (`DoHConfigController`'s `fallbackProviderURI`). This pref outranks the
// `doh-providers` Remote Settings collection, which Sval does not sync and
// whose list is Mozilla's. Each URL is its provider's documented DoH endpoint.
pref(
  "doh-rollout.provider-list",
  '[{"UIName":"Quad9","uri":"https://dns.quad9.net/dns-query"},{"UIName":"Cloudflare","uri":"https://cloudflare-dns.com/dns-query"}]'
);
// The resolver Gecko uses while `network.trr.uri` is empty
// (`TRRServiceBase::CheckURIPrefs`): the list's first.
pref("network.trr.default_provider_uri", "https://dns.quad9.net/dns-query"); // upstream: mozilla.cloudflare-dns.com

// New tabs: no seeded top sites, so the tiles come only from the user's own
// history. DNS prefetch is off everywhere, so no page, the new tab included,
// makes Sval look up hosts the user never visits.
pref("browser.newtabpage.activity-stream.default.sites", "", locked);
// Search shortcuts seed tiles such as "@amazon" for the region's partner
// engines. Shortcuts the user pins, and sites from their own history, stay.
pref(
  "browser.newtabpage.activity-stream.improvesearch.topSiteSearchShortcuts",
  false,
  locked
); // upstream: true
pref("browser.topsites.useRemoteSetting", false, locked); // upstream: true
pref(
  "browser.newtabpage.activity-stream.newtabWallpapers.enabled",
  false,
  locked
); // upstream: true
pref("network.dns.disablePrefetch", true); // upstream: false
// about:home is Sval's own page (chrome/browser/components/sval/home/). The
// startup cache stores the activity stream's rendered markup and would serve it
// in place of that page on the first about:home of a session.
pref("browser.startup.homepage.abouthome_cache.enabled", false, locked); // upstream: true

// Search suggestions send what the user types to their chosen engine, which
// they already trust with what they search for. Settings > Search turns them
// off; private windows keep upstream's default of off. Pre-connecting to the
// engine when the address bar gains focus is off regardless.
pref("browser.search.suggest.enabled", true);
pref("browser.urlbar.suggest.trending", false, locked); // upstream: true
pref("browser.urlbar.speculativeConnect.enabled", false); // upstream: true
// Address-bar rows that suggest switching to a partner search engine.
pref("browser.urlbar.suggest.engines", false, locked); // upstream: true

// Web Push connects only while some site holds the notification permission;
// SvalPush turns this on when one does. Upstream connects at every launch.
// `sticky` keeps a user's own "false" even while it equals the default:
// libpref otherwise drops a user value equal to the default, and the gate
// would later open a connection the user had closed.
pref("dom.push.connection.enabled", false, sticky); // upstream: true

// Search-results categorization is search telemetry: it downloads Mozilla's
// site-category lists to classify the pages a search returns. It turns on by
// region.
pref("browser.search.serpEventTelemetryCategorization.enabled", false, locked); // upstream: true

// Breach alerts are fetched from Mozilla's Monitor service.
pref("signon.management.page.breach-alerts.enabled", false, locked); // upstream: true

// Credentials belong to the user's own password manager (spec §7, decision
// 0078). Firefox's password manager and its address and card autofill are off,
// so the user's manager is the only thing on a page that saves, offers or
// fills. Locked, so the settings that would turn them back on are hidden.
pref("signon.rememberSignons", false, locked); // upstream: true
pref("signon.autofillForms", false, locked); // upstream: true
pref("signon.generation.enabled", false, locked); // upstream: true
pref("browser.contextual-password-manager.enabled", false, locked); // upstream: true
// The pref the PasswordManagerEnabled policy locks to hide "Saved passwords".
pref("pref.privacy.disable_button.view_passwords", true, locked);
// "off" removes address and card autofill entirely, settings included;
// `.enabled` alone leaves the settings showing. Address autofill also turns on
// through its experiment pref.
pref("extensions.formautofill.addresses.supported", "off", locked); // upstream: "detect"
pref("extensions.formautofill.addresses.enabled", false, locked); // upstream: true
pref("extensions.formautofill.addresses.experiments.enabled", false, locked);
pref("extensions.formautofill.creditCards.supported", "off", locked); // upstream: "on"
pref("extensions.formautofill.creditCards.enabled", false, locked); // upstream: true

// Safe Browsing's download check sends details of downloaded programs to
// Google. Gatekeeper and SmartScreen already examine them.
pref("browser.safebrowsing.downloads.remote.enabled", false); // upstream: true

// Promotions, ads, engagement and AI (spec §10.9, principles 6 and §3.4). Found
// by reading settings, the new tab, the browser chrome and the address bar,
// and by running the network-contact test with every switch the UI offers
// turned on. Everything here is either locked off, so it disappears or cannot
// be re-enabled, or set to its dismissed state.

// The new tab's own telemetry, including a ping it sends through an OHTTP
// relay.
pref("browser.newtabpage.activity-stream.telemetry", false, locked);
pref(
  "browser.newtabpage.activity-stream.telemetry.privatePing.enabled",
  false,
  locked
);
pref("browser.newtabpage.ping.enabled", false, locked);

// New tab. "Support Firefox" is a master switch whose change handler sets both
// sponsored prefs to its own value (newtab AboutPreferences.sys.mjs), so the
// sponsored prefs above are locked as well as hidden.
pref(
  "browser.newtabpage.activity-stream.showSponsoredCheckboxes",
  false,
  locked
);
pref("browser.newtabpage.activity-stream.showSponsored", false, locked);
pref("browser.newtabpage.activity-stream.showSponsoredTopSites", false, locked);
pref(
  "browser.newtabpage.activity-stream.unifiedAds.tiles.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.unifiedAds.spocs.enabled",
  false,
  locked
);
pref("browser.newtabpage.activity-stream.unifiedAds.endpoint", "", locked);
pref(
  "browser.newtabpage.activity-stream.discoverystream.endpointSpocsClear",
  "",
  locked
);
pref("browser.topsites.contile.enabled", false, locked);
pref("browser.topsites.contile.endpoint", "", locked);
// Recommended stories, and topics, sections, the daily brief and inferred
// personalization beneath them.
pref(
  "browser.newtabpage.activity-stream.feeds.system.topstories",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.feeds.section.topstories",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.endpoints",
  "",
  locked
);
pref(
  "browser.newtabpage.activity-stream.widgets.system.sportsWidget.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.widgets.sportsWidget.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.mobileDownloadModal.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.promoCard.enabled",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.discoverystream.promoCard.visible",
  false,
  locked
);
// The new tab can replace itself with an add-on downloaded from Mozilla.
pref("browser.newtabpage.trainhopAddon.xpiBaseURL", "", locked);

// Settings and browser chrome.
pref("browser.preferences.moreFromMozilla", false, locked);
// "Recommend extensions/features as you browse" also gates the address bar's
// search tips, separately from the message providers turned off above.
pref(
  "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.addons",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.asrouter.userprefs.cfr.features",
  false,
  locked
);
pref(
  "browser.newtabpage.activity-stream.asrouter.useRemoteL10n",
  false,
  locked
);
pref("browser.ipProtection.enabled", false, locked);
pref("browser.ipProtection.blockIPProtectionCallouts", true, locked);
pref("browser.ipProtection.guardian.endpoint", "", locked);
pref("signon.firefoxRelay.feature", "", locked);
// Firefox's site panel, which Sval's protection button replaces (decision
// 0131). Off, it reads nothing and the address bar has no padlock for it.
pref("browser.urlbar.trustPanel.featureGate", false, locked); // upstream: true
// The site panel's breach alerts are a Monitor promotion with their own gate,
// separate from the password manager's.
pref("browser.urlbar.trustPanel.breachAlerts.featureGate", false, locked);
pref("browser.urlbar.trustPanel.breachAlerts", false, locked);
// Lets mozilla.org pages open menus and highlight browser buttons.
pref("browser.uitour.enabled", false, locked);
// Sval's own default permissions (branding/sval/sval-permissions): Firefox's also
// let support.mozilla.org request a troubleshooting snapshot of the browser.
pref(
  "permissions.manager.defaultsUrl",
  "resource://app/defaults/sval-permissions",
  locked
);
pref("browser.vpn_promo.enabled", false, locked);
pref("browser.promo.focus.enabled", false, locked);
pref("browser.promo.pin.enabled", false, locked);
pref("browser.contentblocking.report.hide_vpn_banner", true, locked);
pref("browser.contentblocking.report.show_mobile_app", false, locked);
pref("browser.contentblocking.cfr-milestone.enabled", false, locked);
pref("browser.tabs.firefox-view.importHistory.dismissed", true);
pref("browser.bookmarks.addedImportButton", true);
pref("sidebar.verticalTabs.dragToPinPromo.dismissed", true);
pref("termsofuse.bypassNotification", true, locked);
pref("browser.preonboarding.enabled", false, locked);
pref("default-browser-agent.enabled", false, locked);

// AI is deferred past v1, and nothing speaks first (spec §2, principle 6), so
// none of Mozilla's AI features ship. Each is locked off with the values
// Mozilla's own AIControls policy writes to block it
// (browser/components/enterprisepolicies/Policies.sys.mjs `AIControls`), so
// neither about:config nor settings can turn one back on, and every setting
// for one is hidden (settings-hide-removed-features.patch hides a locked
// pref's control).
//
// browser.ml.enable is the root: the MLEngine actor is registered only while
// it is on (ActorManagerParent.sys.mjs `MLEngine` enablePreference), and
// EngineProcess.getMLEngineParent throws without it, so no feature can start
// an on-device model or download one from Mozilla's model hub. The feature
// prefs are locked too, so the menus and buttons that offer each feature are
// gone, and a future upstream default flip cannot re-arm one.
//
// Translations is not among them: it runs on the device through its own
// engine, which does not need browser.ml.enable, and its models come from the
// Remote Settings collections spec §10.9 keeps for it.
pref("browser.ml.enable", false, locked); // upstream: true
pref("browser.ai.control.default", "blocked", locked); // upstream: "available"
// The AI Controls settings pane.
pref("browser.preferences.aiControls", false, locked); // upstream: true

// The chatbot sidebar, its page and tab menu items, and the selection
// shortcut. The page and tab menus offer the chatbot from browser.ml.chat.page
// alone, without checking that the chatbot is on (GenAI.sys.mjs
// isPageFeatureAllowed).
pref("browser.ml.chat.enabled", false, locked); // upstream: true
pref("browser.ml.chat.provider", "", locked);
pref("browser.ml.chat.page", false, locked);
pref("browser.ml.chat.menu", false, locked);
pref("browser.ml.chat.sidebar", false, locked);
pref("browser.ml.chat.shortcuts", false, locked);
pref("browser.ml.chat.shortcuts.smartwindow", false, locked);
pref("browser.ml.pageAssist.enabled", false, locked);
pref("browser.ai.control.sidebarChatbot", "blocked", locked);

// Smart Window: a vendor-hosted model that an experiment can switch on.
pref("browser.smartwindow.enabled", false, locked);
pref("browser.smartwindow.worldcup.enabled", false, locked);
pref("browser.smartwindow.endpoint", "", locked);
pref("browser.ai.control.smartWindow", "blocked", locked);

// Link previews, with their generated key points.
pref("browser.ml.linkPreview.enabled", false, locked); // upstream: true
pref("browser.ml.linkPreview.optin", false, locked);
pref("browser.ml.linkPreview.longPress", false, locked);
pref("browser.ai.control.linkPreviewKeyPoints", "blocked", locked);

// Smart tab groups: suggested names and tabs for a group.
pref("browser.tabs.groups.smart.enabled", false, locked); // upstream: true
pref("browser.tabs.groups.smart.userEnabled", false, locked); // upstream: true
pref("browser.tabs.groups.smart.optin", false, locked);
pref("browser.ai.control.smartTabGroups", "blocked", locked);

// PDF alt text, which pdf.js offers to generate with a downloaded model.
pref("pdfjs.enableAltText", false, locked);
pref("pdfjs.enableGuessAltText", false, locked); // upstream: true
pref("pdfjs.enableAltTextModelDownload", false, locked); // upstream: true
pref("browser.ai.control.pdfjsAltText", "blocked", locked);

// The rest of the on-device models: the trial ML API for extensions, address
// bar intent suggestions, semantic history search and form field detection.
pref("extensions.ml.enabled", false, locked); // upstream: true
pref("browser.urlbar.quicksuggest.mlEnabled", false, locked);
pref("places.semanticHistory.featureGate", false, locked);
pref("extensions.formautofill.useml", false, locked);

// Address bar: onboarding rows, and Google Lens, which sends the image to
// Google from a context-menu item badged "New".
pref("browser.urlbar.tabToSearch.onboard.interactionsLeft", 0);
pref("browser.search.visualSearch.featureGate", false, locked);

// Settings: Firefox's announcement of its own settings redesign.
pref("browser.settings-redesign.promo.dismissed", true);
// Send Mozilla a daily usage ping. A control in settings; locked with the rest
// of data collection.
pref("datareporting.usage.uploadEnabled", false, locked);

// Safe Browsing lists (spec §10.9). Firefox fetches every list in one request,
// and Google refuses the whole request if any one is missing. Two of
// Firefox's lists are not available to Sval's key: goog-badbinurl-proto
// ("mwb-4b", known-malware download URLs) and goog-downloadwhite-proto
// ("csdda-32b", the allowlist for the remote download check Sval turns off).
// Downloads remain covered by the malware list and by the operating system's
// own check. Measured against the v5 API with Sval's key.
pref(
  "browser.safebrowsing.provider.google5.lists",
  "goog-phish-proto,googpub-phish-proto,goog-malware-proto,goog-unwanted-proto,goog-harmful-proto,goog-globalcache-proto"
);

// The client name every Safe Browsing request gives Google. Upstream names an
// unofficial build "Firefox"; Sval's requests name Sval.
pref("browser.safebrowsing.id", "sval"); // upstream: "Firefox"

// Import (import spec §2): Firefox's Chrome migrator lists the real Chrome
// profile's extensions whenever it is asked for any resource, even history
// for another browser. Sval imports no extensions, so that lookup is off.
pref("browser.migrate.chrome.extensions.enabled", false, locked);

// Gecko draws every menu on macOS, as it does on Windows and Linux, so each
// takes Sval's popup colours (`sval-header.css`) and honours `closemenu`,
// which an NSMenu ignores: macOS closes one on any item's click.
pref("widget.macos.native-context-menus", false);
pref("widget.macos.native-anchored-menus", false);
pref("widget.macos.allow-native-select", false);

// A see-through window on Windows shows the Acrylic backdrop behind it, the
// closest of the system's backdrops to the HUD material macOS shows. The
// backdrop reaches a window only while its root carries `windowsmica`
// (`nsWindow::UpdateMicaBackdrop`), which a Workspace colour's transparency
// sets (decision 0057).
pref("widget.windows.mica", true);
pref("widget.windows.mica.toplevel-backdrop", 2);

// Defaults Firefox's release channel ships for defects in ESR 153's.
//
// On macOS an HTTP/3 session over the fast UDP datapath (sendmsg_x and
// recvmsg_x) can freeze in 0-RTT with no QUIC timer armed, and the requests
// queued on it never fail over (Mozilla bug 2065491). Off,
// InitAppleFastDatapathProbe never probes for it.
pref("network.http.http3.apple_fast_datapath", false); // upstream: true
// The ML-KEM key share makes WebRTC's DTLS ClientHello too large for some
// TURN relay-only paths, and the handshake stalls (Mozilla bug 2047968).
// TransportLayerDtls::Setup still offers ML-KEM among its groups and sends
// the X25519 share alone.
pref("media.webrtc.send_mlkem_keyshare", false); // upstream: true
// Typing a character outside the Basic Multilingual Plane dispatches a
// keypress for each UTF-16 unit. With this pref on, each one's `key`, and an
// editor's `InputEvent.data`, is a lone surrogate: ill-formed UTF-16, which
// a page's Rust compiled to WebAssembly cannot take as a string. Off, the
// first keypress carries the pair and the second an empty string
// (TextEventDispatcher::DispatchKeyboardEventInternal; Mozilla bug 1849790).
pref("dom.event.keypress.key.allow_lone_surrogate", false); // upstream: true
// Mode 3, DOMINANT_AXIS, moves a trackpad scroll along one axis only, so a
// page or image cannot be panned diagonally on a Mac. Mode 2, STICKY, lets a
// lock break, as on the other platforms (Mozilla bugs 2035075 and 2046884).
pref("apz.axis_lock.mode", 2); // upstream: 3 on macOS
