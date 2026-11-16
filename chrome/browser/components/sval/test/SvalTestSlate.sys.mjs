/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * The state the browser was in when its first browser-chrome test file
 * started, which the browser tests' head.js puts every file into before the
 * file's own setup runs. head.js is loaded afresh into each file's scope, so
 * the state is kept here, in a module the process loads once.
 */
export const SvalTestSlate = {
  /**
   * What head.js recorded before the run's first file, or null until then.
   *
   * @type {object|null}
   */
  baseline: null,
};
