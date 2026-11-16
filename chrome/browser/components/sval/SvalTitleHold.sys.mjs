/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { setTimeout, clearTimeout } from "resource://gre/modules/Timer.sys.mjs";

/**
 * How long a page's title, once written, holds back the titles it sets
 * after it.
 *
 * A page that keeps setting its title, a timer, an unread count or a chat
 * that blinks, would otherwise cost a write and a sync pass per change: each
 * pass reads and serialises the whole document, and each publishes a file
 * into the user's cloud folder. Held, such a page costs one write per hold,
 * and the document takes its title at most this late. A page's
 * first title, and one that changes after a quiet spell, is written at once.
 */
export const TITLE_HOLD_MS = 30_000;

/**
 * Lets the first title change for each key through at once, then holds the
 * changes after it for {@link TITLE_HOLD_MS}. A key that changed while held
 * is due when its hold ends, and starts a fresh hold, so a title that keeps
 * changing is written once per hold, its latest each time.
 */
export class SvalTitleHold {
  #ms;
  #onDue;

  /** key -> `{ timer, due }`. */
  #holds = new Map();

  /**
   * @param {Function} onDue Called with a key that changed while held, once
   *   its hold ends. The caller writes the key's latest title.
   * @param {number} [ms] How long a hold lasts; a test shortens it.
   */
  constructor(onDue, ms = TITLE_HOLD_MS) {
    this.#onDue = onDue;
    this.#ms = ms;
  }

  /**
   * Notes a title change for `key`.
   *
   * @param {string} key What the title belongs to: a node, an address.
   * @returns {boolean} whether to write it now. When false, `onDue` is
   *   called with `key` once the hold ends.
   */
  admit(key) {
    const hold = this.#holds.get(key);
    if (hold) {
      hold.due = true;
      return false;
    }
    this.#hold(key);
    return true;
  }

  #hold(key) {
    const hold = { timer: null, due: false };
    hold.timer = setTimeout(() => {
      this.#holds.delete(key);
      if (hold.due) {
        this.#hold(key);
        this.#onDue(key);
      }
    }, this.#ms);
    this.#holds.set(key, hold);
  }

  /**
   * Ends `key`'s hold without calling `onDue`, for a key whose next title is
   * a new page's first.
   *
   * @param {string} key
   */
  forget(key) {
    clearTimeout(this.#holds.get(key)?.timer);
    this.#holds.delete(key);
  }

  /** Ends every hold without calling `onDue`. */
  stop() {
    for (const { timer } of this.#holds.values()) {
      clearTimeout(timer);
    }
    this.#holds.clear();
  }
}
