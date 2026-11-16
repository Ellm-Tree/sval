/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A loop whose whole body is `await ….waitForTick();`, which waits a
 * number of ticks rather than for the thing that takes them.
 */

import { calledName, calleeNameNode, isLoop, onlyStatement } from "../ast.mjs";

/**
 * Whether `callee` is `waitForTick` or a chain of plain names ending in it.
 *
 * @param {object} callee A call's callee.
 * @returns {boolean}
 */
function isTickCallee(callee) {
  if (callee.type === "Identifier") {
    return callee.name === "waitForTick";
  }
  let node = callee;
  while (node.type === "MemberExpression" && !node.computed) {
    node = node.object;
  }
  return (
    (node.type === "Identifier" || node.type === "ThisExpression") &&
    callee.type === "MemberExpression" &&
    callee.property.name === "waitForTick"
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallows a loop that only waits for ticks",
    },
    messages: {
      ticks:
        "this loop waits a number of ticks; wait for the thing itself, bounded with within()",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (calledName(node) !== "waitForTick") {
          return;
        }
        const loop = context.sourceCode.getAncestors(node).findLast(isLoop);
        const only = loop && onlyStatement(loop);
        if (only?.type !== "ExpressionStatement") {
          return;
        }
        let awaited = only.expression;
        if (awaited.type !== "AwaitExpression") {
          return;
        }
        awaited = awaited.argument;
        if (awaited.type === "ChainExpression") {
          awaited = awaited.expression;
        }
        if (
          awaited === node &&
          node.arguments.length === 0 &&
          isTickCallee(node.callee)
        ) {
          context.report({
            node: calleeNameNode(node),
            messageId: "ticks",
          });
        }
      },
    };
  },
};
