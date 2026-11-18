/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The choices a person makes for one site or one host, as a list: each store
 * that keeps such a choice has one entry here, and whatever asks "what is
 * saved for this name" (the Sites list, a site's page, Reset and its Undo)
 * reads the list.
 *
 * An entry says only what is saved at a name itself. What applies to a page,
 * with what a host takes from its site, is each store's to answer and
 * differs between them (decision 1980).
 */

import {
  SvalSiteProtections,
  SITE_BRANCH as PROTECTION_BRANCH,
  MEDIA_DEFAULT_PREF,
  PRIVATE_TOPIC,
} from "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs";
import {
  SvalJavascript,
  PREFS as JAVASCRIPT_PREFS,
  SITE_BRANCH as JAVASCRIPT_BRANCH,
} from "moz-src:///browser/components/sval/SvalJavascript.sys.mjs";
import {
  SvalExtensionSites,
  SITE_BRANCH as EXTENSION_SITE_BRANCH,
} from "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs";
import {
  STYLES_PREF,
  removeStyles,
  setStyle,
  styles,
} from "moz-src:///browser/components/sval/SvalSiteStyles.sys.mjs";
import {
  appendLines,
  exceptionLine,
  exceptionsInFilters,
  hideAgain,
  linesBySite,
  removeSiteFromLine,
  scopesInFilters,
} from "moz-src:///browser/components/sval/SvalElementRules.sys.mjs";
import { siteOfEntry } from "moz-src:///browser/components/sval/SvalSite.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalBlocking: "moz-src:///browser/components/sval/SvalBlocking.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  permissionsBySite:
    "moz-src:///browser/components/sval/SvalSitePermissionList.sys.mjs",
});

/**
 * Saves My filters, logging a write that fails.
 *
 * @param {string} text
 */
function writeFilters(text) {
  try {
    lazy.SvalBlocking.setMyFilters(text);
  } catch (err) {
    lazy.SvalLog.warn(
      `could not save My filters: ${lazy.SvalLog.errorName(err)}`
    );
  }
}

/**
 * @param {string} name A site or a host.
 * @returns {Array<[string, "off"|"on"]>} The extension switches saved under
 *   `name` itself, by extension id.
 */
function switchesAt(name) {
  return [
    ...SvalExtensionSites.idsOffOn(name).map(id => [id, "off"]),
    ...SvalExtensionSites.idsOnAt(name).map(id => [id, "on"]),
  ];
}

/**
 * One entry per store, in the order Reset clears them and Undo puts them
 * back.
 *
 * - `id` names the entry, and is the key of what `SiteChoiceReading.at`
 *   answers.
 * - `scoped`: whether a host can hold one of its own. The others are the
 *   whole site's.
 * - `private` says what a private window does with it: `"session"` keeps
 *   that window's own, which end with it, `"stored"` shows the stored ones
 *   and changes none, and `"off"` shows none, the feature being off there.
 * - `prefs` and `topics`: what changes when a choice of its kind may have.
 *   Left out where the reader has to look at the notification itself.
 * - `siteBranch`: the pref branch it keeps a pref per name under, where it
 *   keeps one. Those prefs' names are sites, so nothing that leaves the
 *   device names them (`CONTRIBUTING.md` rule 10).
 * - `forget`: the part of Forget this site (`SvalForgetSite.PARTS`) that
 *   takes it.
 * - `read(session)`: every name holding one, with what it holds, as a Map.
 * - `count(own)`: how many choices `own` is, as a site's page counts them.
 * - `taken(own)`: the part of `own` Reset takes, in the form `restore`
 *   reads. Left out where that is `own`.
 * - `clear(name, own, session)` removes it, and `restore(name, taken,
 *   session)` puts it back. An entry with no `restore` is one Undo cannot
 *   bring back, so Reset leaves it to its caller.
 * - `reload(name)`: loads the name's tabs again, where a change shows only
 *   in a page loaded after it. Reset and Undo do, and Forget this site does
 *   not: a page loading as its site's data is cleared can store it again.
 */
