/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The header's row at every window width from the window's minimum up: no
 * two controls overlap, each is in the row or in an overflow panel, the
 * address bar keeps its minimum width, and the controls leave the row in
 * their order (`sval-header.css`, `SvalHeader`). An overflowed control works
 * from the overflow panel.
 */

ChromeUtils.defineESModuleGetters(this, {
  CustomizableUI:
    "moz-src:///browser/components/customizableui/CustomizableUI.sys.mjs",
});

const PINS_PREF = "browser.sval.siteControls.toolbarButtons";

/** The controls that overflow, first to leave first. */
const LEAVE_ORDER = [
  "split-view-button",
  "sval-history-button",
  "downloads-button",
  "reader-mode-button",
  "sval-favorite-button",
  "sval-clean-address-button",
  "sval-colorshift-button",
  "sval-snip-button",
  "sval-remove-button",
  "sval-javascript-button",
  "sval-media-button",
  "sval-site-menu-button",
  "home-button",
  "stop-reload-button",
  "forward-button",
];

/** The controls that never leave the row. */
const KEPT = ["sval-panel-button", "back-button", "urlbar-container"];

/**
 * Resizes `win` to `width`, or to its minimum where `width` is below it, and
 * waits for the nav-bar's overflow handling to finish there.
 *
 * @param {Window} win
 * @param {number} width
 */
async function sizeTo(win, width) {
  const target = Math.max(width, minOuterWidth(win));
  if (win.outerWidth !== target) {
    const resized = BrowserTestUtils.waitForEvent(win, "resize");
    win.resizeTo(target, win.outerHeight);
    await within(resized, 10_000, `the window resizing to ${target}`);
    await windowStill(win);
  }
  await settled(win);
}

/**
 * Waits for the nav-bar's overflow handling to finish. A control the
 * handling moves changes size, and the toolbar's resize observer starts
 * another check from a runnable it dispatches (`#itemResizeObserver` in
 * CustomizableUI.sys.mjs). Resize observers run in the refresh that
 * `promiseDocumentFlushed` resolves after, so a runnable dispatched then
 * runs after the toolbar's. The handling has finished once a refresh passes
 * with no check started.
 *
 * @param {Window} win
 */
async function settled(win) {
  const navbar = win.document.getElementById("nav-bar");
  const handling = () => navbar.overflowable.isHandlingOverflow();
  await within(
    (async () => {
      for (;;) {
        await win.promiseDocumentFlushed(() => {});
        await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
        if (!handling()) {
          return;
        }
        await TestUtils.waitForCondition(
          () => !handling(),
          "the overflow handling finishes"
        );
      }
    })(),
    10_000,
    "the overflow handling settling"
  );
}

/**
 * @param {Window} win
 * @returns {number} The window's minimum outer width.
 */
function minOuterWidth(win) {
  const frame = win.outerWidth - win.innerWidth;
  const min = parseFloat(
    win.getComputedStyle(win.document.documentElement).minWidth
  );
  return Math.ceil(min) + frame;
}

/**
 * The row's controls that take room, in order.
 *
 * @param {Window} win
 * @returns {Element[]}
 */
function rowControls(win) {
  const navbar = win.document.getElementById("nav-bar");
  return [
    ...navbar.querySelectorAll(
      ":scope > :not(#nav-bar-customization-target), #nav-bar-customization-target > *"
    ),
  ].filter(el => el.getBoundingClientRect().width > 0);
}

/**
 * @param {Window} win
 * @param {Element} node
 * @returns {boolean} Whether `node` is in the overflow panel.
 */
function overflowed(win, node) {
  return win.document.getElementById("widget-overflow-list").contains(node);
}

/**
 * Asserts the row's state at the window's present width.
 *
 * @param {Window} win
 * @param {number} addressMin The width the address bar keeps at least.
 */
