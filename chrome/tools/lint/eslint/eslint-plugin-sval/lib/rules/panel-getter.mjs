/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A test that reads one of `SvalPanel`'s own fields where the panel
 * has a getter for it (`GETTERS`, from `sval-panel.js`). The getter is what
 * the panel offers to be read; its field is the panel's to rename. A write
 * passes, as does `delete`.
 */

import { propertyName } from "../ast.mjs";

/** The panel's fields that a getter of the same meaning reads. */
const GETTERS = new Map([
  ["_engine", "engine"],
  ["_observer", "observer"],
  ["_nodes", "nodes"],
  ["_settings", "settings"],
  ["_pins", "pins"],
  ["_folderState", "folderState"],
  ["_lastSynced", "lastSynced"],
  ["_lastPass", "lastPass"],
  ["_syncKeyState", "syncKeyState"],
  ["_inMemory", "inMemory"],
  ["_isPrivate", "isPrivate"],
  ["_agentLabel", "agentLabel"],
  ["_agentMarking", "agentMarking"],
  ["_initialized", "initialized"],
]);

/**
 * Whether `node` is `SvalPanel` or `<…>.SvalPanel`.
 *
 * @param {object} node An expression.
 * @returns {boolean}
 */
function isPanel(node) {
  return (
    (node.type === "Identifier" && node.name === "SvalPanel") ||
    (node.type === "MemberExpression" && propertyName(node) === "SvalPanel")
  );
}

/**
 * Whether `member` is written or deleted rather than read.
 *
 * @param {object} member A MemberExpression.
 * @returns {boolean}
 */
function isWritten(member) {
  const { parent } = member;
  return (
    (parent.type === "AssignmentExpression" && parent.left === member) ||
    (parent.type === "UpdateExpression" && parent.argument === member) ||
    (parent.type === "UnaryExpression" && parent.operator === "delete")
  );
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Requires a test to read SvalPanel through its getters",
    },
    fixable: "code",
    messages: {
      getter: "read SvalPanel.{{getter}}, the panel's getter for {{field}}",
    },
    schema: [],
  },
  create(context) {
    return {
      MemberExpression(node) {
        if (!isPanel(node.object) || isWritten(node)) {
          return;
        }
        const field = propertyName(node);
        let getter = GETTERS.get(field);
        let target = node;
        if (
          !getter &&
          field === "_started" &&
          node.parent.type === "MemberExpression" &&
          propertyName(node.parent) === "promise"
        ) {
          getter = "started";
          target = node.parent;
        }
        if (!getter) {
          return;
        }
        context.report({
          node: node.property,
          messageId: "getter",
          data: { getter, field },
          fix: fixer =>
            fixer.replaceTextRange(
              [node.property.range[0], target.range[1]],
              getter
            ),
        });
      },
    };
  },
};
