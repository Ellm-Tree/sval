/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The choices a person makes for one site (protections spec §2.2, §2.3
 * and §4.1): protections off, fingerprinting protection off, and
 * whether video and audio may play, and which fingerprinting protections
 * the site goes without or gets beyond the defaults (protections spec §3.3).
 *
 * **Each site's choices are a pref of their own,** `SITE_BRANCH` and the site,
 * as `siteOf` cuts one, holding `{protections, media, exceptions}` as JSON.
 * A host under a site has a pref of its own too (decision 1980), and each
 * field resolves on its own along the host's scope chain (`scopeChain`): the
 * most specific name holding that field decides it. A host may hold
 * `protections: "on"` or `exceptions: []`, which a site never stores, to
 * keep what its site turned off or on away from it.
 * Settings sync carries each as a setting of its own, so a choice reaches
 * every device, two devices choosing for different sites both keep their
 * choice, and a site removed on one device is removed on the others. Gecko
 * reads none of it: this module writes each choice into the store Gecko does
 * read, and follows the branch, so a choice that arrives through sync takes
 * effect as one made here does.
 *
 * **Nothing it writes into Gecko is saved.** The permissions are session
 * permissions, and the granular entries live on the default branch of
 * `OVERRIDE_PREFS`, so `start` writes them all from the pref and none can
 * outlive the choice it came from.
 *
 * - `protections: "off"` is Firefox's content-blocking allow list, the
 *   `trackingprotection` permission `ContentBlockingAllowList` writes. Gecko
 *   lifts blocking and fingerprinting protection together for a site that has
 *   it (`ContentBlockingAllowList::Check`), matching the site's subdomains,
 *   so it is written for the site's own http and https origins. A host whose
 *   own rule keeps protections on gets DENY there instead: the permission
 *   manager takes the most specific origin's entry
 *   (`PermissionManager::GetPermissionHashKey`), so it beats its site's
 *   ALLOW.
 * - `protections: "fingerprinting"` is a `-AllTargets` entry for the site in
 *   both `OVERRIDE_PREFS`, which `FingerprintingWebCompatService` reads after
 *   Gecko's granular-overrides prefs, keyed by the same eTLD+1. A person's own
 *   entries in Gecko's prefs are left as they are.
 * - `protections: "full"` keeps fingerprinting protection whole where
 *   Mozilla's webcompat entries relax it: an entry for the site in both
 *   `OVERRIDE_PREFS` that takes the place of Mozilla's and resolves to the
 *   global target set (`KEEP_GLOBAL`), written while Mozilla has entries for
 *   the site.
 * - `exceptions`, ids from `SvalFingerprinting.SITE_EXCEPTIONS`, is the same
 *   kind of entry carrying only those exceptions' tokens, after Mozilla's
 *   webcompat tokens for the site, whose place it takes (`overridesFor`),
 *   unless the site has `"full"`. A site with protections off or
 *   fingerprinting protection off goes without every target already, so it
 *   gets no such entry while it has either.
 *   Gecko reads an entry only for a site with a base domain
 *   (`canWriteFor`), so no other site gets one. A host's entry carries the
 *   host's resolved fields, since Gecko takes the entry of the page's host,
 *   or the nearest name above it, before its site's (Sval's
 *   `fp-overrides-host-scope` patch).
 * - `insecure: true` is HTTPS-Only Mode's exception, the
 *   `https-only-load-insecure` permission at `LOAD_INSECURE_ALLOW`, on the
 *   name's own http origin alone. Gecko matches it to the exact origin
 *   (`nsHTTPSOnlyUtils::TestIfPrincipalIsExempt`), so the field covers no
 *   host below its name, and a host's field never comes from its site.
 * - `media: "ask" | "allow" | "block"` is the `autoplay-media` permission
 *   Gecko's media gate reads: Firefox's own per-site states,
 *   `AUTOPLAY_BLOCKED_ALL`, `ALLOW` and `DENY` (`mediaAction`). A site with
 *   no `media` holds no permission, which the gate answers from the default
 *   (`mediaDefault`). Gecko matches the permission to the exact origin, so
 *   it is written for the site's own origins, for every origin of the site
 *   that already has one, and for an origin of the site as a page of it
 *   starts to load or is redirected to (`coverOrigin`), each origin taking
 *   the rule of the most specific name above it.
 *
 * **A private window's choices** are kept in memory and written to the same
 * stores with a principal of the window's private session and the private
 * permission type, as Firefox's private exceptions are. Each private window
 * is a session of its own, named by its jar (`SvalPrivateJars`), so a choice
 * applies in the window it was made in, and in a popup that window opened,
 * and nowhere else. They never reach the pref, so they never sync, and they
 * go when the session's data is cleared. Gecko applies the granular entries
 * to normal windows alone
 * (`FingerprintingOverride.appliesInPrivateBrowsing`), so a normal window's
 * fingerprinting choices never reach a private one, and a private window
 * cannot turn fingerprinting protection off on its own, keep fingerprinting
 * exceptions, or keep Mozilla's webcompat entries out, which apply in every
 * window.
 *
 * **Gecko's granular-overrides prefs hold only a person's own entries.** They
 * are saved, so an entry of this module's found there (`isOwnEntry`) answers
 * to no choice, and `start` takes it out.
 *
 * **Permissions made before this store existed** are brought into it once
 * (`MIGRATED_PREF`): each site with a `trackingprotection` exception or an
 * `autoplay-media` choice on any of its origins gets that choice in its
 * pref, so it shows in Settings and syncs. Nothing is removed by it.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

