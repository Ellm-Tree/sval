/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's home page: about:home and about:newtab in a normal window,
 * about:privatebrowsing in a private one, all served by
 * `chrome://browser/content/sval/home/`. about:privatebrowsing typed into a
 * normal window opens in a new private window (`SvalHomeSearchParent`).
 *
 * The home page is somewhere the user is, so a tab showing it is a real tab
 * in its workspace, with a row in the panel, however it was opened. The bare
 * `about:blank` a window or an agent starts from is not. And a new tab opens
 * with the cursor in the page's own search field, so typing goes to the page.
 */

import { SvalFirefox } from "moz-src:///browser/components/sval/SvalFirefox.sys.mjs";
import {
  colorKey,
  css,
} from "moz-src:///browser/components/sval/SvalColor.sys.mjs";
import {
  WINDOW_WORKSPACE_TOPIC,
  workspaceKey,
} from "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalWindowWorkspace:
    "moz-src:///browser/components/sval/SvalWindowWorkspace.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  SvalTabs: "moz-src:///browser/components/sval/SvalTabs.sys.mjs",
});

/**
 * Whether the home page shows the row of pinned Favorites (home-favorites
 * spec §2). A synced setting: it says what the user wants on their home page.
 */
export const HOME_FAVORITES_PREF = "browser.sval.home.favorites";

/** The addresses that show the home page. */
const HOME_PAGE_URLS = new Set([
  "about:home",
  "about:newtab",
  "about:privatebrowsing",
]);

/**
 * The notification `BrowserCommands.openTab` raises for every new tab the user
 * asks for, from the keyboard, the menu or Sval's panel. Its subject wraps a
 * promise of the new tab's browser.
 */
const NEW_TAB_TOPIC = "browser-open-newtab-start";

let watching = false;
let actorRegistered = false;
let favoritesActorRegistered = false;
let workspaceActorRegistered = false;

/**
 * The look of workspace `id` in `win`, as the home page draws it: the
 * workspace, and the colour it is drawn in (`SvalPanel.shownLookOf`, the
 * Edit dialog's choice while it is open) solved for `win`'s appearance and
 * contrast (`SvalColor.windowLook`): `key` names the colour, `tint` is the
 * colour the frame shows, `side` the side the window's text is on, and
 * `home` the wash of that colour the page lays over its night sky, with the
 * text solved on it. No colour on a solid window has none, and the page
 * keeps its own sky; on a see-through one it is Sval's own colour.
 *
 * @param {DOMWindow} win A browser window.
 * @param {string|null} id A workspace id.
 * @returns {{id: string|null, key: string|null, tint: string|null,
 *   side: string|null, home: object|null}}
 */
function lookIn(win, id) {
  const { color, transparency } = win.SvalPanel.shownLookOf(id);
  const look = id ? win.SvalPanel.windowLookOf(color, transparency) : null;
  return {
    id,
    key: look ? colorKey(color) || "none" : null,
    tint: look ? css(look.tint) : null,
    side: look?.side ?? null,
    home: look?.home ?? null,
  };
}

/**
 * Publishes the colour of the workspace `win` shows, so a home page opening
 * there is drawn in it from its first paint (`SvalHomeWorkspaceChild`). A
 * private window publishes nothing, and a closing one takes its key away.
 *
 * @param {DOMWindow} win A browser window.
 */
function publish(win) {
  if (
    !win?.SvalPanel ||
    win.closed ||
    lazy.PrivateBrowsingUtils.isWindowPrivate(win)
  ) {
    return;
  }
  const key = workspaceKey(win.docShell.outerWindowID);
  if (!Services.ppmm.sharedData.has(key)) {
    win.addEventListener(
      "unload",
      () => {
        Services.ppmm.sharedData.delete(key);
      },
      { once: true }
    );
  }
  // Every content process reads sharedData, web content included, so only
  // the colour goes there. The workspace's id reaches the page through its
  // actor alone.
  const look = lookIn(win, lazy.SvalWindowWorkspace.of(win).id);
  Services.ppmm.sharedData.set(key, {
    key: look.key,
    tint: look.tint,
    side: look.side,
    home: look.home,
  });
  // Sent now rather than at the next idle, so a tab opened straight after a
  // switch or a recolour is drawn in the workspace's look.
  Services.ppmm.sharedData.flush();
}

