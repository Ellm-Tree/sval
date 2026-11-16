/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Where Enter in the address bar opens what is picked (launcher spec §3),
 * asked by `UrlbarInput._whereToOpen` for a key the address bar takes
 * (`launcher-enter.patch`). A click on a row keeps Firefox's answer.
 *
 * - A page (an address, history, a search, a suggestion, autofill): Enter
 *   loads it in this tab, Shift+Enter in a new tab, Accel+Shift+Enter in a
 *   new window, and Alt+Enter beside this tab in a split. In a split, this
 *   tab is the focused pane, which is `gBrowser.selectedBrowser`, so Enter
 *   loads there alone. On a pin, a page of another site opens in a new tab
 *   instead, because a pin always shows its own site (pins spec §3).
 * - An open tab: Alt+Enter splits this tab with it, Shift+Enter and
 *   Accel+Shift+Enter on a tab of another of the user's workspaces open that
 *   workspace in a window of its own, as Shift does in the workspace
 *   switcher, and every other Enter
 *   switches to it, so a modifier never opens a second copy of a tab. A
 *   split never joins an agent's workspace and the user's (agent-control
 *   spec §3.5), so on an agent's tab, or in a window showing an agent's
 *   workspace, Alt+Enter switches too. An agent's workspace opens in a
 *   window of its own on any Enter (`SvalPanel.goToTab`).
 * - A pin or Favorite: Enter shows the pin's page, or opens the Favorite as
 *   the Favorites menu does; Shift+Enter and Accel+Shift+Enter open its
 *   address in a new tab or window.
 * - A command runs whatever the modifiers: its row has no address, so
 *   `UrlbarInput.pickResult` hands it to its provider before anything reads
 *   where it would open.
 *
 * Accel is Command on macOS and Control elsewhere, and Alt includes AltGraph,
 * as Firefox reads them in `_whereToOpen`.
 *
 * **No address is ever logged** (Sval `CONTRIBUTING.md` rule 10).
 */

import { AppConstants } from "resource://gre/modules/AppConstants.sys.mjs";
import { UrlbarUtils } from "moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs";
import { isPin } from "moz-src:///browser/components/sval/SvalPinTab.sys.mjs";
import { leavesPin } from "moz-src:///browser/components/sval/SvalPinsModel.sys.mjs";

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  SvalFavorites: "moz-src:///browser/components/sval/SvalFavorites.sys.mjs",
  SvalFavoritesProvider:
    "moz-src:///browser/components/sval/SvalFavoritesProvider.sys.mjs",
  SvalPeek: "moz-src:///browser/components/sval/SvalPeek.sys.mjs",
  SvalLauncherTabs:
    "moz-src:///browser/components/sval/SvalLauncherTabs.sys.mjs",
  SvalLog: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  SvalPinPages: "moz-src:///browser/components/sval/SvalPinPages.sys.mjs",
  agentLabelOf: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
  describeError: "moz-src:///browser/components/sval/SvalLog.sys.mjs",
  siteOfPage: "moz-src:///browser/components/sval/SvalPins.sys.mjs",
  workspaceOfNode: "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs",
});

/**
 * @param {KeyboardEvent} event
 * @returns {{alt: boolean, accel: boolean, shift: boolean}}
 */
function keysOf(event) {
  return {
    alt: event.altKey || event.getModifierState("AltGraph"),
    accel: AppConstants.platform === "macosx" ? event.metaKey : event.ctrlKey,
    shift: event.shiftKey,
  };
}

/**
 * Where a page opens for `keys`. A split beside an empty tab would keep the
 * empty tab on screen, so there the page takes its place, as Firefox reuses
 * an empty tab for a new one (`_whereToOpen`'s `reuseEmpty`). A pin's page
 * is no tab of the tree, which cannot split it, so beside a pin the page
 * opens in a new tab, as it does beside any tab the tree does not hold
 * ({@link splitBeside}), such as a Peek's.
 *
 * @param {object} keys As {@link keysOf} answers them.
 * @param {boolean} keys.alt
 * @param {boolean} keys.accel
 * @param {boolean} keys.shift
 * @param {Window} win
 * @returns {"current"|"tab"|"window"|"split"}
 */
function pageWhere({ alt, accel, shift }, win) {
  if (alt) {
    const tab = win.gBrowser.selectedTab;
    if (tab.isEmpty) {
      return "current";
    }
    return isPin(tab) || !win.SvalPanel?.observer?.nodeIdFor(tab)
      ? "tab"
      : "split";
  }
  if (accel && shift) {
    return "window";
  }
  return shift ? "tab" : "current";
}

