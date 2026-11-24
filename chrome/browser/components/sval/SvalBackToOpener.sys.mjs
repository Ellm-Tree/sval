/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Back on a tab that has no page to go back to, and that another tab
 * opened, closes the tab and shows the tab that opened it.
 *
 * `tabbrowser`'s `addTab` sets a tab's `openerTab` from the browser that
 * called `window.open` or from the selected tab a related link opened from.
 * Session restore never sets it, so a restored tab has no opener.
 *
 * The opener qualifies while it is in the same window and in the Workspace
 * the window shows: a visible tab, or the page of one of the Workspace's
 * pins, which is hidden whenever another tab is selected (`SvalPinPages`).
 * A pin's page is the pin, which Back never closes.
 * A tab of another Workspace is hidden by the switch
 * (`SvalFirefox.hideForWorkspace`), and selecting it would show a tab the
 * panel does not list. A Quick Peek's tab is no tab of the Workspace until
 * the user keeps it, so it neither closes this way nor counts as an opener.
 */

import { SvalPinPages } from "moz-src:///browser/components/sval/SvalPinPages.sys.mjs";
import { isQuickPeek } from "moz-src:///browser/components/sval/SvalQuickPeekTab.sys.mjs";

/**
 * @param {object} tab A tab.
 * @returns {object|null} the tab Back on `tab` returns to, or null when Back
 *   steps through `tab`'s own history or does nothing.
 */
export function openerToReturnTo(tab) {
  const window = tab?.documentGlobal;
  const opener = tab?.openerTab;
  if (
    !opener ||
    !opener.isConnected ||
    opener.closing ||
    opener.documentGlobal !== window ||
    tab.closing ||
    SvalPinPages.pageOfTab(tab) ||
    isQuickPeek(tab) ||
    isQuickPeek(opener) ||
    tab.linkedBrowser.canGoBack
  ) {
    return null;
  }
  if (opener.visible) {
    return opener;
  }
  const pages = SvalPinPages.of(window)?.tabsOfShownWorkspace() ?? [];
  return pages.includes(opener) ? opener : null;
}

const FTL = "sval/navigation.ftl";
const TOOLTIP = "navbar-tooltip-back-2";
const TOOLTIP_TO_OPENER = "sval-navbar-tooltip-back-to-opener";

/**
 * Whether Back does anything on the window's selected tab, for the
 * `Browser:Back` command's state (`UpdateBackForwardCommands`). Sets the
 * Back button's tooltip to say which Back it is.
 *
 * @param {Window} window A browser window.
 * @returns {boolean}
 */
export function canGoBack(window) {
  watchOpeners(window);
  const inHistory = window.gBrowser.webNavigation.canGoBack;
  const toOpener =
    !inHistory && !!openerToReturnTo(window.gBrowser.selectedTab);
  showTooltip(window, toOpener);
  return inHistory || toOpener;
}

/** Windows whose openers {@link watchOpeners} watches. */
const watching = new WeakSet();

/**
 * Updates the Back command when the selected tab's opener closes, which
 * changes no location and so never reaches `UpdateBackForwardCommands`.
 * `TabClose` fires once the closing tab's `closing` is set
 * (`tabbrowser`'s `_beginRemoveTab`).
 *
 * @param {Window} window A browser window.
 */
function watchOpeners(window) {
  if (watching.has(window)) {
    return;
  }
  watching.add(window);
  window.gBrowser.tabContainer.addEventListener("TabClose", event => {
    const { gBrowser } = window;
    if (event.target === gBrowser.selectedTab.openerTab) {
      window.UpdateBackForwardCommands(gBrowser.webNavigation);
    }
  });
}

/**
 * Swaps the Back tooltip's string, keeping the shortcut argument
 * `initBackForwardButtonTooltip` gave it. Before that runs at delayed
 * startup, the tooltip has no string to swap.
 *
 * @param {Window} window A browser window.
 * @param {boolean} toOpener Whether Back closes the tab to its opener.
 */
function showTooltip(window, toOpener) {
  const { document } = window;
  const description = document.getElementById(
    "back-button-tooltip-description"
  );
  const current = description && document.l10n.getAttributes(description);
  const wanted = toOpener ? TOOLTIP_TO_OPENER : TOOLTIP;
  if (!current?.id || current.id === wanted) {
    return;
  }
  if (toOpener) {
    window.MozXULElement.insertFTLIfNeeded(FTL);
  }
  document.l10n.setAttributes(description, wanted, current.args);
}

/**
 * Closes `tab` and selects the tab that opened it, when Back on `tab`
 * returns there.
 *
 * @param {object} tab A tab.
 * @returns {boolean} whether `tab` closed.
 */
export function backToOpener(tab) {
  const opener = openerToReturnTo(tab);
  if (!opener) {
    return false;
  }
  const { gBrowser } = tab.documentGlobal;
  // A successor is the first tab `_findTabToBlurTo` picks, ahead of the
  // tab seen last (`SvalTabAfterClose`).
  gBrowser.setSuccessor(tab, opener);
  gBrowser.removeTab(tab);
  return true;
}