function checkRow(win, addressMin) {
  const doc = win.document;
  const at = `at ${win.outerWidth}px`;
  const navbar = doc.getElementById("nav-bar");
  const bounds = navbar.getBoundingClientRect();
  const controls = rowControls(win)
    .map(el => ({
      id: el.id || el.className,
      rect: el.getBoundingClientRect(),
    }))
    .sort((a, b) => a.rect.left - b.rect.left);
  const layout = controls
    .map(c => `${c.id} ${Math.round(c.rect.left)}-${Math.round(c.rect.right)}`)
    .join(", ");
  for (const { id, rect } of controls) {
    Assert.ok(
      rect.left >= bounds.left - 0.5 && rect.right <= bounds.right + 0.5,
      `${at}, ${id} is inside the row (${layout})`
    );
  }
  // `OverflowableToolbar.#getOverflowInfo` floors the row's content width
  // and ceils the room, so a row may run past its room by under 1px
  // without overflowing, which a fractional scale factor draws.
  for (let i = 1; i < controls.length; i++) {
    Assert.less(
      controls[i - 1].rect.right,
      controls[i].rect.left + 1,
      `${at}, ${controls[i - 1].id} ends before ${controls[i].id} starts (${layout})`
    );
  }
  const urlbar = doc.getElementById("urlbar-container");
  Assert.greaterOrEqual(
    urlbar.getBoundingClientRect().width,
    addressMin - 0.5,
    `${at}, the address bar keeps its minimum (${layout})`
  );
  const kept = [...KEPT];
  if (doc.documentElement.hasAttribute("privatebrowsingmode")) {
    kept.push("sval-private-badge");
  }
  for (const id of kept) {
    const node = doc.getElementById(id);
    Assert.equal(
      node.parentElement.id,
      "nav-bar-customization-target",
      `${at}, ${id} stays in the row`
    );
    Assert.greater(
      node.getBoundingClientRect().width,
      0,
      `${at}, ${id} takes room in the row`
    );
  }
  const anyOut = LEAVE_ORDER.some(id => {
    const node = doc.getElementById(id);
    return node && !node.hidden && overflowed(win, node);
  });
  if (anyOut) {
    Assert.greater(
      doc.getElementById("nav-bar-overflow-button").getBoundingClientRect()
        .width,
      0,
      `${at}, the overflow button shows while a control is in its panel`
    );
  }
  let firstInRow = null;
  for (const id of LEAVE_ORDER) {
    const node = doc.getElementById(id);
    if (!overflowed(win, node)) {
      firstInRow ??= id;
    } else if (firstInRow) {
      Assert.ok(
        false,
        `${at}, ${id} overflowed while ${firstInRow} is in the row`
      );
    }
  }
  for (const id of CustomizableUI.getWidgetIdsInArea(
    CustomizableUI.AREA_NAVBAR
  )) {
    const node = doc.getElementById(id);
    if (!node || node.hidden || win.getComputedStyle(node).display === "none") {
      continue;
    }
    const inRow = node.parentElement.id === "nav-bar-customization-target";
    const out =
      overflowed(win, node) ||
      (CustomizableUI.isWebExtensionWidget(id) &&
        node.getAttribute("overflowedItem") === "true");
    Assert.ok(inRow || out, `${at}, ${id} is in the row or the overflow panel`);
    if (inRow) {
      Assert.greater(
        node.getBoundingClientRect().width,
        0,
        `${at}, ${id} takes room in the row`
      );
    }
  }
}

/**
 * Walks `win` from its minimum width up to 1300px, checking the row at each
 * step, then back down, since controls come back in the order they left.
 *
 * @param {Window} win
 * @param {number} addressMin
 * @returns {Promise<number>} How many controls the panel held at the minimum.
 */
async function walkWidths(win, addressMin) {
  const start = win.outerWidth;
  const min = minOuterWidth(win);
  const widths = [];
  for (let width = min; width < 1300; width += 24) {
    widths.push(width);
  }
  widths.push(1300);
  let atMin = 0;
  for (const width of [...widths, ...widths.slice(0, -1).reverse()]) {
    await sizeTo(win, width);
    checkRow(win, addressMin);
    if (width === min) {
      atMin = LEAVE_ORDER.filter(id =>
        overflowed(win, win.document.getElementById(id))
      ).length;
    }
  }
  await sizeTo(win, start);
  return atMin;
}

/**
 * The address bar's minimum width, which `sval-header.css` sets.
 *
 * @param {Window} win
 * @returns {number}
 */
function tokenMin(win) {
  return parseFloat(
    win
      .getComputedStyle(win.document.documentElement)
      .getPropertyValue("--urlbar-container-min-width")
  );
}

/**
 * Opens a foreground tab on `url` in the main window.
 *
 * @param {string} url
 */
function openTab(url) {
  return within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "a tab opening"
  );
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      [PINS_PREF, JSON.stringify(["javascript", "snip"])],
      ["browser.download.autohideButton", false],
    ],
    // Firefox records the first press of the downloads button.
    clear: [["browser.engagement.downloads-button.has-used"]],
  });
});

