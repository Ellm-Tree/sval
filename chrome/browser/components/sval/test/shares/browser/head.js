/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../browser/head.js */

/* exported Shares */

/**
 * The browser tests' own head.js, and the shares on top of it.
 *
 * A file here is a browser test like any other, run against real shares, so
 * it tears down and waits through the same helpers and gets the same checks
 * after every task and file. The harness loads only the head.js beside a
 * test (`testing/mochitest/browser-test.js`, "Import head.js script if it
 * exists"), so this one loads that one into the same scope first.
 */
Services.scriptloader.loadSubScript(
  new URL("../../browser/head.js", getRootDirectory(gTestPath)).href,
  this
);

const { SvalSharesTestUtils: Shares } = ChromeUtils.importESModule(
  "resource://testing-common/SvalSharesTestUtils.sys.mjs"
);

// Every task restores its own faults. This is the backstop for a task that
// died before it could, and it removes this run's directory from the shares
// once nothing else is using them. A misconfigured job makes `Shares.config`
// throw, and the file's first task fails with that reason.
registerCleanupFunction(() => Shares.restoreAndClean());
