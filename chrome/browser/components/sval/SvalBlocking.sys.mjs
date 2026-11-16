/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Ad and tracker blocking on Gecko's content classifier (protections spec
 * §1.1 to §1.3, decision 0102).
 *
 * The user's level is `browser.sval.adblock.level`. Off, Balanced and Strict
 * are list sets Sval curates; Custom is the user's own set,
 * `CUSTOM_LIST_BRANCH`, which may hold lists they added,
 * `USER_LIST_BRANCH`. Any edit to the lists switches to Custom, starting from
 * the lists the level had. The allowed domains, `ALLOWED_DOMAIN_BRANCH`, are
 * excepted on every site at every level. The user's own rules,
 * `browser.sval.adblock.myFilters`, are one more list beside the level's at
 * every level but Off. The `my-filters` engine holds them alone at every
 * level and serves only page rules, for the pages the lists' rules skip
 * (decision 1993). All of these sync (settings-sync spec), each entry of a
 * branch as a setting of its own.
 *
 * uBlock Origin's trusted scriptlets can set cookies, click and rewrite
 * responses, so they run only from lists that hold adblock-rust's trusted
 * permission: Sval's copies of uBlock Origin's own lists, as uBlock Origin's
 * `trustedListPrefixes` default of `ublock-` trusts them, the added lists the
 * user trusts, and the user's own rules once they trust those, as uBlock
 * Origin lets its "My filters" use them.
 * `browser.sval.adblock.trustedScriptlets` off trusts none. Trust is given on
 * each device and never syncs as a grant (spec §10.3): an added list runs
 * trusted scriptlets on a device only once the user trusts it there
 * (`TRUSTED_HERE_PREF`), and the user's own rules only as
 * the text they trusted on this device (`MY_FILTERS_TRUSTED_PREF`), so
 * rules another device writes into them wait for the user here.
 *
 * What the engine runs follows from them, by each list's category (decision
 * 1051). The `trackers` feature blocks with the level's tracker lists and
 * `ads` with the rest, each with the level's fixes, so an unbreak rule
 * reaches what it unbreaks; the allowed domains come last, so that they except
 * everything before them. `trackers-content` only tags requests as trackers,
 * which Firefox's cookie blocking reads, with the tracker lists, the fixes and
 * the owners' exceptions (`SvalTrackerOwners`). Sval runs none of Mozilla's
 * own features, whose lists are Disconnect's.
 *
 * Strict also turns on Firefox's query stripping, as Firefox's own Strict
 * category does (`qps` and `qpsPBM` in
 * `browser.contentblocking.features.strict`), in place of the lists' query
 * parameter rules, which the classifier cannot apply (decision 0104). Query
 * stripping is not a list, so editing Strict's lists keeps it: Custom strips
 * when it started from Strict, `CUSTOM_FROM_PREF`.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { TRACKER_OWNERS_LIST } from "moz-src:///browser/components/sval/SvalTrackerOwners.sys.mjs";
import { clearTimeout, setTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  ALLOWED_DOMAIN_BRANCH,
  allowedDomains,
  BLOCKING_TOPIC,
  normalizeDomain,
  publicListUrl,
  SvalBlockingLists,
  ENGINE_LISTS_PREF,
  TRACKER_LISTS_PREF,
  TRACKER_TAG_LISTS_PREF,
  isPlainText,
  isTrue,
  myFilters,
  MY_FILTERS_LIST,
  MY_FILTERS_PREF,
  storeUserList,
  TRUSTED_HERE_PREF,
  TRUSTED_LISTS_PREF,
  USER_LIST_BRANCH,
  USER_LIST_PREFIX,
  userLists,
} from "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs";
import { sha256HexSync } from "moz-src:///browser/components/sval/SvalBytes.sys.mjs";

export const LEVEL_PREF = "browser.sval.adblock.level";
/** Custom's lists: a pref each, this branch and the list's id, `true`. */
export const CUSTOM_LIST_BRANCH = "browser.sval.adblock.customList.";
export const CUSTOM_FROM_PREF = "browser.sval.adblock.customFrom";
export const TRUSTED_SCRIPTLETS_PREF = "browser.sval.adblock.trustedScriptlets";
/**
 * The SHA-256 of the user's own rules as they trusted them on this device, or
 * nothing. Local, and bound to the text: rules that change by any other way
 * than this device's own save are not the rules the user trusted.
 */
export const MY_FILTERS_TRUSTED_PREF =
  "browser.sval.adblock.myFiltersTrustedHere";

