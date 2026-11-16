/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * What the page dialog test files share: a page alerting outside any tool
 * call. Each file loads this with `loadSubScript` into its own scope.
 */

/* exported alertFromTimer, alerted */

/**
 * Has the page in `bc` raise an alert from a timer, outside any tool call,
 * and waits for the alert to be answered.
 *
 * @param {BrowsingContext} bc
 * @param {string} message
 */
async function alertFromTimer(bc, message) {
  await SpecialPowers.spawn(bc, [message], text => {
    content.setTimeout(() => {
      content.alert(text);
      content.document.body.dataset.alerted = "yes";
    }, 0);
  });
  await alerted(bc);
}

/**
 * Waits for the page in `bc` to mark its body `data-alerted="yes"`, which
 * it does once its alert was answered.
 *
 * @param {BrowsingContext} bc
 */
async function alerted(bc) {
  await TestUtils.waitForCondition(
    () =>
      SpecialPowers.spawn(
        bc,
        [],
        () => content.document.body.dataset.alerted === "yes"
      ),
    "the alert was answered"
  );
}
