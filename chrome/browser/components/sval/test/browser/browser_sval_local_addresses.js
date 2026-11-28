/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */
/* import-globals-from sval_favorites_menu_helpers.js */

/**
 * An address no other device may open (decision 1372). One this device
 * wrote is a pin, a favorite or a tab here as any other is. One another
 * device wrote is never opened: no pin tile, a disabled Favorites item whose
 * only command is Delete, and no tab.
 *
 * Another device's address is planted as a device whose list of such
 * addresses is empty writes one: `services.sync.engine.tabs.filteredSchemes`
 * cleared while it is written, so it carries no `local` mark.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_favorites_menu_helpers.js",
  this
);

const { SvalRestore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRestore.sys.mjs"
);
const { LOCAL_TOOLTIP } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesView.sys.mjs"
);

add_setup(pinsSetup);

const FILTERED_SCHEMES = "services.sync.engine.tabs.filteredSchemes";

/** A page of this directory, as a `file:` address. */
const FILE_PAGE = (() => {
  const file = getChromeDir(getResolvedURI(gTestPath));
  file.append("sval_agent_page.html");
  return Services.io.newFileURI(file).spec;
})();

/**
 * Whether `url` is {@link FILE_PAGE} as it loads: the file channel follows
 * the harness's symbolic links, so the directory it names can differ.
 *
 * @param {string} url
 * @returns {boolean}
 */
function isFilePage(url) {
  return url.startsWith("file:///") && url.endsWith("/sval_agent_page.html");
}

/**
 * The modifier of Firefox's numbered tab keys, which pins take over: Alt on
 * GNOME, the accel key elsewhere (`NUM_SELECT_TAB_MODIFIER`).
 */
const NUMBER_KEY =
  document.getElementById("key_selectTab1").getAttribute("modifiers") === "alt"
    ? { altKey: true }
    : { accelKey: true };

/**
 * Runs `write` as a device that syncs every address writes, so what it
 * writes carries no `local` mark, then reads Favorites again with this
 * device's list.
 *
 * @param {Function} write
 * @returns {Promise<*>} what `write` resolves to.
 */
async function asAnotherDevice(write) {
  await SpecialPowers.pushPrefEnv({ set: [[FILTERED_SCHEMES, ""]] });
  let written;
  try {
    written = await write();
  } finally {
    await SpecialPowers.popPrefEnv();
  }
  // Any write reads the document back, with the list as it stands.
  const { store } = pinsFixture;
  await store.delete(await store.newFolder(TOOLBAR, "re-read"));
  return written;
}

add_task(async function another_devices_pin_at_a_browser_page_gets_no_tile() {
  const { store } = pinsFixture;
  const web = await pinFavorite(PAGE, "Web");
  const planted = await asAnotherDevice(async () => {
    const guids = [];
    for (const url of [
      "chrome://browser/content/browser.xhtml",
      FILE_PAGE,
      "about:config",
      "data:text/html,<p>planted</p>",
    ]) {
      guids.push(await pinFavorite(url, "Planted"));
    }
    return guids;
  });
  for (const guid of planted) {
    Assert.ok(store.get(guid).refused, "held, and refused");
  }
  await TestUtils.waitForCondition(
    () => rowGuids().join() === web,
    "only the pin this device can open shows"
  );

  EventUtils.synthesizeKey("1", NUMBER_KEY);
  await TestUtils.waitForCondition(
    () =>
      selectedPinGuid() === web &&
      gBrowser.selectedBrowser.currentURI.spec === PAGE &&
      !gBrowser.selectedTab.hasAttribute("busy"),
    "⌘1 reaches the first pin that shows, and its page loads"
  );
  Assert.deepEqual(
    pinTabs().map(tab => tab.linkedBrowser.currentURI.spec),
    [PAGE],
    "and no page opens at a planted address"
  );
});

add_task(async function this_devices_file_pin_opens_and_says_it_stays() {
  const { store } = pinsFixture;
  const guid = await pinFavorite(FILE_PAGE, "Notes");
  Assert.ok(store.get(guid).local, "marked local");
  const tile = await untilPinShows(guid);
  Assert.ok(
    tile.title.endsWith(`\n${LOCAL_TOOLTIP}`),
    "its tooltip says it stays here"
  );
  EventUtils.synthesizeMouseAtCenter(tile, {});
  await TestUtils.waitForCondition(
    () =>
      selectedPinGuid() === guid &&
      isFilePage(gBrowser.selectedBrowser.currentURI.spec) &&
      !gBrowser.selectedTab.hasAttribute("busy"),
    "the pin's page shows"
  );
});

add_task(async function another_devices_favorite_can_only_be_deleted() {
  const { store } = pinsFixture;
  const planted = await asAnotherDevice(() =>
    store.add({ url: "about:config", title: "Planted" })
  );
  const notes = await store.add({ url: FILE_PAGE, title: "Notes" });
  atTaskEnd(() => store.delete(notes));

  const popup = await openFavorites();
  const bad = await itemIn(popup, row => row.guid === planted);
  Assert.ok(bad.disabled, "drawn disabled");
  const menu = await contextOn(bad);
  Assert.deepEqual(
    Array.from(menu.querySelectorAll(":scope > [data-sval-menu-id]"))
      .filter(el => !el.hidden)
      .map(el => el.getAttribute("data-sval-menu-id")),
    ["delete"],
    "Delete is its only command"
  );
  await chooseInContextMenu(menu, "delete");
  await TestUtils.waitForCondition(
    () => !store.get(planted),
    "and Delete removes it"
  );
  await closeMenus();

  // From a page: an empty tab is the one a favorite opens in
  // (`PlacesUIUtils.openNodeWithEvent`).
  await BrowserTestUtils.withNewTab(PAGE, async () => {
    const reopened = await openFavorites();
    const good = await itemIn(reopened, row => row.guid === notes);
    Assert.ok(!good.disabled, "this device's file favorite is enabled");
    Assert.equal(
      good.getAttribute("tooltiptext"),
      `Notes\n${LOCAL_TOOLTIP}`,
      "its tooltip names it and says it stays here"
    );
    const opened = BrowserTestUtils.waitForNewTab(gBrowser, isFilePage, true);
    EventUtils.synthesizeMouseAtCenter(good, { button: 1 });
    const tab = await within(opened, 10_000, "the favorite's page opening");
    BrowserTestUtils.removeTab(tab);
    await closeMenus();
  });
});

add_task(async function another_devices_tab_at_a_file_cannot_be_pinned() {
  const { engine, home, store } = pinsFixture;
  const id = await asAnotherDevice(() =>
    engine.mutate({
      kind: "addTab",
      parent: home,
      name: "Planted",
      url: FILE_PAGE,
      id: crypto.randomUUID(),
      now: Date.now(),
    })
  );
  atTaskEnd(() => engine.mutate({ kind: "remove", id }));
  await SvalPanel.refresh();
  Assert.ok(!SvalPanel.pins.canPin(id), "Pin is not offered for it");
  const before = store.all().length;
  Assert.equal(await SvalPanel.pins.pinTab(id), null, "and pins nothing");
  Assert.equal(store.all().length, before, "no Favorite is made of it");
  Assert.deepEqual(
    rowGuids().filter(guid => store.get(guid)?.url === FILE_PAGE),
    [],
    "and no tile shows it"
  );
});

add_task(async function another_devices_settings_tab_does_not_restore() {
  const node = { content: { url: "about:preferences", name: "Settings" } };
  Assert.equal(
    SvalRestore.open(window, node, crypto.randomUUID(), 0),
    null,
    "a tab another device wrote at a settings page gets no tab"
  );
});
