/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * When a tab, or one browsing context in it, is gone: the one place the
 * agent modules learn it. A module that keeps anything by `browserId` or by
 * a context's id registers here, so that what it keeps ends with its key.
 *
 * Gecko discards a context for two reasons
 * (`CanonicalBrowsingContext::CanonicalDiscard`,
 * `CanonicalBrowsingContext::ReplacedBy`). One replaced by a process switch
 * hands its `browserId` and its tab to the next, and its load can still be
 * under way, so nothing is gone then. Any other discard ends the context,
 * and the discard of a tab's top content context ends the tab.
 */

import { SvalLog } from "moz-src:///browser/components/sval/SvalLog.sys.mjs";

/** @type {Set<(browserId: number) => void>} */
const tabListeners = new Set();
/** @type {Set<(contextId: number) => void>} */
const contextListeners = new Set();

/**
 * @param {Set<Function>} listeners
 * @param {number} id
 */
function tell(listeners, id) {
  for (const listener of [...listeners]) {
    try {
      listener(id);
    } catch (err) {
      SvalLog.warn(
        `a gone tab's state was not dropped: ${SvalLog.errorName(err)}`
      );
    }
  }
}

Services.obs.addObserver((context, _topic, why) => {
  if (why === "replace") {
    return;
  }
  tell(contextListeners, context.id);
  if (!context.parent && context.isContent && context.browserId) {
    tell(tabListeners, context.browserId);
  }
}, "browsing-context-discarded");

/**
 * @param {Set<Function>} listeners
 * @param {Function} listener
 * @returns {() => void}
 */
function listen(listeners, listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * @param {(browserId: number) => void} listener Called with the `browserId`
 *   of each tab that is gone.
 * @returns {() => void} Stops the calls, for a listener that ends before
 *   Sval does.
 */
export function onTabGone(listener) {
  return listen(tabListeners, listener);
}

/**
 * @param {(contextId: number) => void} listener Called with the id of each
 *   browsing context that is gone, a frame's included.
 * @returns {() => void} Stops the calls.
 */
export function onContextGone(listener) {
  return listen(contextListeners, listener);
}
