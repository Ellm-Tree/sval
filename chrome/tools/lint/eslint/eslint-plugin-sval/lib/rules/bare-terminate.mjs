/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file `.terminate()` in a browser-chrome test. `stopEngine` first stops
 * what runs over the engine (settings sync, Favorites, history sync, device
 * names); terminated under one of them, the engine is restarted empty by its
 * next post. A Web Worker the file made itself is
 * not an engine and passes. The configuration keeps this rule to the
 * browser-chrome files other than head.js.
 */

import { propertyName, variableOf } from "../ast.mjs";

const WORKER_CONSTRUCTORS = new Set(["ChromeWorker", "SharedWorker", "Worker"]);

function isWorker(node) {
  return (
    node?.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    WORKER_CONSTRUCTORS.has(node.callee.name)
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallows terminating an engine outside head.js",
    },
    messages: {
      bare: "an engine is stopped through head.js's stopEngine or stopFixture, never terminate()",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;
    // The properties a Web Worker is stored in, `this.worker = new Worker()`,
    // which no scope tracks.
    const workerProperties = new Set();
    const calls = [];

    function receiverIsWorker(receiver) {
      if (receiver.type === "Identifier") {
        const variable = variableOf(sourceCode, receiver);
        return (
          !!variable &&
          (variable.defs.some(def => isWorker(def.node.init)) ||
            variable.references.some(ref => isWorker(ref.writeExpr)))
        );
      }
      return (
        receiver.type === "MemberExpression" &&
        workerProperties.has(propertyName(receiver))
      );
    }

    return {
      AssignmentExpression(node) {
        if (node.left.type === "MemberExpression" && isWorker(node.right)) {
          workerProperties.add(propertyName(node.left));
        }
      },
      PropertyDefinition(node) {
        if (isWorker(node.value) && !node.computed) {
          workerProperties.add(
            node.key.type === "PrivateIdentifier"
              ? `#${node.key.name}`
              : node.key.name
          );
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression" &&
          propertyName(node.callee) === "terminate"
        ) {
          calls.push(node);
        }
      },
      "Program:exit": function () {
        for (const call of calls) {
          if (!receiverIsWorker(call.callee.object)) {
            context.report({ node: call.callee.property, messageId: "bare" });
          }
        }
      },
    };
  },
};
