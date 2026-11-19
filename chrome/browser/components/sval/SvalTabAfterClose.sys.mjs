/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The tab a window shows once its selected tab closes or is hidden: the one
 * the user saw last in the Workspace the window shows, as a back button
 * through the Workspace's recent tabs (`tabbrowser`'s `_findTabToBlurTo`).
 *
 * The candidates are the window's visible tabs, which are the Workspace's
 * own because a switch hides every other Workspace's
 * (`SvalFirefox.hideForWorkspace`), and the pages of the Workspace's pins,
 * which are hidden whenever another tab is selected (`SvalPinPages`). A
 * Quick Peek's tab is no tab of the Workspace until the user keeps it.
 *
 * Firefox's `lastSeenActive` is when the user last saw a tab: a tab switch
 * stamps both tabs, and every tab opened this session and never looked at
 * shares the session's start. Two tabs sharing the latest time leave the
 * choice to Firefox's own order, since neither was seen after the other.
 */

import { SvalPinPages } from "moz-src:///browser/components/sval/SvalPinPages.sys.mjs";
import { isQuickPeek } from "moz-src:///browser/components/sval/SvalQuickPeekTab.sys.mjs";

/**
 * @param {object} tab The selected tab, which is going.
 * @param {Set<object>} exclude Tabs going with it.
 * @returns {object|null} the tab to select, or null when no one tab was
 *   seen last.
 */
export function tabAfterClose(tab, exclude) {
  const window = tab.documentGlobal;
  const pages = SvalPinPages.of(window)?.tabsOfShownWorkspace() ?? [];
  let best = null;
  let tied = false;
  for (const candidate of [...window.gBrowser.visibleTabs, ...pages]) {
    if (
      candidate === tab ||
      candidate.closing ||
      exclude.has(candidate) ||
      isQuickPeek(candidate)
    ) {
      continue;
    }
    const seen = candidate.lastSeenActive;
    if (!best || seen > best.lastSeenActive) {
      best = candidate;
      tied = false;
    } else if (seen === best.lastSeenActive) {
      tied = true;
    }
  }
  return tied ? null : best;
}
