/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/tab-switch.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("tab-switch", rule, {
  valid: [
    passes(task("await selectTab(tab);")),
    passes(task("await switchDone(win);")),
    passes(task("const shown = gBrowser.selectedTab;")),
    passes(task("Assert.equal(win.gBrowser.selectedTab, tab);")),
  ],
  invalid: [
    flags("select", task("gBrowser.selectedTab = tab;")),
    flags("select", task("win.gBrowser.selectedTab = win.gBrowser.tabs[0];")),
    flags(
      "switcher",
      task('await TestUtils.waitForCondition(() => !gBrowser._switcher, "x");')
    ),
  ],
});
