/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */

/**
 * A workspace tab's icon is kept on this device (`SvalFavoriteIcons`): a tab
 * showing a page keeps its icon, a row with no live tab draws it once Places
 * has none, and closing the tab takes it.
 */

const { SvalFavoriteIcons } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFavoriteIcons.sys.mjs"
);

const ICON_PAGE = ROOT + "sval_favorite_icon.html";

add_setup(async function () {
  await SvalFavoriteIcons.whenLoaded();
});

add_task(async function a_tab_icon_outlasts_history_and_goes_with_the_tab() {
  Assert.equal(
    SvalFavoriteIcons.iconFor(ICON_PAGE),
    null,
    "no icon before a visit"
  );
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, ICON_PAGE),
    10_000,
    "the page loading"
  );
  try {
    await TestUtils.waitForCondition(
      () => SvalFavoriteIcons.iconFor(ICON_PAGE)?.startsWith("data:image/"),
      "the tab's page gives its address an icon"
    );
    await PlacesUtils.history.clear();
    const img = document.createElement("img");
    SvalPanel._els.tree.append(img);
    try {
      await SvalPanel.fillTabIcon(img, "no-live-tab", ICON_PAGE);
      Assert.equal(
        img.getAttribute("src"),
        SvalFavoriteIcons.iconFor(ICON_PAGE),
        "a row with no live tab draws the kept icon once Places has none"
      );
    } finally {
      img.remove();
    }
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
  await within(
    SvalPanel.observer.settled(),
    10_000,
    "SvalPanel.observer settling"
  );
  await TestUtils.waitForCondition(
    () => SvalFavoriteIcons.iconFor(ICON_PAGE) === null,
    "closing the only tab at the address takes its icon"
  );
});
