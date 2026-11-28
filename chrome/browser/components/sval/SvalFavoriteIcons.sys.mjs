/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Each device's icons for its favorites (favorites-native spec §5.4): a file
 * in the profile from a favorite's address to a small `data:` icon, which the
 * Favorites menu, pins, home tiles and the address bar read before
 * `page-icon:`. It never syncs.
 *
 * Places keeps an icon only for a page in its history, and only while the
 * history lasts, so a favorite saved as `gmail.com`, never visited by that
 * address and opened onto `mail.google.com`, would have none there. An icon
 * is kept here when a tab showing a favorite's address sets one, and when a
 * tab opened from a favorite settles after its redirects, under the
 * favorite's address. Never from a private window.
 *
 * An icon goes only when a favorite holding its address is deleted or
 * re-addressed, here or on another device, and no other favorite holds it
 * (spec §3.1): an address the document does not hold yet keeps its icon.
 *
 * The same file keeps the icon of each address a tab in the workspace tree
 * holds, learned when a tab showing it sets one, so a tab with no page loaded
 * shows its icon once Places has none, as after history expires or is
 * cleared. A tab's icon goes when a read of the tree holds no tab at its
 * address. A read holding no tab at all prunes nothing, so a tree read before
 * its document is whole cannot empty the file.
 *
 * **Addresses are never logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import {
  SvalSaver,
  readJSONOrSetAside,
} from "moz-src:///browser/components/sval/SvalJSONFile.sys.mjs";
import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";
import {
  latestNodes,
  onTree,
} from "moz-src:///browser/components/sval/SvalTreeSnapshot.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  FAVORITES_CHANGED_TOPIC:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  normalUrl: "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SvalFavoritesStore:
    "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs",
});

/** Notified when an icon is learned or the file has been read. */
export const FAVORITE_ICONS_CHANGED_TOPIC = "sval-favorite-icons-changed";

/** The file, in the profile. */
export const ICONS_FILE = "sval-favorite-icons.json";

/**
 * The longest icon kept, in characters of its `data:` URL: a page's icon is
 * a few kilobytes, and one far larger would grow a file read at every start.
 */
export const MAX_ICON_LENGTH = 128 * 1024;

const SAVE_DELAY_MS = 1000;

/** The most icons waiting, in memory, for a read to hold their address. */
const MAX_PENDING = 64;

/**
 * @param {string|null} icon
 * @returns {boolean} Whether it is an icon this store keeps.
 */
function keepable(icon) {
  return (
    typeof icon === "string" &&
    icon.startsWith("data:") &&
    icon.length <= MAX_ICON_LENGTH
  );
}

/** One profile's favorite icons, over the file at `path`. */
export class SvalFavoriteIconStore {
  #path;
  #icons = new Map();

  /** Icons of the addresses the tree's tabs hold. */
  #tabIcons = new Map();

  /**
   * The addresses the latest tree read with a tab held, or null before one.
   *
   * @type {Set<string>|null}
   */
  #tabUrls = null;

  /**
   * Icons set by a tab before a read of the tree held its address: a tab's
   * node takes a new address when its write lands, which can be after the
   * page sets its icon. Oldest first.
   *
   * @type {Map<string, string>}
   */
  #pendingTabIcons = new Map();
  #loading = null;
  #loaded = false;
  #saver;

  /**
   * Addresses whose last favorite went before the file was read: the file's
   * icons for them are not taken when it is.
   */
  #forgotten = new Set();

  /**
   * Tabs opened from a favorite, and the favorite's address: kept until the
   * tab's first icon, which is the page the open settled on.
   *
   * @type {WeakMap<Element, string>}
   */
  #opened = new WeakMap();

