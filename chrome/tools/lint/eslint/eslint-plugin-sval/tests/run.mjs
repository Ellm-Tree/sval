/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

/**
 * @file Runs every test of Sval's lint rules: snippets each rule must flag,
 * and near-misses it must pass. A rule whose pattern stops matching passes
 * every file, so this proves each still finds its shape.
 *
 *   ./mach node tools/lint/eslint/eslint-plugin-sval/tests/run.mjs
 *
 * Sval's scripts/lint.sh runs it. It exits 1 if any case fails.
 */

import { RuleTester } from "eslint";

let passed = 0;
const failed = [];
const names = [];
RuleTester.describe = (name, body) => {
  names.push(name);
  try {
    body();
  } finally {
    names.pop();
  }
};
RuleTester.it = (name, body) => {
  try {
    body();
    passed++;
  } catch (err) {
    failed.push(`${names.join(" > ")} > ${name}\n    ${err.message}`);
  }
};
RuleTester.itOnly = RuleTester.it;

for (const file of [
  "./accessible-read.mjs",
  "./address-wait.mjs",
  "./bare-terminate.mjs",
  "./baseline.mjs",
  "./cleanup-wait.mjs",
  "./config.mjs",
  "./error-name.mjs",
  "./frame-wait.mjs",
  "./hand-rolled-queue.mjs",
  "./native-input.mjs",
  "./numbered-name.mjs",
  "./panel-getter.mjs",
  "./raw-condition-wait.mjs",
  "./tab-switch.mjs",
  "./tick-loop.mjs",
  "./timer-wait.mjs",
  "./ui-wording.mjs",
  "./unawaited-detach.mjs",
  "./unbounded-wait.mjs",
]) {
  const { default: run } = await import(file);
  await run?.();
}

for (const failure of failed) {
  console.error(`FAIL ${failure}`);
}
console.log(`eslint-plugin-sval: ${passed} passed, ${failed.length} failed`);
process.exitCode = failed.length ? 1 : 0;
