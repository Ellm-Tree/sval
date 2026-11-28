/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The pages of one window's pins (pins spec §5).
 *
 * A pin's page is a real tab of the window, marked (`SvalPinTab`) so no tree
 * node describes it and the tab observer leaves it alone, and hidden from
 * everything that walks the window's visible tabs (`gBrowser.hideTab`). A
 * hidden tab can still be the selected one, so selecting a pin is selecting
 * its tab and the content area, toolbar and history work on it as on any
 * tab.
 *
 * A page belongs to its pin and to the workspace it was opened in, keyed by
 * both, so Gmail in Work and Gmail in Home are two pages in two jars. Which
 * pins exist and where they show is never read from the pages: the row asks
 * the favorites document, and hands this the pin it selected.
 *
 * - **Selecting** shows the pin's page, opening it at the saved address when
 *   it has none. It never navigates a page it already has.
 * - **Leaving a workspace** leaves its pages loaded as a switch leaves its
 *   tabs (spec §10.7), until the workspace has been out of sight for
 *   `hiddenWorkspaceUnloadMs()`: then each is discarded, keeping its place
 *   and its history, and one Firefox will not discard (typed text, a call)
 *   or one playing sound stays loaded. Coming back, or launching, shows the
 *   pin looked at after every tab (`onViewed`), as a tab's last-active time
 *   decides among tabs.
 * - **Closing** a page, or Firefox unloading it under memory pressure
 *   (`TabUnloader`), forgets it, so the next selection starts at the saved
 *   address. That is the only automatic reset (§3).
 *
 * The saved page (§5) is where a fresh load of the saved address settles: the
 * page follows its own redirects until the user first touches it, which its
 * actor reports (`SvalPinParent`). Off the saved page is a page the user has
 * touched showing anything else.
 *
 * **Names and addresses are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { SvalFirefox } from "moz-src:///browser/components/sval/SvalFirefox.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import { SvalClock } from "moz-src:///browser/components/sval/SvalClock.sys.mjs";
import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";
import {
  hiddenWorkspaceUnloadMs,
  PAGE_ANSWER_MS,
} from "moz-src:///browser/components/sval/SvalTabs.sys.mjs";
import {
  isPin,
  markPin,
  pinGuidOf,
  unmarkPin,
} from "moz-src:///browser/components/sval/SvalPinTab.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalPins: "moz-src:///browser/components/sval/SvalPins.sys.mjs",
});

/** window -> its pages. */
const byWindow = new WeakMap();

/** How often the window looks for pages hidden long enough to unload. */
const IDLE_SWEEP_MS = 10 * 60 * 1000;

const TAB_EVENTS = [
  "TabSelect",
  "TabClose",
  "TabAttrModified",
  "TabBrowserDiscarded",
];

/**
 * One window's pin pages.
 */
export class SvalPinPages {
  #window;
  #workspaceId;
  #jar;
  #onChange;
  #onViewed;

  /** `${workspaceId}\n${guid}` -> the page. */
  #pages = new Map();

  /** tab -> its page. */
  #byTab = new WeakMap();

  /** Whether this is unloading a page itself, which is no reset. */
  #parking = false;

  /** The next {@link parkIdle}, or null once stopped. */
  #idleTimer = null;