add_task(async function the_row_fits_at_every_width() {
  const width = window.outerWidth;
  atTaskEnd(() => sizeTo(window, width));
  await openTab("https://example.com/");
  const atMin = await walkWidths(window, tokenMin(window));
  Assert.greater(atMin, 0, "the narrowest window overflows controls");
  await sizeTo(window, 1300);
  Assert.ok(
    LEAVE_ORDER.every(id => !overflowed(window, document.getElementById(id))),
    "every control is back in the row at 1300px"
  );
});

add_task(async function the_window_narrows_past_the_row() {
  // The window's minimum holds only what never leaves the row: every control
  // that can leave does not fit beside them at that width.
  const width = window.outerWidth;
  atTaskEnd(() => sizeTo(window, width));
  await sizeTo(window, 1300);
  const room = LEAVE_ORDER.map(id => document.getElementById(id))
    .filter(node => !node.hidden)
    .reduce((sum, node) => sum + node.getBoundingClientRect().width, 0);
  await sizeTo(window, 0);
  Assert.less(
    window.outerWidth,
    minOuterWidth(window) + room,
    "the window's minimum leaves no room for every control that can leave"
  );
});

add_task(async function the_order_holds_in_a_split() {
  const width = window.outerWidth;
  atTaskEnd(() => sizeTo(window, width));
  const tabs = [];
  for (let i = 0; i < 2; i++) {
    tabs.push(await openTab(`https://example.com/split-${i}`));
  }
  // Firefox records the first split it shows, as its own tests clear.
  registerCleanupFunction(() =>
    Services.prefs.clearUserPref("browser.tabs.splitview.hasUsed")
  );
  gBrowser.addTabSplitView(tabs);
  const split = document.getElementById("split-view-button");
  await TestUtils.waitForCondition(
    () => !split.hidden,
    "the split button shows"
  );
  await walkWidths(window, tokenMin(window));

  await sizeTo(window, 0);
  const list = document.getElementById("widget-overflow-list");
  const listed = [...list.children].map(node => node.id);
  Assert.deepEqual(
    listed,
    CustomizableUI.getWidgetIdsInArea(CustomizableUI.AREA_NAVBAR).filter(id =>
      listed.includes(id)
    ),
    "the overflow panel lists its controls in the row's order"
  );

  const navbar = document.getElementById("nav-bar");
  const menu = document.getElementById("split-view-menu");
  await within(navbar.overflowable.show(), 5_000, "the overflow panel opening");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  EventUtils.synthesizeMouseAtCenter(split, {});
  await within(shown, 5_000, "the split view menu's popupshown");
  Assert.greater(
    menu.getBoundingClientRect().width,
    0,
    "the split view menu opens from the overflow panel"
  );
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await within(hidden, 5_000, "the split view menu's popuphidden");
});

add_task(async function a_private_window_fits_at_every_width() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    10_000,
    "a private window opening"
  );
  await walkWidths(win, tokenMin(win));
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the private window closing"
  );
});

add_task(async function every_pinned_site_control_fits_at_every_width() {
  await SpecialPowers.pushPrefEnv({
    set: [
      [
        PINS_PREF,
        JSON.stringify([
          "javascript",
          "remove",
          "snip",
          "colorshift",
          "clean-address",
        ]),
      ],
    ],
  });
  const width = window.outerWidth;
  atTaskEnd(() => sizeTo(window, width));
  await walkWidths(window, tokenMin(window));
});

add_task(async function a_control_that_appears_overflows() {
  // The reader button shows only on a page Reader View can read, after the
  // row has settled at its width.
  const width = window.outerWidth;
  atTaskEnd(() => sizeTo(window, width));
  await openTab("https://example.com/");
  await sizeTo(window, 1300);
  const reader = document.getElementById("reader-mode-button");
  const favorite = document.getElementById("sval-favorite-button");
  // The narrowest width that keeps the hidden reader button in the row.
  let fits = 1300;
  while (fits > minOuterWidth(window)) {
    await sizeTo(window, fits - 4);
    if (overflowed(window, reader)) {
      break;
    }
    fits -= 4;
  }
  // From above: a control comes back only once the row has more room than
  // it had when the control left (`#moveItemsBackToTheirOrigin`).
  await sizeTo(window, 1300);
  await sizeTo(window, fits);
  Assert.ok(!overflowed(window, reader), "the reader button is in the row");
  Assert.ok(!overflowed(window, favorite), "the favorite button is in the row");
  reader.hidden = false;
  atTaskEnd(() => {
    reader.hidden = true;
  });
  await TestUtils.waitForCondition(
    () => overflowed(window, reader),
    "the reader button overflows once it shows"
  );
  await settled(window);
  checkRow(window, tokenMin(window));
});

