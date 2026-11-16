/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A favorite's icon is this device's own (favorites-native spec §5.4): one
 * visit gives a favorite saved as a redirecting address the icon of the page
 * it lands on, Clear History leaves it, and a private window gives none.
 */

const { SvalFavorites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavorites.sys.mjs"
);
const { SvalFavoriteIcons } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs"
);

const ICON_PAGE = ROOT + "sval_favorite_icon.html";
const REDIRECT =
  ROOT + "sval_agent_redirect.sjs?" + encodeURIComponent(ICON_PAGE);

let favorites;

add_setup(async function () {
  ({ store: favorites } = await favoritesFixture());
  await SvalFavoriteIcons.whenLoaded();
});

add_task(async function a_redirecting_favorite_keeps_its_landing_icon() {
  const [guid] = await favorites.insertTree([
    { title: "Lands elsewhere", url: REDIRECT },
  ]);
  Assert.equal(
    SvalFavoriteIcons.iconFor(REDIRECT),
    null,
    "no icon before a visit"
  );
  const opened = BrowserTestUtils.waitForNewTab(gBrowser, ICON_PAGE, true);
  SvalFavorites.open(window, favorites.get(guid), { where: "tab" });
  const tab = await within(opened, 10_000, "the favorite's page loading");
  try {
    await TestUtils.waitForCondition(
      () => SvalFavoriteIcons.iconFor(REDIRECT)?.startsWith("data:image/"),
      "the favorite takes the icon of the page it landed on"
    );
    await PlacesUtils.history.clear();
    Assert.ok(
      SvalFavoriteIcons.iconFor(REDIRECT)?.startsWith("data:image/"),
      "Clear History leaves the favorite's icon"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
  // The landing page's icon is its tab's, which goes with the tab.
  await TestUtils.waitForCondition(
    () => SvalFavoriteIcons.iconFor(ICON_PAGE) === null,
    "the page it landed on is not a favorite, so it keeps none of its own"
  );
  await favorites.delete(guid);
  Assert.equal(
    SvalFavoriteIcons.iconFor(REDIRECT),
    null,
    "deleting the favorite takes its icon"
  );
});

add_task(async function a_private_window_keeps_no_icon() {
  const [guid] = await favorites.insertTree([
    { title: "Has an icon", url: ICON_PAGE },
  ]);
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20_000,
    "the private window opening"
  );
  try {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, ICON_PAGE),
      10_000,
      "the private tab loading"
    );
    await TestUtils.waitForCondition(
      () => tab.linkedBrowser.mIconURL?.startsWith("data:"),
      "the private tab shows the page's icon"
    );
    Assert.equal(
      SvalFavoriteIcons.iconFor(ICON_PAGE),
      null,
      "a private window gives the favorite no icon"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      20_000,
      "the private window closing"
    );
  }
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, ICON_PAGE),
    10_000,
    "the tab loading"
  );
  try {
    await TestUtils.waitForCondition(
      () => SvalFavoriteIcons.iconFor(ICON_PAGE)?.startsWith("data:image/"),
      "a tab showing the favorite's address gives it the page's icon"
    );
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
  await favorites.delete(guid);
});