  /**
   * @param {object} options
   * @param {string} options.path The file.
   * @param {object} [options.finalizeAt] As `SvalSaver` takes it.
   */
  constructor({ path, finalizeAt = null }) {
    this.#path = path;
    this.#saver = new SvalSaver({
      what: "favorite icons",
      write: () => this.#write(),
      delayMs: SAVE_DELAY_MS,
      finalizeAt,
    });
  }

  /**
   * Reads the file, once.
   *
   * @returns {Promise<void>}
   */
  load() {
    this.#loading ??= (async () => {
      const stored = await readJSONOrSetAside(this.#path, "favorite icons");
      for (const [url, icon] of Object.entries(stored?.icons ?? {})) {
        // One learned while the file was read is newer.
        if (
          keepable(icon) &&
          !this.#icons.has(url) &&
          !this.#forgotten.has(url)
        ) {
          this.#icons.set(url, icon);
        }
      }
      if (this.#forgotten.size) {
        this.#saver.saveSoon();
      }
      for (const [url, icon] of Object.entries(stored?.tabs ?? {})) {
        if (keepable(icon) && !this.#tabIcons.has(url)) {
          this.#tabIcons.set(url, icon);
        }
      }
      this.#forgotten.clear();
      this.#pruneTabIcons();
      this.#loaded = true;
      Services.obs.notifyObservers(null, FAVORITE_ICONS_CHANGED_TOPIC);
    })();
    return this.#loading;
  }

  /** Whether the file has been read. */
  get loaded() {
    return this.#loaded;
  }

  /**
   * @param {string|URL} url A favorite's address.
   * @returns {string|null} Its icon, as a `data:` URL.
   */
  iconFor(url) {
    const key = lazy.normalUrl(url);
    return this.#icons.get(key) ?? this.#tabIcons.get(key) ?? null;
  }

  /**
   * Keeps `icon` for the favorite address `url`.
   *
   * @param {string} url
   * @param {string} icon
   */
  remember(url, icon) {
    const key = lazy.normalUrl(url);
    if (!keepable(icon) || this.#icons.get(key) === icon) {
      return;
    }
    this.#icons.set(key, icon);
    this.#forgotten.delete(key);
    this.#saver.saveSoon();
    Services.obs.notifyObservers(null, FAVORITE_ICONS_CHANGED_TOPIC);
  }

  /**
   * Keeps `icon` for `url` while a tab in the tree holds that address. One
   * for an address no read has held waits in memory for a read that does.
   *
   * @param {string} url
   * @param {string} icon
   */
  rememberTab(url, icon) {
    const key = lazy.normalUrl(url);
    if (!keepable(icon)) {
      return;
    }
    if (!this.#tabUrls?.has(key)) {
      this.#pendingTabIcons.delete(key);
      this.#pendingTabIcons.set(key, icon);
      if (this.#pendingTabIcons.size > MAX_PENDING) {
        this.#pendingTabIcons.delete(this.#pendingTabIcons.keys().next().value);
      }
      return;
    }
    if (this.#tabIcons.get(key) !== icon) {
      this.#tabIcons.set(key, icon);
      this.#saver.saveSoon();
    }
  }

  /**
   * After a read of the workspace tree: notes the addresses its tabs hold,
   * and drops the icon of any address none holds.
   *
   * @param {object} nodes The tree's `nodes` map.
   */
  onTree(nodes) {
    const urls = new Set();
    for (const node of Object.values(nodes ?? {})) {
      if (node?.kind === "tab" && node.content?.url) {
        urls.add(lazy.normalUrl(node.content.url));
      }
    }
    if (!urls.size) {
      return;
    }
    this.#tabUrls = urls;
    for (const [url, icon] of this.#pendingTabIcons) {
      if (urls.has(url)) {
        this.#pendingTabIcons.delete(url);
        this.rememberTab(url, icon);
      }
    }
    this.#pruneTabIcons();
  }

  #pruneTabIcons() {
    if (!this.#tabUrls) {
      return;
    }
    let pruned = false;
    for (const url of this.#tabIcons.keys()) {
      if (!this.#tabUrls.has(url)) {
        this.#tabIcons.delete(url);
        pruned = true;
      }
    }
    if (pruned) {
      this.#saver.saveSoon();
    }
  }

  /**
   * After a change to Favorites (`SvalFavoritesStore.addChangeListener`):
   * the icon of an address a removed or re-addressed favorite held goes,
   * when no favorite or pin holds it now. Nothing else is looked at.
   *
   * @param {object} store The Favorites the change was made in.
   * @param {object} change
   * @param {string[]} [change.changed] Guids changed.
   * @param {string[]} [change.removed] Guids removed.
   * @param {Map<string, object>|null} [change.before] The read before it.
   */
  onFavoritesChanged(store, { changed = [], removed = [], before = null }) {
    const gone = new Set(removed);
    let forgot = false;
    for (const guid of new Set([...removed, ...changed])) {
      const url = before?.get(guid)?.url;
      if (!url || (this.#loaded && !this.#icons.has(url))) {
        continue;
      }
      const left = gone.has(guid) || store.get(guid)?.url !== url;
      if (left && !store.isKept(url)) {
        this.#icons.delete(url);
        if (!this.#loaded) {
          this.#forgotten.add(url);
        }
        forgot = true;
      }
    }
    if (forgot) {
      this.#saver.saveSoon();
    }
  }

  /**
   * Notes the tab an open of the favorite `url` lands in: the one it opens,
   * or else the selected one, which a load in place uses.
   *
   * @param {Window} win A browser window.
   * @param {string} url The favorite's address.
   * @returns {{done: Function}} Call `done` once the open has been asked for.
   */
  watchOpen(win, url) {
    if (!win?.gBrowser || lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return { done() {} };
    }
    const tabs = win.gBrowser.tabContainer;
    const opened = [];
    const onOpen = event => opened.push(event.target);
    tabs.addEventListener("TabOpen", onOpen);
    const selected = win.gBrowser.selectedTab;
    return {
      done: () => {
        tabs.removeEventListener("TabOpen", onOpen);
        const key = lazy.normalUrl(url);
        for (const tab of opened.length ? opened : [selected]) {
          this.#opened.set(tab, key);
        }
      },
    };
  }

  /**
   * Keeps the icons a window's tabs show for favorites and for the tree's
   * tabs. Nothing in a private window.
   *
   * @param {Window} win A browser window.
   * @param {Function} storeOf Answers the process's Favorites, once read.
   */
  watchWindow(win, storeOf) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(win)) {
      return;
    }
    win.gBrowser.tabContainer.addEventListener("TabAttrModified", event => {
      if (event.detail?.changed?.includes("image")) {
        this.#iconSet(event.target, storeOf());
      }
    });
  }

  /**
   * A tab set its icon. `mIconURL` is the icon as the page gave it, where
   * the tab's `image` can be a remote rendering of it.
   *
   * @param {Element} tab
   * @param {object|null} store The process's Favorites, once read.
   */
  #iconSet(tab, store) {
    const browser = tab.linkedBrowser;
    const icon = browser?.mIconURL;
    if (!keepable(icon)) {
      return;
    }
    let shown = null;
    try {
      shown = Services.io.createExposableURI(browser.currentURI).spec;
    } catch {
      // A page with no address of its own.
    }
    if (shown) {
      this.rememberTab(shown, icon);
    }
    if (shown && store?.isKept(shown)) {
      this.remember(shown, icon);
    }
    const favorite = this.#opened.get(tab);
    if (!favorite || !store) {
      return;
    }
    // The first icon after the open is of the page it settled on, if the
    // page shown is still the one the open loaded: the session history entry
    // a redirected load makes keeps the address it began at.
    this.#opened.delete(tab);
    const history = browser.browsingContext?.sessionHistory;
    const entry = history?.count
      ? history.getEntryAtIndex(history.index)
      : null;
    const began = entry?.originalURI?.spec ?? shown;
    if (began && lazy.normalUrl(began) === favorite && store.isKept(favorite)) {
      this.remember(favorite, icon);
    }
  }

  /**
   * Writes what is waiting now.
   *
   * @returns {Promise<void>}
   */
  flush() {
    return this.#saver.flush();
  }

  /**
   * `tmpPath` makes the write atomic, so a crash mid-write leaves the
   * previous file whole.
   */
  async #write() {
    await IOUtils.writeJSON(
      this.#path,
      {
        version: 1,
        icons: Object.fromEntries(this.#icons),
        tabs: Object.fromEntries(this.#tabIcons),
      },
      { tmpPath: `${this.#path}.tmp` }
    );
  }
}

