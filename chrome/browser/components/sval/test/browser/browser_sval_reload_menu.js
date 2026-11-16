/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const CACHEABLE = ROOT + "sval_reload_cacheable.sjs";

/**
 * Right-clicks the Reload button and resolves with its menu once shown.
 *
 * @returns {Promise<Element>}
 */
async function openReloadMenu() {
  const menu = document.getElementById("sval-reload-menu");
  const shown = BrowserTestUtils.waitForPopupEvent(menu, "shown");
  EventUtils.synthesizeMouseAtCenter(document.getElementById("reload-button"), {
    type: "contextmenu",
    button: 2,
  });
  await within(shown, 10_000, "the Reload menu showing");
  return menu;
}

/**
 * @param {Element} menu
 */
async function closeMenu(menu) {
  const hidden = BrowserTestUtils.waitForPopupEvent(menu, "hidden");
  menu.hidePopup();
  await within(hidden, 10_000, "the Reload menu hiding");
}

/**
 * The hosts of the HTTP cache's entries for the cacheable fixture.
 *
 * @returns {Promise<string[]>}
 */
function cachedHosts() {
  const path = new URL(CACHEABLE).pathname;
  return new Promise(resolve => {
    const hosts = [];
    Services.cache2.asyncVisitAllStorages(
      {
        QueryInterface: ChromeUtils.generateQI(["nsICacheStorageVisitor"]),
        onCacheStorageInfo() {},
        onCacheEntryInfo(uri) {
          if (uri.filePath === path) {
            hosts.push(uri.host);
          }
        },
        onCacheEntryVisitCompleted() {
          resolve(hosts);
        },
      },
      true
    );
  });
}

/**
 * Fetches the cacheable fixture from `browser`'s page, on its own site.
 *
 * @param {Element} browser
 */
async function fetchCacheable(browser) {
  await within(
    SpecialPowers.spawn(browser, [new URL(CACHEABLE).pathname], path =>
      content.fetch(path).then(r => r.text())
    ),
    10_000,
    "the fixture fetching"
  );
}

add_task(async function the_reload_button_offers_its_menu() {
  const tab = await openPage(PAGE);
  const menu = await openReloadMenu();
  const ids = [...menu.children].filter(i => !i.hidden).map(i => i.id);
  Assert.deepEqual(
    ids,
    ["sval-reload-normal", "sval-reload-skip-cache", "sval-reload-clear-cache"],
    "Reload, Hard reload and the cache clearing are offered"
  );
  Assert.ok(
    !menu.querySelector("#sval-reload-clear-cache").hasAttribute("disabled"),
    "a web page's site can be cleared"
  );
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function a_page_without_a_site_has_no_cache_to_clear() {
  const tab = await openPage("data:text/html,page");
  const menu = await openReloadMenu();
  Assert.ok(
    menu.querySelector("#sval-reload-clear-cache").hasAttribute("disabled"),
    "a data: page has no site to clear"
  );
  await closeMenu(menu);
  BrowserTestUtils.removeTab(tab);
});

add_task(async function clearing_drops_the_sites_cache_and_reloads() {
  const other = await openPage(ORG_PAGE);
  await fetchCacheable(other.linkedBrowser);
  const tab = await openPage(PAGE);
  await fetchCacheable(tab.linkedBrowser);
  await TestUtils.waitForCondition(async () => {
    const hosts = await cachedHosts();
    return hosts.includes("example.com") && hosts.includes("example.org");
  }, "both sites' fixtures are in the cache");

  const menu = await openReloadMenu();
  const reloaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    PAGE
  );
  menu.activateItem(menu.querySelector("#sval-reload-clear-cache"));
  await within(reloaded, 10_000, "the page reloading");
  await pageReady(tab.linkedBrowser, PAGE);

  const hosts = await cachedHosts();
  Assert.ok(!hosts.includes("example.com"), "the page's site is cleared");
  Assert.ok(hosts.includes("example.org"), "another site keeps its cache");
  BrowserTestUtils.removeTab(tab);
  BrowserTestUtils.removeTab(other);
});
