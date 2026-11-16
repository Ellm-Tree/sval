/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/accessible-read.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("accessible-read", rule, {
  valid: [
    passes(task("const acc = await accessibleOf(node);")),
    passes(task('info("getAccessibleFor(node)");')),
    passes(
      task(
        'await TestUtils.waitForCondition(() => (acc = service.getAccessibleFor(node)), "x");'
      )
    ),
    passes(
      task(
        'await ContentTaskUtils.waitForCondition(() => service.getAccessibleFor(node)?.name === "A", "x");'
      )
    ),
  ],
  invalid: [
    flags("read", task("const acc = accService.getAccessibleFor(node);")),
    flags(
      "read",
      task(
        'await TestUtils.waitForCondition(() => node.isConnected, "x");\nAssert.ok(svc.getAccessibleFor(node));'
      )
    ),
  ],
});
