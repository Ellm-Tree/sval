/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/timer-wait.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("timer-wait", rule, {
  valid: [
    passes(task("await new Promise(r => win.setTimeout(r, 0));")),
    passes(task("await new Promise(r => win.setTimeout(r));")),
    passes(
      task(
        'await new Promise((_, reject) => win.setTimeout(() => reject(new Error("late")), 100));'
      )
    ),
    passes(
      task(
        "await Promise.race([\n  loaded,\n" +
          '  new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 100)),\n]);'
      )
    ),
    passes(task("win.setTimeout(() => button.click(), 100);")),
    passes(task("setTimeout(() => button.click(), 100);")),
  ],
  invalid: [
    flags("timer", task("await new Promise(r => win.setTimeout(r, 100));")),
    flags("timer", task("await new Promise(r => do_timeout(100, r));")),
    flags(
      "timer",
      task(
        "await new Promise(resolve => {\n  win.setTimeout(resolve, 100);\n});"
      )
    ),
    flags(
      "timer",
      task("while (!done) await new Promise(r => win.setTimeout(r, 50));")
    ),
    flags("timer", task("await new Promise(r => setTimeout(r, 100));")),
    flags("timer", task("await new Promise(r => window.setTimeout(r, 100));")),
    // A timer that resolves goes on as if the awaited thing had come.
    flags(
      "timer",
      task(
        "await Promise.race([loaded, new Promise(r => win.setTimeout(r, 100))]);"
      )
    ),
    // A poll is TestUtils.waitForCondition, which has a bound of its own.
    flags(
      "timer",
      task(
        "while (!done) {\n  done = check();\n" +
          "  await new Promise(r => win.setTimeout(r, 50));\n}"
      )
    ),
    flags(
      "timer",
      task(
        "for (let i = 0; i < 50; i++) {\n  if (ready()) {\n    return true;\n  }\n" +
          "  await new Promise(r => content.setTimeout(r, 100));\n}"
      )
    ),
  ],
});
