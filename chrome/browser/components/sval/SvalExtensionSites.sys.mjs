/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Each extension's switch for each site or host (extension controls spec,
 * Part 2; decision 1980): off there, the extension reaches nothing in a tab
 * showing a page of it. A site is `siteOf`'s, and a host rule covers the
 * names under it. The switches are one synced pref per site or host holding
 * a sorted list: the id of each extension off there, and `~id` for one on
 * there under a name above it that holds it off. A name with none has no
 * pref. An id stays when its extension is removed, so a reinstall, or
 * another device that installs it, finds its switches. Each running
 * extension's policy holds its names, `~name` for one it runs on
 * (`WebExtensionPolicy.blockedSites`), and Gecko takes the entry of the most
 * specific name above the tab's top-level host.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  Management: "resource://gre/modules/Extension.sys.mjs",
  mostSpecificRule:
    "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs",
  scopeChain: "moz-src:///browser/components/sval/SvalAgentPolicy.sys.mjs",
});

export const SITE_BRANCH = "browser.sval.extensions.offOn.";

/** Marks an entry, in a pref's list and in a policy's names, as "on". */
const ON = "~";

/**
 * @param {string} name A site or a host.
 * @returns {string[]} The entries saved under `name`: ids, and `~id`s; none
 *   for a value that is not a list of strings.
 */
function readEntries(name) {
  try {
    const entries = JSON.parse(
      Services.prefs.getStringPref(SITE_BRANCH + name, "")
    );
    if (
      Array.isArray(entries) &&
      entries.every(entry => typeof entry === "string")
    ) {
      return entries;
    }
  } catch {}
  return [];
}

/** @returns {string[]} Every site and host with a switch saved. */
function names() {
  return Services.prefs
    .getChildList(SITE_BRANCH)
    .map(name => name.slice(SITE_BRANCH.length));
}

/** The latest hand-over to each extension, settled once every process has it. */
const pending = new Map();

/**
 * Hands `policy` its sites, in this process and every content process
 * (`Extension.updateBlockedSites`), unless it holds them already: each
 * hand-over sends the extension's data to every process.
 *
 * @param {WebExtensionPolicy} policy
 */
function apply(policy) {
  const blocked = SvalExtensionSites.blockedSitesFor(policy.id);
  const held = [...(policy.blockedSites ?? [])].sort();
  if (
    held.length === blocked.length &&
    held.every((site, i) => site === blocked[i])
  ) {
    return;
  }
  pending.set(
    policy.id,
    policy.extension?.updateBlockedSites
      ? policy.extension.updateBlockedSites(blocked)
      : Promise.resolve((policy.blockedSites = blocked))
  );
}

function applyAll() {
  for (const policy of WebExtensionPolicy.getActiveExtensions()) {
    apply(policy);
  }
}

let started = false;

export const SvalExtensionSites = {
  /**
   * @param {string} id
   * @param {string} name A site or a host.
   * @returns {"off"|"on"|undefined} The switch saved under `name` itself.
   */
  ruleFor(id, name) {
    const entries = readEntries(name);
    if (entries.includes(id)) {
      return "off";
    }
    return entries.includes(ON + id) ? "on" : undefined;
  },

  /**
   * @param {string} id
   * @param {string} host A host or a site, as `scopeOfHost` names it.
   * @returns {boolean} Whether `id` is off on `host`: the switch of the most
   *   specific name above it, on where none has one.
   */
  isOff(id, host) {
    return (
      lazy.mostSpecificRule(host, name => this.ruleFor(id, name))?.rule ===
      "off"
    );
  },

  /**
   * @param {string} id
   * @param {string} name
   * @returns {boolean} Whether `id` is off on `name` without a switch of its
   *   own: as the nearest name above it has it.
   */
  inheritedOff(id, name) {
    const above = lazy.scopeChain(name)[1];
    return above !== undefined && this.isOff(id, above);
  },

  /**
   * Turns `id` off or on for a site or a host. A choice that matches what
   * the name gets without a switch (`inheritedOff`) takes its switch away
   * (host-scoped rules spec §2).
   *
   * @param {string} id
   * @param {string} name
   * @param {boolean} off
   * @returns {Promise<void>} Settles once every process has the change.
   */
  setOff(id, name, off) {
    const entries = new Set(readEntries(name));
    entries.delete(id);
    entries.delete(ON + id);
    if (off !== this.inheritedOff(id, name)) {
      entries.add(off ? id : ON + id);
    }
    if (entries.size) {
      Services.prefs.setStringPref(
        SITE_BRANCH + name,
        JSON.stringify([...entries].sort())
      );
    } else {
      Services.prefs.clearUserPref(SITE_BRANCH + name);
    }
    // The pref's observer has handed the change over by now.
    return Promise.resolve(pending.get(id)).then(() => {});
  },

  /**
   * Takes away every switch saved under `name`.
   *
   * @param {string} name
   */
  removeAll(name) {
    Services.prefs.clearUserPref(SITE_BRANCH + name);
  },

  /** @returns {string[]} Every site and host with a switch saved, sorted. */
  names() {
    return names().sort();
  },

  /**
   * @param {string} id
   * @returns {string[]} The sites and hosts `id` is off on by a switch of
   *   their own, sorted.
   */
  sitesOff(id) {
    return names()
      .filter(name => readEntries(name).includes(id))
      .sort();
  },

  /**
   * @param {string} name
   * @returns {string[]} The ids off on `name` by a switch of its own.
   */
  idsOffOn(name) {
    return readEntries(name).filter(entry => !entry.startsWith(ON));
  },

  /**
   * @param {string} name
   * @returns {string[]} The ids on at `name` by a switch of its own, under a
   *   name above that holds them off.
   */
  idsOnAt(name) {
    return readEntries(name)
      .filter(entry => entry.startsWith(ON))
      .map(entry => entry.slice(ON.length));
  },

  /**
   * @param {string} id
   * @returns {string[]} The names the extension's policy holds, sorted: each
   *   name it is off on, and `~name` for each it is on at.
   */
  blockedSitesFor(id) {
    const held = [];
    for (const name of names()) {
      const rule = this.ruleFor(id, name);
      if (rule) {
        held.push(rule === "off" ? name : ON + name);
      }
    }
    return held.sort();
  },

  /**
   * Reloads every tab of every browser window whose page is on `name` or a
   * name under it, so scripts an extension put there go and scripts it may
   * now put there run.
   *
   * @param {string} name A site or a host.
   */
  reloadSite(name) {
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      for (const tab of win.gBrowser.tabs) {
        // A tab not yet loaded loads afresh when it is selected.
        if (!tab.linkedPanel) {
          continue;
        }
        let host = "";
        try {
          host = tab.linkedBrowser.currentURI.host;
        } catch {}
        if (host && lazy.scopeChain(host).includes(name)) {
          win.gBrowser.reloadTab(tab);
        }
      }
    }
  },

  /** Keeps every running extension's policy holding its sites. Idempotent. */
  start() {
    if (started) {
      return;
    }
    started = true;
    Services.prefs.addObserver(SITE_BRANCH, applyAll);
    lazy.Management.on("ready", (_kind, extension) => apply(extension.policy));
    applyAll();
  },
};