/** The profile's store, made on first use. */
let profileStore = null;

/** The Favorites whose changes it follows. */
let followed = null;
let unfollow = null;

function storeOfProfile() {
  if (!profileStore) {
    profileStore = new SvalFavoriteIconStore({
      path: PathUtils.join(PathUtils.profileDir, ICONS_FILE),
    });
    profileStore
      .load()
      .catch(err =>
        SvalLog.warn(`favorite icons did not load: ${SvalLog.errorName(err)}`)
      );
    Services.obs.addObserver(follow, lazy.FAVORITES_CHANGED_TOPIC);
    follow();
    // A private window's tree is in memory and keeps no icons.
    const noteTree = engine => {
      if (engine && !engine.isMemory) {
        profileStore.onTree(latestNodes(engine));
      }
    };
    onTree(noteTree);
    // Reads made before this store, which `onTree` does not repeat.
    for (const win of Services.wm.getEnumerator("navigator:browser")) {
      noteTree(win.SvalPanel?.engine);
    }
  }
  return profileStore;
}

/**
 * Follows the process's Favorites, again whenever they are replaced: each
 * change is heard from the first one after they start, which is the read
 * they start with and changes nothing.
 */
function follow() {
  const favorites = lazy.SvalFavoritesStore.instance;
  if (favorites === followed) {
    return;
  }
  unfollow?.();
  followed = favorites;
  unfollow = favorites
    ? favorites.addChangeListener(change =>
        profileStore.onFavoritesChanged(favorites, change)
      )
    : null;
}

export const SvalFavoriteIcons = {
  /**
   * @param {string|URL} url A favorite's address.
   * @returns {string|null} Its icon, as a `data:` URL, once the file is read.
   */
  iconFor(url) {
    return storeOfProfile().iconFor(url);
  },

  /** @returns {Promise<void>} once the file has been read. */
  whenLoaded() {
    return storeOfProfile().load();
  },

  /**
   * See `SvalFavoriteIconStore.watchOpen`.
   *
   * @param {Window} win
   * @param {string} url
   * @returns {{done: Function}}
   */
  watchOpen(win, url) {
    return storeOfProfile().watchOpen(win, url);
  },

  /**
   * Keeps the icons `win`'s tabs show for favorites.
   *
   * @param {Window} win A browser window.
   */
  watchWindow(win) {
    storeOfProfile().watchWindow(
      win,
      () => lazy.SvalFavoritesStore.readyInstance
    );
  },

  /** @returns {Promise<void>} once the file holds every icon learned. */
  flush() {
    return storeOfProfile().flush();
  },
};
