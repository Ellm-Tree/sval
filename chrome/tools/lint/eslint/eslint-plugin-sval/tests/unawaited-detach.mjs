/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/unawaited-detach.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("unawaited-detach", rule, {
  valid: [
    passes(task("await observer.detach();")),
    passes(task("const flushed = observer.detach();\nawait flushed;")),
    passes("function stop(o) {\n  return o.detach();\n}\n"),
    passes(task("observer.detach().then(done);")),
    passes(task("cleanup(() => observer.detach());")),
    passes(task('const s = "observer.detach();";')),
  ],
  invalid: [
    flags("unawaited", task("observer.detach();")),
    flags("unawaited", task("this._observers.get(win).detach();")),
    flags("unawaited", task("if (observer) observer.detach();")),
    flags("unawaited", task("observer?.detach();")),
  ],
});
