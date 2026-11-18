/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import {
  ALLOWED_DOMAIN_BRANCH,
  MY_FILTER_BRANCH,
  CUSTOM_LIST_BRANCH,
  SYNC_RULES as BLOCKING_RULES,
  USER_LIST_BRANCH,
} from "moz-src:///browser/components/sval/SvalBlocking.sys.mjs";
import { SYNC_RULES as SECURE_DNS_RULES } from "moz-src:///browser/components/sval/SvalSecureDns.sys.mjs";
import {
  SYNCED_PREFS as FINGERPRINTING_PREFS,
  SYNC_RULES as FINGERPRINTING_RULES,
} from "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs";
import { SITE_BRANCH as JAVASCRIPT_BRANCH } from "moz-src:///browser/components/sval/SvalJavascript.sys.mjs";
import { SITE_BRANCH as PROTECTION_BRANCH } from "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs";
import { SITE_BRANCH as EXTENSION_SITE_BRANCH } from "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs";
import { SYNC_RULES as TRACKING_RULES } from "moz-src:///browser/components/sval/SvalTrackingSettings.sys.mjs";
import { SYNC_RULES as ARCHIVE_RULES } from "moz-src:///browser/components/sval/SvalArchive.sys.mjs";
import { SYNC_RULES as PEEK_RULES } from "moz-src:///browser/components/sval/SvalPeek.sys.mjs";
import { SYNC_RULES as LINK_RULES } from "moz-src:///browser/components/sval/SvalLinkRules.sys.mjs";
import { SYNC_RULES as SITE_STYLE_RULES } from "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs";
import { SYNC_RULES as CARD_RULES } from "moz-src:///browser/components/sval/SvalCard.sys.mjs";
import { SYNC_RULES as UPDATE_DELAY_RULES } from "moz-src:///browser/components/sval/SvalUpdateDelay.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalHomePage: "moz-src:///browser/components/sval/SvalHomePage.sys.mjs",
});

/**
 * Whether a home page value may sync. The home page holds one address or
 * several joined by "|" (`HomePage.get`), and Home and startup open every one
 * with the system principal (`loadOneOrMoreURIs`). Firefox Sync refuses only
 * its `UNSYNCABLE_URL_REGEXP` schemes, at the start of the value
 * (`UNSYNCABLE_URL` below), because its devices sign in to one account. Any
 * device holding Sval's key writes the settings document, so Sval trusts a
 * peer's value less: every address in it must be a web page's, http or https,
 * or Sval's own home page (`SvalHomePage.isHomePage`).
 *
 * @param {*} value
 * @returns {boolean}
 */
function isSyncableHomePage(value) {
  return (
    typeof value === "string" &&
    value.split("|").every(part => {
      if (lazy.SvalHomePage.isHomePage(part)) {
        return true;
      }
      try {
        return ["http:", "https:"].includes(new URL(part).protocol);
      } catch {
        return false;
      }
    })
  );
}

/**
 * The home page's rule: a value it refuses from another device is kept here
 * when this device holds it, and published as unset.
 */
const HOME_PAGE_RULES = Object.freeze({
  "browser.startup.homepage": Object.freeze({
    accepts: isSyncableHomePage,
    staysOnDevice: value => !isSyncableHomePage(value),
  }),
});

/**
 * A protection that syncs one way (spec §10.8): a synced value that turns it
 * on applies, and one that turns it off does not, so no device can switch it
 * off on another. Each is on by default, so turning it on clears the user
 * value, which syncs as a reset.
 */
const ON_ONLY = Object.freeze({ accepts: value => value === true });

const ONE_WAY_RULES = Object.fromEntries(
  [
    "browser.safebrowsing.downloads.enabled",
    "browser.safebrowsing.downloads.remote.block_potentially_unwanted",
    "browser.safebrowsing.malware.enabled",
    "browser.safebrowsing.phishing.enabled",
    "extensions.update.enabled",
  ].map(pref => [pref, ON_ONLY])
);

