/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_launcher_home_helpers.js */

/**
 * The address bar in the toolbar, the floating Launcher and the home page's
 * field open the same pick in the same place for the same key or click
 * (launcher spec §3): this tab, a new tab in front or behind, or a new
 * window, and a new tab in the workspace the window shows.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_launcher_home_helpers.js",
  this
);

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);
const { ancestorIds } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTree.sys.mjs"
);

add_setup(failOnConsoleErrors);
add_setup(async function () {
  await PlacesUtils.history.clear();
  registerCleanupFunction(async () => {
    await UrlbarTestUtils.promisePopupClose(window);
    gURLBar.handleRevert();
    await PlacesUtils.history.clear();
  });
});

const SURFACES = ["address bar", "Launcher", "home page field"];

/**
 * Each pick and where it opens a page's row, from a home tab. A home tab is
 * empty, so Alt+Enter's split loads in it, as it does in any empty tab.
 */
const PICKS = [
  { name: "Enter", key: {}, lands: "this tab" },
  { name: "Accel+Enter", key: { accelKey: true }, lands: "this tab" },
  { name: "Shift+Enter", key: { shiftKey: true }, lands: "a new tab in front" },
  {
    name: "Accel+Shift+Enter",
    key: { accelKey: true, shiftKey: true },
    lands: "a new window",
  },
  { name: "Alt+Enter", key: { altKey: true }, lands: "this tab" },
  { name: "a click", click: {}, lands: "this tab" },
  {
    name: "Accel+click",
    click: { accelKey: true },
    lands: "a new tab in front",
  },
  { name: "a middle-click", click: { button: 1 }, lands: "a new tab in front" },
  {
    name: "Accel+Shift+click",
    click: { accelKey: true, shiftKey: true },
    lands: "a new tab behind",
  },
  { name: "Shift+click", click: { shiftKey: true }, lands: "a new window" },
];

/**
 * Lists `PAGE`'s row in `surface`, on the home tab `browser` shows.
 *
 * @param {string} surface
 * @param {object} browser
 */
async function listPage(surface, browser) {
  if (surface === "address bar") {
    await within(
      UrlbarTestUtils.promiseAutocompleteResultPopup({ window, value: PAGE }),
      10_000,
      "the address bar's rows"
    );
    return;
  }
  if (surface === "Launcher") {
    browser.focus();
    await within(
      UrlbarTestUtils.promisePopupOpen(window, () =>
        EventUtils.synthesizeKey("l", { accelKey: true })
      ),
      10_000,
      "the Launcher's list"
    );
    await TestUtils.waitForCondition(
      () => gURLBar.hasAttribute("sval-launcher-floating"),
      "the address bar floats"
    );
    const searched = UrlbarTestUtils.promiseSearchComplete(window);
    EventUtils.sendString(PAGE);
    await within(searched, 10_000, "the Launcher's rows");
    return;
  }
  await typeInHomeField(browser, PAGE);
  await SpecialPowers.spawn(browser, [], () =>
    ContentTaskUtils.waitForCondition(
      () => content.document.querySelector(".suggestions [aria-selected=true]"),
      "the row Enter takes is listed"
    ).then(() => undefined)
  );
}

/**
 * Picks the first row of `surface` as `pick` says.
 *
 * @param {string} surface
 * @param {object} browser
 * @param {object} pick One of {@link PICKS}.
 */
async function pickFirstRow(surface, browser, pick) {
  if (surface === "home page field") {
    if (pick.key) {
      await BrowserTestUtils.synthesizeKey("KEY_Enter", pick.key, browser);
    } else {
      await BrowserTestUtils.synthesizeMouseAtCenter(
        ".suggestions [aria-selected=true]",
        pick.click,
        browser
      );
    }
    return;
  }
  if (pick.key) {
    EventUtils.synthesizeKey("KEY_Enter", pick.key);
    return;
  }
  const row = await UrlbarTestUtils.waitForAutocompleteResultAt(window, 0);
  EventUtils.synthesizeMouseAtCenter(row, pick.click);
}

/**
 * Resolves with the first place a page opens: a new tab, a new window, or
 * `PAGE` in `browser`.
 *
 * @param {object} browser
 * @returns {{first: Promise<object>, stop: Function}}
 */
function firstOpening(browser) {
  const { promise, resolve } = Promise.withResolvers();
  const onTab = event => resolve({ tab: event.target });
  const onWindow = (subject, topic) => {
    if (topic === "domwindowopened") {
      resolve({ win: subject });
    }
  };
  const onLocation = {
    onLocationChange(changed, progress, request, location) {
      if (changed === browser && location.spec === PAGE) {
        resolve({ here: true });
      }
    },
  };
  gBrowser.tabContainer.addEventListener("TabOpen", onTab);
  Services.ww.registerNotification(onWindow);
  gBrowser.addTabsProgressListener(onLocation);
  const stop = () => {
    gBrowser.tabContainer.removeEventListener("TabOpen", onTab);
    Services.ww.unregisterNotification(onWindow);
    gBrowser.removeTabsProgressListener(onLocation);
  };
  atTaskEnd(stop);
  return { first: promise, stop };
}

/**
 * Where `pick` in `surface` opens `PAGE` from a new home tab, which it then
 * closes with whatever opened.
 *
 * @param {string} surface
 * @param {object} pick One of {@link PICKS}.
 * @returns {Promise<string>} as {@link PICKS} names the places.
 */
async function whereItLands(surface, pick) {
  const what = `${pick.name} in the ${surface}`;
  const { tab } = await homeTab();
  const browser = tab.linkedBrowser;
  await listPage(surface, browser);
  const opening = firstOpening(browser);
  await pickFirstRow(surface, browser, pick);
  const opened = await within(opening.first, 10_000, `${what} opens the page`);
  opening.stop();

  let lands;
  if (opened.here) {
    await pageReady(browser, PAGE);
    lands = "this tab";
  } else if (opened.tab) {
    expectOpened(opened.tab);
    await pageReady(opened.tab.linkedBrowser, PAGE);
    lands =
      gBrowser.selectedTab === opened.tab
        ? "a new tab in front"
        : "a new tab behind";
    await within(
      SvalPanel.observer.settled(),
      10_000,
      "SvalPanel.observer settling"
    );
    const id = SvalPanel.observer.nodeIdFor(opened.tab);
    const all = (await SvalPanel.engine.tree()).nodes ?? {};
    Assert.ok(
      ancestorIds(all, id).includes(SvalPanel.workspaceId),
      `${what}: the new tab is in the workspace the window shows`
    );
    BrowserTestUtils.removeTab(opened.tab);
  } else {
    const win = opened.win;
    expectOpened(win);
    await TestUtils.waitForCondition(
      () => win.SvalPanel?.initialized,
      "the new window's panel starts"
    );
    await within(win.SvalPanel.started, 10_000, "its first pass");
    await pageReady(win.gBrowser.selectedBrowser, PAGE);
    lands = "a new window";
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the new window closing"
    );
  }
  await UrlbarTestUtils.promisePopupClose(window);
  gURLBar.handleRevert();
  if (gBrowser.tabs.includes(tab)) {
    BrowserTestUtils.removeTab(tab);
  }
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  await PlacesUtils.history.clear();
  return lands;
}

for (const pick of PICKS) {
  add_task(async function a_pick_lands_in_the_same_place_from_every_surface() {
    for (const surface of SURFACES) {
      Assert.equal(
        await whereItLands(surface, pick),
        pick.lands,
        `${pick.name} in the ${surface} opens the page in ${pick.lands}`
      );
    }
  });
}
