/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file `requestAnimationFrame(…)`, which waits a number of frames rather
 * than for the thing the frames bring.
 */

import { calledName, calleeNameNode } from "../ast.mjs";

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallows waiting for animation frames in a test",
    },
    messages: {
      frame:
        "requestAnimationFrame waits a number of frames; wait for the thing itself, bounded with within()",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        if (calledName(node) === "requestAnimationFrame") {
          context.report({
            node: calleeNameNode(node),
            messageId: "frame",
          });
        }
      },
    };
  },
};
