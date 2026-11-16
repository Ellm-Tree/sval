/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * The camera and microphone prompt answers with Block, Always allow or
 * Allow, each a button of its own, and Always allow saves the grant for the
 * site.
 */

const CALL_PAGE = ROOT + "sval_capture_page.html";

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["media.navigator.streams.fake", true]],
  });
});

/**
 * Starts the page's call and waits for the camera prompt.
 *
 * @param {Element} browser
 * @returns {Promise<Element>} The prompt's popupnotification.
 */
async function askForCall(browser) {
  const shown = BrowserTestUtils.waitForEvent(
    PopupNotifications.panel,
    "popupshown"
  );
  await SpecialPowers.spawn(browser, [], () => {
    content.wrappedJSObject.start();
  });
  await within(shown, 10_000, "the camera prompt");
  const prompt = PopupNotifications.panel.firstElementChild;
  Assert.equal(
    prompt.notification.id,
    "webRTC-shareDevices",
    "the prompt asks for the devices"
  );
  return prompt;
}

function callState(browser) {
  return SpecialPowers.spawn(browser, [], async () => {
    await ContentTaskUtils.waitForCondition(
      () => content.wrappedJSObject.state !== "idle",
      "the page has its answer"
    );
    return content.wrappedJSObject.state;
  });
}

add_task(async function always_allow_is_its_own_button() {
  await BrowserTestUtils.withNewTab(CALL_PAGE, async browser => {
    const principal = browser.contentPrincipal;
    registerCleanupFunction(() => {
      for (const kind of ["camera", "microphone"]) {
        SitePermissions.removeFromPrincipal(principal, kind);
      }
    });
    const prompt = await askForCall(browser);
    const always = prompt.querySelector(".sval-prompt-action-button");
    Assert.ok(always, "an Always allow button");
    Assert.ok(
      BrowserTestUtils.isVisible(prompt.secondaryButton),
      "beside Block"
    );
    Assert.ok(BrowserTestUtils.isVisible(prompt.button), "and Allow");
    Assert.ok(
      !BrowserTestUtils.isVisible(prompt.checkbox),
      "with no remember checkbox"
    );

    const hidden = BrowserTestUtils.waitForEvent(
      PopupNotifications.panel,
      "popuphidden"
    );
    always.click();
    await within(hidden, 5_000, "the prompt closing");
    Assert.equal(await callState(browser), "started", "the page has both");
    for (const kind of ["camera", "microphone"]) {
      const { state, scope } = SitePermissions.getForPrincipal(principal, kind);
      Assert.equal(state, SitePermissions.ALLOW, `${kind} allowed`);
      Assert.equal(scope, SitePermissions.SCOPE_PERSISTENT, "for good");
    }
    await SpecialPowers.spawn(browser, [], () =>
      content.wrappedJSObject.hangUp()
    );
  });
});

add_task(async function allow_grants_this_time_only() {
  await BrowserTestUtils.withNewTab(CALL_PAGE, async browser => {
    const principal = browser.contentPrincipal;
    // The earlier task saved an Allow, which would answer with no prompt.
    for (const kind of ["camera", "microphone"]) {
      SitePermissions.removeFromPrincipal(principal, kind);
    }
    registerCleanupFunction(() => {
      for (const kind of ["camera", "microphone"]) {
        SitePermissions.removeFromPrincipal(principal, kind);
      }
    });
    const prompt = await askForCall(browser);
    const hidden = BrowserTestUtils.waitForEvent(
      PopupNotifications.panel,
      "popuphidden"
    );
    prompt.button.click();
    await within(hidden, 5_000, "the prompt closing");
    Assert.equal(await callState(browser), "started", "the page has both");
    Assert.notEqual(
      SitePermissions.getForPrincipal(principal, "camera").state,
      SitePermissions.ALLOW,
      "nothing saved as always allowed"
    );
    await SpecialPowers.spawn(browser, [], () =>
      content.wrappedJSObject.hangUp()
    );
  });
});
