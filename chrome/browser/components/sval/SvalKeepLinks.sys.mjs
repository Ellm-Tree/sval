/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Keep links in this tab: on a site with the rule on, a link to another of
 * the site's pages that asks for a new tab or window loads in the tab it is
 * in.
 *
 * A rule is for a site, as `siteOf` cuts one, or for a host under it.
 * Each is a pref of its own, `SITE_BRANCH` and the site or
 * host, holding `"on"` or `"off"`, and settings sync carries each as a
 * setting of its own. A name without a rule takes the rule of the nearest
 * name above it, and a site without one has the rule off.
 *
 * Gecko decides in the content process, as a page asks for the tab
 * (`SvalKeepsLinkInTab`), from the site this module sets on the tab's top
 * browsing context (`svalKeepLinksSite`): as each top document asks for its
 * page rules (`SvalPageRulesParent`), and in every open tab when a rule
 * changes. A content process cannot read the rules themselves: Gecko keeps
 * string prefs without a default value out of web content processes
 * (`ShouldSanitizePreference`).
 */

import {
  mostSpecificRule,
  scopeChain,
  scopeOf,
} from "moz-src:///browser/components/sval/SvalSite.sys.mjs";

/** The branch each rule is a pref under, named for its site or host. */
export const SITE_BRANCH = "browser.sval.keepLinks.site.";

/** What the rules are read from, to observe. */
export const PREFS = Object.freeze([SITE_BRANCH]);

/**
 * @param {*} rule
 * @returns {boolean} Whether `rule` is one.
 */
function isRule(rule) {
  return rule === "on" || rule === "off";
}

/**
 * @param {nsIURI} uri
 * @returns {boolean}
 */
function isWeb(uri) {
  return !!uri && (uri.schemeIs("http") || uri.schemeIs("https"));
}

let watching = false;

export const SvalKeepLinks = {
  PREFS,

  /**
   * @returns {Map<string, "on"|"off">} Every rule, by the site or host it is
   *   saved under.
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

  /**
   * @param {string} name A site or a host.
   * @returns {"on"|"off"|undefined} The rule saved under `name` itself.
   */
  ruleFor(name) {
    const pref = SITE_BRANCH + name;
    const rule =
      Services.prefs.getPrefType(pref) === Ci.nsIPrefBranch.PREF_STRING &&
      Services.prefs.getStringPref(pref);
    return isRule(rule) ? rule : undefined;
  },

  /**
   * @param {string} name A site or a host.
   * @returns {boolean} Whether `name` has a rule of its own.
   */
  hasRule(name) {
    return this.ruleFor(name) !== undefined;
  },

  /**
   * @param {string} host A host or a site, as `scopeOfHost` names it.
   * @returns {boolean} Whether the rule is on for a page of `host`: the rule
   *   of the most specific name above it, off where none has one.
   */
  onFor(host) {
    return mostSpecificRule(host, name => this.ruleFor(name))?.rule === "on";
  },

  /**
   * What `name` gets without a rule of its own: the rule of the nearest name
   * above it, or off.
   *
   * @param {string} name
   * @returns {boolean}
   */
  inheritedFor(name) {
    const above = scopeChain(name)[1];
    return above !== undefined && this.onFor(above);
  },

  /**
   * Turns the rule on or off for a site or a host. A choice that matches what
   * the name gets without a rule takes its rule away rather than storing one
   * (host-scoped rules spec §2).
   *
   * @param {string} name
   * @param {boolean} on
   */
  setOn(name, on) {
    if (on === this.inheritedFor(name)) {
      this.removeRule(name);
    } else {
      Services.prefs.setStringPref(SITE_BRANCH + name, on ? "on" : "off");
    }
  },

  /** @param {string} name A site or a host. */
  removeRule(name) {
    Services.prefs.clearUserPref(SITE_BRANCH + name);
  },

  /**
   * Gives a tab's top browsing context the site whose links it keeps, for the
   * top document at `uri`, or none.
   *
   * @param {CanonicalBrowsingContext} context A tab's top one.
   * @param {?nsIURI} uri Its top document's address.
   */
  applyTo(context, uri) {
    const scope = isWeb(uri) ? scopeOf(uri.spec) : null;
    const site = scope && this.onFor(scope.host) ? scope.site : "";
    if (context.svalKeepLinksSite !== site) {
      context.svalKeepLinksSite = site;
    }
  },

  /**
   * Follows the rules, from this device or a synced one, into every open
   * tab. Runs once, as the first window starts.
   */
  start() {
    if (watching) {
      return;
    }
    watching = true;
    Services.prefs.addObserver(SITE_BRANCH, () => {
      for (const win of Services.wm.getEnumerator("navigator:browser")) {
        for (const browser of win.gBrowser?.browsers ?? []) {
          if (browser.browsingContext) {
            this.applyTo(browser.browsingContext, browser.currentURI);
          }
        }
      }
    });
  },
};