/** Sval's copies of uBlock Origin's own lists, which it trusts. */
const TRUSTED_LIST_PREFIX = "sval-ublock-";
export {
  ALLOWED_DOMAIN_BRANCH,
  BLOCKING_TOPIC,
  MY_FILTERS_LIST,
  MY_FILTERS_PREF,
  USER_LIST_BRANCH,
};

const PROTECTION_ENGINES_PREF =
  "privacy.trackingprotection.content.protection.engines";
const PROTECTION_ENGINES_PBM_PREF =
  "privacy.trackingprotection.content.protection.engines.pbmode";
const ANNOTATION_ENGINES_PREF =
  "privacy.trackingprotection.content.annotation.engines";
const ANNOTATION_ENGINES_PBM_PREF =
  "privacy.trackingprotection.content.annotation.engines.pbmode";

/**
 * Firefox's query stripping prefs, normal and private windows. The level
 * sets their defaults, so a value the user chose wins at every level, and
 * Firefox's tracking-protection category, which counts any user value of
 * these as Custom (`ContentBlockingPrefs.prefsMatch`), stays as it was.
 */
const QUERY_STRIPPING_PREFS = Object.freeze([
  "privacy.query_stripping.enabled",
  "privacy.query_stripping.enabled.pbmode",
]);

const CB_CATEGORY_PREF = "browser.contentblocking.category";

/** Each query stripping pref's default as shipped, before Strict moved it. */
const shippedDefaults = new Map();

const CURATED_LEVELS = Object.freeze(["off", "balanced", "strict"]);
const LEVELS = Object.freeze([...CURATED_LEVELS, "custom"]);

/**
 * How `SvalSettingsSync` treats the blocking prefs (`SvalSettingsRegistry`'s
 * `VALUE_RULES`). `CUSTOM_FROM_PREF` holds the curated level Custom started
 * from, or nothing, so a synced value that is neither leaves this device's.
 */
export const SYNC_RULES = Object.freeze({
  [CUSTOM_FROM_PREF]: Object.freeze({
    accepts: value => value === "" || CURATED_LEVELS.includes(value),
  }),
});

const CATEGORIES = Object.freeze([
  Object.freeze({ id: "ads", label: "Ads" }),
  Object.freeze({ id: "trackers", label: "Trackers" }),
  Object.freeze({ id: "annoyances", label: "Annoyances" }),
  Object.freeze({ id: "malware", label: "Scams and malware" }),
  Object.freeze({ id: "fixes", label: "Site fixes" }),
  Object.freeze({ id: "other", label: "Other" }),
]);

const BALANCED = Object.freeze([
  "sval-ublock-filters",
  "sval-ublock-badware",
  "sval-ublock-privacy",
  "sval-ublock-unbreak",
  "sval-ublock-quick-fixes",
  "sval-easylist",
  "sval-easyprivacy",
  "sval-curben-urlhaus",
  "sval-brave-unbreak",
]);

const STRICT = Object.freeze([
  ...BALANCED,
  "sval-hagezi-pro-mini",
  "sval-curben-phishing",
  "sval-ublock-annoyances-others",
  "sval-fanboy-social",
  // The cookie banner lists work by hiding elements, which page rules apply
  // (decision 0102).
  "sval-easylist-cookie",
  "sval-ublock-cookies",
]);

/** The branches whose entries a sync pass can change several of at once. */
const LIST_BRANCHES = [CUSTOM_LIST_BRANCH, USER_LIST_BRANCH];

const OBSERVED_PREFS = [
  LEVEL_PREF,
  CUSTOM_FROM_PREF,
  ...LIST_BRANCHES,
  ALLOWED_DOMAIN_BRANCH,
  TRUSTED_SCRIPTLETS_PREF,
  MY_FILTERS_PREF,
  MY_FILTERS_TRUSTED_PREF,
  TRUSTED_HERE_PREF,
];

/** @returns {Set<string>} The ids `CUSTOM_LIST_BRANCH` turns on. */
function customLists() {
  return new Set(
    Services.prefs
      .getChildList(CUSTOM_LIST_BRANCH)
      .filter(isTrue)
      .map(name => name.slice(CUSTOM_LIST_BRANCH.length))
  );
}

/**
 * Makes Custom's lists exactly `ids`.
 *
 * @param {Iterable<string>} ids
 */