/**
 * What Sval syncs between devices, and under which names (settings-sync spec
 * §4, §5). The pref list is Firefox Sync's `services.sync.prefs.sync.*` list,
 * trimmed where Sval changed the ground under a pref; the spec gives the
 * reason for every pref left out. To it are added Sval's own settings that are
 * prefs, among them the fingerprinting settings' own
 * (`SvalFingerprinting.SYNCED_PREFS`, protections spec §3.3). Secure DNS syncs
 * too (decision 0105): the choice, the resolver's URL, custom or not, as the
 * home page's URL does, and the names that skip it. So do the prefs
 * Protections' tracking settings write (protections spec §3.3), which stand
 * in for Enhanced Tracking Protection's.
 */
export const SvalSettingsRegistry = Object.freeze({
  /** The engine document settings sync under. */
  SETTINGS_DOCUMENT: "settings",

  /** The default search engine, by config identifier. Not a pref. */
  SEARCH_ENGINE_KEY: "sval.search.engine",

  /** The engine in use until the user chooses (spec §13 item 3). */
  DEFAULT_SEARCH_ENGINE: "ddg",

  /**
   * pref -> how `SvalSettingsSync` checks its values: `accepts(value)`, which
   * a synced value must pass to apply, and `staysOnDevice(value)`, true for a
   * value this device keeps to itself and publishes as unset. A pref with no
   * rule applies any value of its type.
   */
  VALUE_RULES: Object.freeze({
    ...ARCHIVE_RULES,
    ...PEEK_RULES,
    ...LINK_RULES,
    ...SITE_STYLE_RULES,
    ...CARD_RULES,
    ...ONE_WAY_RULES,
    ...HOME_PAGE_RULES,
    ...BLOCKING_RULES,
    ...FINGERPRINTING_RULES,
    ...SECURE_DNS_RULES,
    ...TRACKING_RULES,
    ...UPDATE_DELAY_RULES,
  }),

  /**
   * String values no pref syncs, either way: Firefox Sync's
   * `UNSYNCABLE_URL_REGEXP` (services/sync/modules/engines/prefs.sys.mjs),
   * which that module does not export. Such an address points at something
   * on one device, or at content no other device should load as a home page
   * with the system principal.
   */
  UNSYNCABLE_URL: /^(moz-extension|blob|data|file):/i,

  /**
   * Pref branches each of whose prefs syncs as a setting of its own, named by
   * the pref: a choice per site or per list entry, so two devices that change
   * different entries both keep their change, and a removal is a reset that
   * stands (spec §2, one node per setting).
   */
  SYNCED_BRANCHES: Object.freeze([
    ALLOWED_DOMAIN_BRANCH,
    CUSTOM_LIST_BRANCH,
    USER_LIST_BRANCH,
    JAVASCRIPT_BRANCH,
    PROTECTION_BRANCH,
    EXTENSION_SITE_BRANCH,
    MY_FILTER_BRANCH,
  ]),

  SYNCED_PREFS: Object.freeze([
    ...new Set([
      "accessibility.blockautorefresh",
      "accessibility.browsewithcaret",
      "accessibility.typeaheadfind",
      "accessibility.typeaheadfind.linksonly",
      "browser.sval.adblock.customFrom",
      "browser.sval.adblock.level",
      "browser.sval.adblock.pageRules",
      "browser.sval.breachWarnings",
      "browser.sval.card",
      "browser.sval.extensions.updateWaitDays",
      "browser.sval.home.favorites",
      "browser.sval.launcher.limit.commands",
      "browser.sval.launcher.limit.favorites",
      "browser.sval.launcher.limit.history",
      "browser.sval.launcher.limit.suggestions",
      "browser.sval.launcher.limit.tabs",
      "browser.sval.launcher.order",
      "browser.sval.quickPeek.enabled",
      "browser.sval.links.rules",
      "browser.sval.panel.swipeWorkspaces",
      "browser.sval.pins.lines",
      "browser.sval.pins.quickPeekLinks",
      "browser.sval.peek.enabled",
      "browser.sval.peek.idleCloseMinutes",
      "browser.sval.siteControls.toolbarButtons",
      "browser.sval.siteStyles",
      "browser.sval.tabs.archiveRetentionDays",
      "browser.sval.tabs.autoArchive",
      "browser.ctrlTab.sortByRecentlyUsed",
      "browser.download.useDownloadDir",
      "browser.formfill.enable",
      "browser.menu.showViewImageInfo",
      "browser.newtabpage.enabled",
      "browser.newtabpage.pinned",
      "browser.newtabpage.activity-stream.feeds.section.highlights",
      "browser.newtabpage.activity-stream.feeds.topsites",
      "browser.newtabpage.activity-stream.section.highlights.includeBookmarks",
      "browser.newtabpage.activity-stream.section.highlights.includeDownloads",
      "browser.newtabpage.activity-stream.section.highlights.includeVisited",
      "browser.newtabpage.activity-stream.section.highlights.rows",
      "browser.newtabpage.activity-stream.showSearch",
      "browser.newtabpage.activity-stream.topSitesRows",
      "browser.safebrowsing.downloads.enabled",
      "browser.safebrowsing.downloads.remote.block_potentially_unwanted",
      "browser.safebrowsing.malware.enabled",
      "browser.safebrowsing.phishing.enabled",
      "browser.startup.homepage",
      "browser.tabs.hoverPreview.enabled",
      "browser.tabs.loadInBackground",
      "browser.tabs.warnOnClose",
      "browser.tabs.warnOnOpen",
      "browser.urlbar.maxRichResults",
      "browser.urlbar.showSearchSuggestionsFirst",
      "browser.urlbar.suggest.bookmark",
      "browser.urlbar.suggest.history",
      "browser.urlbar.suggest.openpage",
      "browser.urlbar.suggest.searches",
      "browser.urlbar.suggest.topsites",
      "dom.disable_open_during_load",
      "dom.disable_window_flip",
      "dom.disable_window_move_resize",
      "dom.event.contextmenu.enabled",
      "dom.security.https_only_mode",
      "dom.security.https_only_mode_ever_enabled",
      "dom.security.https_only_mode_ever_enabled_pbm",
      "dom.security.https_only_mode_pbm",
      "extensions.update.enabled",
      "general.autoScroll",
      "intl.accept_languages",
      "intl.regional_prefs.use_os_locales",
      "javascript.enabled",
      "layout.css.prefers-color-scheme.content-override",
      "layout.spellcheckDefault",
      "media.autoplay.site-permission-only.default",
      "media.eme.enabled",
      "media.videocontrols.picture-in-picture.enable-when-switching-tabs.enabled",
      "media.videocontrols.picture-in-picture.video-toggle.enabled",
      "network.cookie.cookieBehavior",
      "network.http.referer.disallowCrossSiteRelaxingDefault.top_navigation",
      "network.trr.excluded-domains",
      "network.trr.mode",
      "network.trr.uri",
      "permissions.default.image",
      "privacy.bounceTrackingProtection.mode",
      "privacy.clearOnShutdown.cache",
      "privacy.clearOnShutdown.cookies",
      "privacy.clearOnShutdown.downloads",
      "privacy.clearOnShutdown.formdata",
      "privacy.clearOnShutdown.history",
      "privacy.clearOnShutdown.offlineApps",
      "privacy.clearOnShutdown.sessions",
      "privacy.clearOnShutdown.siteSettings",
      "privacy.clearOnShutdown_v2.browsingHistoryAndDownloads",
      "privacy.clearOnShutdown_v2.cache",
      "privacy.clearOnShutdown_v2.cookiesAndStorage",
      "privacy.clearOnShutdown_v2.downloads",
      "privacy.clearOnShutdown_v2.formdata",
      "privacy.clearOnShutdown_v2.historyFormDataAndDownloads",
      "privacy.clearOnShutdown_v2.siteSettings",
      "privacy.donottrackheader.enabled",
      "privacy.fingerprintingProtection",
      "privacy.fingerprintingProtection.pbmode",
      "privacy.globalprivacycontrol.enabled",
      "privacy.query_stripping.enabled",
      "privacy.query_stripping.enabled.pbmode",
      "privacy.reduceTimerPrecision",
      "privacy.resistFingerprinting.reduceTimerPrecision.jitter",
      "privacy.resistFingerprinting.reduceTimerPrecision.microseconds",
      "privacy.sanitize.sanitizeOnShutdown",
      "privacy.trackingprotection.harmfuladdon.enabled",
      "security.default_personal_cert",
      "spellchecker.dictionary",
      ...FINGERPRINTING_PREFS,
    ]),
  ]),
});
