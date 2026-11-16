/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_ctrl_tab_helpers.js */

/**
 * The Ctrl+Tab switcher's keys and clicks (`SvalTabSwitcher`, keyed by
 * Firefox's `ctrlTab`): Ctrl+Tab and Ctrl+Shift+Tab step through the tabs and
 * the arrows move, letting Ctrl go picks, Escape cancels, Ctrl+W and Delete
 * close the selected tab, and a click picks.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_ctrl_tab_helpers.js",
  this
);

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

add_task(async function ctrl_tab_steps_and_letting_go_picks() {
  const [a, , , d] = await lettered(4);
  Assert.equal(gBrowser.selectedTab, d, "D is shown");

  await holdCtrlTab(2);
  Assert.equal(
    selectedTitle(),
    "B",
    "two presses select the tab used before C"
  );
  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true, shiftKey: true });
  Assert.equal(selectedTitle(), "C", "Ctrl+Shift+Tab steps back");
  EventUtils.synthesizeKey("KEY_ArrowRight", { ctrlKey: true });
  EventUtils.synthesizeKey("KEY_ArrowRight", { ctrlKey: true });
  Assert.equal(selectedTitle(), "A", "the right arrow steps on");
  EventUtils.synthesizeKey("KEY_ArrowLeft", { ctrlKey: true });
  Assert.equal(selectedTitle(), "B", "and the left arrow back");

  await releaseCtrl();
  Assert.ok(!switcherShown(), "letting Ctrl go closes the switcher");
  Assert.equal(gBrowser.selectedTab.label, "B", "and shows the tab picked");
  Assert.notEqual(gBrowser.selectedTab, a, "past the others");
});

add_task(async function escape_cancels() {
  const [, , c] = await lettered(3);
  await holdCtrlTab();
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the switcher closing"
  );
  await releaseCtrl();
  Assert.equal(gBrowser.selectedTab, c, "the tab shown stays shown");
});

add_task(async function ctrl_w_and_delete_close_the_selected_tab() {
  const [, b, c, d, e] = await lettered(5);
  await holdCtrlTab();
  Assert.equal(selectedTitle(), "D", "D is selected");

  const closed = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabClose"
  );
  EventUtils.synthesizeKey("w", { ctrlKey: true });
  await within(closed, 10_000, "Ctrl+W closing a tab");
  Assert.ok(!d.isConnected, "Ctrl+W closed the selected tab");
  Assert.ok(e.isConnected, "and left the tab shown");
  Assert.ok(switcherShown(), "the switcher stays");
  Assert.ok(
    !switcherOptions().map(optionTitle).includes("D"),
    "without the tab closed"
  );
  Assert.equal(selectedTitle(), "C", "selecting the next one");

  const closedAgain = BrowserTestUtils.waitForEvent(
    gBrowser.tabContainer,
    "TabClose"
  );
  EventUtils.synthesizeKey("KEY_Delete", { ctrlKey: true });
  await within(closedAgain, 10_000, "Delete closing a tab");
  Assert.ok(!c.isConnected, "Delete closed the selected tab");

  await releaseCtrl();
  Assert.equal(gBrowser.selectedTab, b, "letting go picks the one selected");
});

add_task(async function a_click_picks() {
  await moveWindowOnScreen();
  await lettered(4);
  await holdCtrlTab();
  const option = switcherOptions().find(item => optionTitle(item) === "B");
  const rect = option.getBoundingClientRect();
  const x = window.mozInnerScreenX + rect.left + rect.width / 2;
  const y = window.mozInnerScreenY + rect.top + rect.height / 2;
  await nativeMouse({ type: "mousedown", screenX: x, screenY: y });
  await nativeMouse({
    type: "mouseup",
    screenX: x,
    screenY: y,
    eventTargetToListen: option,
    eventTypeToWait: "click",
  });
  // The click is heard as it is dispatched, before the switcher answers it.
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the click closing the switcher"
  );
  await switchDone(window);
  Assert.equal(gBrowser.selectedTab.label, "B", "and shows the tab clicked");
  await releaseCtrl();
});

add_task(async function ctrl_backquote_steps_back_while_the_switcher_shows() {
  const [, , c] = await lettered(4);
  await holdCtrlTab(2);
  Assert.equal(selectedTitle(), "B", "two presses select B");
  EventUtils.synthesizeKey("`", { ctrlKey: true, code: "Backquote" });
  Assert.equal(selectedTitle(), "C", "Ctrl+` steps back one tab");
  EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
  Assert.equal(selectedTitle(), "B", "and Ctrl+Tab steps on again");
  EventUtils.synthesizeKey("`", { ctrlKey: true, code: "Backquote" });
  await releaseCtrl();
  Assert.ok(!switcherShown(), "letting Ctrl go closes the switcher");
  Assert.equal(gBrowser.selectedTab, c, "and shows the tab stepped back to");
});

add_task(
  async function ctrl_backquote_is_the_pages_while_the_switcher_is_closed() {
    await lettered(3);
    const page = await openPage(
      `${ROOT}sval_switcher_page.sjs?${encodeURIComponent(
        `<title>Listening</title><script>addEventListener("keydown", e => {` +
          `if (e.code === "Backquote" && e.ctrlKey) window.heard = true; });` +
          `</script>`
      )}`
    );
    page.linkedBrowser.focus();
    EventUtils.synthesizeKey("`", { ctrlKey: true, code: "Backquote" });
    await TestUtils.waitForCondition(
      () =>
        SpecialPowers.spawn(
          page.linkedBrowser,
          [],
          () => content.wrappedJSObject.heard === true
        ),
      "the page hearing Ctrl+`"
    );
    Assert.equal(gBrowser.selectedTab, page, "the tab shown stays shown");
    Assert.ok(!switcherShown(), "and no switcher opens");
  }
);

add_task(async function the_heading_and_footer_frame_the_tiles_that_scroll() {
  await lettered(3);
  for (let i = 0; i < 60; i++) {
    BrowserTestUtils.addTab(gBrowser, titledPage(`Many ${i}`), {
      createLazyBrowser: true,
    });
  }
  await holdCtrlTab();
  const card = document.querySelector(".sval-switcher-card");
  const heading = card.querySelector(".sval-switcher-heading");
  const scroller = card.querySelector(".sval-switcher-scroller");
  const footer = card.querySelector(".sval-switcher-footer");
  Assert.equal(
    footer.getAttribute("aria-hidden"),
    "true",
    "the footer's keys are for the eye alone"
  );
  Assert.equal(
    footer.querySelectorAll(".sval-switcher-pair .sval-keycap").length,
    5,
    "it shows five keys"
  );
  Assert.greater(
    scroller.scrollHeight,
    scroller.clientHeight,
    "the tiles run past the card"
  );
  scroller.scrollTop = 0;
  await TestUtils.waitForCondition(
    () =>
      footer.hasAttribute("sval-over-rows") &&
      !heading.hasAttribute("sval-over-rows"),
    "at the top, the footer shading the tiles below it"
  );
  Assert.ok(
    footer.hasAttribute("sval-over-rows"),
    "at the top, the footer shades the tiles below"
  );
  scroller.scrollTop = scroller.scrollHeight;
  await TestUtils.waitForCondition(
    () =>
      heading.hasAttribute("sval-over-rows") &&
      !footer.hasAttribute("sval-over-rows"),
    "at the bottom, the heading shading the tiles above it"
  );
  Assert.ok(
    heading.hasAttribute("sval-over-rows"),
    "at the bottom, the heading shades the tiles above"
  );
  EventUtils.synthesizeKey("KEY_Escape");
  await TestUtils.waitForCondition(
    () => !switcherShown(),
    "the switcher closing"
  );
  await releaseCtrl();
});