function storeCustomLists(ids) {
  const wanted = new Set(ids);
  for (const id of customLists()) {
    if (!wanted.has(id)) {
      Services.prefs.clearUserPref(CUSTOM_LIST_BRANCH + id);
    }
  }
  for (const id of wanted) {
    Services.prefs.setBoolPref(CUSTOM_LIST_BRANCH + id, true);
  }
}

function changed() {
  Services.obs.notifyObservers(null, BLOCKING_TOPIC);
}

/**
 * The browsers blocked ads were counted for: browser element ->
 * `{ innerWindowId, origins }`, the origins whose requests the `ads` feature
 * blocked for the top document of that inner window. The content-blocking
 * log records those origins as blocked tracking content; this tells which
 * were ads. Gecko keeps that log on the top document's `WindowGlobalParent`,
 * so a set belongs to one document as the log does, and a new document
 * starts an empty one.
 */
const adOrigins = new WeakMap();

/**
 * @param {Element} browser
 * @returns {number|undefined} The inner window id of the browser's top
 *   document.
 */
function topWindowId(browser) {
  return browser.browsingContext?.currentWindowGlobal?.innerWindowId;
}

const blockedChannelListener = {
  observe(subject) {
    try {
      const channel = subject.QueryInterface(Ci.nsIUrlClassifierBlockedChannel);
      if (channel.tables != "ads") {
        return;
      }
      const browser = BrowsingContext.getCurrentTopByBrowserId(
        channel.browserId
      )?.embedderElement;
      if (!browser) {
        return;
      }
      const origin = Services.io.newURI(channel.url).prePath;
      const innerWindowId = topWindowId(browser);
      let entry = adOrigins.get(browser);
      if (entry?.innerWindowId !== innerWindowId) {
        entry = { innerWindowId, origins: new Set() };
        adOrigins.set(browser, entry);
      }
      entry.origins.add(origin);
    } catch (err) {
      SvalLog.debug(
        `a blocked ad could not be counted: ${SvalLog.errorName(err)}`
      );
    }
  },
};

let initialized = false;
let applying = false;
/** The pending write of edits made in Custom, which `flush` makes at once. */
let applyTimer = null;
// Toggling several lists in a row rebuilds the engine once, this long after
// the last toggle.
const EDIT_DEBOUNCE_MS = 500;