const CHOICES = Object.freeze([
  {
    id: "protections",
    scoped: true,
    private: "session",
    siteBranch: PROTECTION_BRANCH,
    // Its fingerprinting exceptions are a part of their own, `exceptions`.
    forget: "choices",
    prefs: [PROTECTION_BRANCH, MEDIA_DEFAULT_PREF],
    topics: [PRIVATE_TOPIC],
    read: session => SvalSiteProtections.rules(session),
    count: rule =>
      Number(!!rule.protections) +
      Number(!!rule.media) +
      (rule.exceptions?.length ?? 0),
    clear: (name, own, session) =>
      SvalSiteProtections.setRule(name, null, session),
    restore: (name, rule, session) =>
      SvalSiteProtections.setRule(name, rule, session),
  },
  {
    id: "javascript",
    scoped: true,
    private: "stored",
    siteBranch: JAVASCRIPT_BRANCH,
    forget: "choices",
    prefs: JAVASCRIPT_PREFS,
    read: () => SvalJavascript.rules(),
    count: () => 1,
    clear: name => SvalJavascript.removeRule(name),
    restore: (name, rule) => SvalJavascript.setEnabled(name, rule === "allow"),
  },
  {
    id: "style",
    scoped: true,
    private: "off",
    forget: "choices",
    prefs: [STYLES_PREF],
    read: () =>
      new Map(styles().map(({ scope, ...values }) => [scope, values])),
    count: () => 1,
    clear: name => removeStyles([name]),
    restore: (name, values) => setStyle(name, values),
  },
  {
    id: "permissions",
    scoped: false,
    private: "stored",
    forget: "permissions",
    read: () => lazy.permissionsBySite(),
    count: permissions => permissions.length,
    // A permission the defaults file grants is no choice to reset.
    taken: permissions =>
      permissions
        .filter(perm => !perm.isDefault)
        .map(perm => ({
          principal: perm.principal,
          type: perm.type,
          capability: perm.capability,
          expireType: perm.expireType,
          expireTime: perm.expireTime,
        })),
    clear(name, permissions) {
      for (const perm of permissions) {
        if (!perm.isDefault) {
          Services.perms.removePermission(perm);
        }
      }
    },
    restore(name, permissions) {
      for (const perm of permissions) {
        Services.perms.addFromPrincipal(
          perm.principal,
          perm.type,
          perm.capability,
          perm.expireType,
          perm.expireTime
        );
      }
    },
  },
  {
    id: "switches",
    scoped: true,
    private: "stored",
    siteBranch: EXTENSION_SITE_BRANCH,
    forget: "choices",
    prefs: [EXTENSION_SITE_BRANCH],
    read: () =>
      new Map(SvalExtensionSites.names().map(name => [name, switchesAt(name)])),
    count: switches => switches.length,
    clear: name => SvalExtensionSites.removeAll(name),
    // Undo follows a Reset of this name alone, so each switch differs from
    // what the name inherits as it did, and `setOff` keeps it.
    restore(name, switches) {
      for (const [id, state] of switches) {
        SvalExtensionSites.setOff(id, name, state === "off").catch(err =>
          lazy.SvalLog.warn(
            `an extension's site switch did not apply: ${lazy.SvalLog.errorName(err)}`
          )
        );
      }
    },
    // Each tab of the name loads again, as after a switch on the site's
    // page, so an extension's scripts go or run there.
    reload: name => SvalExtensionSites.reloadSite(name),
  },
  {
    // The lines in My filters that hide an element or block a request on
    // the name, newest first.
    id: "removed",
    scoped: true,
    private: "stored",
    forget: "hiddenLines",
    read() {
      const text = lazy.SvalBlocking.myFilters;
      const byName = new Map(scopesInFilters(text).map(name => [name, []]));
      for (const lines of linesBySite(text).values()) {
        for (const line of lines) {
          byName.get(line.scope)?.push(line);
        }
      }
      return byName;
    },
    count: lines => lines.length,
    /**
     * Takes the name out of each line saved for it, leaving the lines of the
     * hosts under a site and of the site above a host.
     *
     * @param {string} name
     * @param {Array<{index: number}>} lines
     * @throws As `SvalBlocking.setMyFilters` does, with nothing written.
     */
    clear(name, lines) {
      let text = lazy.SvalBlocking.myFilters;
      // Newest first is last in the text first, so each edit leaves the
      // index of the next one where it was.
      for (const { index } of lines) {
        text = removeSiteFromLine(text, index, name);
      }
      lazy.SvalBlocking.setMyFilters(text);
    },
  },
  {
    // The selectors a `#@#` line shows again on a host, under a line hiding
    // the element on its site. A choice of the host it names alone.
    id: "shown",
    scoped: true,
    private: "stored",
    forget: "hiddenLines",
    read: () =>
      new Map(
        [...exceptionsInFilters(lazy.SvalBlocking.myFilters)].filter(
          ([name]) => siteOfEntry(name).site !== name
        )
      ),
    count: selectors => selectors.length,
    clear(name, selectors) {
      let text = lazy.SvalBlocking.myFilters;
      for (const selector of selectors) {
        text = hideAgain(text, [name], selector) ?? text;
      }
      writeFilters(text);
    },
    restore(name, selectors) {
      writeFilters(
        appendLines(
          lazy.SvalBlocking.myFilters,
          selectors.map(selector => exceptionLine(name, selector))
        )
      );
    },
  },
]);

/**
 * @param {object} choice
 * @param {?number} session
 * @returns {boolean} Whether a window of `session` shows the choice.
 */
