/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file The tree's configuration gives each rule the files it is for. These
 * lint snippets through it, as the files they would be.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ESLint, RuleTester } from "eslint";
import { TREE_ROOT } from "../lib/baselined.mjs";
import { HAND_ROLLED_QUEUES } from "../../../../../browser/components/sval/.eslintrc.mjs";

const SVAL = "browser/components/sval";

const eslint = new ESLint({
  cwd: TREE_ROOT,
  ruleFilter: ({ ruleId }) => ruleId.startsWith("sval/"),
});

/**
 * The Sval rules that fire on `code` as the file at `file`.
 *
 * @param {string} file A path from the top of the tree.
 * @param {string} code The file's text.
 * @returns {Promise<string[]>}
 */
async function svalRules(file, code) {
  const [result] = await eslint.lintText(code, {
    filePath: path.join(TREE_ROOT, file),
  });
  return result.messages
    .map(m => m.ruleId)
    .filter(id => id?.startsWith("sval/"));
}

const terminate = "add_task(async function a() {\n  engine.terminate();\n});\n";
const queue = "let q;\nq = q.then(() => {});\n";
const frame = "requestAnimationFrame(() => {});\n";
const raw = 'TestUtils.waitForCondition(() => true, "x");\n';

const cases = [
  [
    "bare-terminate in a browser test",
    `${SVAL}/test/browser/browser_sval_x.js`,
    terminate,
    ["sval/bare-terminate"],
  ],
  ["bare-terminate in head.js", `${SVAL}/test/browser/head.js`, terminate, []],
  [
    "bare-terminate in xpcshell",
    `${SVAL}/test/xpcshell/test_sval_x.js`,
    terminate,
    [],
  ],
  [
    "a test rule in an xpcshell test",
    `${SVAL}/test/xpcshell/test_sval_x.js`,
    frame,
    ["sval/frame-wait"],
  ],
  [
    "a test rule in a test module",
    `${SVAL}/test/SvalTestX.sys.mjs`,
    frame,
    ["sval/frame-wait"],
  ],
  ["a test rule outside the tests", `${SVAL}/SvalX.sys.mjs`, frame, []],
  [
    "raw-condition-wait in an xpcshell test",
    `${SVAL}/test/xpcshell/test_sval_x.js`,
    raw,
    ["sval/raw-condition-wait"],
  ],
  [
    "raw-condition-wait in a test module",
    `${SVAL}/test/shares/SvalTestX.sys.mjs`,
    raw,
    ["sval/raw-condition-wait"],
  ],
  [
    "raw-condition-wait in a browser test",
    `${SVAL}/test/browser/browser_sval_x.js`,
    raw,
    [],
  ],
  [
    "raw-condition-wait in a share browser test",
    `${SVAL}/test/shares/browser/browser_sval_x.js`,
    raw,
    [],
  ],
  [
    "hand-rolled-queue in a module",
    `${SVAL}/SvalX.sys.mjs`,
    queue,
    ["sval/hand-rolled-queue"],
  ],
  [
    "hand-rolled-queue in a test",
    `${SVAL}/test/xpcshell/test_sval_x.js`,
    queue,
    [],
  ],
  [
    "hand-rolled-queue in an exempt file",
    `${SVAL}/SvalSerialQueue.sys.mjs`,
    queue,
    [],
  ],
];

export default async function run() {
  const results = await Promise.all(
    cases.map(([, file, code]) => svalRules(file, code))
  );
  RuleTester.describe("config", () => {
    cases.forEach(([name, , , expected], i) => {
      RuleTester.it(name, () => assert.deepEqual(results[i], expected));
    });
    // A renamed file would otherwise keep its exemption under a stale path
    // while the new path is checked.
    RuleTester.it("every exempt file exists", () => {
      for (const file of HAND_ROLLED_QUEUES) {
        assert.ok(fs.existsSync(path.join(TREE_ROOT, file)), file);
      }
    });
  });
}
