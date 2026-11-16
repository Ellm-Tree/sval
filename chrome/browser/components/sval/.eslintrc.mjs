/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * Sval's own lint rules (`tools/lint/eslint/eslint-plugin-sval`), and the files
 * each covers. The tree's `eslint-subdirs.config.mjs` loads this file and
 * puts this directory in front of each `files` pattern; `ignores` patterns
 * are taken as they are, from the top of the tree.
 */

import sval from "../../../tools/lint/eslint/eslint-plugin-sval/lib/index.mjs";

const HERE = "browser/components/sval";

/**
 * The files that keep a promise chain of their own, and why
 * `SvalSerialQueue` does not fit.
 */
export const HAND_ROLLED_QUEUES = [
  // The queue itself.
  `${HERE}/SvalSerialQueue.sys.mjs`,
  // A frame lets the next one go ahead while it waits on the user
  // (`onWaiting`), before its own work has ended.
  `${HERE}/SvalAgents.sys.mjs`,
  // A worker has no `Cu`, so it cannot tell automation from a release.
  `${HERE}/SvalSync.worker.mjs`,
];

const TESTS = ["test/**/*.js", "test/**/*.mjs"];

export default [
  {
    files: TESTS,
    plugins: { sval },
    rules: {
      "sval/cleanup-wait": "error",
      "sval/frame-wait": "error",
      "sval/numbered-name": "error",
      "sval/panel-getter": "error",
      "sval/stale-baseline": "warn",
      "sval/tick-loop": "error",
      "sval/timer-wait": "error",
      "sval/ui-wording": "error",
      "sval/unawaited-detach": "error",
      "sval/unbounded-wait": "error",
    },
  },
  {
    // head.js is where an engine is stopped, a page is waited for, a tab is
    // selected, an accessible is read and a native mouse event is sent.
    files: ["test/browser/*.js"],
    ignores: [`${HERE}/test/browser/head.js`],
    plugins: { sval },
    rules: {
      "sval/accessible-read": "error",
      "sval/address-wait": "error",
      "sval/bare-terminate": "error",
      "sval/native-input": "error",
      "sval/tab-switch": "error",
    },
  },
  {
    // The browser tests' head.js puts SvalTestWait's waitForCondition in
    // place of Mozilla's for the whole run of a browser test.
    files: TESTS,
    ignores: [`${HERE}/test/browser/**`, `${HERE}/test/shares/browser/**`],
    plugins: { sval },
    rules: {
      "sval/raw-condition-wait": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ignores: [
      `${HERE}/test/**`,
      `${HERE}/sval_core.mjs`,
      ...HAND_ROLLED_QUEUES,
    ],
    plugins: { sval },
    rules: {
      "sval/hand-rolled-queue": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs"],
    ignores: [`${HERE}/sval_core.mjs`],
    plugins: { sval },
    rules: {
      "sval/error-name": "error",
    },
  },
];
