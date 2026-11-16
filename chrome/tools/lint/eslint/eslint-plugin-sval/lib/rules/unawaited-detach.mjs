/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A statement that is only `….detach()`. A tab observer's `detach`
 * hands back its last flush, which writes into its engine and can publish.
 * Dropped, that flush runs into the next task, or past the engine stopping.
 */

import { propertyName } from "../ast.mjs";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Requires the promise a tab observer's detach() returns",
    },
    messages: {
      unawaited:
        "detach()'s promise is dropped; await it, or tear down with stopFixture",
    },
    schema: [],
  },
  create(context) {
    return {
      ExpressionStatement(node) {
        let call = node.expression;
        if (call.type === "ChainExpression") {
          call = call.expression;
        }
        if (
          call.type === "CallExpression" &&
          call.arguments.length === 0 &&
          call.callee.type === "MemberExpression" &&
          propertyName(call.callee) === "detach"
        ) {
          context.report({
            node: call.callee.property,
            messageId: "unawaited",
          });
        }
      },
    };
  },
};
