/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A call to `getAccessibleFor`. Gecko makes a node's accessible on the
 * refresh after the node is inserted or shown
 * (`NotificationController::WillRefresh`), so a node already in the DOM can
 * have none yet, and a read then finds null. The browser tests' head.js has
 * `accessibleOf(node)`, which waits for it.
 *
 * A read in the condition of a `waitForCondition` passes: it waits too, as a
 * content task must, where head.js is not loaded.
 */

import {
  calledName,
  calleeNameNode,
  inFunctionArgumentOf,
  propertyName,
} from "../ast.mjs";

/**
 * Whether `node` lies in a function passed first to a `waitForCondition`.
 *
 * @param {object} node An ESTree node.
 * @returns {boolean}
 */
function inCondition(node) {
  return inFunctionArgumentOf(
    node,
    (call, index) =>
      index === 0 &&
      call.callee.type === "MemberExpression" &&
      propertyName(call.callee) === "waitForCondition"
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Requires a node's accessible to be waited for",
    },
    messages: {
      read: "a node's accessible is made on a later refresh; use await accessibleOf(node)",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (calledName(node) === "getAccessibleFor" && !inCondition(node)) {
          context.report({
            node: calleeNameNode(node),
            messageId: "read",
          });
        }
      },
    };
  },
};
