/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import { RuleTester } from "eslint";
import { baselined, staleBaseline, treePath } from "../lib/baselined.mjs";
import rule from "../lib/rules/frame-wait.mjs";
import { BROWSER_TEST, ruleTester, task } from "./helpers.mjs";

const baseline = { [treePath(BROWSER_TEST)]: { "frame-wait": 2 } };
const held = baselined("frame-wait", rule, baseline);
const frames = n =>
  task("await new Promise(r => requestAnimationFrame(r));\n".repeat(n));

ruleTester.run("baselined", held, {
  valid: [
    { code: frames(2), filename: BROWSER_TEST },
    { code: frames(1), filename: BROWSER_TEST },
  ],
  invalid: [
    // Past its allowance, a file fails with every hit named.
    {
      code: frames(3),
      filename: BROWSER_TEST,
      errors: Array.from({ length: 3 }, () => ({ messageId: "frame" })),
    },
    // A file the baseline does not list has no allowance.
    {
      code: frames(1),
      filename: BROWSER_TEST.replace("example", "other"),
      errors: [{ messageId: "frame" }],
    },
  ],
});

RuleTester.describe("stale-baseline", () => {
  ruleTester.run(
    "stale-baseline",
    staleBaseline({ "frame-wait": rule }, baseline),
    {
      valid: [
        { code: frames(2), filename: BROWSER_TEST },
        { code: frames(3), filename: BROWSER_TEST },
      ],
      invalid: [
        {
          code: frames(1),
          filename: BROWSER_TEST,
          errors: [
            {
              message:
                "the baseline allows 2 frame-wait in this file, which has 1; lower it to 1 in eslint-plugin-sval/lib/baseline.mjs",
            },
          ],
        },
        {
          code: frames(0),
          filename: BROWSER_TEST,
          errors: [
            {
              message:
                "the baseline allows 2 frame-wait in this file, which has 0; delete it in eslint-plugin-sval/lib/baseline.mjs",
            },
          ],
        },
      ],
    }
  );
});
