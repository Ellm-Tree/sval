/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A live cell and the site menu's Mute mute one tab's camera or microphone
 * and unmute it with no prompt.
 */

const CALL_PAGE = ROOT + "sval_capture_page.html";

function byId(id) {
  return document.getElementById(id);
}

async function openMenu() {
  const menu = byId("sval-site-menu");
  const shown = BrowserTestUtils.waitForEvent(menu, "popupshown");
  byId("sval-site-menu-button").click();
  await within(shown, 5_000, "the site menu's popupshown");
}

async function closeMenu() {
  const menu = byId("sval-site-menu");
  if (menu.state === "closed") {
    return;
  }
  const hidden = BrowserTestUtils.waitForEvent(menu, "popuphidden");
  menu.hidePopup();
  await within(hidden, 5_000, "the site menu's popuphidden");
}

function sharing(browser) {
  const webRTC = browser._sharingState?.webRTC;
  return { camera: !!webRTC?.camera, microphone: !!webRTC?.microphone };
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [
      ["media.navigator.streams.fake", true],
      // Fake devices count as in use only with this (`DeviceListener::
      // CapturingSource`); the request still goes through `prompt`.
      ["media.navigator.permission.fake", true],
    ],
  });
});

/**
 * Starts the call page's capture on a site always allowed.
 *
 * @param {Element} browser
 */
async function startCall(browser) {
  const principal = browser.contentPrincipal;
  for (const kind of ["camera", "microphone"]) {
    SitePermissions.setForPrincipal(principal, kind, SitePermissions.ALLOW);
  }
  registerCleanupFunction(() => {
    for (const kind of ["camera", "microphone"]) {
      SitePermissions.removeFromPrincipal(principal, kind);
    }
  });
  await SpecialPowers.spawn(browser, [], async () => {
    content.wrappedJSObject.start();
    await ContentTaskUtils.waitForCondition(
      () => content.wrappedJSObject.state === "started",
      "the call started"
    );
  });
  await TestUtils.waitForCondition(
    () => sharing(browser).camera && sharing(browser).microphone,
    "the tab shares the camera and the microphone"
  );
}

function videoMuted(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.wrappedJSObject.call.getVideoTracks()[0].muted
  );
}

function cameraCell() {
  return byId("sval-live-devices").querySelector(
    '.sval-live-cell[data-kind="camera"]'
  );
}

add_task(async function a_live_cell_mutes_one_tab() {
  // One content process for the site, so both tabs share the MediaManager a
  // process-wide mute would reach.
  await SpecialPowers.pushPrefEnv({
    set: [["dom.ipc.processCount.webIsolated", 1]],
  });
  await BrowserTestUtils.withNewTab(CALL_PAGE, async browser => {
    await startCall(browser);
    const other = await within(
      BrowserTestUtils.openNewForegroundTab(gBrowser, CALL_PAGE),
      10_000,
      "the second call tab"
    );
    try {
      await startCall(other.linkedBrowser);
      Assert.equal(
        other.linkedBrowser.browsingContext.currentWindowGlobal.osPid,
        browser.browsingContext.currentWindowGlobal.osPid,
        "both tabs in one process"
      );
      await selectTab(gBrowser.getTabForBrowser(browser));

      cameraCell().click();
      await TestUtils.waitForCondition(
        () =>
          browser._sharingState?.webRTC?.camera ===
          Ci.nsIMediaManagerService.STATE_CAPTURE_DISABLED,
        "the camera reported muted"
      );
      Assert.ok(await videoMuted(browser), "the page's camera track muted");
      Assert.ok(
        !(await videoMuted(other.linkedBrowser)),
        "the other tab's camera goes on"
      );
      Assert.ok(
        cameraCell().hasAttribute("sval-muted"),
        "the camera's cell shows it muted"
      );
      Assert.strictEqual(
        SitePermissions.getForPrincipal(browser.contentPrincipal, "camera")
          .state,
        SitePermissions.ALLOW,
        "the saved permission unchanged"
      );

      await openMenu();
      try {
        const mute = byId("sval-site-mute-camera");
        Assert.equal(mute.dataset.muted, "true", "the button unmutes");
        mute.click();
        await TestUtils.waitForCondition(
          () =>
            browser._sharingState?.webRTC?.camera ===
            Ci.nsIMediaManagerService.STATE_CAPTURE_ENABLED,
          "the camera reported live"
        );
        Assert.ok(!(await videoMuted(browser)), "with no prompt");
        await TestUtils.waitForCondition(
          () => byId("sval-site-mute-camera")?.dataset.muted === "false",
          "the menu offering Mute again"
        );
      } finally {
        await closeMenu();
      }
    } finally {
      await SpecialPowers.spawn(other.linkedBrowser, [], () =>
        content.wrappedJSObject.hangUp()
      );
      BrowserTestUtils.removeTab(other);
    }
    await SpecialPowers.spawn(browser, [], () =>
      content.wrappedJSObject.hangUp()
    );
  });
});
