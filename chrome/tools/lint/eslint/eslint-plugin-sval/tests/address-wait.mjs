/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/address-wait.mjs";
import { flags, passes, ruleTester, task } from "./helpers.mjs";

ruleTester.run("address-wait", rule, {
  valid: [
    passes(
      task(
        'await TestUtils.waitForCondition(\n  () => seen.length && browser.currentURI.spec.endsWith(url),\n  "shows"\n);'
      )
    ),
    passes(task("await pageReady(tab.linkedBrowser, url);")),
    passes(task("await committed(browser, url);")),
    passes(
      task(
        'await TestUtils.waitForCondition(() => browser.currentURI.spec === url && !tab.hasAttribute("busy"), "loaded");'
      )
    ),
    passes(
      task('await TestUtils.waitForCondition(() => tab.label === url, "x");')
    ),
    passes(task("Assert.equal(browser.currentURI.spec, url);")),
  ],
  invalid: [
    flags(
      "address",
      task(
        'await TestUtils.waitForCondition(() => browser.currentURI.spec.endsWith(url), "shows");'
      )
    ),
    flags(
      "address",
      task(
        'await TestUtils.waitForCondition(() => browser.currentURI?.spec.includes("#done"), "shows");'
      )
    ),
    flags(
      "address",
      task(
        'await TestUtils.waitForCondition(() => tab.linkedBrowser.currentURI.spec === "about:home", "shows");'
      )
    ),
    flags(
      "address",
      task(
        'await TestUtils.waitForCondition(() => b.browsingContext?.currentWindowGlobal?.documentURI?.spec === url, "shows");'
      )
    ),
    flags(
      "address",
      task(
        "await TestUtils.waitForCondition(function () { return url == browser.currentURI.spec; });"
      )
    ),
  ],
});
