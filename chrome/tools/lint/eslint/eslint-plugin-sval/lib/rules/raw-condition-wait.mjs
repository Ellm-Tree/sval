/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file Mozilla's `waitForCondition`, read from `TestUtils` or
 * `BrowserTestUtils`, in a file the browser tests' head.js does not cover.
 * Mozilla's counts its tries only between checks (`tryOnce` in
 * testing/modules/TestUtils.sys.mjs), so a slow check stretches its bound
 * and a check that never settles holds the wait open until the harness ends
 * the whole file, naming nothing. `waitForCondition` in
 * SvalTestWait.sys.mjs ends on time. head.js puts it in place of both of
 * Mozilla's names for a browser test's run, so the tree's configuration
 * gives this rule only the files outside that: xpcshell tests and test
 * modules.
 */

import { isQualified } from "../ast.mjs";

const NAMESPACES = ["TestUtils", "BrowserTestUtils"];

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Requires the time-bounded waitForCondition from SvalTestWait.sys.mjs outside browser tests",
    },
    messages: {
      raw: "{{ns}}.waitForCondition cannot time out while a check is pending; import waitForCondition from SvalTestWait.sys.mjs",
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        const ns = NAMESPACES.find(n =>
          isQualified(node, n, "waitForCondition")
        );
        if (ns) {
          context.report({ node, messageId: "raw", data: { ns } });
        }
      },
    };
  },
};
