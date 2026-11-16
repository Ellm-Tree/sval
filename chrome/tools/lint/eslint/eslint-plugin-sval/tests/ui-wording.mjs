/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/ui-wording.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("ui-wording", rule, {
  valid: [
    passes(
      task(
        'Assert.equal(title.getAttribute("data-l10n-id"), "sval-send-again", "the title");'
      )
    ),
    // Text the test made is data.
    passes(
      task(
        'await engine.mutate({ kind: "addWorkspace", name: "Mine" });\n' +
          'Assert.equal(row.label, "Mine", "the row names it");'
      )
    ),
    passes(task('Assert.equal(row.label, name, "the row names it");')),
    passes(task('Assert.equal(badge.textContent, "", "no badge");')),
    passes(task('Assert.equal(count.textContent, "3", "three tabs");')),
    passes(task('Assert.equal(input.value, "typed", "kept");')),
    passes(task('Assert.ok(BrowserTestUtils.isVisible(notice), "shown");')),
    passes(task('Assert.equal(host.textContent, "example.com", "the host");')),
    passes(task("Assert.ok(/\\d+:\\d\\d/.test(countdown.textContent));")),
    passes(task('Assert.deepEqual(status.textContent.match(/\\d+/g), ["2"]);')),
    passes(task('Assert.ok(body.textContent.includes(\'"item": "boots"\'));')),
  ],
  invalid: [
    flags(
      "wording",
      task('Assert.equal(title.textContent, "Send the form again?", "title");')
    ),
    flags("wording", task('is(button.label, "Send Again", "the button");')),
    flags(
      "wording",
      task(
        'Assert.equal(el.getAttribute("tooltiptext"), "Close tab", "tooltip");'
      )
    ),
    flags("wording", task("Assert.ok(/website/i.test(body.textContent));")),
    flags(
      "wording",
      task('Assert.ok(!notice.textContent.includes("pair"), "no pairing");')
    ),
    flags(
      "wording",
      task(
        "const text = notice.textContent;\n" +
          'Assert.equal(text, "Certificates", "the heading");'
      )
    ),
    flags(
      "wording",
      task(
        'await TestUtils.waitForCondition(() => el.textContent === "Saved", "saved");'
      )
    ),
    flags(
      "wording",
      task(
        'Assert.stringMatches(row.label, /^shortcuts$/i, "the shortcuts row");'
      )
    ),
  ],
});
