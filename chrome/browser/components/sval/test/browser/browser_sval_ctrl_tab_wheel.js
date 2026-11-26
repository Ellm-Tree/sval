/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_ctrl_tab_helpers.js */

/**
 * A wheel or a two-finger swipe in the Ctrl+Tab switcher (`SvalTabSwitcher`):
 * it slides the carousel down the tabs or back, stops at its ends, and
 * latches the switcher open, so letting Ctrl go picks nothing and Return or
 * a click picks.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_ctrl_tab_helpers.js",
  this
);

const { shortcutText } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalKeys.sys.mjs"
);

/** A wheel's travel per card (`WHEEL_PX_PER_CARD`). */
const CARD_PX = 90;

/**
 * Opens tabs titled A, B, C… in that order, so in order of use the last is
 * first and A last.
 *
 * @param {number} count
 * @returns {Promise<Element[]>}
 */
async function lettered(count) {
  const tabs = [];
  for (let i = 0; i < count; i++) {
    tabs.push(await openPage(titledPage(String.fromCharCode(65 + i))));
  }
  return tabs;
}

/**
 * Turns the wheel over the carousel, by pixels, Ctrl held when `ctrlKey`
 * says so.
 *
 * @param {object} delta
 * @param {number} [delta.deltaX]
 * @param {number} [delta.deltaY]
 * @param {boolean} [delta.ctrlKey]
 */
function wheel({ deltaX = 0, deltaY = 0, ctrlKey = false }) {
  const list = document.getElementById("sval-tab-switcher-list");
  const rect = list.getBoundingClientRect();
  EventUtils.synthesizeWheel(list, rect.width / 2, rect.height / 2, {
    deltaX,
    deltaY,
    ctrlKey,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
  });
}

/**
 * @param {string} title
 * @param {string} what
 */
async function selects(title, what) {
  await TestUtils.waitForCondition(() => selectedTitle() === title, what);
  Assert.equal(selectedTitle(), title, what);
}

add_task(async function a_wheel_slides_either_way_and_stops_at_the_ends() {
  await lettered(4);
  await holdCtrlTab();
  Assert.equal(selectedTitle(), "C", "C is selected");

  wheel({ deltaY: CARD_PX, ctrlKey: true });
  await selects("B", "a wheel down moves to the older tab");
  wheel({ deltaX: CARD_PX, ctrlKey: true });
  await selects("A", "and a sideways one too");
  const options = switcherOptions();
  const oldest = optionTitle(options.at(-1));
  wheel({ deltaY: CARD_PX * options.length, ctrlKey: true });
  await selects(oldest, "the oldest tab is as far as it goes");
  wheel({ deltaY: -CARD_PX * options.length * 2, ctrlKey: true });
  await selects("D", "and back up, the newest");

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the switcher closing"
  );
  await releaseCtrl();
});

add_task(async function a_wheel_latches_the_switcher_open() {
  const [a, , , d] = await lettered(4);
  await holdCtrlTab();
  const footer = document.querySelector(".sval-switcher-footer");
  const keys = () =>
    [...footer.querySelectorAll(".sval-keycap")].map(cap => cap.textContent);
  const ret = shortcutText({ keycode: "VK_RETURN" });
  Assert.ok(!keys().includes(ret), "the footer has no Return before");

  wheel({ deltaY: CARD_PX * 2, ctrlKey: true });
  await selects("A", "the wheel moves to A");
  Assert.ok(keys().includes(ret), "and the footer offers Return to switch");

  EventUtils.synthesizeKey("KEY_Control", { type: "keyup" });
  Assert.ok(switcherShown(), "letting Ctrl go leaves the switcher open");
  Assert.equal(gBrowser.selectedTab, d, "and the tab shown as it was");

  EventUtils.synthesizeKey("KEY_Enter");
  await switchDone(window);
  Assert.ok(!switcherShown(), "Return closes the switcher");
  Assert.equal(gBrowser.selectedTab, a, "and shows the tab selected");
});

add_task(async function a_wheel_over_the_panel_slides_the_carousel() {
  await lettered(4);
  await holdCtrlTab();
  wheel({ deltaY: CARD_PX, ctrlKey: true });
  await selects("B", "the wheel moves to B");
  EventUtils.synthesizeKey("KEY_Control", { type: "keyup" });

  const panel = SvalPanel.container;
  const rect = panel.getBoundingClientRect();
  EventUtils.synthesizeWheel(panel, rect.width / 2, rect.height / 2, {
    deltaX: CARD_PX,
    deltaMode: WheelEvent.DOM_DELTA_PIXEL,
  });
  await selects("A", "a wheel over the panel moves the carousel on");
  Assert.ok(switcherShown(), "and leaves it open");

  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the switcher closing"
  );
});
