/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/tick-loop.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("tick-loop", rule, {
  valid: [
    passes(task("await TestUtils.waitForTick();")),
    passes(
      task("while (!ready) {\n  poke();\n  await TestUtils.waitForTick();\n}")
    ),
    passes(task("while (!ready) await TestUtils.waitForTick(win);")),
  ],
  invalid: [
    flags(
      "ticks",
      task("for (let i = 0; i < 3; i++) {\n  await TestUtils.waitForTick();\n}")
    ),
    flags("ticks", task("while (!ready) await TestUtils.waitForTick();")),
    flags("ticks", task("do {\n  await waitForTick();\n} while (!ready);")),
    flags("ticks", task("for (const x of xs) await this.waitForTick();")),
  ],
});