function shows(choice, session) {
  return session === null || choice.private !== "off";
}

/**
 * @param {object} choice
 * @param {?number} session
 * @returns {boolean} Whether a window of `session` may change the choice.
 */
function changes(choice, session) {
  return session === null || choice.private === "session";
}

/**
 * @param {*} part
 * @returns {boolean} Whether `part` holds nothing.
 */
function isEmpty(part) {
  if (part === null || part === undefined) {
    return true;
  }
  if (Array.isArray(part)) {
    return !part.length;
  }
  return typeof part === "object" && !Object.keys(part).length;
}

/** Every store as it stood at one moment, by name. */
class SiteChoiceReading {
  #byId;

  /** @param {Map<string, Map<string, *>>} byId Each entry's `read`. */
  constructor(byId) {
    this.#byId = byId;
  }

  /** @returns {Set<string>} Every name holding a choice. */
  names() {
    return new Set(
      [...this.#byId.values()].flatMap(byName => [...byName.keys()])
    );
  }

  /**
   * @param {string} name A site or a host.
   * @returns {object} What is saved at `name` itself, by entry id. An entry
   *   holding nothing there is left out.
   */
  at(name) {
    const own = {};
    for (const [id, byName] of this.#byId) {
      const part = byName.get(name);
      if (!isEmpty(part)) {
        own[id] = part;
      }
    }
    return own;
  }
}

export const SvalSiteChoices = {
  CHOICES,

  /** The prefs a reader watches to follow the choices. */
  get PREFS() {
    return CHOICES.flatMap(choice => choice.prefs ?? []);
  },

  /** The pref branches whose prefs are each named for a site. */
  get SITE_BRANCHES() {
    return CHOICES.flatMap(choice => choice.siteBranch ?? []);
  },

  /** The topics a reader watches to follow the choices. */
  get TOPICS() {
    return CHOICES.flatMap(choice => choice.topics ?? []);
  },

  /**
   * @param {?number} [session] The private session of the window asking
   *   (`SvalPrivateJars.sessionOf`), or null for the stored choices.
   * @param {object} [which]
   * @param {boolean} [which.scoped] Only the entries a host can hold, which
   *   are the ones a site's page counts.
   * @returns {SiteChoiceReading}
   */
  read(session = null, { scoped = false } = {}) {
    return new SiteChoiceReading(
      new Map(
        CHOICES.filter(
          choice => shows(choice, session) && (!scoped || choice.scoped)
        ).map(choice => [choice.id, choice.read(session)])
      )
    );
  },

  /**
   * @param {object} own From `SiteChoiceReading.at`.
   * @returns {number} How many choices that is.
   */
  count(own) {
    return CHOICES.reduce(
      (sum, choice) =>
        sum + (choice.id in own ? choice.count(own[choice.id]) : 0),
      0
    );
  },

  /**
   * @param {object} own From `SiteChoiceReading.at`.
   * @param {?number} [session]
   * @returns {boolean} Whether a window of `session` has anything to reset
   *   there.
   */
  resettable(own, session = null) {
    return CHOICES.some(
      choice =>
        choice.id in own &&
        changes(choice, session) &&
        !isEmpty(choice.taken?.(own[choice.id]) ?? own[choice.id])
    );
  },

  /**
   * Removes the one entry's choice saved at `name`.
   *
   * @param {string} id
   * @param {string} name
   * @param {?number} [session]
   * @throws What the entry's store throws for a write it refuses.
   */
  clear(id, name, session = null) {
    const choice = CHOICES.find(entry => entry.id === id);
    const own = choice.read(session).get(name);
    if (!isEmpty(own)) {
      choice.clear(name, own, session);
    }
  },

  /**
   * Puts a site's or a host's choices back to the defaults: every choice
   * Undo can bring back that a window of `session` may change.
   *
   * @param {string} name
   * @param {?number} [session]
   * @returns {{name: string, taken: object}} What `restore` needs.
   */
  reset(name, session = null) {
    const own = this.read(session).at(name);
    const taken = {};
    for (const choice of CHOICES) {
      if (!choice.restore || !(choice.id in own) || !changes(choice, session)) {
        continue;
      }
      const part = choice.taken?.(own[choice.id]) ?? own[choice.id];
      if (!isEmpty(part)) {
        choice.clear(name, own[choice.id], session);
        choice.reload?.(name);
        taken[choice.id] = part;
      }
    }
    return { name, taken };
  },

  /**
   * Puts back what `reset` took.
   *
   * @param {{name: string, taken: object}} was From `reset`.
   * @param {?number} [session]
   */
  restore({ name, taken }, session = null) {
    for (const choice of CHOICES) {
      if (choice.id in taken) {
        choice.restore(name, taken[choice.id], session);
        choice.reload?.(name);
      }
    }
  },
};