add_task(async function overflowed_controls_work_from_the_panel() {
  const width = window.outerWidth;
  atTaskEnd(() => sizeTo(window, width));
  await openTab("https://example.com/");
  await sizeTo(window, 0);
  const navbar = document.getElementById("nav-bar");
  const overflowButton = document.getElementById("nav-bar-overflow-button");

  for (const id of ["downloads-button", "sval-favorite-button"]) {
    Assert.ok(
      overflowed(window, document.getElementById(id)),
      `${id} is in the overflow panel at the minimum`
    );
  }

  const downloads = document.getElementById("downloadsPanel");
  await within(navbar.overflowable.show(), 5_000, "the overflow panel opening");
  const downloadsShown = BrowserTestUtils.waitForEvent(downloads, "popupshown");
  document.getElementById("downloads-button").click();
  await within(downloadsShown, 5_000, "the downloads panel's popupshown");
  Assert.ok(
    overflowButton.contains(downloads.anchorNode),
    "the downloads panel opens from the overflow button"
  );
  const downloadsHidden = BrowserTestUtils.waitForEvent(
    downloads,
    "popuphidden"
  );
  downloads.hidePopup();
  await within(downloadsHidden, 5_000, "the downloads panel's popuphidden");

  const favorite = document.getElementById("sval-favorite-button");
  const starred = favorite.hasAttribute("starred");
  await within(navbar.overflowable.show(), 5_000, "the overflow panel opening");
  favorite.click();
  await TestUtils.waitForCondition(
    () => favorite.hasAttribute("starred") !== starred,
    "the favorite button's state changes from the panel"
  );
  await within(navbar.overflowable.show(), 5_000, "the overflow panel opening");
  favorite.click();
  await TestUtils.waitForCondition(
    () => favorite.hasAttribute("starred") === starred,
    "the favorite button's state changes back from the panel"
  );
});

add_task(async function the_site_menu_opens_from_the_overflow_button() {
  // A private window's minimum leaves the least room beside the private
  // badge, so its site controls overflow on every platform.
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    10_000,
    "a private window opening"
  );
  await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, "https://example.com/"),
    10_000,
    "a tab opening"
  );
  await sizeTo(win, 0);
  const doc = win.document;
  const button = doc.getElementById("sval-site-menu-button");
  Assert.ok(
    overflowed(win, button),
    "the chevron is in the overflow panel at the minimum"
  );
  const navbar = doc.getElementById("nav-bar");
  const siteMenu = doc.getElementById("sval-site-menu");
  await within(navbar.overflowable.show(), 5_000, "the overflow panel opening");
  const menuShown = BrowserTestUtils.waitForEvent(siteMenu, "popupshown");
  button.click();
  await within(menuShown, 5_000, "the site menu's popupshown");
  Assert.ok(
    doc.getElementById("nav-bar-overflow-button").contains(siteMenu.anchorNode),
    "the site menu opens from the overflow button"
  );
  const menuHidden = BrowserTestUtils.waitForEvent(siteMenu, "popuphidden");
  siteMenu.hidePopup();
  await within(menuHidden, 5_000, "the site menu's popuphidden");
  await within(
    BrowserTestUtils.closeWindow(win),
    10_000,
    "the private window closing"
  );
});

add_task(async function the_overflow_panel_offers_no_customize_mode() {
  const panel = document.getElementById("widget-overflow");
  Assert.ok(
    !panel.querySelector('[command="cmd_CustomizeToolbars"]'),
    "the overflow panel has no item that opens customize mode"
  );
  Assert.ok(
    !document
      .getElementById("customizationPanelItemContextMenu")
      .querySelector('[command="cmd_CustomizeToolbars"]'),
    "an overflowed widget's context menu has no item that opens customize mode"
  );
});

