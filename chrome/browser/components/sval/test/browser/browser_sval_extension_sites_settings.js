/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_site_page_helpers.js */

/**
 * Settings shows each extension's site switches: an extension's page lists
 * the sites it is off on and takes a new one, and a site's page lists the
 * extensions that reach it (`SvalExtensionSites`).
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_site_page_helpers.js",
  this
);

const { SvalExtensionSites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
);

const ID = "sites-settings@sval.invalid";
const EXTENSION_PAGE = `about:preferences#svalExtensions-extension?id=${encodeURIComponent(
  ID
)}`;

async function loadExtension() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      name: "Sites settings test extension",
      browser_specific_settings: { gecko: { id: ID } },
      permissions: ["<all_urls>"],
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(async () => {
    for (const site of SvalExtensionSites.sitesOff(ID)) {
      await SvalExtensionSites.setOff(ID, site, false);
    }
    await extension.unload();
  });
  return extension;
}

/**
 * @param {Document} doc
 * @returns {Element|null} The extension page's sites card.
 */
function sitesCard(doc) {
  return doc.querySelector('[data-extension-card="sites"]');
}

add_task(async function test_extension_page_lists_sites_off() {
  await loadExtension();
  await SvalExtensionSites.setOff(ID, "example.com", true);
  const { page } = await openAt(EXTENSION_PAGE);
  const doc = page.document;
  await until(() => sitesCard(doc), "the sites card showing");
  const row = () =>
    sitesCard(doc).querySelector('[data-extension-site="example.com"]');
  Assert.ok(row(), "the site it is off on is listed");
  const toggle = row().querySelector("input.sval-switch");
  Assert.ok(!toggle.checked, "with its switch off");
  toggle.click();
  await until(
    () => !SvalExtensionSites.isOff(ID, "example.com"),
    "the switch turning the extension on there"
  );
  await until(() => !row(), "and the site leaving the list");
});

add_task(async function test_extension_page_adds_site() {
  await loadExtension();
  const { page } = await openAt(EXTENSION_PAGE);
  const doc = page.document;
  await until(() => sitesCard(doc), "the sites card showing");
  const entry = sitesCard(doc).querySelector(
    "input[data-sval-key='sites-entry']"
  );
  entry.value = "www.example.org";
  sitesCard(doc).querySelector("[data-sval-key='sites-add']").click();
  await until(
    () => SvalExtensionSites.isOff(ID, "example.org"),
    "a typed address turning the extension off on its site"
  );
  await until(
    () => sitesCard(doc).querySelector('[data-extension-site="example.org"]'),
    "and the site showing in the list"
  );
});

add_task(async function test_site_page_lists_extensions() {
  await loadExtension();
  const { page } = await openAt(PAGE_URL("example.com"));
  const ui = await untilSitePage(page, "example.com");
  const row = () =>
    ui.doc.querySelector(
      `[data-site-card="extensions"] [data-extension-id="${ID}"]`
    );
  await until(row, "the extension listed on the site's page");
  const toggle = row().querySelector("input.sval-switch");
  Assert.ok(toggle.checked, "on by default");
  toggle.click();
  await until(
    () => SvalExtensionSites.isOff(ID, "example.com"),
    "the switch turning the extension off there"
  );
  await until(
    () => !row().querySelector("input.sval-switch").checked,
    "and the switch showing off"
  );
});