import {
  SITE_SCHEMES,
  mostSpecificRule,
  scopeChain,
  scopeOfHost,
  siteForURI,
  siteOrigins,
} from "moz-src:///browser/components/sval/SvalSite.sys.mjs";
import { MEDIA_PERMISSION } from "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs";

import { SITE_EXCEPTIONS } from "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalPrivateJars: "moz-src:///browser/components/sval/SvalPrivateJars.sys.mjs",
  RemoteSettings: "resource://services-settings/remote-settings.sys.mjs",
});

/** The branch each site's or host's choices are a pref under, named for it. */
export const SITE_BRANCH = "browser.sval.protection.site.";
export const GATE_PREF = "media.autoplay.site-permission-only";
export const MIGRATED_PREF = "browser.sval.protection.migrated";
/**
 * The media choice for every site without one of its own, which Gecko's gate
 * reads as the answer for a site with no `autoplay-media` permission
 * (`MEDIA_DEFAULT_VALUES`).
 */
export const MEDIA_DEFAULT_PREF = "media.autoplay.site-permission-only.default";
/** Each media choice as `MEDIA_DEFAULT_PREF` holds it. */
const MEDIA_DEFAULT_VALUES = Object.freeze({ ask: 0, allow: 1, block: 2 });
/**
 * The media choices in the order every control lists them, with the words
 * each shows: one vocabulary for a site's own choice and for the default.
 */
export const MEDIA_CHOICES = Object.freeze([
  ["allow", "Always allow"],
  ["ask", "Ask first"],
  ["block", "Always deny"],
]);
/**
 * Notified when a private window's choice changes, which no pref carries,
 * with the session's jar as the data.
 */
export const PRIVATE_TOPIC = "sval-site-protections-private-changed";
/**
 * Notified once Gecko's stores hold the stored choices. libpref calls a
 * branch's observers newest first, so anything added after `start` that
 * observed `SITE_BRANCH` would run before the stores change.
 */
export const APPLIED_TOPIC = "sval-site-protections-applied";
const BASELINE_PREF =
  "privacy.baselineFingerprintingProtection.granularOverrides";
export const GRANULAR_PREFS = Object.freeze([
  "privacy.fingerprintingProtection.granularOverrides",
  BASELINE_PREF,
]);
const BASELINE_OVERRIDE_PREF =
  "browser.sval.protection.baselineFingerprintingOverrides";
/**
 * This module's granular entries, as `GRANULAR_PREFS` take them and in the
 * same order, kept on the default branch, which is never saved.
 */
export const OVERRIDE_PREFS = Object.freeze([
  "browser.sval.protection.fingerprintingOverrides",
  BASELINE_OVERRIDE_PREF,
]);

/** HTTPS-Only Mode's exception for an origin. */
export const HTTPS_ONLY_PERMISSION = "https-only-load-insecure";

/** The content-blocking allow list's permission type, and a private window's. */
const ALLOW_LIST = "trackingprotection";
const ALLOW_LIST_PRIVATE = "trackingprotection-pb";

/**
 * The permission types this module writes to apply the site choices, in
 * stored and private sessions alike.
 */
export const APPLIED_PERMISSIONS = Object.freeze([
  ALLOW_LIST,
  ALLOW_LIST_PRIVATE,
  MEDIA_PERMISSION,
]);
const REQUEST_TOPIC = "http-on-modify-request";
const ALL_TARGETS_OFF = "-AllTargets";
/**
 * An entry that changes no target. `nsRFPService::CreateOverridesFromText`
 * starts each entry from the global set and skips
 * `IsAlwaysEnabledForPrecompute`, so this resolves to the global set, which
 * the entry schema's pattern would not let an empty list stand for.
 */
const KEEP_GLOBAL = "-IsAlwaysEnabledForPrecompute";

/** The values a rule's fields may take. */
const PROTECTIONS = new Set(["on", "off", "fingerprinting", "full"]);
const MEDIA = new Set(["ask", "allow", "block"]);

/**
 * @param {"ask"|"allow"|"block"} media
 * @returns {number} The `autoplay-media` permission that gives it. The gate
 *   lets ALLOW play and holds every other permission, whatever the default
 *   and whatever the person pressed on the page.
 */
