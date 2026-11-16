/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */

// With the content classifier blocking, the URL classifier keeps the one
// feature it does not replace (protections spec §1.1, decision 1051):
// Mozilla's harmful add-on protection still blocks.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
);
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { UrlClassifierTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlClassifierTestUtils.sys.mjs"
);

add_setup(async function () {
  // The level, and the prefs Sval and Firefox derive from it, as this file
  // found them.
  keepPrefs(
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.trackingprotection.content.testing", true]],
  });
  await UrlClassifierTestUtils.addTestTrackers();
  await serveLists({ "sval-easylist": "||ads.example.org^" });
  registerCleanupFunction(async () => {
    UrlClassifierTestUtils.cleanupTestTrackers();
    SvalBlocking.setLevel("off");
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });
  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  await SvalBlockingLists.update("sval-easylist");
  await listsInForce();
});

add_task(async function the_harmful_add_on_protection_still_blocks() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      host_permissions: ["https://example.org/*"],
    },
    background() {
      const { browser } = this;
      browser.test.onMessage.addListener(async url => {
        let loaded;
        try {
          await fetch(url);
          loaded = true;
        } catch {
          loaded = false;
        }
        browser.test.sendMessage("loaded", loaded);
      });
    },
  });
  await extension.startup();
  const url =
    "https://example.org/browser/browser/components/sval/test/browser/sval_agent_page.html";

  extension.sendMessage(`${url}?before`);
  ok(await extension.awaitMessage("loaded"), "the add-on loads it unlisted");

  await SpecialPowers.pushPrefEnv({
    set: [
      ["urlclassifier.features.harmfuladdon.blocklistHosts", "example.org"],
    ],
  });
  extension.sendMessage(`${url}?listed`);
  ok(
    !(await extension.awaitMessage("loaded")),
    "listed as harmful for add-ons, it is blocked"
  );
  await SpecialPowers.popPrefEnv();
  await extension.unload();
});
