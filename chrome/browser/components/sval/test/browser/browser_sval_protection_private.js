/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * Fingerprinting choices and private windows: a choice made in a normal
 * window is written to the granular overrides, which a private window does
 * not read, while Mozilla's webcompat fixes reach both. A private window's
 * own choice applies there alone.
 */

const { SvalSiteProtections, SITE_BRANCH, GRANULAR_PREFS } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSiteProtections.sys.mjs"
  );
const { compatFixApplies } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalProtectionButton.sys.mjs"
);
const { SITE_EXCEPTIONS } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalFingerprinting.sys.mjs"
);
const { RemoteSettings } = ChromeUtils.importESModule(
  "resource://services-settings/remote-settings.sys.mjs"
);

const PB_SITE = "example.com";
const PB_PAGE = "https://example.com/";
const PB_OTHER = "example.org";
const PB_OTHER_PAGE = "https://example.org/";
const PB_CANVAS = SITE_EXCEPTIONS.find(e => e.id === "canvas").tokens.join(",");

/**
 * Loads a page in a window's tab and reads the canvas as the page does.
 *
 * @param {Window} win
 * @param {string} url
 * @returns {Promise<number>} How many channels carry noise.
 */
async function noiseIn(win, url) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(win.gBrowser, url),
    20000,
    "the page loads"
  );
  try {
    return await asPage(tab.linkedBrowser, canvasProbe);
  } finally {
    BrowserTestUtils.removeTab(tab);
  }
}

/**
 * Sets Mozilla's webcompat entries as Remote Settings delivers them, and
 * waits for nsRFPService to hold them.
 *
 * @param {object[]} entries
 */
async function setRemote(entries) {
  const client = RemoteSettings("fingerprinting-protection-overrides");
  const set = TestUtils.topicObserved("fpp-test:set-overrides-finishes");
  await client.db.clear();
  await client.db.importChanges({}, Date.now(), entries);
  await client.emit("sync", { data: { current: entries } });
  await within(set, 10000, "the remote entries reach nsRFPService");
}

function reset() {
  clearPrefBranches(SITE_BRANCH);
  for (const name of GRANULAR_PREFS) {
    Services.prefs.clearUserPref(name);
  }
  Services.perms.removeAll();
}

add_setup(async function () {
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.fingerprintingProtection.remoteOverrides.testing", true]],
  });
  // Mozilla's fixes are off by default (decision 1685).
  const set = TestUtils.topicObserved("fpp-test:set-overrides-finishes");
  await SpecialPowers.pushPrefEnv({
    set: [["privacy.fingerprintingProtection.remoteOverrides.enabled", true]],
  });
  await within(set, 10000, "Mozilla's fixes reach nsRFPService");
  registerCleanupFunction(async () => {
    reset();
    await setRemote([]);
  });
});

add_task(async function a_normal_windows_choices_stay_out_of_private() {
  reset();
  SvalSiteProtections.setProtections(PB_SITE, "fingerprinting");
  SvalSiteProtections.setExceptions(PB_OTHER, ["canvas"]);
  Assert.equal(await noiseIn(window, PB_PAGE), 0, "the normal window is real");
  Assert.equal(
    await noiseIn(window, PB_OTHER_PAGE),
    0,
    "and so is the exception"
  );
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20000,
    "a private window opens"
  );
  try {
    Assert.greater(
      await noiseIn(win, PB_PAGE),
      0,
      "fingerprinting protection off stays out of the private window"
    );
    Assert.greater(
      await noiseIn(win, PB_OTHER_PAGE),
      0,
      "and so does a fingerprinting exception"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      20000,
      "the private window closes"
    );
    reset();
  }
});

add_task(async function mozillas_fix_reaches_a_private_window() {
  reset();
  await setRemote([
    { id: "sval-568", firstPartyDomain: PB_OTHER, overrides: PB_CANVAS },
  ]);
  // Sval's own entry for the site takes the fix's key in a normal window.
  SvalSiteProtections.setProtections(PB_OTHER, "fingerprinting");
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20000,
    "a private window opens"
  );
  try {
    Assert.equal(
      await noiseIn(win, PB_OTHER_PAGE),
      0,
      "the fix applies in the private window"
    );
    Assert.greater(await noiseIn(win, PB_PAGE), 0, "and only to its site");
    Assert.ok(
      compatFixApplies(PB_OTHER, true),
      "the private panel says the fix applies"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      20000,
      "the private window closes"
    );
    reset();
    await setRemote([]);
  }
});

add_task(async function a_private_choice_applies_there_alone() {
  reset();
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    20000,
    "a private window opens"
  );
  try {
    SvalSiteProtections.setProtections(
      PB_SITE,
      "off",
      win.gBrowser.defaultUserContextId
    );
    Assert.equal(
      await noiseIn(win, PB_PAGE),
      0,
      "protections off reaches the private window"
    );
    Assert.greater(
      await noiseIn(window, PB_PAGE),
      0,
      "and not the normal window"
    );
    Assert.deepEqual(
      Services.prefs.getChildList(SITE_BRANCH),
      [],
      "nothing synced"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      20000,
      "the private window closes"
    );
    reset();
  }
});
