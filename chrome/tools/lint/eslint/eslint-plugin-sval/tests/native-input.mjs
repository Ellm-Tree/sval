/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/native-input.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("native-input", rule, {
  valid: [
    passes(
      task(
        'await nativeMouse({ type: "mousedown", target, screenX: 4, screenY: 4 });'
      )
    ),
    passes(task("EventUtils.synthesizeMouseAtCenter(el, {});")),
  ],
  invalid: [
    flags(
      "native",
      task(
        'await EventUtils.promiseNativeMouseEvent({ type: "mousedown", target, screenX: 4, screenY: 4 });'
      )
    ),
    flags(
      "native",
      task(
        'await EventUtils.promiseNativeMouseEventAndWaitForEvent({ type: "mousemove", target, screenX: 4, screenY: 4 });'
      )
    ),
  ],
});
