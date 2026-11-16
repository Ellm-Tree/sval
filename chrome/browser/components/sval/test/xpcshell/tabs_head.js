/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { makeTempDir, tempPath } = ChromeUtils.importESModule(
  "resource://testing-common/SvalTestTemp.sys.mjs"
).SvalTestTemp;

/**
 * Fake tabs, a fake window and a fake adapter for driving `SvalTabs` without a
 * chrome window. Shared by `test_sval_tabs.js` and `test_sval_private.js`.
 */

const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalLocalSettings } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
);
const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { TestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/TestUtils.sys.mjs"
);

/** One fake tab: a label, a URL, and whatever the adapter tagged it with. */
class FakeTab {
  constructor(label, url) {
    this.label = label;
    this.url = url;
    this.values = new Map();
    // Stands in for "`about:blank` with no history". The real adapter asks
    // the browser's address and its history, and neither
    // exists here, so the fixture states the answer instead of deriving it.
    this.blank = false;
  }
}

/**
 * A fake window whose tab strip is a plain array and whose event target
 * records listeners, so a test can dispatch `TabOpen` and friends by hand.
 */
class FakeWindow {
  constructor() {
    this.tabs = [];
    this.listeners = new Map();
    this.navigationWatchers = new Set();
    this.titleWatchers = new Set();
    this.closingWatchers = new Set();
    this.selected = null;
    this.closedByPanel = [];
    this.gBrowser = { tabs: this.tabs, tabContainer: this };
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type).add(handler);
  }

  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }

  dispatch(type, tab, detail = {}) {
    for (const handler of this.listeners.get(type) ?? []) {
      handler.handleEvent({ type, target: tab, detail });
    }
  }

  /**
   * Appends a tab at `index` and fires `TabOpen`, the way tabbrowser does.
   *
   * @param {string} label The tab's label.
   * @param {string} url The tab's URL.
   * @param {number} [index] Where in the strip it lands.
   */
  openTab(label, url, index = this.tabs.length) {
    const tab = new FakeTab(label, url);
    this.tabs.splice(index, 0, tab);
    this.dispatch("TabOpen", tab);
    return tab;
  }

  closeTab(tab, detail = {}) {
    this.tabs.splice(this.tabs.indexOf(tab), 1);
    // The window's capturing listeners run first, as in a real window.
    for (const onClosing of this.closingWatchers) {
      onClosing({ type: "TabClose", target: tab, detail });
    }
    this.dispatch("TabClose", tab, detail);
  }

  /**
   * Commits a page in `tab`, the way a click on a link or a redirect does:
   * the tab shows the address, and the adapter's navigation watcher fires
   * with it and the page's title, empty until the page sets one.
   *
   * @param {object} tab The tab that moved.
   * @param {string} url Where it moved to.
   * @param {string} [title] The committed page's title.
   */
  navigate(tab, url, title = "") {
    tab.url = url;
    for (const watcher of this.navigationWatchers) {
      watcher(tab, url, title);
    }
  }

  /**
   * Sets the title of `tab`'s committed page, which in a real window arrives
   * as `pagetitlechanged` once the page answers, long after `TabOpen`.
   * Firefox labels the tab with it.
   *
   * @param {object} tab The tab whose title arrived.
   * @param {string} label The title.
   */
  retitle(tab, label) {
    tab.label = label;
    for (const watcher of this.titleWatchers) {
      watcher(tab, label);
    }
    this.dispatch("TabAttrModified", tab, { changed: ["label"] });
  }

  /**
   * Gives `tab` a label that is not its page's title, as tabbrowser labels a
   * tab with its address while a page has none yet, or with the title a
   * restore remembers (`setTabTitle`).
   *
   * @param {object} tab The tab.
   * @param {string} label What it shows as its label.
   */
  relabel(tab, label) {
    tab.label = label;
    this.dispatch("TabAttrModified", tab, { changed: ["label"] });
  }

  /**
   * Gives `tab` a favicon, which a real window reports as `TabAttrModified`
   * naming `"image"`.
   *
   * @param {object} tab The tab whose favicon arrived.
   * @param {string} image The favicon's address.
   */
  setIcon(tab, image) {
    tab.image = image;
    this.dispatch("TabAttrModified", tab, { changed: ["image"] });
  }

  /**
   * Starts loading a tab that was restored without loading, which a real
   * window reports as `SSTabRestoring` once `pending` is cleared.
   *
   * @param {object} tab A tab opened `pending`.
   */
  startRestoring(tab) {
    tab.pending = false;
    this.dispatch("SSTabRestoring", tab);
  }
}

const fakeAdapter = {
  nodeId(tab) {
    return tab.values.get(SvalTabs.NODE_ID_KEY) ?? null;
  },
  setNodeId(tab, id) {
    // The real store holds strings only; refusing anything else here is what
    // keeps this fake honest about the constraint.
    Assert.equal(typeof id, "string", "a node id is stored as a string");
    tab.values.set(SvalTabs.NODE_ID_KEY, id);
  },
  name(tab) {
    return tab.label;
  },
  icon(tab) {
    return tab.image ?? null;
  },
  isLoaded(tab) {
    return !tab.pending;
  },
  isBusy(tab) {
    return !!tab.busy;
  },
  openingUrl(tab) {
    return tab.url;
  },
  isBlank(tab) {
    return tab.blank;
  },
  tabsOf(window) {
    return Array.from(window.gBrowser.tabs);
  },
  holds(window, tab) {
    return window.gBrowser.tabs.includes(tab);
  },
  eventTargetOf(window) {
    return window.gBrowser.tabContainer;
  },
  isPrivate() {
    return false;
  },
  watchNavigation(window, onCommitted) {
    window.navigationWatchers.add(onCommitted);
    return () => window.navigationWatchers.delete(onCommitted);
  },
  watchTitles(window, onTitle) {
    window.titleWatchers.add(onTitle);
    return () => window.titleWatchers.delete(onTitle);
  },
  watchClosing(window, onClosing) {
    window.closingWatchers.add(onClosing);
    return () => window.closingWatchers.delete(onClosing);
  },
  formerParent(tab) {
    return tab.values.get("sval-former-parent") ?? null;
  },
  setFormerParent(tab, parent) {
    if (parent) {
      tab.values.set("sval-former-parent", parent);
    } else {
      tab.values.delete("sval-former-parent");
    }
  },
  select(window, tab) {
    window.selected = tab;
  },
  close(window, tab) {
    window.closedByPanel.push(tab);
    window.closeTab(tab);
  },
  // As production's `removeTab(tab, { skipSessionStore: true })`, whose
  // `TabClose` carries the option.
  release(window, tab) {
    window.closeTab(tab, { skipSessionStore: true });
  },
  // The mark that tells a tab carried in from another window from a tab
  // Firefox handed back out of its recently-closed list. Production writes a
  // DOM attribute, because the destination tab can be in a window that has not
  // started its own panel yet; the fake keeps it on the object for the same
  // read-and-clear contract.
  markAdopted(tab) {
    tab.adopted = true;
  },
  takeAdopted(tab) {
    const marked = tab.adopted === true;
    tab.adopted = false;
    return marked;
  },
};