function mediaAction(media) {
  return {
    ask: Ci.nsIAutoplay.BLOCKED_ALL,
    allow: Ci.nsIPermissionManager.ALLOW_ACTION,
    block: Ci.nsIPermissionManager.DENY_ACTION,
  }[media];
}

/** Mozilla's webcompat overrides, which an exception entry carries along. */
const REMOTE_COLLECTION = "fingerprinting-protection-overrides";
export const REMOTE_OVERRIDES_PREF =
  "privacy.fingerprintingProtection.remoteOverrides.enabled";

/**
 * @param {string} name
 * @returns {boolean} Whether `name` is a site as `siteOf` cuts one, or a
 *   host under it that a rule can be saved for (`scopeOfHost`).
 */
function isScopeName(name) {
  const [uri] = siteOrigins(name, ["https"]);
  return (
    !!uri && (siteForURI(uri) === name || scopeOfHost(uri.host)?.host === name)
  );
}

/**
 * @param {string} name
 * @returns {boolean} Whether `name` is a host under its site.
 */
function isHost(name) {
  return scopeChain(name).length > 1;
}

/**
 * The rules `SITE_BRANCH` holds. A pref that does not name a site or a host,
 * or hold a rule, is dropped.
 *
 * @returns {Map<string, {protections?: string, media?: string,
 *   exceptions?: string[]}>}
 */
