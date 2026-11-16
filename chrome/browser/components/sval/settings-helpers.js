/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Plain functions more than one of Sval's settings scripts uses, as
 * `window.SvalSettingsHelpers`. `SvalPreferences` loads this first, so each
 * of the others can take what it needs as its own block starts.
 */

"use strict";

{
  const lazy = {};
  ChromeUtils.defineESModuleGetters(lazy, {
    BrowserWindowTracker: "resource:///modules/BrowserWindowTracker.sys.mjs",
  });

  /**
   * @param {number} n
   * @param {string} word
   * @returns {string} `n` and the word, plural unless `n` is 1.
   */
  const counted = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  /**
   * The pane name `preferences.js` gives a friendly one: `svalSync` →
   * `paneSvalSync`.
   *
   * @param {string} id
   * @returns {string}
   */
  const paneName = id => `pane${id[0].toUpperCase()}${id.slice(1)}`;

  /**
   * This profile's browser windows that are not private, front to back. A
   * private window's panel holds a private session, which owns no engine, no
   * storage and no pairing (private-windows spec), so this page never binds to
   * one.
   *
   * @returns {object[]}
   */
  function profileWindows() {
    return lazy.BrowserWindowTracker.getOrderedWindows({ private: false });
  }

  window.SvalSettingsHelpers = Object.freeze({
    counted,
    paneName,
    profileWindows,
  });
}
