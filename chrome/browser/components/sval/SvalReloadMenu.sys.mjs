/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The Reload button's context menu: reload, reload past the cache, and clear
 * the page's site from the caches before reloading.
 *
 * The menu hangs on `reload-button` itself, inside the `stop-reload-button`
 * item, so it stands both in the row and in the overflow panel:
 * `CustomizableUIInternal.ensureButtonContextMenu` gives the overflow panel's
 * menu to the item, and a press finds the nearest `context` from its target.
 */

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalMenu: "moz-src:///browser/components/sval/SvalMenu.sys.mjs",
});

export const RELOAD_MENU_ID = "sval-reload-menu";

/**
 * The caches a site's pages fill. `CLEAR_ALL_CACHES` would also forget the
 * site's HSTS state, which is a security setting rather than a cache of the
 * page.
 */
const SITE_CACHES =
  Ci.nsIClearDataService.CLEAR_NETWORK_CACHE |
  Ci.nsIClearDataService.CLEAR_IMAGE_CACHE |
  Ci.nsIClearDataService.CLEAR_JS_CACHE |
  Ci.nsIClearDataService.CLEAR_CSS_CACHE |
  Ci.nsIClearDataService.CLEAR_PREFLIGHT_CACHE;

/** Reload and Hard reload run `browser-sets.inc.xhtml`'s commands and show their keys. */
const ITEMS = [
  {
    id: "reload",
    label: "Reload",
    key: { id: "key_reload" },
    attributes: { command: "Browser:Reload" },
  },
  {
    id: "skipCache",
    label: "Hard reload",
    key: { id: "key_reload_skip_cache" },
    attributes: { command: "Browser:ReloadSkipCache" },
  },
  { id: "clearCache", label: "Clear site cache and reload" },
];

/** @type {WeakMap<Window, object>} Each window's menu, as SvalMenu gave it. */
const menus = new WeakMap();

/**
 * Clears the caches of the selected page's site in its tab's jar, then
 * reloads that tab past the cache, wherever the selection has moved.
 *
 * @param {Window} win A browser window.
 */
function clearSiteCacheAndReload(win) {
  const browser = win.gBrowser.selectedBrowser;
  const { userContextId, privateBrowsingId } =
    browser.contentPrincipal.originAttributes;
  Services.clearData.deleteDataFromSite(
    Services.eTLD.getSchemelessSite(browser.currentURI),
    { userContextId, privateBrowsingId },
    true,
    SITE_CACHES,
    () =>
      browser.reloadWithFlags(
        Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_PROXY |
          Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE
      )
  );
}

/**
 * `popupshowing`: the clearing item asks for a site, which an http or https
 * page alone has.
 *
 * @param {Event} event
 * @param {object} handle The menu.
 */
function onShowing(event, handle) {
  const { gBrowser } = event.target.documentGlobal;
  const uri = gBrowser.selectedBrowser.currentURI;
  handle
    .item("clearCache")
    .toggleAttribute(
      "disabled",
      !uri.schemeIs("http") && !uri.schemeIs("https")
    );
}

export const SvalReloadMenu = {
  /**
   * Builds the menu in a browser window and hangs it on the Reload button.
   *
   * @param {Window} win A browser window.
   */
  mount(win) {
    const doc = win.document;
    const button = doc.getElementById("reload-button");
    if (!button) {
      return;
    }
    const handle = lazy.SvalMenu.create(doc, {
      name: RELOAD_MENU_ID,
      items: ITEMS,
      onShowing,
      onCommand: id => {
        if (id === "clearCache") {
          clearSiteCacheAndReload(win);
        }
      },
    });
    menus.set(win, handle);
    button.setAttribute("context", RELOAD_MENU_ID);
  },

  /**
   * @param {Window} win A browser window.
   * @returns {object|undefined} its menu, as `SvalMenu.create` gave it.
   */
  menuOf(win) {
    return menus.get(win);
  },
};
