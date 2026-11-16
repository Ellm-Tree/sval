/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* globals browser */

/**
 * An extension off on a site learns nothing of the site through its
 * navigation events, its cookies or find (`SvalExtensionSites`,
 * extension-blocked-sites-js.patch).
 */

const { SvalExtensionSites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
);

const ID = "blocked-site-data@sval.invalid";

const page = (host, html) =>
  `https://${host}/document-builder.sjs?html=${encodeURIComponent(html)}`;
const COM_FRAMING_ORG = page(
  "example.com",
  `<iframe src="${page("example.org", "<p>framed org</p>")}"></iframe>`
);
const ORG = page("example.org", "<p>org</p>");

/**
 * @param {string[]} permissions
 * @param {Function} background
 * @returns {Promise<object>}
 */
async function loadExtension(permissions, background) {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: ID } },
      permissions: [...permissions, "<all_urls>"],
    },
    background,
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(() => extension.unload());
  return extension;
}

/** @param {string} site */
async function blockOn(site) {
  atTaskEnd(() => SvalExtensionSites.setOff(ID, site, false));
  await within(
    SvalExtensionSites.setOff(ID, site, true),
    10_000,
    "the switch reaching every process"
  );
}

function openLoaded(url) {
  return within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "the page loading"
  );
}

add_task(async function test_web_navigation_blocked() {
  const extension = await loadExtension(["webNavigation"], () => {
    const seen = [];
    browser.webNavigation.onCompleted.addListener(({ url }) => seen.push(url));
    browser.test.onMessage.addListener(() =>
      browser.test.sendMessage("seen", seen.splice(0))
    );
  });
  await blockOn("example.com");
  await openLoaded(COM_FRAMING_ORG);
  extension.sendMessage("seen");
  Assert.deepEqual(
    await within(extension.awaitMessage("seen"), 10_000, "the events seen"),
    [],
    "no navigation in the tab, its frame's included"
  );
  await openLoaded(ORG);
  await TestUtils.waitForCondition(async () => {
    extension.sendMessage("seen");
    return (await extension.awaitMessage("seen")).includes(ORG);
  }, "another site's navigation is seen");
});

add_task(async function test_cookies_blocked() {
  const extension = await loadExtension(["cookies"], () => {
    browser.test.onMessage.addListener(async (what, domain) => {
      if (what === "set") {
        const cookie = await browser.cookies
          .set({ url: `https://${domain}/`, name: "sval", value: "1" })
          .catch(() => null);
        browser.test.sendMessage("done", Boolean(cookie));
      } else {
        const all = await browser.cookies.getAll({ domain });
        const one = await browser.cookies.get({
          url: `https://${domain}/`,
          name: "sval",
        });
        browser.test.sendMessage("done", all.length + (one ? 1 : 0));
      }
    });
  });
  const ask = async (what, domain) => {
    extension.sendMessage(what, domain);
    return within(extension.awaitMessage("done"), 10_000, `cookies ${what}`);
  };
  Assert.ok(await ask("set", "example.com"), "a cookie set before");
  Assert.ok(await ask("set", "example.org"), "on both sites");
  atTaskEnd(() => Services.cookies.removeAll());
  await blockOn("example.com");
  Assert.equal(await ask("read", "example.com"), 0, "the site's are hidden");
  Assert.ok(!(await ask("set", "example.com")), "and cannot be set");
  Assert.equal(await ask("read", "example.org"), 2, "another site's are not");
});

add_task(async function test_find_blocked() {
  const extension = await loadExtension(["find"], () => {
    browser.test.onMessage.addListener(async () => {
      const found = await browser.find
        .find("svalneedle", { includeRangeData: true })
        .then(
          ({ rangeData }) => rangeData.map(r => r.text),
          () => null
        );
      browser.test.sendMessage("found", found);
    });
  });
  const find = async () => {
    extension.sendMessage("find");
    return within(extension.awaitMessage("found"), 10_000, "the find");
  };
  await blockOn("example.com");
  await openLoaded(page("example.org", "<p>svalneedle</p>"));
  Assert.deepEqual(
    await find(),
    ["svalneedle"],
    "another site's text is found"
  );
  await openLoaded(page("example.com", "<p>svalneedle</p>"));
  Assert.equal(await find(), null, "the site's text cannot be searched");
});
