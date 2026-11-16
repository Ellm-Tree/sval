/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A wait on a page in a function given to `registerCleanupFunction`
 * that does not reach `within(promise, ms, what)`. The harness runs a
 * file's cleanups after the file's time limit has stopped
 * (`Tester.nextTest` in testing/mochitest/browser-test.js), so a cleanup
 * that never ends is caught only by the run's no-output timeout: minutes
 * later, with the browser killed and nothing named. `unbounded-wait` covers
 * Mozilla's event waits everywhere; this adds the waits on a page, which a
 * task's own deadline covers anywhere else.
 */

import { inFunctionArgumentOf, inWithin, propertyName } from "../ast.mjs";

/**
 * Whether `node` lies in a function passed to `registerCleanupFunction`.
 *
 * @param {object} node An ESTree node.
 * @returns {boolean}
 */
function inCleanup(node) {
  return inFunctionArgumentOf(
    node,
    call =>
      call.callee.type === "Identifier" &&
      call.callee.name === "registerCleanupFunction"
  );
}

/** The calls that wait on a page, by namespace. */
const PAGE_WAITS = {
  BrowserTestUtils: new Set(["withNewTab"]),
  SpecialPowers: new Set(["spawn"]),
  ContentTask: new Set(["spawn"]),
};

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Requires a cleanup's waits on a page to be bounded",
    },
    messages: {
      cleanup:
        "a cleanup runs after the file's time limit has stopped; bound {{ns}}.{{name}} with within(promise, ms, what), or undo the state without a page",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== "MemberExpression" ||
          callee.object.type !== "Identifier"
        ) {
          return;
        }
        const ns = callee.object.name;
        const name = propertyName(callee);
        if (!PAGE_WAITS[ns]?.has(name) || !inCleanup(node) || inWithin(node)) {
          return;
        }
        context.report({
          node: callee.property,
          messageId: "cleanup",
          data: { ns, name },
        });
      },
    };
  },
};
