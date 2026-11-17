/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * JavaScript per site: Gecko's `javascript.enabled` is the default, and a
 * site's rule turns it on or off there.
 *
 * Gecko keeps the exceptions itself, in the script security manager's domain
 * policy (`nsIDomainPolicy`): `PolicyAllowsScript` starts from
 * `javascript.enabled` and flips it for a host in the blocklists while it is
 * on, and in the allowlists while it is off. The parent broadcasts every
 * change to the content processes. A global reads the policy once, when it is
 * made (`xpc::Scriptability`), so a rule reaches a page at its next load, and
 * a page with script off parses `<noscript>` as a browser with script off
 * does.
 *
 * A rule is for a site, as `siteOf` cuts one, or for a host under it
 * (decision 1980), and lives in the super lists, so it covers every name
 * under it. Gecko takes the entry of the most specific name in either
 * direction (Sval's `script-policy-most-specific` patch), so a host's rule
 * beats its site's whatever the default. A site that is itself a public
 * suffix, such as `github.io`, has each name under it as a site of its own,
 * so its rule lives in the exact lists and covers that host alone. The lists match a
 * scheme and host, whatever the port (Sval's `domain-policy-hostless-uris`
 * patch), so each site is entered for http and for https. A frame follows its
 * own site's rule, the frame's realm being made with the frame's principal.
 *
 * Each rule is a pref of its own, `SITE_BRANCH` and the site or host,
 * holding `"allow"` or `"block"`. Settings sync carries each as a setting of its own,
 * with `javascript.enabled` itself, so two devices that set rules for
 * different sites both keep them. Both lists hold their rules whatever the
 * default, so a rule keeps its meaning when the default changes.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  SITE_SCHEMES,
  mostSpecificRule,
  scopeChain,
  siteOrigins,
} from "moz-src:///browser/components/sval/SvalSite.sys.mjs";

/** The branch each rule is a pref under, named for its site or host. */
export const SITE_BRANCH = "browser.sval.javascript.site.";
export const ENABLED_PREF = "javascript.enabled";

/** What the rules and their default are read from, to observe. */
export const PREFS = Object.freeze([SITE_BRANCH, ENABLED_PREF]);
/** Notified once the policy holds the rules the branch has. */
export const APPLIED_TOPIC = "sval-javascript-applied";

/**
 * @param {*} rule
 * @returns {boolean} Whether `rule` is one.
 */
function isRule(rule) {
  return rule === "allow" || rule === "block";
}

/**
 * @param {string} site
 * @returns {boolean} Whether the site is itself a public suffix.
 */
function isPublicSuffix(site) {
  try {
    return Services.eTLD.getPublicSuffixFromHost(site) === site;
  } catch {
    return false;
  }
}

/**
 * Drops every tab's back-forward cache. A cached page keeps the global it was
 * made with, so going back to it would bring back script the rules have
 * since turned off, or leave off script they turned on.
 */
function forgetCachedPages() {
  for (const win of Services.wm.getEnumerator("navigator:browser")) {
    for (const browser of win.gBrowser?.browsers ?? []) {
      browser.browsingContext?.sessionHistory?.evictAllDocumentViewers();
    }
  }
}

