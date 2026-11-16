/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A timer with a delay that a `new Promise(…)` waits on:
 * `do_timeout(ms, …)`, or `setTimeout(…, ms)` bare or on any object.
 * Mozilla's `no-arbitrary-setTimeout` sees a bare or `window.` call, and a
 * file can switch that rule off, so this one sees them too.
 *
 * These pass: a timer that rejects, which is a deadline rather than a wait,
 * and one outside any promise, which is a page's own behaviour under test.
 * A timer that resolves inside `Promise.race(…)` goes on after its delay as
 * if the awaited thing had come, and one in a loop is a poll with no bound
 * of its own, so both are hits: `TestUtils.waitForCondition` is the poll.
 */

import {
  calledName,
  calleeNameNode,
  inArguments,
  mentions,
  propertyName,
} from "../ast.mjs";

/**
 * The delay argument of a timer call, or null if `node` is not one.
 *
 * @param {object} node A CallExpression.
 * @returns {object|null}
 */
function delayOf(node) {
  const { callee } = node;
  if (callee.type === "Identifier" && callee.name === "do_timeout") {
    return node.arguments.length > 1 ? node.arguments[0] : null;
  }
  const named =
    (callee.type === "Identifier" && callee.name === "setTimeout") ||
    (callee.type === "MemberExpression" &&
      propertyName(callee) === "setTimeout");
  return named && node.arguments.length > 1 ? node.arguments[1] : null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallows waiting a fixed time in a test",
    },
    messages: {
      timer:
        "this waits a fixed time; wait for the thing itself, bounded with within()",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    return {
      CallExpression(node) {
        const delay = delayOf(node);
        if (!delay || (delay.type === "Literal" && delay.value === 0)) {
          return;
        }
        let inPromise = false;
        for (const outer of sourceCode.getAncestors(node)) {
          if (
            (outer.type === "CallExpression" ||
              outer.type === "NewExpression") &&
            inArguments(outer, node) &&
            outer.callee.type === "Identifier" &&
            calledName(outer) === "Promise"
          ) {
            inPromise = true;
          }
        }
        if (
          !inPromise ||
          node.arguments.some(arg =>
            mentions(arg, "reject", sourceCode.visitorKeys)
          )
        ) {
          return;
        }
        context.report({
          node: calleeNameNode(node),
          messageId: "timer",
        });
      },
    };
  },
};