add_task(async function the_overflow_button_draws_its_chevrons() {
  const { iconURL } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalIcons.sys.mjs"
  );
  const button = document.getElementById("nav-bar-overflow-button");
  const url = getComputedStyle(button)
    .listStyleImage.replace(/^url\("/, "")
    .replace(/"\)$/, "");
  const shapeOf = async href => {
    const text = await (await fetch(href)).text();
    const svg = new DOMParser().parseFromString(text, "image/svg+xml");
    return [...svg.querySelectorAll("path, polyline, circle, rect, line")].map(
      el => el.outerHTML.replace(/\s+/g, " ")
    );
  };
  Assert.deepEqual(
    await shapeOf(url),
    await shapeOf(iconURL("overflow")),
    "the » button draws the inventory's overflow chevrons"
  );
  Assert.notDeepEqual(
    await shapeOf(url),
    await shapeOf(iconURL("performance")),
    "and no gauge"
  );
});

add_task(async function the_overflow_button_closes_the_last_pill() {
  const width = window.outerWidth;
  atTaskEnd(() => sizeTo(window, width));
  await openTab("https://example.com/");
  await sizeTo(window, 0);
  const button = document.getElementById("nav-bar-overflow-button");
  const extensions = document.getElementById("unified-extensions-button");
  Assert.ok(button.checkVisibility(), "the » button shows");
  const iconOf = el =>
    el.querySelector(":scope > .toolbarbutton-icon").getBoundingClientRect();
  const box = button.getBoundingClientRect();
  const theirs = extensions.getBoundingClientRect();
  Assert.equal(iconOf(button).width, iconOf(extensions).width, "icon width");
  Assert.equal(iconOf(button).height, iconOf(extensions).height, "icon height");
  Assert.equal(box.height, theirs.height, "button height");
  Assert.equal(box.top, theirs.top, "on the same line");
  const style = getComputedStyle(button);
  const pill = getComputedStyle(extensions);
  for (const name of ["background-color", "border-top-color", "box-shadow"]) {
    Assert.equal(
      style.getPropertyValue(name),
      pill.getPropertyValue(name),
      `the » button is filled as the pills are: ${name}`
    );
  }
  // It closes the pill before it, with no gap between them.
  const before = [
    ...document.querySelectorAll(
      "#nav-bar-customization-target > :is(toolbarbutton, toolbaritem)"
    ),
  ]
    .filter(el => el.checkVisibility())
    .at(-1);
  Assert.equal(
    Math.round(box.left),
    Math.round(before.getBoundingClientRect().right),
    `the » button follows ${before.id} with no gap`
  );
  Assert.equal(
    getComputedStyle(before).borderEndEndRadius,
    "0px",
    `${before.id} leaves the pill's end to the » button`
  );
  Assert.equal(style.borderEndEndRadius, "999px", "which rounds it");
});

add_task(async function the_overflow_panel_is_as_wide_as_its_rows() {
  const width = window.outerWidth;
  atTaskEnd(() => sizeTo(window, width));
  await openTab("https://example.com/");
  await sizeTo(window, 0);
  const navbar = document.getElementById("nav-bar");
  const panel = document.getElementById("widget-overflow");
  await within(navbar.overflowable.show(), 5_000, "the overflow panel opening");
  atTaskEnd(async () => {
    if (panel.state !== "closed") {
      const hidden = BrowserTestUtils.waitForPopupEvent(panel, "hidden");
      PanelMultiView.hidePopup(panel);
      await within(hidden, 5_000, "the overflow panel closing");
    }
  });
  const rows = [
    ...document.querySelectorAll(
      "#widget-overflow .widget-overflow-list > :is(toolbarbutton, toolbaritem)"
    ),
  ].filter(row => row.checkVisibility());
  Assert.greater(rows.length, 0, "the panel holds rows");
  const view = document.getElementById("widget-overflow-mainView");
  // Each row as wide as its own icon and label make it.
  const natural = Math.max(
    ...rows.map(row => {
      const style = getComputedStyle(row);
      row.style.width = "max-content";
      const own = row.getBoundingClientRect().width;
      row.style.removeProperty("width");
      return own + parseFloat(style.marginLeft) + parseFloat(style.marginRight);
    })
  );
  const wide = view.getBoundingClientRect().width;
  Assert.lessOrEqual(
    wide,
    Math.ceil(natural) + 1,
    "the panel is no wider than its widest row needs"
  );
  Assert.less(
    wide,
    29 * parseFloat(getComputedStyle(view).fontSize),
    "and narrower than Firefox's main menu"
  );
  for (const row of rows) {
    const style = getComputedStyle(row);
    Assert.equal(style.borderTopStyle, "none", `${row.id} has no frame`);
    Assert.equal(style.boxShadow, "none", `${row.id} has no shadow`);
    const label = row.querySelector(":scope > .toolbarbutton-text");
    if (label) {
      Assert.lessOrEqual(
        label.scrollWidth,
        label.clientWidth,
        `${row.id}'s label is whole`
      );
    }
  }
});
