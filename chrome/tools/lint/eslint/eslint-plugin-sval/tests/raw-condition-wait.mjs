/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/raw-condition-wait.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("raw-condition-wait", rule, {
  valid: [
    passes(task('await waitForCondition(() => ready, "ready");')),
    passes(task('await ContentTaskUtils.waitForCondition(() => ready, "x");')),
    passes(task('await other.TestUtils.waitForCondition(() => ready, "x");')),
  ],
  invalid: [
    flags("raw", task('await TestUtils.waitForCondition(() => ready, "x");')),
    flags(
      "raw",
      task('await BrowserTestUtils.waitForCondition(() => ready, "x");')
    ),
    flags("raw", "const wait = TestUtils.waitForCondition;\n"),
  ],
});
