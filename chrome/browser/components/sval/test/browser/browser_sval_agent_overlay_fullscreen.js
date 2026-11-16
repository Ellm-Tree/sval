/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * A page in a tab an agent controls neither goes full screen nor locks the
 * pointer, though the agent's click gives it the user activation both ask
 * for. Either would put the user's pointer in the agent's page (agent-control
 * spec §6): the `<browser>` in full screen is drawn above the overlay and its
 * Take control card, and a locked pointer's events go to the page wherever
 * they fall. Once the user takes control, the page does both as in any tab,
 * and giving the tab back ends them.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

const REQUESTS = {
  fullscreen: "document.body.requestFullscreen()",
  "pointer lock": "document.body.requestPointerLock()",
};

/**
 * Makes the page's Press button ask for `kind`, as a page's own button
 * would. The page records how the request ended.
 *
 * @param {object} browser
 * @param {"fullscreen"|"pointer lock"} kind
 */
function pageAsksOnPress(browser, kind) {
  return SpecialPowers.spawn(browser, [REQUESTS[kind]], request => {
    content.wrappedJSObject.eval(`
      document.getElementById("press").onclick = () => {
        delete document.body.dataset.asked;
        ${request}.then(
          () => { document.body.dataset.asked = "granted"; },
          error => { document.body.dataset.asked = error.name; }
        );
      };
    `);
  });
}

/**
 * @param {object} browser
 * @returns {Promise<string>} How the page's last request ended, once it has.
 */
async function askedIn(browser) {
  let asked;
  await TestUtils.waitForCondition(async () => {
    asked = await SpecialPowers.spawn(
      browser,
      [],
      () => content.document.body.dataset.asked
    );
    return asked !== undefined;
  }, "the page's request ended");
  return asked;
}

/**
 * @param {object} browser
 * @returns {Promise<{fullscreen: boolean, pointerLocked: boolean}>} What the
 *   page holds.
 */
function pageHolds(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    fullscreen: !!content.document.fullscreenElement,
    pointerLocked: !!content.document.pointerLockElement,
  }));
}

/**
 * Has the agent press the page's Press button, as `click_element` does.
 *
 * @param {Function} call
 * @param {string} tab
 */
async function agentPresses(call, tab) {
  const { snapshot } = await call("get_snapshot", { tab });
  const ref = snapshot.match(/button "Press" \[(e\d+)\]/)[1];
  await call("click_element", { tab, ref });
}

/**
 * Gives the tab back with a press of the bar's Give back button itself,
 * since a page in full screen covers the bar.
 *
 * @param {object} browser
 */
function pressGiveBack(browser) {
  partsOf(browser).bar.querySelector(".sval-agent-give").click();
  Assert.ok(!isUserInControl(browser.browsingContext.browserId), "given back");
}

add_task(async function a_page_goes_full_screen_only_once_taken() {
  const { call, tab, win, browser } = await layerSetup();
  await pageAsksOnPress(browser, "fullscreen");

  await agentPresses(call, tab);
  Assert.notEqual(
    await askedIn(browser),
    "granted",
    "the page's request after the agent's click is refused"
  );
  await settle(browser);
  Assert.equal(
    win.document.fullscreenElement,
    null,
    "the window shows no page in full screen"
  );
  Assert.ok(!(await pageHolds(browser)).fullscreen, "the page is not either");

  await takeControlOf(win, browser);
  await BrowserTestUtils.synthesizeMouseAtCenter("#press", {}, browser);
  Assert.equal(await askedIn(browser), "granted", "once the user has control");
  await TestUtils.waitForCondition(
    () => win.document.fullscreenElement === browser,
    "the window shows the page in full screen"
  );
  atTaskEnd(async () => {
    if (win.document.fullscreenElement) {
      const exited = BrowserTestUtils.waitForEvent(
        win,
        "MozDOMFullscreen:Exited"
      );
      win.document.exitFullscreen();
      await within(exited, 10_000, "full screen ending");
    }
  });

  pressGiveBack(browser);
  await TestUtils.waitForCondition(
    () => !win.document.fullscreenElement,
    "full screen ends at the give-back"
  );
  await TestUtils.waitForCondition(
    async () => !(await pageHolds(browser)).fullscreen,
    "and the page leaves it"
  );
});

add_task(async function a_page_locks_the_pointer_only_once_taken() {
  const { call, tab, win, browser } = await layerSetup();
  await pageAsksOnPress(browser, "pointer lock");

  await agentPresses(call, tab);
  Assert.notEqual(
    await askedIn(browser),
    "granted",
    "the page's request after the agent's click is refused"
  );
  Assert.ok(
    !(await pageHolds(browser)).pointerLocked,
    "the pointer is not locked"
  );

  await takeControlOf(win, browser);
  await BrowserTestUtils.synthesizeMouseAtCenter("#press", {}, browser);
  Assert.equal(await askedIn(browser), "granted", "once the user has control");
  Assert.ok(
    (await pageHolds(browser)).pointerLocked,
    "the page holds the pointer"
  );

  pressGiveBack(browser);
  await TestUtils.waitForCondition(
    async () => !(await pageHolds(browser)).pointerLocked,
    "the pointer is released at the give-back"
  );
});
