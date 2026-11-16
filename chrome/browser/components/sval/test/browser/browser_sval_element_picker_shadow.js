/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */
/* import-globals-from sval_element_picker_helpers.js */

// An element inside an open shadow root (element picker spec §1): what the
// picker offers when the person points at it.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_element_picker_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { SvalElementPicker } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalElementPicker.sys.mjs"
);

const SHADOW_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_element_picker_shadow.html";

add_setup(async function () {
  keepPrefs(
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [...CONTENT_BLOCKING_TEST_PREFS],
    clear: [
      ["browser.sval.adblock.customFrom"],
      ["browser.sval.adblock.myFilters"],
      ["browser.sval.adblock.myFiltersTrustedHere"],
    ],
  });
  await serveLists();
  registerCleanupFunction(async () => {
    SvalBlocking.setLevel("off");
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });

  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  ok(await SvalBlockingLists.update("sval-easylist"), "a list downloads");
  await listsInForce();
  isnot(SvalBlocking.level, "off", "ad blocking is on");
});

add_task(async function pointing_inside_a_shadow_root_offers_the_host() {
  await BrowserTestUtils.withNewTab(SHADOW_PAGE, async browser => {
    await within(
      SvalElementPicker.start(browser, "remove"),
      10_000,
      "the picker starting"
    );
    await overlayUntil(browser, s => s?.bar, "the pointing bar");
    const { x, y } = await SpecialPowers.spawn(browser, [], () => {
      const rect = content.document
        .getElementById("host")
        .shadowRoot.getElementById("inner")
        .getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    });
    await BrowserTestUtils.synthesizeMouseAtPoint(x, y, {}, browser);
    const state = await overlayUntil(browser, s => s?.card, "the card");
    is(state.selector, "#host", "the host is offered, not the element in it");
    is(state.matches, 1, "one element matches");
    SvalElementPicker.stop(browser);
    await overlayUntil(browser, s => !s, "the overlay going on Stop");
  });
});