/**
 * Whether loading `url` in `browser` would take a pin's page off its site.
 *
 * @param {Window} win
 * @param {string} url
 * @param {object} browser
 * @returns {boolean}
 */
function leavesPinPage(win, url, browser) {
  const tab = win.gBrowser.getTabForBrowser(browser);
  const page = isPin(tab) ? lazy.SvalPinPages.pageOfTab(tab) : null;
  return !!page && leavesPin(url, lazy.siteOfPage(page));
}

/**
 * Whether `win` shows an agent's workspace.
 *
 * @param {Window} win
 * @returns {boolean}
 */
function showsAgent(win) {
  const panel = win.SvalPanel;
  const id = panel?.workspaceId;
  return !!id && lazy.agentLabelOf(panel.nodes ?? {}, id) !== null;
}

/**
 * Splits `viewed` with `id` through the panel's own write, as an Alt-click
 * on a row does (`_splitBeside`).
 *
 * @param {Window} win
 * @param {object} viewed A tab of the window.
 * @param {string} id A tab's node.
 * @returns {Promise<boolean>} whether the split was written.
 */
async function splitBeside(win, viewed, id) {
  const panel = win.SvalPanel;
  const viewedId = panel?.observer?.nodeIdFor(viewed);
  return !!viewedId && !viewed.closing && panel.splitBeside(viewedId, id);
}

/**
 * Splits `viewed` with the open tab `id` ({@link splitBeside}), which may be
 * of another workspace. A tab of another workspace moves into this one, so
 * a move into another cookie jar asks first, as Move this tab to… asks
 * (`_confirmJarCrossing`). A tab that another window holds for the
 * workspace it shows goes from there as a moved tab goes
 * (`_moveToWorkspace`): that window lets go of it and this one takes it,
 * before this window goes to it.
 *
 * @param {Window} win
 * @param {object} viewed A tab of the window.
 * @param {string} id A tab's node.
 * @returns {Promise<boolean>} whether the row is done with: the split was
 *   written, or the user declined the move.
 */
async function splitWithTab(win, viewed, id) {
  const panel = win.SvalPanel;
  const nodes = panel?.nodes ?? {};
  const from = lazy.workspaceOfNode(nodes, id);
  const here = panel?.workspaceId;
  const elsewhere = !!from && from !== here;
  if (elsewhere && !(await panel.confirmJarCrossing(id, here, null, from))) {
    return true;
  }
  const shownBy = elsewhere ? panel.workspacesShownElsewhere().get(from) : null;
  if (!(await splitBeside(win, viewed, id))) {
    return false;
  }
  // That window reads the tree again first: its panel learns of the write
  // only when the tree next tells it.
  await shownBy?.SvalPanel?.refresh();
  await shownBy?.SvalPanel?.releaseTabsElsewhere();
  await panel.takeKeptTabs();
  await panel.goToTab(id);
  // A pane's tab that has just come here is shown in its split once it is
  // here (`_keepSplits`), as a restore shows it.
  panel.keepSplits();
  return true;
}

/**
 * Puts `tab`, just opened for a page, beside `viewed` in a split once the
 * tab observer has filed it, then shows it, unless the user has gone to
 * another tab since. A tab the tree cannot split, such as a private
 * window's, stays a tab of its own.
 *
 * @param {Window} win
 * @param {object} viewed The tab the page was asked for in.
 * @param {object} tab The page's tab.
 */
async function splitWithPage(win, viewed, tab) {
  const observer = win.SvalPanel?.observer;
  await observer?.settled();
  const id = observer?.nodeIdFor(tab);
  if (id && !tab.closing && !(await splitBeside(win, viewed, id))) {
    lazy.SvalLog.warn("a page asked for in a split stayed a tab");
  }
  if (!tab.closing && win.gBrowser.selectedTab === viewed) {
    win.gBrowser.selectedTab = tab;
  }
}

