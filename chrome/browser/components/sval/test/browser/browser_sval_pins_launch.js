/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_panel_startup_helpers.js */

/**
 * A launch lands where this device left the workspace (pins spec §5): on the
 * pin looked at after every tab, at its saved address, and on the tab when
 * the tab came after.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_panel_startup_helpers.js",
  this
);

const { SvalFavoritesStore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoritesStore.sys.mjs"
);
const { SvalPinPages } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPinPages.sys.mjs"
);
const { SvalRestore } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalRestore.sys.mjs"
);

const PIN_PAGE = ROOT + "sval_quick_peek_links.html";

/**
 * A fresh profile's window holding one tab and one pin, the pin's tile
 * clicked once.
 *
 * @returns {Promise<object>} `{ profile, win, guid, tabId, tab }`.
 */
async function aProfileWithATabAndAPin() {
  const profile = await freshProfile();
  const win = await profile.open();
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, PAGE),
    10_000,
    "a tab opening"
  );
  await within(win.SvalPanel.observer.settled(), 10_000, "the tab filing");
  const tabId = win.SvalPanel.observer.nodeIdFor(tab);
  Assert.ok(tabId, "the tab is filed");

  const store = await within(
    SvalFavoritesStore.startFor(win.SvalPanel.engine),
    10_000,
    "the profile's Favorites"
  );
  const entry = { url: PIN_PAGE, title: "Links" };
  const [guid] = await store.insertTree([], { pins: [entry] });
  await clickPin(win, guid);
  return { profile, win, guid, tabId, tab };
}

/**
 * Clicks the pin's tile and waits for its page to show.
 *
 * @param {Window} win
 * @param {string} guid
 */
async function clickPin(win, guid) {
  const tile = () =>
    win.SvalPanel._els.pins.querySelector(
      `button.sval-pin[data-key="pin:${guid}"]`
    );
  await TestUtils.waitForCondition(tile, "the pin's tile shows");
  EventUtils.synthesizeMouseAtCenter(tile(), {}, win);
  await TestUtils.waitForCondition(
    () =>
      SvalPinPages.of(win)?.selectedGuid === guid &&
      win.gBrowser.selectedBrowser.currentURI.spec === PIN_PAGE,
    "the pin's page shows"
  );
}

/**
 * Relaunches the profile once its document is in its folder. The window it
 * opens is a launch's first window, which is the one that restores the
 * session (`SvalRestore.restoreOnce`).
 *
 * @param {object} profile
 * @param {Window} win
 * @returns {Promise<Window>}
 */
async function relaunch(profile, win) {
  Assert.ok(
    await within(win.SvalPanel.syncNow(), 10_000, "the pass before quitting"),
    "the tab and the pin reached the folder"
  );
  const claimed = SvalRestore._claimed;
  SvalRestore._claimed = false;
  atTaskEnd(() => {
    SvalRestore._claimed = claimed;
  });
  return profile.relaunch();
}

add_task(async function a_launch_lands_on_the_pin_looked_at_last() {
  const { profile, win, guid } = await aProfileWithATabAndAPin();

  const again = await relaunch(profile, win);
  await TestUtils.waitForCondition(
    () => SvalPinPages.of(again)?.selectedGuid === guid,
    "the relaunched window shows the pin"
  );
  await committed(again.gBrowser.selectedBrowser, PIN_PAGE);
  Assert.equal(
    again.gBrowser.selectedBrowser.currentURI.spec,
    PIN_PAGE,
    "at its saved address"
  );
});

add_task(async function a_launch_lands_on_a_tab_looked_at_after_the_pin() {
  const { profile, win, tabId, tab } = await aProfileWithATabAndAPin();
  await selectTab(tab);
  Assert.equal(
    SvalPinPages.of(win)?.selectedGuid ?? null,
    null,
    "the tab is chosen after the pin"
  );

  const again = await relaunch(profile, win);
  Assert.equal(
    SvalPinPages.of(again)?.selectedGuid ?? null,
    null,
    "no pin is selected"
  );
  Assert.equal(
    again.SvalPanel.observer.nodeIdFor(again.gBrowser.selectedTab),
    tabId,
    "the tab chosen last is"
  );
});