export const SvalHomePage = {
  /**
   * Whether `url` shows the home page. A query or fragment does not change the
   * page.
   *
   * @param {string} url An address.
   * @returns {boolean}
   */
  isHomePage(url) {
    return HOME_PAGE_URLS.has(String(url ?? "").replace(/[?#].*$/, ""));
  },

  /**
   * Registers the actor that answers the page's field with the address bar's
   * engine (`SvalHomeSearchParent`). Once per process; later calls do nothing.
   */
  registerSearchActor() {
    if (actorRegistered) {
      return;
    }
    actorRegistered = true;
    ChromeUtils.registerWindowActor("SvalHomeSearch", {
      parent: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalHomeSearchParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalHomeSearchChild.sys.mjs",
        events: {
          SvalHomeSearch: { capture: true, wantUntrusted: true },
          pageshow: {},
        },
      },
      matches: [...HOME_PAGE_URLS],
      remoteTypes: ["privilegedabout"],
    });
  },

  /**
   * Registers the actor that gives the page its row of pinned Favorites
   * (`SvalHomeFavoritesParent`, home-favorites spec §7). Once per process;
   * later calls do nothing.
   */
  registerFavoritesActor() {
    if (favoritesActorRegistered) {
      return;
    }
    favoritesActorRegistered = true;
    ChromeUtils.registerWindowActor("SvalHomeFavorites", {
      parent: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalHomeFavoritesParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalHomeFavoritesChild.sys.mjs",
        events: { SvalHomeFavorites: { capture: true, wantUntrusted: true } },
      },
      matches: ["about:home", "about:newtab"],
      remoteTypes: ["privilegedabout"],
    });
  },

  /**
   * Registers the actor that tells the page which workspace its tab is in
   * and that workspace's colour (`SvalHomeWorkspaceParent`, pins spec §9).
   * Once per process; later calls do nothing.
   */
  registerWorkspaceActor() {
    if (workspaceActorRegistered) {
      return;
    }
    workspaceActorRegistered = true;
    Services.obs.addObserver(publish, WINDOW_WORKSPACE_TOPIC);
    ChromeUtils.registerWindowActor("SvalHomeWorkspace", {
      parent: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalHomeWorkspaceParent.sys.mjs",
      },
      child: {
        esModuleURI:
          "moz-src:///browser/components/sval/SvalHomeWorkspaceChild.sys.mjs",
        events: {
          DOMDocElementInserted: { capture: true },
          SvalHomeWorkspace: { capture: true, wantUntrusted: true },
        },
      },
      matches: ["about:home", "about:newtab"],
      remoteTypes: ["privilegedabout"],
    });
  },

  /**
   * The workspace the tab showing `browser` is in, and the colour that
   * workspace marks its window with: the workspace of the tab's node in the
   * tree, or, for a tab not yet filed, the one its window shows. Null in a
   * private window, which shows no workspace's colour or pins, and for a
   * browser in no Sval window.
   *
   * @param {Element} browser A tab's `<browser>`.
   * @returns {?object} the workspace and its look ({@link lookIn}).
   */
  workspaceOf(browser) {
    const win = browser?.documentGlobal;
    const panel = win?.SvalPanel;
    if (!panel || lazy.PrivateBrowsingUtils.isBrowserPrivate(browser)) {
      return null;
    }
    return lookIn(
      win,
      lazy.SvalTabs.workspaceOfTab(win, win.gBrowser?.getTabForBrowser(browser))
    );
  },

  /**
   * Puts focus in the page, not the address bar, of every new tab the user
   * opens. Once per process; later calls do nothing.
   *
   * The promise resolves once the tab exists and has been selected, and the
   * page focuses its own field as it loads (`home.js`), so focusing the
   * browser is all that is left.
   */
  watchNewTabs() {
    if (watching) {
      return;
    }
    watching = true;
    Services.obs.addObserver(subject => {
      subject?.wrappedJSObject?.then?.(browser => {
        const window = browser?.documentGlobal;
        if (window?.gURLBar && !window.closed) {
          SvalFirefox.focusPageNotUrlbar(window, browser);
        }
      });
    }, NEW_TAB_TOPIC);
  },
};
