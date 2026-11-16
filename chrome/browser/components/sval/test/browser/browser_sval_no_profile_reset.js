/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * Sval offers no profile reset ("Refresh"), which would carry only Firefox's
 * files into the new profile (`no-profile-reset.patch`), and none of the
 * ways to one shows.
 */

ChromeUtils.defineESModuleGetters(this, {
  ActionsProviderQuickActions:
    "moz-src:///browser/components/urlbar/ActionsProviderQuickActions.sys.mjs",
  QuickActionsLoaderDefault:
    "moz-src:///browser/components/urlbar/QuickActionsLoaderDefault.sys.mjs",
  ResetProfile: "resource://gre/modules/ResetProfile.sys.mjs",
});

const { UrlbarTestUtils } = ChromeUtils.importESModule(
  "resource://testing-common/UrlbarTestUtils.sys.mjs"
);
UrlbarTestUtils.init(this);

add_task(function a_reset_is_not_supported() {
  Assert.ok(!ResetProfile.resetSupported(), "Sval supports no reset");
});

add_task(async function about_support_has_no_refresh_button() {
  const tab = await openPage("about:support");
  const shown = await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const box = content.document.getElementById("reset-box");
    return box.checkVisibility({ checkVisibilityCSS: true });
  });
  Assert.ok(!shown, "about:support shows no Refresh button");
  BrowserTestUtils.removeTab(tab);
});

add_task(async function troubleshoot_mode_offers_no_refresh() {
  const win = Services.ww.openWindow(
    null,
    "chrome://browser/content/safeMode.xhtml",
    "_blank",
    "chrome,centerscreen,dialog",
    null
  );
  await within(
    BrowserTestUtils.waitForEvent(win, "load"),
    10_000,
    "the Troubleshoot Mode dialog loading"
  );
  const { document } = win;
  Assert.ok(
    document.getElementById("safeModeDialog").getButton("extra1").hidden,
    "the dialog has no Refresh button"
  );
  Assert.ok(
    document.getElementById("resetProfileInstead").hidden,
    "and no text offering one"
  );
  // Cancelling the dialog quits the browser (`onCancel`), so it is closed
  // without its cancel handler.
  document.removeEventListener("dialogcancel", win.onCancel);
  const closed = BrowserTestUtils.domWindowClosed(win);
  win.close();
  await within(closed, 10_000, "the Troubleshoot Mode dialog closing");
});

add_task(async function the_address_bar_offers_no_refresh() {
  await QuickActionsLoaderDefault.ensureLoaded();
  Assert.ok(
    !ActionsProviderQuickActions.getAction("refresh").isVisible(),
    "the refresh quick action does not show"
  );
  await BrowserTestUtils.withNewTab("about:blank", async () => {
    await UrlbarTestUtils.promiseAutocompleteResultPopup({
      window,
      value: "refresh firefox",
    });
    for (let i = 0; i < UrlbarTestUtils.getResultCount(window); i++) {
      const { result } = await UrlbarTestUtils.getDetailsOfResultAt(window, i);
      Assert.notEqual(
        result.payload.type,
        "intervention_refresh",
        "no result offers a refresh"
      );
    }
    await UrlbarTestUtils.promisePopupClose(window);
  });
});