export const SvalJavascript = {
  ENABLED_PREF,
  PREFS,

  /** @type {nsIDomainPolicy|null} */
  _policy: null,
  /** @type {Map<string, "allow"|"block">} What the policy holds. */
  _applied: new Map(),

  /**
   * Takes the domain policy and fills it from the rules, then follows the
   * pref. Before any page can load: `SvalStartup` runs it before the first
   * window opens. Only one holder of the policy may exist, and Sval is it.
   */
  start() {
    if (this._policy) {
      return;
    }
    try {
      this._policy = Services.scriptSecurityManager.activateDomainPolicy();
    } catch (err) {
      SvalLog.warn(
        `the JavaScript site rules are off: ${SvalLog.errorName(err)}`
      );
      return;
    }
    this._apply();
    Services.prefs.addObserver(SITE_BRANCH, () => this._apply());
    Services.prefs.addObserver(ENABLED_PREF, forgetCachedPages);
  },

  /**
   * @returns {Map<string, "allow"|"block">} Every rule, by the site or host
   *   it is saved under.
   */
  rules() {
    const rules = [];
    for (const name of Services.prefs.getChildList(SITE_BRANCH)) {
      const rule =
        Services.prefs.getPrefType(name) === Ci.nsIPrefBranch.PREF_STRING &&
        Services.prefs.getStringPref(name);
      const site = name.slice(SITE_BRANCH.length);
      if (site && isRule(rule)) {
        rules.push([site, rule]);
      }
    }
    return new Map(rules.sort(([a], [b]) => a.localeCompare(b)));
  },

  /** @returns {boolean} The default every site without a rule follows. */
  defaultEnabled() {
    return Services.prefs.getBoolPref(ENABLED_PREF, true);
  },

  /**
   * @param {string} name A site or a host.
   * @returns {"allow"|"block"|undefined} The rule saved under `name` itself,
   *   as the policy has it.
   */
  ruleFor(name) {
    return this._applied.get(name);
  },

  /**
   * @param {string} host A host or a site, as `scopeOfHost` names it.
   * @returns {boolean} Whether a page of `host` runs script, as the policy
   *   has it: the rule of the most specific name above it, or the default.
   */
  enabledFor(host) {
    const found = mostSpecificRule(host, name => this.ruleFor(name));
    return found ? found.rule === "allow" : this.defaultEnabled();
  },

  /**
   * What `name` gets without a rule of its own: the rule of the nearest name
   * above it, or the default.
   *
   * @param {string} name
   * @returns {boolean}
   */
  inheritedFor(name) {
    const above = scopeChain(name)[1];
    return above === undefined ? this.defaultEnabled() : this.enabledFor(above);
  },

  /**
   * @param {string} name A site or a host.
   * @returns {boolean} Whether `name` has a rule of its own in the policy.
   */
  hasRule(name) {
    return this._applied.has(name);
  },

  /**
   * Turns script on or off for a site or a host. A choice that matches what
   * the name gets without a rule (`inheritedFor`) takes its rule away rather
   * than storing one (host-scoped rules spec §2).
   *
   * @param {string} name
   * @param {boolean} enabled
   */
  setEnabled(name, enabled) {
    if (enabled === this.inheritedFor(name)) {
      this.removeRule(name);
    } else {
      Services.prefs.setStringPref(
        SITE_BRANCH + name,
        enabled ? "allow" : "block"
      );
    }
  },

  /** @param {string} name A site or a host. */
  removeRule(name) {
    Services.prefs.clearUserPref(SITE_BRANCH + name);
  },

  /**
   * Brings the policy's lists to the rules, changing only the sites whose rule
   * changed, so a page loading meanwhile never sees a site without its rule.
   */
  _apply() {
    const policy = this._policy;
    if (!policy) {
      return;
    }
    const listFor = (site, rule) => {
      const exact = isPublicSuffix(site);
      if (rule === "allow") {
        return exact ? policy.allowlist : policy.superAllowlist;
      }
      return exact ? policy.blocklist : policy.superBlocklist;
    };
    const rules = this.rules();
    let changed = false;
    for (const [site, rule] of this._applied) {
      if (rules.get(site) !== rule) {
        changed = true;
        for (const uri of siteOrigins(site, SITE_SCHEMES)) {
          listFor(site, rule).remove(uri);
        }
      }
    }
    for (const [site, rule] of rules) {
      if (this._applied.get(site) !== rule) {
        changed = true;
        for (const uri of siteOrigins(site, SITE_SCHEMES)) {
          listFor(site, rule).add(uri);
        }
      }
    }
    this._applied = rules;
    if (changed) {
      forgetCachedPages();
    }
    Services.obs.notifyObservers(null, APPLIED_TOPIC);
  },
};
