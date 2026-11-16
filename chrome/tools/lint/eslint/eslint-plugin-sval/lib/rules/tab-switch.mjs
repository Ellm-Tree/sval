/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A tab switch a test starts or watches by hand: an assignment to a
 * tabbrowser's `selectedTab`, or a read of its `_switcher`. Setting
 * `selectedTab` starts a switch that runs on after the assignment
 * (`AsyncTabSwitcher`) and moves the window's focus once the new tab's
 * layers are ready, so what a test reads or types straight after can land
 * before or after it. The browser tests' head.js has `selectTab(tab)`, which
 * selects and waits for the switch to finish, and `switchDone(win)`, which
 * waits for a switch something else started.
 */

import { propertyName } from "../ast.mjs";

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Requires a tab switch to be started and waited for through head.js",
    },
    messages: {
      select:
        "a tab switch goes on after selectedTab is set and moves the focus when it ends; use await selectTab(tab)",
      switcher: "wait for a tab switch with await switchDone(win)",
    },
    schema: [],
  },
  create(context) {
    return {
      AssignmentExpression(node) {
        if (
          node.left.type === "MemberExpression" &&
          propertyName(node.left) === "selectedTab"
        ) {
          context.report({ node: node.left.property, messageId: "select" });
        }
      },
      MemberExpression(node) {
        if (propertyName(node) === "_switcher") {
          context.report({ node: node.property, messageId: "switcher" });
        }
      },
    };
  },
};
