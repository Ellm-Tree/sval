/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/hand-rolled-queue.mjs";
import { flags, passes, ruleTester } from "./helpers.mjs";

const inClass = body => `class Q {\n  ${body}\n}\n`;

ruleTester.run("hand-rolled-queue", rule, {
  valid: [
    passes("const tail = tail.then(() => work());"),
    passes("result = other.then(() => work());"),
    passes("queue = run.catch(err => report(err));"),
    passes("queue = make().catch(() => {});"),
    passes("const q = run.catch(() => {});"),
  ],
  invalid: [
    flags("queue", "this._tail = this._tail.then(() => work());"),
    flags("queue", "x();\nqueue = run.catch(() => {});"),
    flags("queue", inClass("#q = run.then(() => {}, () => {});")),
    flags(
      "queue",
      inClass(
        "#queue;\n  run(work) {\n    this.#queue = this.#queue.then(work).catch(err => log(err));\n  }"
      )
    ),
    flags("queue", "transition = transition\n  .then(async () => step());"),
    flags("queue", "queue = run.catch(function () {});"),
  ],
});
