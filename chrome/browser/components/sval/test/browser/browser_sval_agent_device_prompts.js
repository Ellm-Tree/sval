/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_take_control_helpers.js */

/**
 * A site the user always allowed to use the camera, or their location, gets
 * it with no prompt in the user's own tabs. In an agent's tab it asks, the
 * prompt waits for Take control, and it offers no answer to save.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_take_control_helpers.js",
  this
);

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

const CALL_PAGE = ROOT + "sval_capture_page.html";
const SITE = Services.scriptSecurityManager.createContentPrincipalFromOrigin(
  "https://example.com"
);

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
  await SpecialPowers.pushPrefEnv({
    set: [["media.navigator.streams.fake", true]],
  });
});

/**
 * Saves Always allow for `kinds` on the test site until the task ends.
 *
 * @param {string[]} kinds
 */
function alwaysAllow(kinds) {
  for (const kind of kinds) {
    SitePermissions.setForPrincipal(SITE, kind, SitePermissions.ALLOW);
  }
  atTaskEnd(() => {
    for (const kind of kinds) {
      SitePermissions.removeFromPrincipal(SITE, kind);
    }
  });
}

/**
 * An agent's tab on `url`, selected in the agent's focused window.
 *
 * @param {string} url
 * @returns {Promise<object>}
 */
async function agentTabOn(url) {
  const setup = await agentSetup({ sites: { "example.com": "full" } });
  const { tab } = await setup.call("open_tab", { url });
  const found = await setup.tabs.tabIn(setup.agent, tab);
  await showTab(setup.win, found.tab);
  await within(
    SimpleTest.promiseFocus(setup.win),
    10_000,
    "the window's focus"
  );
  Assert.ok(
    found.browser.browsingContext.svalAgentTab,
    "the tab is marked as an agent's"
  );
  return { win: setup.win, browser: found.browser };
}

/**
 * Starts the call page's request for the camera and microphone.
 *
 * @param {object} browser
 */
function startCall(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.start();
  });
}

/**
 * @param {object} browser
 * @returns {Promise<string>} The call page's state once it has an answer.
 */
function callAnswer(browser) {
  return within(
    SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.wrappedJSObject.state !== "idle",
        "the page has its answer"
      );
      return content.wrappedJSObject.state;
    }),
    10_000,
    "the call page's answer"
  );
}

/**
 * @param {object} browser
 * @returns {Promise<string>} The call page's state.
 */
function callState(browser) {
  return SpecialPowers.spawn(browser, [], () => content.wrappedJSObject.state);
}

/**
 * Asks for the position as the page, keeping the answer in the page.
 *
 * @param {object} browser
 */
function askForLocation(browser) {
  return SpecialPowers.spawn(browser, [], () => {
    const win = content.wrappedJSObject;
    win.located = "idle";
    content.navigator.geolocation.getCurrentPosition(
      () => {
        win.located = "granted";
      },
      error => {
        win.located =
          error.code === error.PERMISSION_DENIED ? "denied" : "unavailable";
      }
    );
  });
}

/**
 * @param {object} browser
 * @returns {Promise<string>} The page's answer to its location request.
 */
function locationAnswer(browser) {
  return within(
    SpecialPowers.spawn(browser, [], async () => {
      await ContentTaskUtils.waitForCondition(
        () => content.wrappedJSObject.located !== "idle",
        "the page has its location answer"
      );
      return content.wrappedJSObject.located;
    }),
    10_000,
    "the page's location answer"
  );
}

/**
 * Waits for the prompt `id` to be pending for `browser`, takes control, and
 * waits for it to show.
 *
 * @param {Window} win
 * @param {object} browser
 * @param {string} id
 * @returns {Promise<Element>} The prompt's popupnotification.
 */
async function promptOnceTaken(win, browser, id) {
  const notifications = win.PopupNotifications;
  await within(
    TestUtils.waitForCondition(
      () => notifications.getNotification(id, browser),
      "the prompt is pending"
    ),
    10_000,
    "the pending prompt"
  );
  const shown = BrowserTestUtils.waitForEvent(
    notifications.panel,
    "popupshown"
  );
  await takeControlOf(win, browser);
  await within(shown, 10_000, "the prompt showing once taken");
  const prompt = [...notifications.panel.children].find(
    n => n.notification?.id === id
  );
  Assert.ok(prompt, "the user sees the prompt once they hold the workspace");
  return prompt;
}

/**
 * Answers `prompt` with Block, and waits for it to close.
 *
 * @param {Window} win
 * @param {Element} prompt
 */
async function block(win, prompt) {
  const hidden = BrowserTestUtils.waitForEvent(
    win.PopupNotifications.panel,
    "popuphidden"
  );
  prompt.secondaryButton.click();
  await within(hidden, 10_000, "the prompt closing");
}

add_task(async function a_saved_camera_allow_asks_in_an_agent_tab() {
  alwaysAllow(["camera", "microphone"]);
  const { win, browser } = await agentTabOn(CALL_PAGE);
  await startCall(browser);
  const prompt = await promptOnceTaken(win, browser, "webRTC-shareDevices");
  Assert.equal(
    await callState(browser),
    "idle",
    "the page has no camera before the user answers"
  );
  Assert.ok(
    !prompt.querySelector(".sval-prompt-action-button"),
    "no Always allow button"
  );
  Assert.ok(
    !BrowserTestUtils.isVisible(prompt.checkbox),
    "no remember checkbox"
  );
  await block(win, prompt);
  Assert.equal(
    await callAnswer(browser),
    "NotAllowedError",
    "the page is refused"
  );
});

add_task(async function a_saved_camera_allow_grants_in_the_users_tab() {
  alwaysAllow(["camera", "microphone"]);
  await BrowserTestUtils.withNewTab(CALL_PAGE, async browser => {
    await startCall(browser);
    Assert.equal(
      await callAnswer(browser),
      "started",
      "the page has the camera"
    );
    Assert.ok(
      !PopupNotifications.getNotification("webRTC-shareDevices", browser),
      "with no prompt"
    );
    await SpecialPowers.spawn(browser, [], () =>
      content.wrappedJSObject.hangUp()
    );
  });
});

add_task(async function a_saved_location_allow_asks_in_an_agent_tab() {
  alwaysAllow(["geo"]);
  const { win, browser } = await agentTabOn(INPUT);
  await askForLocation(browser);
  const prompt = await promptOnceTaken(win, browser, "geolocation");
  Assert.ok(
    !BrowserTestUtils.isVisible(prompt.checkbox),
    "no remember checkbox"
  );
  await block(win, prompt);
  Assert.equal(await locationAnswer(browser), "denied", "the page is refused");
});

add_task(async function a_saved_location_allow_grants_in_the_users_tab() {
  alwaysAllow(["geo"]);
  // The location provider runs a repeating timer until it stops, `geo.timeout`
  // after its last answer (`nsGeolocationService::SetDisconnectTimer`), and
  // the harness fails a file that leaves one running.
  const stopped = TestUtils.topicObserved(
    "geolocation-device-events",
    (subject, data) => data === "shutdown"
  );
  atTaskEnd(() => within(stopped, 15_000, "the location provider stopping"));
  await BrowserTestUtils.withNewTab(INPUT, async browser => {
    await askForLocation(browser);
    Assert.equal(
      await locationAnswer(browser),
      "granted",
      "the page has the location"
    );
    Assert.ok(
      !PopupNotifications.getNotification("geolocation", browser),
      "with no prompt"
    );
  });
});
