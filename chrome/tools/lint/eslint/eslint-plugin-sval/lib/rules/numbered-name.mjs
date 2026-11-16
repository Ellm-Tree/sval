/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A test file whose name ends in `_<digits>.js`. A file split for time
 * is named for what its tasks cover, so a failure's file name says what broke
 * and each task has one place it belongs; a number says only that the file
 * was cut.
 */

import path from "node:path";

const NUMBERED = /_\d+\.js$/;

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Requires a test file to be named for what it covers",
    },
    messages: {
      numbered: "name the file for what its tasks cover, not with a number",
    },
    schema: [],
  },
  create(context) {
    return {
      Program(node) {
        if (NUMBERED.test(path.basename(context.filename))) {
          context.report({ node, messageId: "numbered" });
        }
      },
    };
  },
};
