/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file An error's `.name` read straight into a `SvalLog` call. A rejection
 * need not be an Error: a string or an object without a name logs
 * "undefined", and `?? "Error"` copies a fallback into every call site.
 * `SvalLog.errorName(err)` gives the name, or "Error" for anything without
 * one. The fix rewrites the read to it, through the same `SvalLog` the call
 * logs through.
 */

const LEVELS = new Set(["debug", "error", "info", "warn"]);

/** The names an error is held under at Sval's call sites. */
const ERROR_NAME =
  /^(?:e|ex|err|error|reason|cause|failure|exception|rejection)$|(?:Err|Error)$/;

/**
 * The `SvalLog` a call logs through, `SvalLog`, `lazy.SvalLog` or
 * `this._modules.SvalLog`; null for any other call.
 *
 * @param {object} call A CallExpression.
 * @returns {object|null}
 */
function svalLogOf(call) {
  const callee = call.callee;
  if (
    callee.type !== "MemberExpression" ||
    callee.computed ||
    !LEVELS.has(callee.property.name)
  ) {
    return null;
  }
  const object = callee.object;
  const named =
    (object.type === "Identifier" && object.name === "SvalLog") ||
    (object.type === "MemberExpression" &&
      !object.computed &&
      object.property.name === "SvalLog");
  return named ? object : null;
}

/**
 * The name the error read is held under: `err` for `err.name`, `cause` for
 * `err.cause.name`.
 *
 * @param {object} node The object a `.name` is read from.
 * @returns {string|null}
 */
function heldUnder(node) {
  if (node.type === "Identifier") {
    return node.name;
  }
  if (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier"
  ) {
    return node.property.name;
  }
  return null;
}

/**
 * Whether `node` reads an error's name: `err.name` or `err?.name`.
 *
 * @param {object} node An ESTree node, a ChainExpression's included.
 * @returns {object|null} The MemberExpression, or null.
 */
function errorNameRead(node) {
  const member = node.type === "ChainExpression" ? node.expression : node;
  if (
    member.type !== "MemberExpression" ||
    member.computed ||
    member.property.name !== "name"
  ) {
    return null;
  }
  const held = heldUnder(member.object);
  return held && ERROR_NAME.test(held) ? member : null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Requires SvalLog.errorName for an error's name in a log line",
    },
    fixable: "code",
    messages: {
      bare: "log an error's name through SvalLog.errorName(err), which never prints undefined",
    },
    schema: [],
  },
  create(context) {
    const { sourceCode } = context;

    /**
     * Reports `node`, a value logged: a call's argument or a template's
     * expression. `err?.name ?? "Error"` is replaced whole.
     *
     * @param {object} node
     * @param {object} log The `SvalLog` the call logs through.
     */
    function check(node, log) {
      const whole = node;
      let read = errorNameRead(node);
      if (
        !read &&
        node.type === "LogicalExpression" &&
        (node.operator === "??" || node.operator === "||") &&
        node.right.type === "Literal" &&
        typeof node.right.value === "string"
      ) {
        read = errorNameRead(node.left);
      }
      if (!read) {
        return;
      }
      context.report({
        node: whole,
        messageId: "bare",
        fix: fixer =>
          fixer.replaceText(
            whole,
            `${sourceCode.getText(log)}.errorName(${sourceCode.getText(read.object)})`
          ),
      });
    }

    function visit(node, log) {
      if (node.type === "TemplateLiteral") {
        for (const expression of node.expressions) {
          check(expression, log);
        }
      } else if (node.type === "BinaryExpression" && node.operator === "+") {
        visit(node.left, log);
        visit(node.right, log);
      } else {
        check(node, log);
      }
    }

    return {
      CallExpression(node) {
        const log = svalLogOf(node);
        if (!log) {
          return;
        }
        for (const argument of node.arguments) {
          visit(argument, log);
        }
      },
    };
  },
};
