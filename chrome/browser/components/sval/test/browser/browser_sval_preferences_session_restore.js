/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * A Settings tab that comes back through the session store changes no
 * setting. The session store saves a page's form fields with its tab and
 * puts them back when the tab is restored, firing `input` on each, and every
 * switch in Settings writes its pref on `input`. A tab restored at launch
 * carries the fields it had when it was last saved, which can be long before.
 */

const { TabStateFlusher } = ChromeUtils.importESModule(
  "resource:///modules/sessionstore/TabStateFlusher.sys.mjs"
);

/** Sval's switch for opening links in a Quick Peek, on by default. */
const PREF = "browser.sval.quickPeek.enabled";
const URL = "about:preferences#svalLinks";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel starting");
});

/**
 * Waits until `tab` shows Settings with Sval's panes in place.
 *
 * @param {Element} tab
 */
async function settingsShown(tab) {
  await pageReady(tab.linkedBrowser, URL);
  await TestUtils.waitForCondition(
    () =>
      tab.linkedBrowser.contentDocument?.documentElement.dataset
        .svalSettings === "ready",
    "Sval's panes in Settings"
  );
}

add_task(
  async function a_restored_settings_tab_keeps_a_setting_changed_since() {
    const tab = await openPage(URL);
    await settingsShown(tab);
    const page = tab.linkedBrowser.contentWindow;
    const box = page.document.getElementById("sval-quick-peek");
    Assert.ok(box.checked, "the switch shows the setting on");

    // The user turns it off and on again. Any edit in the page has the session
    // store save every field in it that differs from its markup.
    box.scrollIntoView({ block: "center" });
    for (const on of [false, true]) {
      EventUtils.synthesizeMouseAtCenter(box, {}, page);
      await TestUtils.waitForCondition(
        () => Services.prefs.getBoolPref(PREF) === on,
        `the switch turning the setting ${on ? "on" : "off"}`
      );
    }
    await TabStateFlusher.flush(tab.linkedBrowser);
    BrowserTestUtils.removeTab(tab);

    // The user turns the setting off while the Settings tab is closed, as
    // they would from another window or another device.
    await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });

    const { state } = SessionStore.getClosedTabDataForWindow(window)[0];
    SessionStore.forgetClosedTab(window, 0);
    Assert.equal(
      state.formdata,
      undefined,
      "the closed Settings tab keeps none of its fields to put back"
    );
    await restoredShowsOff(state);
  }
);

/**
 * A Settings tab saved with its fields, as a profile holds one from before
 * they were left out, changes no setting when it comes back.
 */
add_task(async function a_settings_tab_saved_with_fields_changes_no_setting() {
  await SpecialPowers.pushPrefEnv({ set: [[PREF, false]] });
  await restoredShowsOff({
    entries: [
      {
        url: URL,
        title: "Settings",
        triggeringPrincipal_base64: E10SUtils.SERIALIZED_SYSTEMPRINCIPAL,
      },
    ],
    index: 1,
    formdata: { url: "about:preferences", id: { "sval-quick-peek": true } },
  });
});

/**
 * Restores `state` into a tab as a launch does, a tab that loads when it is
 * selected, and asserts that the setting is still off and shown off.
 *
 * @param {object} state A tab's session state.
 */
async function restoredShowsOff(state) {
  const back = BrowserTestUtils.addTab(gBrowser, null, {
    createLazyBrowser: true,
    skipLoad: true,
  });
  registerCleanupFunction(() => {
    if (back.parentNode) {
      BrowserTestUtils.removeTab(back);
    }
  });
  SessionStore.setTabState(back, state);
  await selectTab(back);
  await settingsShown(back);
  // The session store puts saved fields back as the page finishes loading
  // (`RestoreTabContentObserver`), so the tab is waited on until its restore
  // is over.
  await TestUtils.waitForCondition(
    () => !SessionStore.isTabRestoring(back),
    "the tab's restore"
  );

  Assert.equal(
    Services.prefs.getBoolPref(PREF),
    false,
    "the setting stays off"
  );
  Assert.ok(
    !back.linkedBrowser.contentDocument.getElementById("sval-quick-peek")
      .checked,
    "and the restored switch shows it off"
  );
  BrowserTestUtils.removeTab(back);
}
