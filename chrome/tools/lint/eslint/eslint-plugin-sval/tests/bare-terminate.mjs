/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/bare-terminate.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

// Which files the rule covers, head.js and xpcshell left out, is the
// configuration's, tested in config.mjs.
ruleTester.run("bare-terminate", rule, {
  valid: [
    passes(
      task('const worker = new ChromeWorker("w.js");\nworker.terminate();')
    ),
    passes(
      task('let worker;\nworker = new Worker("w.js");\nworker.terminate();')
    ),
    passes(
      task('this.worker = new SharedWorker("w.js");\nthis.worker.terminate();')
    ),
    passes(task("const terminate = engine.terminate;")),
  ],
  invalid: [
    flags("bare", task("engine.terminate();")),
    flags("bare", task("fixture.engine.terminate();")),
    flags("bare", task("engine?.terminate();")),
    // A worker by the same name elsewhere is a different variable.
    flags(
      "bare",
      'function a() {\n  const worker = new Worker("w.js");\n  worker.terminate();\n}\n' +
        "function b(worker) {\n  worker.terminate();\n}\n"
    ),
  ],
});
