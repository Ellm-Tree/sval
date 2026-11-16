/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The mark on a Quick Peek's tab (`SvalQuickPeek`): a real tab of its window, opened in
 * the background, whose panel shows over the tab it was opened from. It is
 * written to the tree only once the user keeps it, so everything that files
 * or walks a window's tabs (`SvalTabs`) leaves a marked tab alone.
 *
 * An attribute on the tab, because the tab observer must know at the
 * `TabOpen` that `gBrowser.addTab` dispatches before it returns, and the
 * Quick Peek sets it from a capturing listener that runs first.
 */

const QUICK_PEEK_ATTRIBUTE = "sval-quick-peek";

/**
 * @param {object} tab A Firefox tab.
 * @returns {boolean} whether `tab` is a Quick Peek's.
 */
export function isQuickPeek(tab) {
  return tab?.hasAttribute?.(QUICK_PEEK_ATTRIBUTE) === true;
}

/** @param {object} tab A Firefox tab, as it opens. */
export function markQuickPeek(tab) {
  tab.setAttribute(QUICK_PEEK_ATTRIBUTE, "true");
}

/** @param {object} tab A Quick Peek's tab the user keeps. */
export function unmarkQuickPeek(tab) {
  tab.removeAttribute(QUICK_PEEK_ATTRIBUTE);
}
