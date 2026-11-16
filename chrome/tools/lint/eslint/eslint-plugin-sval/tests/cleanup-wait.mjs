/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

import rule from "../lib/rules/cleanup-wait.mjs";
import { flags, passes, ruleTester } from "./helpers.mjs";

ruleTester.run("cleanup-wait", rule, {
  valid: [
    passes(
      'registerCleanupFunction(async () => {\n  await within(BrowserTestUtils.withNewTab(url, fn), 10_000, "the page");\n});'
    ),
    passes(
      'registerCleanupFunction(async () => {\n  await within(ServiceWorkerCleanUp.removeFromHost(host), 10_000, "x");\n});'
    ),
    passes(
      "add_task(async function a_task() {\n  await BrowserTestUtils.withNewTab(url, fn);\n});"
    ),
  ],
  invalid: [
    flags(
      "cleanup",
      "registerCleanupFunction(async () => {\n  await BrowserTestUtils.withNewTab(url, fn);\n});"
    ),
    flags(
      "cleanup",
      "registerCleanupFunction(async function () {\n  await SpecialPowers.spawn(browser, [], () => {});\n});"
    ),
    flags(
      "cleanup",
      'registerCleanupFunction(async () => {\n  await within(await SpecialPowers.spawn(browser, [], () => {}), 1000, "x");\n});'
    ),
  ],
});
