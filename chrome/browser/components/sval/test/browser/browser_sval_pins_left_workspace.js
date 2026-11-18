/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_pins_helpers.js */

/**
 * What a switch does to the pins of the workspace it leaves (pins spec §5):
 * their pages stay loaded, as the workspace's tabs do, and unload once the
 * workspace has been out of sight long enough.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_pins_helpers.js",
  this
);

add_setup(pinsSetup);

const { HIDDEN_WORKSPACE_UNLOAD_MS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { SvalClock } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalClock.sys.mjs"
);

/**
 * Runs the window's sweep of pin pages as it runs once every workspace the
 * window has left has been out of sight for its whole allowance
 * (`SvalPinPages.parkIdle`).
 *
 * @returns {Promise<void>}
 */
function unloadLeftPinsNow() {
  return within(
    SvalPinPages.of(window).parkIdle(
      SvalClock.now() + HIDDEN_WORKSPACE_UNLOAD_MS
    ),
    20_000,
    "the sweep of the pins left behind"
  );
}

/**
 * @param {string} guid
 * @returns {boolean} whether the pin's tile shows it as having no page.
 */
function drawnUnloaded(guid) {
  return tileOf(guid).closest(".sval-pin-slot").hasAttribute("data-unloaded");
}

/**
 * The window comes back to Home on the tab chosen after the pin, so the
 * pin's tile says whether its page outlived the time away: coming back on
 * the pin itself would load it either way.
 */
add_task(async function a_left_workspaces_pin_stays_loaded_until_its_time() {
  const { home, work } = pinsFixture;
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, PAGE2),
    10_000,
    "a tab of Home's"
  );
  await within(SvalPanel.observer.settled(), 10_000, "the observer settling");
  const id = SvalPanel.observer.nodeIdFor(tab);
  atTaskEnd(async () => {
    const nodes = (await SvalPanel.engine.tree()).nodes ?? {};
    if (nodes[id]) {
      await SvalPanel.engine.mutate({ kind: "remove", id, now: Date.now() });
    }
  });
  const guid = await pinFavorite(PAGE, "Kept");
  const pinPage = await clickTile(guid, PAGE);
  await selectTab(tab);
  Assert.ok(!drawnUnloaded(guid), "the pin's page is loaded behind the tab");

  expectWorkspaceTabs();
  await showWorkspace(work);
  Assert.ok(
    pinPage.isConnected && pinPage.linkedPanel,
    "the switch away leaves the pin's page loaded"
  );
  await showWorkspace(home);
  Assert.equal(gBrowser.selectedTab, tab, "back in Home, on the tab left");
  Assert.ok(!drawnUnloaded(guid), "the pin's tile shows its page loaded");
  Assert.equal(
    SvalPinPages.of(window).tabOf(guid),
    pinPage,
    "and it is the page the pin had"
  );

  await showWorkspace(work);
  await unloadLeftPinsNow();
  Assert.ok(
    pinPage.isConnected && !pinPage.linkedPanel,
    "once Home has been out of sight long enough, its pin's page unloads"
  );
  await showWorkspace(home);
  Assert.equal(gBrowser.selectedTab, tab, "back in Home, on the tab left");
  Assert.ok(drawnUnloaded(guid), "and the pin's tile shows it unloaded");
});