export const SvalLauncherEnter = {
  /**
   * Where a key picking `result`, or the text typed when no row is
   * picked, opens it.
   *
   * @param {object} options
   * @param {KeyboardEvent} options.event
   * @param {UrlbarResult|null} [options.result]
   * @param {Window} options.win
   * @returns {"current"|"tab"|"window"|"split"|"switch"} `switch` is the
   *   row's own place: an open tab's tab, a pin's page, or for a Favorite
   *   that is no pin, where the Favorites menu opens it. An open tab's
   *   `window` is its workspace's window.
   */
  whereFor({ event, result = null, win }) {
    const keys = keysOf(event);
    const { TAB_SWITCH, OMNIBOX } = UrlbarUtils.RESULT_TYPE;
    if (result?.type === TAB_SWITCH) {
      const { svalNodeId, svalAgent, svalHere } = result.payload;
      if (!svalNodeId || svalAgent) {
        return "switch";
      }
      if (keys.alt) {
        return showsAgent(win) || lazy.SvalPeek.isPeek(win)
          ? "switch"
          : "split";
      }
      return keys.shift && !svalHere ? "window" : "switch";
    }
    if (result?.type === OMNIBOX) {
      // The places an extension's row can name
      // (`ExtensionSearchHandler.handleInputEntered`).
      return keys.shift ? "tab" : "current";
    }
    const where = pageWhere(keys, win);
    if (
      where === "current" &&
      result &&
      lazy.SvalFavoritesProvider.favoriteOf(result)
    ) {
      return "switch";
    }
    return where;
  },

  /**
   * Where a page loads that is asked for at `where`: a new tab, where it
   * would take a pin's page off its site.
   *
   * @param {Window} win
   * @param {string} url
   * @param {string} where
   * @param {object} browser The browser it would load in.
   * @returns {string}
   */
  whereToLoad(win, url, where, browser) {
    return where === "current" && leavesPinPage(win, url, browser)
      ? "tab"
      : where;
  },

  /**
   * Opens a page as `openTrustedLinkIn` does, and at `split` in a new tab
   * beside this one in a split.
   *
   * @param {Window} win
   * @param {string} url
   * @param {string} where
   * @param {object} params `openTrustedLinkIn`'s.
   */
  open(win, url, where, params) {
    if (where !== "split") {
      win.openTrustedLinkIn(url, where, params);
      return;
    }
    const viewed = win.gBrowser.selectedTab;
    let tab = null;
    win.openTrustedLinkIn(url, "tab", {
      ...params,
      // Shown once it is a pane, so the page does not show alone first.
      inBackground: true,
      resolveOnNewTabCreated: browser => {
        tab = win.gBrowser.getTabForBrowser(browser);
      },
    });
    if (tab) {
      splitWithPage(win, viewed, tab).catch(err =>
        lazy.SvalLog.error(
          `splitting with a page failed: ${lazy.describeError(err)}`
        )
      );
    }
  },

  /**
   * Picks an open tab's row of `SvalLauncherTabs`: at `split`, splits this
   * tab with it, unless the user declines its move into this workspace's
   * jar; otherwise, or where the tree cannot split them, goes to it.
   * Either way the window then shows that tab: a tab of another workspace
   * has no Firefox tab here until it is gone to, and the window shows only
   * the panes it holds (`SvalSplits.splitsToShow`). At `window`, its
   * workspace's own window shows it, a new one where no window shows that
   * workspace. A Shift-click comes here at `window` too, as
   * `BrowserUtils.whereToOpenLink` answers it.
   *
   * @param {Window} win
   * @param {UrlbarResult} result
   * @param {object} from The tab the row was picked in.
   * @param {string} where
   */
  pickTab(win, result, from, where) {
    if (where !== "split") {
      lazy.SvalLauncherTabs.pick(win, result, from, {
        newWindow: where === "window" && !result.payload.svalHere,
      });
      return;
    }
    splitWithTab(win, from, result.payload.svalNodeId)
      .then(split => {
        if (!split) {
          lazy.SvalLauncherTabs.pick(win, result, from);
        }
      })
      .catch(err =>
        lazy.SvalLog.error(
          `splitting with an open tab failed: ${lazy.describeError(err)}`
        )
      );
  },

  /**
   * Picks a pin's or Favorite's row of `SvalFavorites`. Enter, or a plain
   * click, shows a pin's page, and opens a Favorite as the Favorites menu
   * does (`SvalFavorites.open`), in a new tab where this tab is a pin and the
   * Favorite is on another site. Elsewhere, its address opens where
   * `where` says.
   *
   * @param {object} input The `UrlbarInput` the row was picked in.
   * @param {UrlbarResult} result
   * @param {string} where As `_whereToOpen` answered for the pick.
   * @param {Event} event The pick.
   * @returns {boolean} whether the row was one, now opened; a split is
   *   opened as any page's.
   */
  pickFavorite(input, result, where, event) {
    const favorite = lazy.SvalFavoritesProvider.favoriteOf(result);
    if (!favorite || where === "split") {
      return false;
    }
    const win = input.window;
    const plain =
      where === "switch" ||
      (where === "current" && !win.KeyboardEvent.isInstance(event));
    if (plain && lazy.SvalFavoritesProvider.pickPin(input, result)) {
      return true;
    }
    input.handleRevert();
    const at = this.whereToLoad(
      win,
      favorite.url,
      plain ? "current" : where,
      win.gBrowser.selectedBrowser
    );
    lazy.SvalFavorites.open(
      win,
      favorite,
      plain && at === "current" ? { event } : { where: at }
    );
    return true;
  },
};
