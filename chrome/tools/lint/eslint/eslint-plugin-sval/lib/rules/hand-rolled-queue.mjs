/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A promise chain kept as a queue's tail: `q = q.then(…)`,
 * `q = run.catch(() => {})` or `q = run.then(() => {}, () => {})`. A queue is
 * a `SvalSerialQueue`, which names the queue and the call path when a task
 * waits for its own queue, where a chain only stops. A declaration
 * (`const p = …`) starts a value rather than moving a tail, and passes.
 */

import { propertyName } from "../ast.mjs";

/**
 * Whether `node` is a plain name or a chain of them: `q`, `this.#q`, `a.b`.
 *
 * @param {object} node An expression.
 * @returns {boolean}
 */
function isNamePath(node) {
  if (node.type === "Identifier" || node.type === "ThisExpression") {
    return true;
  }
  return (
    node.type === "MemberExpression" &&
    propertyName(node) !== null &&
    isNamePath(node.object)
  );
}

/**
 * Whether `node` is a function that takes nothing and does nothing.
 *
 * @param {object} node An expression.
 * @returns {boolean}
 */
function isNoop(node) {
  return (
    (node.type === "ArrowFunctionExpression" ||
      node.type === "FunctionExpression") &&
    node.params.length === 0 &&
    node.body.type === "BlockStatement" &&
    node.body.body.length === 0
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Requires a queue to be a SvalSerialQueue",
    },
    messages: {
      queue:
        "a promise chain kept as a queue's tail; make it a SvalSerialQueue, or exempt the file in browser/components/sval/.eslintrc.mjs with the reason it cannot be one",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;

    /**
     * Whether `value` chains onto the queue `tail` names: `tail.then(…)`,
     * with or without more calls after it.
     *
     * @param {string} tail The source text of what is assigned to.
     * @param {object} value The assigned expression.
     * @returns {boolean}
     */
    function extendsTail(tail, value) {
      for (
        let call = value;
        call?.type === "CallExpression" &&
        call.callee.type === "MemberExpression";
        call = call.callee.object
      ) {
        if (
          propertyName(call.callee) === "then" &&
          sourceCode.getText(call.callee.object) === tail
        ) {
          return true;
        }
      }
      return false;
    }

    /**
     * Whether `value` is a promise with its outcome swallowed:
     * `run.catch(() => {})` or `run.then(() => {}, () => {})`.
     *
     * @param {object} value The assigned expression.
     * @returns {boolean}
     */
    function swallows(value) {
      if (
        value?.type !== "CallExpression" ||
        value.callee.type !== "MemberExpression" ||
        !isNamePath(value.callee.object)
      ) {
        return false;
      }
      const method = propertyName(value.callee);
      const args = value.arguments;
      return (
        (method === "catch" && args.length === 1 && isNoop(args[0])) ||
        (method === "then" && args.length === 2 && args.every(isNoop))
      );
    }

    function check(tail, value) {
      if (extendsTail(tail, value) || swallows(value)) {
        context.report({ node: value, messageId: "queue" });
      }
    }

    return {
      "ExpressionStatement > AssignmentExpression[operator='=']": function (
        node
      ) {
        if (isNamePath(node.left)) {
          check(sourceCode.getText(node.left), node.right);
        }
      },
      PropertyDefinition(node) {
        if (!node.computed) {
          check(sourceCode.getText(node.key), node.value);
        }
      },
    };
  },
};
