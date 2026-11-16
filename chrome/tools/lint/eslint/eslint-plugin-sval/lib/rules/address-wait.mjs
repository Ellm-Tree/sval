/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file A `waitForCondition` whose condition is only an address check: a
 * browser's `currentURI.spec`, or its window global's `documentURI.spec`,
 * compared with something. Both change when a load commits
 * (`nsDocShell::CreateDocumentViewer`), before the new document has parsed
 * any of its nodes or run its deferred scripts, so a page read straight
 * after finds no body or a page half drawn. The browser tests' head.js has
 * `pageReady(browser, url)`, which waits for the document to load, and
 * `committed(browser, url)`, which says the address is all the test needs.
 *
 * The address may be compared with `==`, `===`, `!=` or `!==`, or matched
 * with `startsWith`, `endsWith` or `includes`. A condition that checks more
 * than the address passes: it names the state it waits for.
 */

import { isFunction, propertyName } from "../ast.mjs";

/** The properties that hold an address from the load's commit on. */
const ADDRESSES = new Set(["currentURI", "documentURI"]);

/**
 * @param {object} node An expression.
 * @returns {object} `node` without a `ChainExpression` around it.
 */
function unchained(node) {
  return node.type === "ChainExpression" ? node.expression : node;
}

/**
 * Whether `node` reads `<…>.currentURI.spec` or `<…>.documentURI.spec`.
 *
 * @param {object} node An expression.
 * @returns {boolean}
 */
function readsAddress(node) {
  const member = unchained(node);
  return (
    member.type === "MemberExpression" &&
    propertyName(member) === "spec" &&
    member.object.type === "MemberExpression" &&
    ADDRESSES.has(propertyName(member.object))
  );
}

/** The string methods that match an address against part of one. */
const MATCHES = new Set(["startsWith", "endsWith", "includes"]);

/**
 * Whether `answer` compares or matches an address and does nothing else.
 *
 * @param {object|null} answer An expression.
 * @returns {boolean}
 */
function onlyAddress(answer) {
  const node = answer && unchained(answer);
  if (
    node?.type === "BinaryExpression" &&
    ["===", "==", "!==", "!="].includes(node.operator)
  ) {
    return readsAddress(node.left) || readsAddress(node.right);
  }
  if (node?.type === "CallExpression") {
    const callee = unchained(node.callee);
    return (
      callee.type === "MemberExpression" &&
      MATCHES.has(propertyName(callee)) &&
      readsAddress(callee.object)
    );
  }
  return false;
}

/**
 * The expression a condition function answers with, or null when its body
 * does more than return one.
 *
 * @param {object} fn A function node.
 * @returns {object|null}
 */
function answerOf(fn) {
  if (fn.body.type !== "BlockStatement") {
    return fn.body;
  }
  const [only, ...rest] = fn.body.body;
  return !rest.length && only?.type === "ReturnStatement"
    ? only.argument
    : null;
}

export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallows waiting for a page's address where the page itself is meant",
    },
    messages: {
      address:
        "a page has its address at commit, before its document is there; wait with pageReady(browser, url) to read the page, or committed(browser, url) for the address alone",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const { callee } = node;
        if (
          callee.type !== "MemberExpression" ||
          propertyName(callee) !== "waitForCondition"
        ) {
          return;
        }
        const condition = node.arguments[0];
        if (!condition || !isFunction(condition)) {
          return;
        }
        if (onlyAddress(answerOf(condition))) {
          context.report({ node: callee.property, messageId: "address" });
        }
      },
    };
  },
};