  #progress = {
    onLocationChange: (browser, webProgress) => {
      if (webProgress?.isTopLevel) {
        this.#moved(browser);
      }
    },
  };

  /**
   * @param {Window} window A browser window.
   * @param {object} options
   * @param {() => string|null} options.workspaceId The workspace the window
   *   shows.
   * @param {() => number} options.jar The `userContextId` its tabs open in.
   * @param {Function} options.onChange Called whenever what the row draws of
   *   a page may have changed: selection, load, title, place, sound.
   * @param {Function} [options.onViewed] Called with `(workspaceId, guid)`
   *   whenever a pin's page is selected.
   */
  constructor(window, options) {
    this.#window = window;
    this.bind(options);
    for (const type of TAB_EVENTS) {
      window.gBrowser.tabContainer.addEventListener(type, this);
    }
    window.gBrowser.addTabsProgressListener(this.#progress);
    window.addEventListener("unload", () => this.stop(), { once: true });
    byWindow.set(window, this);
    this.#scheduleIdleSweep();
  }

  /** Runs {@link parkIdle} every {@link IDLE_SWEEP_MS} until stopped. */
  #scheduleIdleSweep() {
    this.#idleTimer = setTimeout(() => {
      this.parkIdle()
        .catch(err =>
          SvalLog.warn(
            `a pin's page was not unloaded: ${SvalLog.errorName(err)}`
          )
        )
        .finally(() => {
          if (this.#idleTimer !== null) {
            this.#scheduleIdleSweep();
          }
        });
    }, IDLE_SWEEP_MS);
  }

  /**
   * The window's pages, made the first time they are asked for, and bound to
   * `options` (see the constructor). The panel's row is built again when the
   * panel is, and the pages it had stay the window's.
   *
   * @param {Window} window
   * @param {object} options
   * @returns {SvalPinPages}
   */
  static for(window, options) {
    const pages = byWindow.get(window);
    if (pages) {
      pages.bind(options);
      return pages;
    }
    return new SvalPinPages(window, options);
  }

  /**
   * @param {object} options As the constructor takes them.
   * @param {Function} options.workspaceId
   * @param {Function} options.jar
   * @param {Function} options.onChange
   * @param {Function} [options.onViewed]
   */
  bind({ workspaceId, jar, onChange, onViewed }) {
    this.#workspaceId = workspaceId;
    this.#jar = jar;
    this.#onChange = onChange;
    this.#onViewed = onViewed;
  }

  /** Stops listening. The pages go with the window. */
  stop() {
    clearTimeout(this.#idleTimer);
    this.#idleTimer = null;
    const { gBrowser } = this.#window;
    for (const type of TAB_EVENTS) {
      gBrowser?.tabContainer.removeEventListener(type, this);
    }
    gBrowser?.removeTabsProgressListener(this.#progress);
    if (byWindow.get(this.#window) === this) {
      byWindow.delete(this.#window);
    }
  }

  /**
   * The pages of `window`, or null.
   *
   * @param {Window} window
   * @returns {SvalPinPages|null}
   */
  static of(window) {
    return byWindow.get(window) ?? null;
  }

  /**
   * The page a pin's tab belongs to, in whichever window it is.
   *
   * @param {object} tab A Firefox tab.
   * @returns {object|null} `{ guid, url, name, savedPage, touched }`.
   */
  static pageOfTab(tab) {
    const pages = byWindow.get(tab?.documentGlobal);
    return pages?.#byTab.get(tab) ?? null;
  }

  #key(guid, workspaceId = this.#workspaceId()) {
    return `${workspaceId}\n${guid}`;
  }

  /** @returns {string|null} the guid of the pin whose page is selected. */
  get selectedGuid() {
    const tab = this.#window.gBrowser.selectedTab;
    return isPin(tab) && this.#byTab.has(tab) ? pinGuidOf(tab) : null;
  }

  /**
   * The tab of the pin's page in the workspace the window shows, or null.
   *
   * @param {string} guid
   * @returns {object|null}
   */
  tabOf(guid) {
    const page = this.#pages.get(this.#key(guid));
    return page && !page.tab.closing ? page.tab : null;
  }

  /**
   * What the row draws of the pin's page (§12.3), or null when it has none.
   *
   * @param {string} guid
   * @returns {object|null} `{ loaded, off, title, playing, muted,
   *   attention }`.
   */
  stateOf(guid) {
    const page = this.#pages.get(this.#key(guid));
    if (!page || page.tab.closing) {
      return null;
    }
    const { tab } = page;
    const loaded =
      !SvalFirefox.isLazy(tab) &&
      !tab.hasAttribute("pending") &&
      !tab.hasAttribute("discarded");
    return {
      loaded,
      off: this.#isOff(page),
      title: tab._labelIsContentTitle ? tab.label : "",
      playing: tab.hasAttribute("soundplaying"),
      muted: tab.hasAttribute("muted"),
      attention: tab.hasAttribute("attention"),
    };
  }

  /**
   * Whether the pin's page shows something other than its saved page.
   *
   * @param {object} page
   * @returns {boolean}
   */
  #isOff(page) {
    if (!page.touched || !page.savedPage) {
      return false;
    }
    const spec = SvalFirefox.isLazy(page.tab)
      ? SvalFirefox.lazyUrl(page.tab)
      : page.tab.linkedBrowser?.currentURI?.spec;
    return !!spec && spec !== page.savedPage;
  }

  /**
   * Shows the pin's page, opening it at its saved address when it has none
   * in this workspace (§5). A page that is there is shown as it is.
   *
   * @param {object} pin `{ guid, url, name }` from the favorites document.
   * @returns {object|null} its tab.
   */
  select(pin) {
    const { gBrowser } = this.#window;
    let page = this.#pages.get(this.#key(pin.guid));
    // A workspace isolated or shared since keeps its pages in no jar of its
    // own; the pin starts again in the jar its tabs use.
    if (page && page.tab.userContextId !== this.#jar()) {
      this.#close(page);
      page = null;
    }
    page ??= this.#open(pin);
    if (!page) {
      return null;
    }
    page.name = pin.name;
    gBrowser.selectedTab = page.tab;
    return page.tab;
  }

  /**
   * Opens the pin's page in the background, marked as it opens, hidden.
   *
   * @param {object} pin
   * @returns {object|null} the page.
   */
  #open(pin) {
    const win = this.#window;
    const { gBrowser } = win;
    const mark = event => markPin(event.target, pin.guid);
    win.addEventListener("TabOpen", mark, { capture: true });
    let tab;
    try {
      tab = gBrowser.addTrustedTab(pin.url, {
        inBackground: true,
        skipAnimation: true,
        userContextId: this.#jar(),
      });
    } catch (err) {
      SvalLog.warn(`a pin's page did not open: ${SvalLog.errorName(err)}`);
      return null;
    } finally {
      win.removeEventListener("TabOpen", mark, { capture: true });
    }
    if (!tab || !isPin(tab)) {
      return null;
    }
    gBrowser.hideTab(tab);
    return this.#adopt(tab, pin, { fresh: true });
  }

  /**
   * Records `tab`, already marked, as the pin's page in this workspace.
   *
   * @param {object} tab
   * @param {object} pin
   * @param {object} options
   * @param {boolean} options.fresh Whether the tab is loading the saved
   *   address, and so settling on the saved page.
   * @param {string} [options.workspaceId] The workspace it is the page in,
   *   the one the window shows unless named.
   * @returns {object} the page.
   */
  #adopt(tab, pin, { fresh, workspaceId = this.#workspaceId() }) {
    const page = {
      tab,
      guid: pin.guid,
      url: pin.url,
      name: pin.name,
      workspaceId,
      savedPage: fresh ? null : (tab.linkedBrowser?.currentURI?.spec ?? null),
      touched: !fresh,
    };
    this.#pages.set(this.#key(pin.guid, page.workspaceId), page);
    this.#byTab.set(tab, page);
    if (tab.selected) {
      this.#onViewed?.(page.workspaceId, page.guid);
    }
    return page;
  }

  /**
   * Makes an open tab the pin's page in this workspace, as it is (§8.1). The
   * caller has taken it out of the tree; this marks it first.
   *
   * Given `was`, the page as {@link pageOfTab} read it before
   * {@link release}, it is that page again: in its workspace, with its saved
   * page and whether the user has touched it.
   *
   * @param {object} tab A Firefox tab of this window.
   * @param {object} pin `{ guid, url, name }`.
   * @param {object} [was] `{ workspaceId, savedPage, touched }`.
   */
  take(tab, pin, was = null) {
    const workspaceId = was?.workspaceId ?? this.#workspaceId();
    const old = this.#pages.get(this.#key(pin.guid, workspaceId));
    markPin(tab, pin.guid);
    if (old && old.tab !== tab) {
      this.#close(old);
    }
    const page = this.#adopt(tab, pin, { fresh: false, workspaceId });
    // The address it was pinned at is its saved address, so it is on it.
    page.savedPage = was ? was.savedPage : pin.url;
    page.touched = was ? was.touched : true;
    if (!tab.selected) {
      this.#window.gBrowser.hideTab(tab);
    }
    this.#onChange();
  }

  /**
   * Takes the pin's page in this workspace out of the pins, unmarked and
   * shown, for the caller to file as a tab (§8: an unpinned page becomes a
   * tab). The tab moves to the start of the strip, where the tab list's top
   * is.
   *
   * @param {string} guid
   * @returns {object|null} the tab, or null when the pin had no page.
   */
  release(guid) {
    const page = this.#pages.get(this.#key(guid));
    if (!page || page.tab.closing) {
      return null;
    }
    this.#forget(page);
    const { gBrowser } = this.#window;
    gBrowser.moveTabTo(page.tab, { tabIndex: 0 });
    unmarkPin(page.tab);
    lazy.SvalPins.tellPage(page.tab);
    gBrowser.showTab(page.tab);
    this.#onChange();
    return page.tab;
  }

  /**
   * Back to the saved page (§5): the saved address loads afresh, and the page
   * settles again.
   *
   * @param {string} guid
   * @param {string} url The pin's saved address.
   */
  reset(guid, url) {
    const page = this.#pages.get(this.#key(guid));
    if (!page || page.tab.closing) {
      return;
    }
    page.url = url;
    page.savedPage = null;
    page.touched = false;
    page.tab.linkedBrowser.fixupAndLoadURIString(url, {
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    this.#onChange();
  }

  /**
   * After "Save current page as this pin": the page is on its saved page.
   *
   * @param {string} guid
   * @param {string} url The address saved.
   */
  saved(guid, url) {
    const page = this.#pages.get(this.#key(guid));
    if (page) {
      page.url = url;
      page.savedPage = url;
      lazy.SvalPins.tellPage(page.tab);
      this.#onChange();
    }
  }

  /**
   * Keeps each page's record of its pin as the favorites document has it: a
   * name or address edited since the page opened.
   *
   * @param {object[]} pins The pins that show here, folders' included.
   */
  follow(pins) {
    for (const pin of pins) {
      const page = this.#pages.get(this.#key(pin.guid));
      if (!page) {
        continue;
      }
      page.name = pin.name;
      if (page.url !== pin.url) {
        page.url = pin.url;
        lazy.SvalPins.tellPage(page.tab);
      }
    }
  }

  /**
   * Closes the pages of workspaces that are gone, and unloads those of
   * workspaces the window no longer shows, however it came to leave them
   * (a switch, or a peer deleting the one it showed).
   *
   * @param {string|null} workspaceId The workspace the window shows.
   * @param {Set<string>} workspaces Every workspace the document holds.
   */
  tidy(workspaceId, workspaces) {
    if (!workspaceId) {
      return;
    }
    const leftBehind = new Set();
    for (const page of [...this.#pages.values()]) {
      if (page.workspaceId === workspaceId) {
        page.parked = false;
        page.parkedAt = null;
      } else if (workspaces.size && !workspaces.has(page.workspaceId)) {
        this.#close(page);
      } else if (!page.parked) {
        page.parked = true;
        leftBehind.add(page.workspaceId);
      }
    }
    for (const id of leftBehind) {
      this.park(id);
    }
  }

  /**
   * The tabs of `workspaceId`'s pin pages.
   *
   * @param {string} workspaceId
   * @returns {object[]}
   */
  tabsOfWorkspace(workspaceId) {
    return [...this.#pages.values()]
      .filter(page => page.workspaceId === workspaceId && !page.tab.closing)
      .map(page => page.tab);
  }

  /** @returns {object[]} the tabs of the shown workspace's pin pages. */
  tabsOfShownWorkspace() {
    return this.tabsOfWorkspace(this.#workspaceId());
  }

  /**
   * The address the pin's page shows, or null.
   *
   * @param {string} guid
   * @returns {string|null}
   */
  currentUrl(guid) {
    const tab = this.tabOf(guid);
    if (!tab) {
      return null;
    }
    return SvalFirefox.isLazy(tab)
      ? SvalFirefox.lazyUrl(tab)
      : (tab.linkedBrowser?.currentURI?.spec ?? null);
  }

  /**
   * Closes the pin's page in this workspace: the icon stays, and the next
   * selection starts at the saved address (§5).
   *
   * @param {string} guid
   */
  close(guid) {
    const page = this.#pages.get(this.#key(guid));
    if (page) {
      this.#close(page);
    }
  }

  /**
   * Closes, in every workspace, each page of a pin among `guids` for which
   * `gone(guid, workspaceId)` says the pin no longer shows there. Only a
   * change that names a pin closes its page (favorites-native spec §5.5).
   *
   * @param {Set<string>} guids The pins a change named.
   * @param {(guid: string, workspaceId: string) => boolean} gone
   */
  closeWhere(guids, gone) {
    for (const page of [...this.#pages.values()]) {
      if (guids.has(page.guid) && gone(page.guid, page.workspaceId)) {
        this.#close(page);
      }
    }
  }

  /**
   * Notes that the window has left `workspaceId`, whose pages
   * {@link parkIdle} unloads once it has been out of sight long enough.
   *
   * @param {string} workspaceId
   * @param {number} [now] Milliseconds since the epoch.
   */
  park(workspaceId, now = SvalClock.now()) {
    for (const page of this.#pages.values()) {
      if (page.workspaceId === workspaceId) {
        page.parkedAt ??= now;
      }
    }
  }

  /**
   * Unloads the pages of workspaces the window left
   * `hiddenWorkspaceUnloadMs()` ago or more, keeping where each was (§5,
   * spec §10.7). A page Firefox will not unload, one the user typed into, or
   * one playing sound stays loaded.
   *
   * @param {number} [now] Milliseconds since the epoch.
   * @returns {Promise<void>}
   */
  async parkIdle(now = SvalClock.now()) {
    const win = this.#window;
    const unloadMs = hiddenWorkspaceUnloadMs();
    for (const page of [...this.#pages.values()]) {
      const { tab } = page;
      if (
        page.parkedAt == null ||
        now - page.parkedAt < unloadMs ||
        tab.closing ||
        tab.selected ||
        tab.soundPlaying ||
        SvalFirefox.isLazy(tab)
      ) {
        continue;
      }
      if (
        tab.linkedBrowser?.isRemoteBrowser &&
        (!(await SvalFirefox.flushState(win, tab)) ||
          !(await SvalFirefox.pageAllowsUnload(tab, PAGE_ANSWER_MS)))
      ) {
        continue;
      }
      if (tab.closing || SvalFirefox.mustStayLoaded(tab)) {
        continue;
      }
      this.#parking = true;
      try {
        SvalFirefox.discard(win, tab);
      } finally {
        this.#parking = false;
      }
    }
  }

  #close(page) {
    this.#forget(page);
    const { tab } = page;
    if (!tab.closing) {
      this.#window.gBrowser.removeTab(tab, {
        animate: false,
        skipSessionStore: true,
        closeWindowWithLastTab: false,
      });
    }
    this.#onChange();
  }

  #forget(page) {
    const key = this.#key(page.guid, page.workspaceId);
    if (this.#pages.get(key) === page) {
      this.#pages.delete(key);
    }
    this.#byTab.delete(page.tab);
  }

  /**
   * The user touched the page in `tab` (`SvalPinParent`), which settles its
   * saved page where it is.
   *
   * @param {object} tab
   */
  static touched(tab) {
    const page = SvalPinPages.pageOfTab(tab);
    if (page && !page.touched) {
      page.touched = true;
      page.savedPage ??= tab.linkedBrowser?.currentURI?.spec ?? null;
      // Its site is the saved page's from here on.
      lazy.SvalPins.tellPage(tab);
      byWindow.get(tab.documentGlobal)?.#onChange();
    }
  }

  /** @param {Element} browser A browser whose page moved. */
  #moved(browser) {
    const tab = this.#window.gBrowser.getTabForBrowser(browser);
    const page = tab && this.#byTab.get(tab);
    if (!page) {
      return;
    }
    const spec = browser.currentURI?.spec;
    // A fresh load follows its own redirects and settles before the user
    // touches it: that is the saved page.
    if (!page.touched && spec && spec !== "about:blank") {
      page.savedPage = spec;
    }
    this.#onChange();
  }

  /** @param {Event} event */
  handleEvent(event) {
    const tab = event.target;
    switch (event.type) {
      case "TabSelect": {
        const shown = this.#byTab.get(tab);
        if (shown) {
          this.#onViewed?.(shown.workspaceId, shown.guid);
        }
        // A pin's page out of sight leaves the visible tabs, which Ctrl+Tab
        // and the window's other tab lists walk. A selected tab cannot be
        // hidden (`hideTab`), so it is hidden as it is left.
        for (const page of this.#pages.values()) {
          if (!page.tab.selected && !page.tab.hidden && !page.tab.closing) {
            this.#window.gBrowser.hideTab(page.tab);
          }
        }
        this.#onChange();
        break;
      }
      case "TabClose": {
        const page = this.#byTab.get(tab);
        if (page) {
          this.#forget(page);
          this.#onChange();
        }
        break;
      }
      case "TabBrowserDiscarded": {
        // Firefox unloading a page to save memory is the long idle the spec
        // resets on; a switch's own unload is no reset.
        const page = this.#byTab.get(tab);
        if (page && !this.#parking) {
          // After the discard's own dispatch, which tabbrowser is still in.
          Promise.resolve().then(() => this.#close(page));
        } else if (page) {
          this.#onChange();
        }
        break;
      }
      case "TabAttrModified":
        if (this.#byTab.has(tab)) {
          this.#onChange();
        }
        break;
    }
  }
}
