/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/frame-wait.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("frame-wait", rule, {
  valid: [
    passes(task("// requestAnimationFrame(r) waits a frame")),
    passes(task('info("requestAnimationFrame(r)");')),
    passes(task("const raf = win.requestAnimationFrame;")),
    passes(task("const a = `requestAnimationFrame(r)`;")),
  ],
  invalid: [
    flags(
      "frame",
      task("await new Promise(r => win.requestAnimationFrame(r));")
    ),
    flags("frame", task("await new Promise(r => requestAnimationFrame(r));")),
  ],
});