function readRules() {
  const rules = new Map();
  for (const name of Services.prefs.getChildList(SITE_BRANCH)) {
    const site = name.slice(SITE_BRANCH.length);
    let rule = null;
    try {
      rule = cleanRule(JSON.parse(Services.prefs.getStringPref(name, "")));
    } catch {}
    if (rule && isScopeName(site)) {
      rules.set(site, rule);
    }
  }
  return new Map([...rules].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Stores one site's rule, or takes its pref away with none.
 *
 * @param {string} site
 * @param {object|null} rule A clean rule.
 */
function storeRule(site, rule) {
  if (rule) {
    Services.prefs.setStringPref(SITE_BRANCH + site, JSON.stringify(rule));
  } else {
    Services.prefs.clearUserPref(SITE_BRANCH + site);
  }
}

/**
 * @param {*} rule
 * @returns {object|null} The rule's known fields, or null when it has none.
 */
function cleanRule(rule) {
  if (!rule || typeof rule !== "object") {
    return null;
  }
  const clean = {};
  if (PROTECTIONS.has(rule.protections)) {
    clean.protections = rule.protections;
  }
  if (MEDIA.has(rule.media)) {
    clean.media = rule.media;
  }
  if (rule.insecure === true) {
    clean.insecure = true;
  }
  if (Array.isArray(rule.exceptions)) {
    const exceptions = SITE_EXCEPTIONS.map(e => e.id).filter(id =>
      rule.exceptions.includes(id)
    );
    // An empty list is a host's, keeping its site's exceptions away.
    if (exceptions.length || !rule.exceptions.length) {
      clean.exceptions = exceptions;
    }
  }
  return Object.keys(clean).length ? clean : null;
}

/**
 * The overrides of the granular entry a rule wants for its site, or null for
 * none. An entry takes the place of Mozilla's webcompat entries for the
 * site's first-party loads (`GetOverriddenFingerprintingSettingsForURI`
 * prefers the narrower scope), so an exception entry starts with their
 * tokens, the broader scope first, and its own come last and win. With
 * `"full"` it leaves their tokens out.
 *
 * @param {object} rule A clean rule.
 * @param {string[]} remote The webcompat tokens for the site.
 * @returns {string|null}
 */
function overridesFor(rule, remote) {
  if (rule.protections === "fingerprinting") {
    return ALL_TARGETS_OFF;
  }
  const full = rule.protections === "full";
  if (rule.protections === "off") {
    return null;
  }
  const tokens = [
    ...(full ? [] : remote),
    ...SITE_EXCEPTIONS.filter(e => rule.exceptions?.includes(e.id)).flatMap(
      e => e.tokens
    ),
  ];
  if (!tokens.length) {
    return full && remote.length ? KEEP_GLOBAL : null;
  }
  return tokens.join(",");
}

/**
 * @param {nsIPrincipal} principal
 * @returns {string|null}
 */
function siteOfPrincipal(principal) {
  return principal?.isContentPrincipal ? siteForURI(principal.URI) : null;
}

/**
 * Which choices a caller means: a private session's, named by its jar
 * (`SvalPrivateJars.sessionOf`), or the stored ones, null.
 *
 * @param {number|null|undefined} session
 * @returns {number|null}
 */
function sessionKey(session) {
  if (session === null || session === undefined) {
    return null;
  }
  if (!Number.isInteger(session)) {
    throw new Error("sval: a private session is named by its jar");
  }
  return session;
}

/**
 * The site's own origins, as principals.
 *
 * @param {string} site
 * @param {number|null} session
 * @returns {nsIPrincipal[]}
 */
function sitePrincipals(site, session) {
  const attrs =
    session === null ? {} : { privateBrowsingId: 1, userContextId: session };
  return siteOrigins(site, SITE_SCHEMES).map(uri =>
    Services.scriptSecurityManager.createContentPrincipal(uri, attrs)
  );
}

/**
 * @param {nsIPrincipal} principal
 * @returns {boolean}
 */
function isPrivatePrincipal(principal) {
  return principal.originAttributes.privateBrowsingId > 0;
}

/**
 * @param {nsIPrincipal} principal
 * @returns {number|null} the private session `principal` is of, or null.
 */
function sessionOfPrincipal(principal) {
  return lazy.SvalPrivateJars.sessionOf(principal.originAttributes);
}

/**
 * @param {number|null} session
 * @returns {string} The content-blocking allow list's permission type.
 */
function allowListType(session) {
  return session === null ? ALLOW_LIST : ALLOW_LIST_PRIVATE;
}

/**
 * The granular overrides a pref holds, as Gecko reads them: a JSON array.
 *
 * @param {string} name
 * @returns {object[]}
 */
export function readGranular(name) {
  try {
    const value = JSON.parse(Services.prefs.getStringPref(name, "") || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/**
 * Whether an entry in `GRANULAR_PREFS` is one of this module's for `site`:
 * marked `sval`, which Gecko's schema leaves alone, or a bare `-AllTargets`
 * first-party entry, the whole-site switch's.
 *
 * @param {object} entry A granular override.
 * @param {string} site
 * @returns {boolean}
 */
export function isOwnEntry(entry, site) {
  if (entry?.firstPartyDomain !== site || entry.thirdPartyDomain) {
    return false;
  }
  return entry.sval === true || entry.overrides === ALL_TARGETS_OFF;
}

export const SvalSiteProtections = {
  SITE_BRANCH,
  GATE_PREF,
  MEDIA_DEFAULT_PREF,
  MEDIA_CHOICES,
  PRIVATE_TOPIC,
  APPLIED_TOPIC,

  /**
   * The site the protection button's "Manage sites" asked Settings to show,
   * until Settings takes it.
   *
   * @type {string|null}
   */
  manageFilter: null,

  _started: false,

  /** @type {Map<string, object>} What the stores hold from the pref. */
  _applied: new Map(),

  /**
   * @type {Map<number, Map<string, object>>} Each private session's
   *   choices, by its jar.
   */
  _private: new Map(),

  /**
   * Writes the stored choices into Gecko's stores and follows the branch.
   * Before any page can load, as `SvalJavascript.start` is.
   */
  start() {
    if (this._started) {
      return;
    }
    this._started = true;
    this._migrate();
    this._dropSavedEntries();
    this._apply();
    Services.prefs.addObserver(SITE_BRANCH, this);
    Services.prefs.addObserver(REMOTE_OVERRIDES_PREF, this);
    Services.obs.addObserver(this, "last-pb-context-exited");
    Services.obs.addObserver(this, "clear-origin-attributes-data");
    this._followRemote();
  },

  observe(subject, topic, data) {
    if (topic === REQUEST_TOPIC) {
      this._coverRedirect(subject.QueryInterface(Ci.nsIChannel));
    } else if (data === REMOTE_OVERRIDES_PREF) {
      this._writeFingerprinting();
    } else if (topic === "last-pb-context-exited") {
      // Gecko drops the private permissions itself.
      this._private.clear();
      this._followRedirects();
    } else if (topic === "clear-origin-attributes-data") {
      // A private session's data being cleared (`SvalPrivateJars`) takes its
      // permissions; its choices go with them.
      const pattern = JSON.parse(data);
      const session =
        pattern.privateBrowsingId > 0
          ? lazy.SvalPrivateJars.sessionOf(pattern)
          : null;
      if (session !== null && this._private.delete(session)) {
        this._followRedirects();
        Services.obs.notifyObservers(null, PRIVATE_TOPIC, String(session));
      }
    } else {
      this._apply();
    }
  },

  /**
   * Every choice that names a private session takes it as the session's jar
   * (`SvalPrivateJars.sessionOf`), and one that names none is the stored one.
   *
   * @param {number|null} [session]
   * @returns {Map<string, object>} The stored (synced) choices, or the
   *   private session's choices.
   */
  rules(session = null) {
    const key = sessionKey(session);
    return key === null ? readRules() : new Map(this._private.get(key) ?? []);
  },

  /**
   * @param {string} name A site or a host.
   * @param {number|null} [session]
   * @returns {{protections?: string, media?: string, exceptions?: string[]}}
   *   The choices saved under `name` itself, as Gecko's stores hold them;
   *   empty where it has none.
   */
  ruleFor(name, session = null) {
    const key = sessionKey(session);
    const rules = key === null ? this._applied : this._private.get(key);
    return rules?.get(name) ?? {};
  },

  /**
   * One field as `host` gets it: from the most specific name above it that
   * holds the field.
   *
   * @param {string} host A host or a site, as `scopeOfHost` names it.
   * @param {"protections"|"media"|"exceptions"} field
   * @param {number|null} [session]
   * @returns {*} The field's value, undefined where no name holds it.
   */
  resolvedFor(host, field, session = null) {
    return mostSpecificRule(host, name => this.ruleFor(name, session)[field])
      ?.rule;
  },

  /**
   * One field as `name` would get it without a choice of its own: from the
   * nearest name above it, or the default.
   *
   * @param {string} name
   * @param {"protections"|"media"|"exceptions"} field
   * @param {number|null} [session]
   * @returns {*}
   */
  inheritedFor(name, field, session = null) {
    const above = scopeChain(name)[1];
    const value =
      above === undefined ? undefined : this.resolvedFor(above, field, session);
    return value ?? this._fieldDefault(field);
  },

  /**
   * @param {"protections"|"media"|"exceptions"} field
   * @returns {*} What a name holding no rule for the field gets.
   */
  _fieldDefault(field) {
    return { protections: "on", media: this.mediaDefault(), exceptions: [] }[
      field
    ];
  },

  /**
   * @param {string} host A host or a site, as `scopeOfHost` names it.
   * @param {number|null} [session]
   * @returns {"on"|"off"|"fingerprinting"|"full"}
   */
  protectionsFor(host, session = null) {
    return this.resolvedFor(host, "protections", session) ?? "on";
  },

  /**
   * @param {string} host A host or a site, as `scopeOfHost` names it.
   * @param {number|null} [session]
   * @returns {"ask"|"allow"|"block"} What the host gets: the choice of the
   *   most specific name above it, or the default's where none has one.
   */
  mediaFor(host, session = null) {
    return this.resolvedFor(host, "media", session) ?? this.mediaDefault();
  },

  /**
   * @param {string} host A host or a site, as `scopeOfHost` names it.
   * @returns {string[]} The ids of the fingerprinting exceptions the host
   *   gets, from `SvalFingerprinting.SITE_EXCEPTIONS`.
   */
  exceptionsFor(host) {
    return this.resolvedFor(host, "exceptions") ?? [];
  },

  /**
   * Sets which fingerprinting exceptions a site or host has. Outside private
   * windows only.
   *
   * @param {string} name
   * @param {string[]} ids From `SvalFingerprinting.SITE_EXCEPTIONS`.
   */
  setExceptions(name, ids) {
    this._change(name, { exceptions: ids }, null);
  },

  /**
   * @param {string} name A site or a host.
   * @param {"on"|"off"|"fingerprinting"|"full"} value
   * @param {number|null} [session]
   */
  setProtections(name, value, session = null) {
    this._change(name, { protections: value }, session);
  },

  /**
   * @param {string} name A site or a host.
   * @param {"ask"|"allow"|"block"|""} value "" follows the default, or for
   *   a host the names above it.
   * @param {number|null} [session]
   */
  setMedia(name, value, session = null) {
    this._change(name, { media: value }, session);
  },

  /**
   * @param {string} name A site or a host.
   * @returns {boolean} Whether `name`'s own http origin opens without
   *   HTTPS-Only Mode's warning on every device.
   */
  insecureFor(name) {
    return this.ruleFor(name).insecure === true;
  },

  /**
   * @param {string} name
   * @returns {boolean} Whether a choice can be saved for `name`: a site, or
   *   a host under one.
   */
  canChooseFor(name) {
    return isScopeName(name);
  },

  /**
   * Lets `name`'s own http origin open without HTTPS-Only Mode's warning on
   * every device, or takes that away. The field is the name's own, so it
   * skips `_change`'s comparison with the names above it. Outside private
   * windows only.
   *
   * @param {string} name A site or a host.
   * @param {boolean} allowed
   */
  setInsecure(name, allowed) {
    const rule = { ...this.ruleFor(name) };
    if (allowed) {
      rule.insecure = true;
    } else {
      delete rule.insecure;
    }
    this._put(name, rule, null);
  },

  /**
   * Puts a site's or host's whole rule back, or takes it away with none.
   * Settings' remove and its Undo.
   *
   * @param {string} name
   * @param {object|null} rule
   * @param {number|null} [session]
   */
  setRule(name, rule, session = null) {
    this._put(name, rule, session);
  },

  /**
   * Changes fields of a name's rule. A site keeps a field unless it is the
   * default a site never stores (protections on, no exceptions). A host
   * keeps one only where it differs from what the host gets without it
   * (host-scoped rules spec §2).
   *
   * @param {string} name
   * @param {object} fields
   * @param {number|null} session
   */
  _change(name, fields, session) {
    const key = sessionKey(session);
    if (
      key !== null &&
      (fields.protections === "fingerprinting" || fields.protections === "full")
    ) {
      return;
    }
    const rule = { ...this.ruleFor(name, key) };
    const host = isHost(name);
    const same = (a, b) =>
      Array.isArray(a)
        ? Array.isArray(b) && [...a].sort().join() === [...b].sort().join()
        : a === b;
    for (const [field, value] of Object.entries(fields)) {
      const dropped = host
        ? same(value, this.inheritedFor(name, field, key))
        : field !== "media" && same(value, this._fieldDefault(field));
      if (value === "" || value === undefined || dropped) {
        delete rule[field];
      } else {
        rule[field] = value;
      }
    }
    this._put(name, rule, key);
  },

  /**
   * @param {string} name
   * @param {object|null} rule
   * @param {number|null} session
   */
  _put(name, rule, session) {
    const key = sessionKey(session);
    const clean = cleanRule(rule);
    if (key === null) {
      storeRule(name, clean);
      return;
    }
    let rules = this._private.get(key);
    const before = rules?.get(name) ?? {};
    if (clean) {
      if (!rules) {
        rules = new Map();
        this._private.set(key, rules);
      }
      rules.set(name, clean);
    } else if (rules) {
      rules.delete(name);
      if (!rules.size) {
        this._private.delete(key);
      }
    }
    this._applyName(name, before, clean ?? {}, key);
    this._followRedirects();
    Services.obs.notifyObservers(null, PRIVATE_TOPIC, String(key));
  },

  /**
   * Brings Gecko's stores to the branch, changing only the names whose
   * choices changed.
   */
  _apply() {
    const rules = this.rules();
    const previous = this._applied;
    // Each origin is decided from the rules as they now are.
    this._applied = rules;
    const names = new Set([...previous.keys(), ...rules.keys()]);
    for (const name of names) {
      const before = previous.get(name) ?? {};
      const after = rules.get(name) ?? {};
      if (
        before.protections !== after.protections ||
        before.media !== after.media ||
        before.insecure !== after.insecure
      ) {
        this._applyName(name, before, after, null);
      }
    }
    this._writeFingerprinting();
    this._followRedirects();
    Services.obs.notifyObservers(null, APPLIED_TOPIC);
  },

  _followingRedirects: false,

  /**
   * Follows top-level redirects while any choice has a media rule, the only
   * thing `_coverRedirect` acts on, so no request pays for it otherwise.
   */
  _followRedirects() {
    const wanted = [
      ...this._applied.values(),
      ...[...this._private.values()].flatMap(rules => [...rules.values()]),
    ].some(rule => rule.media);
    if (wanted === this._followingRedirects) {
      return;
    }
    this._followingRedirects = wanted;
    if (wanted) {
      Services.obs.addObserver(this, REQUEST_TOPIC);
    } else {
      Services.obs.removeObserver(this, REQUEST_TOPIC);
    }
  },

  /**
   * Writes the permissions of every origin a change to `name`'s rule can
   * reach: its own origins, and each origin under it that holds one. Each
   * takes the rule of the most specific name above it, so an origin under a
   * host with a rule of its own keeps that host's.
   *
   * @param {string} name
   * @param {object} before
   * @param {object} after
   * @param {number|null} session
   */
  _applyName(name, before, after, session) {
    const principals = sitePrincipals(name, session);
    const expire = Ci.nsIPermissionManager.EXPIRE_SESSION;
    const decide = (principal, field) =>
      mostSpecificRule(principal.host, n => this.ruleFor(n, session)[field]);
    if (before.protections !== after.protections) {
      const type = allowListType(session);
      const all = [...principals, ...this._principalsWith(type, name, session)];
      for (const principal of all) {
        const found = decide(principal, "protections");
        if (found?.rule === "off") {
          Services.perms.addFromPrincipal(
            principal,
            type,
            Ci.nsIPermissionManager.ALLOW_ACTION,
            expire
          );
        } else if (found && isHost(found.name)) {
          Services.perms.addFromPrincipal(
            principal,
            type,
            Ci.nsIPermissionManager.DENY_ACTION,
            expire
          );
        } else {
          Services.perms.removeFromPrincipal(principal, type);
        }
      }
    }
    if (session === null && before.insecure !== after.insecure) {
      const http = principals.find(principal => principal.schemeIs("http"));
      if (after.insecure) {
        Services.perms.addFromPrincipal(
          http,
          HTTPS_ONLY_PERMISSION,
          Ci.nsIHttpsOnlyModePermission.LOAD_INSECURE_ALLOW,
          expire
        );
      } else {
        Services.perms.removeFromPrincipal(http, HTTPS_ONLY_PERMISSION);
      }
    }
    if (before.media !== after.media) {
      const covered = this._principalsWith(MEDIA_PERMISSION, name, session);
      for (const principal of [...principals, ...covered]) {
        const found = decide(principal, "media");
        if (found) {
          Services.perms.addFromPrincipal(
            principal,
            MEDIA_PERMISSION,
            mediaAction(found.rule),
            expire
          );
        } else {
          Services.perms.removeFromPrincipal(principal, MEDIA_PERMISSION);
        }
      }
    }
  },

  /**
   * Every web origin on `name` or a name under it holding a permission of
   * `type`, in the same session.
   *
   * @param {string} type
   * @param {string} name A site or a host.
   * @param {number|null} session
   * @returns {nsIPrincipal[]}
   */
  _principalsWith(type, name, session) {
    return Services.perms
      .getAllByTypes([type])
      .map(perm => perm.principal)
      .filter(
        principal =>
          sessionOfPrincipal(principal) === session &&
          !!siteOfPrincipal(principal) &&
          scopeChain(principal.host).includes(name)
      );
  },

  /**
   * Gives an origin the media choice of the most specific name above it, if
   * it lacks it: Gecko matches the media permission to the exact origin, and
   * a choice is for a whole site or host. Called as a top-level page starts
   * to load, before its document exists.
   *
   * @param {nsIPrincipal} principal The page's principal.
   */
  coverOrigin(principal) {
    if (!siteOfPrincipal(principal)) {
      return;
    }
    const media = this.resolvedFor(
      principal.host,
      "media",
      sessionOfPrincipal(principal)
    );
    if (!media) {
      return;
    }
    const action = mediaAction(media);
    if (
      Services.perms.testExactPermissionFromPrincipal(
        principal,
        MEDIA_PERMISSION
      ) !== action
    ) {
      Services.perms.addFromPrincipal(
        principal,
        MEDIA_PERMISSION,
        action,
        Ci.nsIPermissionManager.EXPIRE_SESSION
      );
    }
  },

  /**
   * Covers the origin a top-level page was redirected to as its request goes
   * out, before its document exists. The protection button covers the origin
   * a load starts on at its `STATE_START`, but a redirect in the parent tells
   * no web progress listener (`DocumentLoadListener::AsyncOnChannelRedirect`).
   *
   * @param {nsIChannel} channel
   */
  _coverRedirect(channel) {
    const { loadInfo } = channel;
    if (
      loadInfo.externalContentPolicyType !==
        Ci.nsIContentPolicy.TYPE_DOCUMENT ||
      !loadInfo.isTopLevelLoad ||
      !loadInfo.redirectChainIncludingInternalRedirects.length
    ) {
      return;
    }
    this.coverOrigin(
      Services.scriptSecurityManager.createContentPrincipal(
        channel.URI,
        loadInfo.originAttributes
      )
    );
  },

  /**
   * Takes this module's entries out of `GRANULAR_PREFS`, keeping a person's
   * own.
   */
  _dropSavedEntries() {
    for (const name of GRANULAR_PREFS) {
      const entries = readGranular(name);
      const kept = entries.filter(
        entry => !isOwnEntry(entry, entry?.firstPartyDomain)
      );
      if (kept.length === entries.length) {
        continue;
      }
      if (kept.length) {
        Services.prefs.setStringPref(name, JSON.stringify(kept));
      } else {
        Services.prefs.clearUserPref(name);
      }
    }
  },

  /**
   * Brings the permissions made before this store existed into the branch,
   * once: a site's `trackingprotection` exception as protections off, and
   * its `autoplay-media` ALLOW or DENY as Always allow or Always deny. A
   * choice the pref already holds wins. Only lasting permissions outside
   * private windows count.
   */
  _migrate() {
    if (Services.prefs.getBoolPref(MIGRATED_PREF, false)) {
      return;
    }
    const rules = this.rules();
    const migrated = new Map();
    const perms = Services.perms.getAllByTypes([
      allowListType(null),
      MEDIA_PERMISSION,
    ]);
    for (const perm of perms) {
      if (
        perm.expireType !== Ci.nsIPermissionManager.EXPIRE_NEVER ||
        isPrivatePrincipal(perm.principal)
      ) {
        continue;
      }
      const site = siteOfPrincipal(perm.principal);
      if (!site) {
        continue;
      }
      const rule = { ...rules.get(site) };
      if (
        perm.type === allowListType(null) &&
        perm.capability === Ci.nsIPermissionManager.ALLOW_ACTION &&
        !rule.protections
      ) {
        rule.protections = "off";
      } else if (perm.type === MEDIA_PERMISSION && !rule.media) {
        if (perm.capability === Ci.nsIPermissionManager.ALLOW_ACTION) {
          rule.media = "allow";
        } else if (perm.capability === Ci.nsIPermissionManager.DENY_ACTION) {
          rule.media = "block";
        }
      }
      const clean = cleanRule(rule);
      if (clean && JSON.stringify(clean) !== JSON.stringify(rules.get(site))) {
        rules.set(site, clean);
        migrated.set(site, clean);
      }
    }
    for (const [site, rule] of migrated) {
      storeRule(site, rule);
    }
    Services.prefs.setBoolPref(MIGRATED_PREF, true);
  },

  /**
   * Writes `OVERRIDE_PREFS`: for each site the one entry its rule wants
   * (`overridesFor`). A host holding protections or exceptions of its own
   * gets an entry from its resolved fields, which takes the place of its
   * site's, so it holds the global set (`KEEP_GLOBAL`) where it wants none.
   */
  _writeFingerprinting() {
    const defaults = Services.prefs.getDefaultBranch("");
    for (const pref of OVERRIDE_PREFS) {
      const isBaseline = pref === BASELINE_OVERRIDE_PREF;
      const entries = [];
      for (const [name, own] of this._applied) {
        const host = isHost(name);
        if (host && !own.protections && !own.exceptions) {
          continue;
        }
        const site = scopeChain(name).at(-1);
        const rule = host
          ? {
              protections: this.resolvedFor(name, "protections"),
              exceptions: this.resolvedFor(name, "exceptions"),
            }
          : own;
        let overrides = overridesFor(
          rule,
          this.remoteTokensFor(site, isBaseline)
        );
        if (host) {
          overrides ??= KEEP_GLOBAL;
        }
        if (overrides && this.canWriteFor(site)) {
          entries.push({ firstPartyDomain: name, overrides });
        }
      }
      const text = entries.length ? JSON.stringify(entries) : "";
      if (defaults.getStringPref(pref, "") !== text) {
        defaults.setStringPref(pref, text);
      }
    }
  },

  /** @type {object[]} Mozilla's webcompat entries, as Remote Settings has them. */
  _remote: [],

  /**
   * Mozilla's webcompat tokens for the site's first-party loads, broader
   * scope first, or none while Firefox's remote overrides are off.
   *
   * @param {string} site
   * @param {boolean} isBaseline For the baseline mode's entries.
   * @returns {string[]}
   */
  remoteTokensFor(site, isBaseline) {
    if (!Services.prefs.getBoolPref(REMOTE_OVERRIDES_PREF, true)) {
      return [];
    }
    const of = scope =>
      this._remote
        .filter(
          entry =>
            entry?.firstPartyDomain === site &&
            (entry.thirdPartyDomain ?? "") === scope &&
            !!entry.isBaseline === isBaseline &&
            typeof entry.overrides === "string"
        )
        .flatMap(entry => entry.overrides.split(","));
    return [...of("*"), ...of("")];
  },

  /** Why a site `canWriteFor` turns down has no fingerprinting choices. */
  UNWRITABLE_NOTE:
    "Fingerprinting exceptions work only for named sites, not for an address like this one.",

  /**
   * Whether Gecko would read a granular entry for the site.
   * `GetOverriddenFingerprintingSettingsForURI` looks entries up by the
   * page's base domain from the eTLD service, and finds none for a host that
   * has no base domain: an IP address, `localhost`, a single-label name.
   *
   * @param {string} site
   * @returns {boolean}
   */
  canWriteFor(site) {
    try {
      return Services.eTLD.getBaseDomainFromHost(site) === site;
    } catch {
      return false;
    }
  },

  /**
   * Reads Mozilla's webcompat entries from the local Remote Settings copy,
   * which `FingerprintingWebCompatService` keeps in step, and follows it.
   */
  _followRemote() {
    const rs = lazy.RemoteSettings(REMOTE_COLLECTION);
    const take = entries => {
      this._remote = Array.isArray(entries) ? entries : [];
      this._writeFingerprinting();
    };
    rs.get({ syncIfEmpty: false }).then(take, err =>
      SvalLog.warn(
        `could not read the webcompat overrides: ${SvalLog.errorName(err)}`
      )
    );
    rs.on("sync", ({ data }) => take(data?.current));
  },

  /**
   * The media choice for every site without one of its own, which it gets as
   * if it were its own (protections spec §4.1).
   *
   * @returns {"ask"|"allow"|"block"}
   */
  mediaDefault() {
    const value = Services.prefs.getIntPref(MEDIA_DEFAULT_PREF, 0);
    return (
      Object.keys(MEDIA_DEFAULT_VALUES).find(
        key => MEDIA_DEFAULT_VALUES[key] === value
      ) ?? "ask"
    );
  },

  /** @param {"ask"|"allow"|"block"} value */
  setMediaDefault(value) {
    if (value === "ask") {
      Services.prefs.clearUserPref(MEDIA_DEFAULT_PREF);
    } else {
      Services.prefs.setIntPref(
        MEDIA_DEFAULT_PREF,
        MEDIA_DEFAULT_VALUES[value]
      );
    }
  },
};
