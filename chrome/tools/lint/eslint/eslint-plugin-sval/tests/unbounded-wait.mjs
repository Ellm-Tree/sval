/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/unbounded-wait.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("unbounded-wait", rule, {
  valid: [
    passes(
      task('await within(BrowserTestUtils.browserLoaded(b), 1000, "load");')
    ),
    passes(
      task(
        "const loaded = BrowserTestUtils.browserLoaded(b);\nb.reload();\n" +
          'await within(loaded, 1000, "load");'
      )
    ),
    passes(
      task(
        "let loaded;\nloaded = BrowserTestUtils.browserLoaded(b);\n" +
          'await within(loaded, 1000, "load");'
      )
    ),
    passes(
      task(
        'const shown = BrowserTestUtils.waitForEvent(p, "popupshown");\n' +
          "const both = Promise.all([shown, other]);\n" +
          'await within(both, 1000, "both");'
      )
    ),
    passes(
      task(
        "await within(\n  Promise.all([\n" +
          '    BrowserTestUtils.waitForEvent(a, "x"),\n' +
          '    BrowserTestUtils.waitForEvent(b, "y"),\n  ]),\n  1000,\n  "both"\n);'
      )
    ),
    passes(
      task(
        "await within(\n  opened.then(dialog => {\n" +
          "    return BrowserTestUtils.waitForDialogClose(dialog);\n  }),\n" +
          '  1000,\n  "closed"\n);'
      )
    ),
    passes(
      task(
        "await within(\n  opened.then(dialog => BrowserTestUtils.waitForDialogClose(dialog)),\n" +
          '  1000,\n  "closed"\n);'
      )
    ),
    passes(
      task(
        "await within(\n  (async () => {\n" +
          "    await BrowserTestUtils.browserLoaded(b);\n  })(),\n" +
          '  1000,\n  "load"\n);'
      )
    ),
    passes(task("await BrowserTestUtils.waitForCondition(() => ready);")),
    passes(task("await TestUtils.waitForCondition(() => ready);")),
    passes(task("BrowserTestUtils.removeTab(tab);")),
    passes(task("await other.BrowserTestUtils.browserLoaded(b);")),
    passes(task("await BrowserTestUtils[name](b);")),
    passes(
      task('await within(observer.settled(), 10_000, "the observer settling");')
    ),
    passes(
      task(
        'await within(SvalPanel._started.promise, 10_000, "the panel starting");'
      )
    ),
    passes(task("const settled = { at: 1 };\nsettled.at++;")),
    passes(task("await engine.settled(now);")),
  ],
  invalid: [
    flags("unboundedSval", task("await observer.settled();")),
    flags("unboundedSval", task("await win.SvalPanel._observer.settled();")),
    flags("unboundedSval", task("await store.whenIdle();")),
    flags("unboundedSval", task("await queue.idle();")),
    flags("unboundedSval", task("await SvalPanel._started.promise;")),
    flags(
      "unboundedSval",
      task("const done = observer.settled();\nawait done;")
    ),
    flags("unbounded", task("await BrowserTestUtils.browserLoaded(browser);")),
    flags(
      "unbounded",
      task("const loaded = BrowserTestUtils.browserLoaded(b);\nawait loaded;")
    ),
    flags(
      "unbounded",
      'function shown(p) {\n  return BrowserTestUtils.waitForEvent(p, "popupshown");\n}\n'
    ),
    flags(
      "unbounded",
      task("await within(BrowserTestUtils.browserLoaded(b), 1000);")
    ),
    flags(
      "unbounded",
      task(
        'await within(await BrowserTestUtils.browserLoaded(b), 1000, "load");'
      )
    ),
    flags("unbounded", task('await TestUtils.topicObserved("a-topic");')),
    flags(
      "unbounded",
      task("await PromptTestUtils.handleNextPrompt(win, {}, {});")
    ),
    flags(
      "unbounded",
      task("const tab = { loaded: BrowserTestUtils.browserLoaded(b) };")
    ),
    // A read of the variable before the wait was assigned does not bound it.
    flags(
      "unbounded",
      task(
        'let loaded;\nawait within(loaded, 1000, "early");\n' +
          "loaded = BrowserTestUtils.browserLoaded(b);\nawait loaded;"
      )
    ),
    // A different variable with the same name, in another function, is not
    // the one the wait was assigned to.
    flags(
      "unbounded",
      "add_task(async function a() {\n" +
        "  const loaded = BrowserTestUtils.browserLoaded(b);\n  await loaded;\n});\n" +
        "add_task(async function b(loaded) {\n" +
        '  await within(loaded, 1000, "other");\n});\n'
    ),
  ],
});
