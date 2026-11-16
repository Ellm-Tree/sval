/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The mark on a pin's page (pins spec §5, decision 0137): a real tab of its
 * window that no tree node describes. A pin's icon is its tab, so its page
 * never appears in the tab list, and everything that files or walks a
 * window's tabs (`SvalTabs`) leaves a marked tab alone, as it leaves a
 * Quick Peek's (`SvalQuickPeekTab`).
 *
 * The mark names the Favorite the page belongs to by its guid. It is
 * what `SvalPinPages` set when it opened the page, read back by the tab
 * observer and the page's actor; which pins exist, where they show and in
 * what order is never read from it, only from the favorites document.
 *
 * An attribute on the tab, because the tab observer must know at the
 * `TabOpen` that `gBrowser.addTab` dispatches before it returns, and the
 * pins set it from a capturing listener that runs first.
 *
 * SessionStore leaves a marked tab out of every session it keeps and out of
 * the recently closed tabs (`_collectWindowData`, `maybeSaveClosedTab`), as
 * after a restart each pin starts at its saved address (pins spec §5). The
 * mark is no attribute SessionStore restores, so a page it brought back
 * would be a hidden tab of no pin, which the tab observer files as a tab.
 */

const PIN_ATTRIBUTE = "sval-pin";

/**
 * @param {object} tab A Firefox tab.
 * @returns {boolean} whether `tab` is a pin's page.
 */
export function isPin(tab) {
  return tab?.hasAttribute?.(PIN_ATTRIBUTE) === true;
}

/**
 * @param {object} tab A Firefox tab.
 * @returns {string|null} the guid of the pin whose page `tab` is.
 */
export function pinGuidOf(tab) {
  return tab?.getAttribute?.(PIN_ATTRIBUTE) || null;
}

/**
 * @param {object} tab A Firefox tab.
 * @param {string} guid The pin's guid.
 */
export function markPin(tab, guid) {
  tab.setAttribute(PIN_ATTRIBUTE, guid);
}

/** @param {object} tab A pin's page that becomes a normal tab. */
export function unmarkPin(tab) {
  tab.removeAttribute(PIN_ATTRIBUTE);
}
