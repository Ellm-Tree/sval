/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file What the rule tests share.
 */

import path from "node:path";
import { RuleTester } from "eslint";
import { TREE_ROOT } from "../lib/baselined.mjs";

export const BROWSER_TEST = path.join(
  TREE_ROOT,
  "browser/components/sval/test/browser/browser_sval_example.js"
);

export const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: "latest", sourceType: "script" },
});

/**
 * `body` as the body of an async task.
 *
 * @param {string} body Statements.
 * @returns {string}
 */
export function task(body) {
  return `add_task(async function a_task() {\n${body}\n});\n`;
}

/**
 * A case the rule must pass.
 *
 * @param {string} code The snippet.
 * @returns {object}
 */
export function passes(code) {
  return { code, filename: BROWSER_TEST };
}

/**
 * A case the rule must flag, `count` times.
 *
 * @param {string} messageId The rule's message.
 * @param {string} code The snippet.
 * @param {number} [count] How many hits.
 * @returns {object}
 */
export function flags(messageId, code, count = 1) {
  return {
    code,
    filename: BROWSER_TEST,
    errors: Array.from({ length: count }, () => ({ messageId })),
  };
}