export const SvalBlocking = {
  LEVELS,
  CURATED_LEVELS,
  CATEGORIES,

  init() {
    if (initialized) {
      return;
    }
    initialized = true;
    for (const pref of OBSERVED_PREFS) {
      Services.prefs.addObserver(pref, this);
    }
    Cc["@mozilla.org/url-classifier/channel-classifier-service;1"]
      .getService(Ci.nsIChannelClassifierService)
      .addListener(blockedChannelListener);
    this.apply();
    SvalBlockingLists.start();
  },

  observe(subject, topic, data) {
    if (topic != "nsPref:changed" || applying) {
      return;
    }
    if (LIST_BRANCHES.some(branch => data.startsWith(branch))) {
      // A list removed or untrusted, here or by another device, takes this
      // device's trust in it along at once.
      if (data.startsWith(USER_LIST_BRANCH)) {
        SvalBlockingLists.dropLapsedTrust();
      }
      this._applySoon();
      return;
    }
    if (data == MY_FILTERS_PREF) {
      this._myFiltersEdit(() => this.apply());
      changed();
      return;
    }
    if (!data.startsWith(ALLOWED_DOMAIN_BRANCH)) {
      this.apply();
    }
    changed();
  },

  /**
   * Runs `edit`, which changes the user's own rules and applies. An edit that
   * adds or takes away the list changes the engine's list ids, which rebuilds
   * the engine; any other edit has it read the rules.
   *
   * @param {Function} edit
   */
  _myFiltersEdit(edit) {
    const before = SvalBlockingLists.enabledIds();
    edit();
    const after = SvalBlockingLists.enabledIds();
    if (
      after.includes(MY_FILTERS_LIST) &&
      after.join(",") == before.join(",")
    ) {
      SvalBlockingLists.myFiltersChanged();
    }
  },

  _applyPending: false,

  /**
   * Applies once for all the list entries that changed in one turn, as a
   * sync pass changes several at once, so the engine is rebuilt once.
   */
  _applySoon() {
    if (this._applyPending) {
      return;
    }
    this._applyPending = true;
    Promise.resolve().then(() => {
      this._applyPending = false;
      this.apply();
      changed();
    });
  },

  get level() {
    const level = Services.prefs.getStringPref(LEVEL_PREF, "off");
    return LEVELS.includes(level) ? level : "off";
  },

  /**
   * Chooses a curated level, which replaces any Custom set.
   *
   * @param {string} level One of {@link CURATED_LEVELS}.
   */
  setLevel(level) {
    if (!CURATED_LEVELS.includes(level)) {
      SvalLog.warn("a blocking level sval does not know was ignored");
      return;
    }
    this.batch(() => {
      Services.prefs.setStringPref(LEVEL_PREF, level);
      storeCustomLists([]);
      Services.prefs.clearUserPref(CUSTOM_FROM_PREF);
    });
  },

  /** Every list Sval knows, and the user's. */
  catalog() {
    return SvalBlockingLists.catalog().map(list => ({
      id: list.id,
      title: list.title,
      category: list.category,
      license: list.license ?? SvalBlockingLists.status(list.id).license,
      user: !!list.user,
      url: list.user ? list.url : undefined,
      trusted: list.user ? list.trusted : undefined,
      trustedElsewhere: list.user ? list.trustedElsewhere : undefined,
    }));
  },

  /**
   * The lists a level uses. Balanced and Strict add the regional list for
   * the browser's language.
   *
   * @param {string} level
   * @returns {string[]}
   */
  listsForLevel(level) {
    if (level == "custom") {
      const on = customLists();
      return SvalBlockingLists.catalog()
        .map(list => list.id)
        .filter(id => on.has(id));
    }
    const lists = { balanced: BALANCED, strict: STRICT }[level];
    if (!lists) {
      return [];
    }
    return [
      ...lists,
      ...SvalBlockingLists.regionalFor(Services.locale.appLocaleAsBCP47),
    ];
  },

  activeListIds() {
    return this.listsForLevel(this.level);
  },

  /**
   * Switches a curated level to Custom with the level's lists.
   *
   * @returns {{switchedFrom: ?string}}
   */
  customize() {
    const from = this.level;
    if (from == "custom") {
      return { switchedFrom: null };
    }
    this.batch(
      () => {
        storeCustomLists(this.listsForLevel(from));
        Services.prefs.setStringPref(CUSTOM_FROM_PREF, from);
        Services.prefs.setStringPref(LEVEL_PREF, "custom");
      },
      { debounce: true }
    );
    return { switchedFrom: from };
  },

  setListEnabled(id, enabled) {
    let result;
    this.batch(
      () => {
        result = this.customize();
        if (enabled) {
          Services.prefs.setBoolPref(CUSTOM_LIST_BRANCH + id, true);
        } else {
          Services.prefs.clearUserPref(CUSTOM_LIST_BRANCH + id);
        }
      },
      { debounce: true }
    );
    return result;
  },

  /**
   * Adds a list by its address, switched on, in Custom.
   *
   * @param {string} text An https address.
   * @param {string} category One of {@link CATEGORIES}' ids.
   * @returns {{id: string, switchedFrom: ?string}}
   */
  addList(text, category) {
    let parsed;
    try {
      parsed = new URL(String(text).trim());
    } catch {
      throw new Error("invalid");
    }
    if (parsed.protocol != "https:") {
      throw new Error("not-https");
    }
    const href = publicListUrl(parsed.href);
    if (!href) {
      throw new Error("invalid");
    }
    const id = SvalBlockingLists.userListId(href);
    SvalBlockingLists.confirm(href);
    let result;
    this.batch(
      () => {
        storeUserList({
          url: href,
          category: CATEGORIES.some(c => c.id == category) ? category : "other",
        });
        result = this.setListEnabled(id, true);
      },
      { debounce: true }
    );
    return { id, ...result };
  },

  /**
   * Lets a list that arrived through sync download on this device.
   *
   * @param {string} id A user list's id.
   */
  confirmList(id) {
    const list = SvalBlockingLists.catalog().find(item => item.id == id);
    if (list?.user) {
      SvalBlockingLists.confirm(list.url);
      changed();
    }
  },

  removeList(id) {
    if (!id.startsWith(USER_LIST_PREFIX)) {
      return { switchedFrom: null };
    }
    let result;
    this.batch(
      () => {
        result = this.setListEnabled(id, false);
        Services.prefs.clearUserPref(USER_LIST_BRANCH + id);
        SvalBlockingLists.dropLapsedTrust();
      },
      { debounce: true }
    );
    return result;
  },

  /** Whether any list may run trusted scriptlets. */
  get trustedScriptlets() {
    return Services.prefs.getBoolPref(TRUSTED_SCRIPTLETS_PREF, true);
  },

  setTrustedScriptlets(on) {
    this.batch(
      () => Services.prefs.setBoolPref(TRUSTED_SCRIPTLETS_PREF, !!on),
      { debounce: true }
    );
  },

  /**
   * Trusts a list the user added with trusted scriptlets on this device, or
   * stops. Trusting says so to the other devices, which each ask their user;
   * withdrawing takes the list's trust away on every device.
   *
   * @param {string} id A user list's id.
   * @param {boolean} trusted
   */
  setListTrusted(id, trusted) {
    const entry = userLists().find(
      list => SvalBlockingLists.userListId(list.url) == id
    );
    if (!entry) {
      return;
    }
    const rest = { ...entry };
    delete rest.trusted;
    this.batch(
      () => {
        SvalBlockingLists.trustHere(entry.url, trusted);
        storeUserList(trusted ? { ...rest, trusted: true } : rest);
      },
      { debounce: true }
    );
  },

  /** The user's own rules as stored, "" when they are not plain text. */
  get myFilters() {
    return myFilters();
  },

  /**
   * Stores the user's own rules, which rebuilds the engine with them.
   *
   * @param {string} text One rule per line.
   * @throws {Error} "invalid" for text that is not plain text, "too-large"
   *   for text the pref store refuses.
   */
  setMyFilters(text) {
    if (!isPlainText(text)) {
      throw new Error("invalid");
    }
    // Rules the user saves here are theirs, so trust they gave here goes
    // with them, in the same apply.
    const trusted = this.myFiltersTrusted;
    this._myFiltersEdit(() =>
      this.batch(() => {
        if (!text.trim()) {
          Services.prefs.clearUserPref(MY_FILTERS_PREF);
        } else {
          try {
            Services.prefs.setStringPref(MY_FILTERS_PREF, text);
          } catch {
            throw new Error("too-large");
          }
        }
        if (trusted) {
          Services.prefs.setStringPref(
            MY_FILTERS_TRUSTED_PREF,
            sha256HexSync(myFilters())
          );
        }
      })
    );
  },

  /**
   * Whether the user's own rules may run trusted scriptlets: the user trusted
   * these very rules on this device.
   */
  get myFiltersTrusted() {
    const trusted = Services.prefs.getStringPref(MY_FILTERS_TRUSTED_PREF, "");
    return !!trusted && trusted == sha256HexSync(myFilters());
  },

  /**
   * Whether the user trusted their own rules on this device and the rules
   * have since changed by another way than this device's save, such as
   * another device's.
   */
  get myFiltersChangedElsewhere() {
    return (
      !!Services.prefs.getStringPref(MY_FILTERS_TRUSTED_PREF, "") &&
      !this.myFiltersTrusted
    );
  },

  /**
   * Trusts the user's own rules, or stops.
   *
   * @param {boolean} on
   * @param {string} [shown] The rules as they were when the user was asked,
   *   which trusting needs: rules that changed since, as another device's
   *   can while the question is open, are not the rules the user trusted.
   * @returns {boolean} false when `shown` is not the rules any more, and
   *   nothing was trusted.
   */
  setMyFiltersTrusted(on, shown) {
    if (on && shown !== myFilters()) {
      return false;
    }
    this.batch(
      () => {
        if (on) {
          Services.prefs.setStringPref(
            MY_FILTERS_TRUSTED_PREF,
            sha256HexSync(shown)
          );
        } else {
          Services.prefs.clearUserPref(MY_FILTERS_TRUSTED_PREF);
        }
      },
      { debounce: true }
    );
    return true;
  },

  /** @returns {string[]} The allowed domains, sorted. */
  allowedDomains() {
    return allowedDomains();
  },

  /**
   * Adds a domain that is never blocked, subdomains included. Takes a domain
   * or an address.
   *
   * @param {string} text
   * @returns {string} the domain as stored.
   */
  addAllowedDomain(text) {
    const host = normalizeDomain(text);
    if (!host) {
      throw new Error("invalid");
    }
    Services.prefs.setBoolPref(ALLOWED_DOMAIN_BRANCH + host, true);
    return host;
  },

  removeAllowedDomain(domain) {
    Services.prefs.clearUserPref(ALLOWED_DOMAIN_BRANCH + domain);
  },

  /**
   * @param {string} id
   * @returns {object} `SvalBlockingLists.status` for the list.
   */
  listStatus(id) {
    return SvalBlockingLists.status(id);
  },

  /**
   * Which of the origins the log reports blocked were ads, for the
   * protection panel: those blocked for the browser's current top document.
   *
   * @param {Element} browser
   * @returns {Set<string>}
   */
  adOriginsFor(browser) {
    const entry = adOrigins.get(browser);
    return entry && entry.innerWindowId === topWindowId(browser)
      ? entry.origins
      : new Set();
  },

  apply() {
    clearTimeout(applyTimer);
    applyTimer = null;
    applying = true;
    try {
      const lists = this.activeListIds();
      if (this.level != "off" && myFilters().trim()) {
        lists.push(MY_FILTERS_LIST);
      }
      const trusted = this.trustedScriptlets
        ? SvalBlockingLists.catalog()
            .filter(list =>
              list.user ? list.trusted : list.id.startsWith(TRUSTED_LIST_PREFIX)
            )
            .map(list => list.id)
        : [];
      if (this.trustedScriptlets && this.myFiltersTrusted) {
        trusted.push(MY_FILTERS_LIST);
      }
      Services.prefs.setStringPref(TRUSTED_LISTS_PREF, trusted.join(","));
      const categories = new Map(
        SvalBlockingLists.catalog().map(list => [list.id, list.category])
      );
      const inCategory = category =>
        lists.filter(id => categories.get(id) == category);
      const fixes = inCategory("fixes");
      const trackers = inCategory("trackers");
      const ads = lists.filter(
        id => !fixes.includes(id) && !trackers.includes(id)
      );
      const withFixes = ids => (ids.length ? [...ids, ...fixes] : []);
      Services.prefs.setStringPref(ENGINE_LISTS_PREF, withFixes(ads).join(","));
      Services.prefs.setStringPref(
        TRACKER_LISTS_PREF,
        withFixes(trackers).join(",")
      );
      Services.prefs.setStringPref(
        TRACKER_TAG_LISTS_PREF,
        trackers.length
          ? [...trackers, ...fixes, TRACKER_OWNERS_LIST].join(",")
          : ""
      );
      const blocking = [
        ...(trackers.length ? ["trackers"] : []),
        ...(ads.length ? ["ads"] : []),
        ...(myFilters().trim() ? ["my-filters"] : []),
        "allowed-domains",
      ].join(",");
      const tagging = trackers.length ? "trackers-content,allowed-domains" : "";
      Services.prefs.setStringPref(PROTECTION_ENGINES_PREF, blocking);
      Services.prefs.setStringPref(PROTECTION_ENGINES_PBM_PREF, blocking);
      Services.prefs.setStringPref(ANNOTATION_ENGINES_PREF, tagging);
      Services.prefs.setStringPref(ANNOTATION_ENGINES_PBM_PREF, tagging);
      const level = this.level;
      const strips =
        level == "strict" ||
        (level == "custom" &&
          Services.prefs.getStringPref(CUSTOM_FROM_PREF, "") == "strict");
      const category = Services.prefs.getStringPref(CB_CATEGORY_PREF, "");
      const defaults = Services.prefs.getDefaultBranch("");
      for (const pref of QUERY_STRIPPING_PREFS) {
        if (!shippedDefaults.has(pref)) {
          shippedDefaults.set(pref, defaults.getBoolPref(pref, false));
        }
        defaults.setBoolPref(pref, strips || shippedDefaults.get(pref));
      }
      // Firefox's Strict category writes query stripping on, which matches
      // Sval's Strict default and so stores no user value. Lowering the
      // default then reads to `ContentBlockingPrefs.matchCBCategory` as a
      // change to Custom; choosing the category again re-applies it.
      if (Services.prefs.getStringPref(CB_CATEGORY_PREF, "") != category) {
        Services.prefs.setStringPref(CB_CATEGORY_PREF, category);
      }
    } finally {
      applying = false;
    }
  },

  /**
   * Runs several pref writes as one change. An edit in Custom writes what the
   * engine runs a moment later, so a run of toggles rebuilds it once.
   *
   * @param {Function} task Writes the prefs.
   * @param {object} [options]
   * @param {boolean} [options.debounce] Whether the engine's prefs may wait.
   */
  batch(task, { debounce = false } = {}) {
    const wasApplying = applying;
    applying = true;
    try {
      task();
    } finally {
      applying = wasApplying;
    }
    if (wasApplying) {
      return;
    }
    if (debounce) {
      clearTimeout(applyTimer);
      applyTimer = setTimeout(() => this.apply(), EDIT_DEBOUNCE_MS);
    } else {
      this.apply();
    }
    changed();
  },

  /** Writes any pending edit's engine prefs at once. */
  flush() {
    if (applyTimer) {
      this.apply();
    }
  },
};
