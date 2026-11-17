/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */
/* import-globals-from sval_blocking_helpers.js */

// uBlock Origin's trusted scriptlets run only from lists trusted with them:
// Sval's copies of uBlock Origin's own lists, and a list the user added once
// they trust it through the confirmation on this device. Another device's
// trust waits for that confirmation. The Use trusted scriptlets switch off
// trusts none. Private windows get the same. The uBlock Origin files are
// stand-ins written for the test (`TRUSTED_PROBE_FILES`).

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalBlocking, CUSTOM_LIST_BRANCH, USER_LIST_BRANCH } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
  );
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { SvalScriptlets } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalScriptlets.sys.mjs"
);

const SCRIPTLETS_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_scriptlets.html";
const BUILTIN = "sval-ublock-filters";
const listFor = flag =>
  `! Title: Trusted test\nexample.net##+js(trusted-sval-probe, ${flag})\n` +
  `example.net##+js(trusted-sval-unmarked, ${flag}Unmarked)\n`;

/**
 * A page only the added list blocks, so a page tells when that list is in
 * force.
 */
const USER_MARK =
  "https://www.example.org/browser/browser/components/sval/test/browser/sval_agent_page.html";
const USER_URL = listAddress(
  "added",
  `${listFor("svalUserProbe")}||www.example.org^`
);

/**
 * @param {Element} browser
 * @returns {Promise<object>} which lists' trusted scriptlet ran on the page.
 */
async function ran(browser) {
  return SpecialPowers.spawn(browser, [], () => ({
    builtin: content.wrappedJSObject.svalBuiltinProbe === true,
    user: content.wrappedJSObject.svalUserProbe === true,
  }));
}

async function ranInNewTab() {
  return BrowserTestUtils.withNewTab(SCRIPTLETS_PAGE, ran);
}

/**
 * Loads the page in a new private window's own tab. A second tab would leave
 * that first one on about:privatebrowsing, and closing the window would wait
 * for its last session-store flush from its own process, which can take
 * over 30 seconds.
 *
 * @returns {Promise<object>} what `ran` says.
 */
async function ranInPrivateWindow() {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
  try {
    const browser = win.gBrowser.selectedBrowser;
    await within(
      BrowserTestUtils.loadURIString({ browser, uriString: SCRIPTLETS_PAGE }),
      15_000,
      "the scriptlets page loading in a private window"
    );
    return await ran(browser);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
}

/**
 * Opens settings at Privacy and protection.
 *
 * @returns {Promise<object>} the page and `byId`.
 */
async function openBlocking() {
  return openPane(
    "privacy",
    ({ byId }) => byId("sval-blocking")?.checkVisibility(),
    "the blocking card is showing"
  );
}

let userId;

add_setup(async function () {
  // The level, and the prefs Sval and Firefox derive from it, as this file
  // found them.
  keepPrefs(
    "browser.sval.adblock.",
    "privacy.trackingprotection.",
    "privacy.query_stripping.",
    "browser.contentblocking.category"
  );
  await SpecialPowers.pushPrefEnv({
    set: [...CONTENT_BLOCKING_TEST_PREFS],
    clear: [
      ["browser.sval.adblock.customFrom"],
      ["browser.sval.adblock.trustedScriptlets"],
    ],
  });
  clearPrefBranches(CUSTOM_LIST_BRANCH, USER_LIST_BRANCH);
  await serveLists({ [BUILTIN]: listFor("svalBuiltinProbe") });
  await serveUboFiles(TRUSTED_PROBE_FILES);
  // The harness reaches every host through its HTTPS proxy on 127.0.0.1:4443,
  // which a list the user added may not download from. Gecko's override
  // gives that address the space a public server's has.
  await SpecialPowers.pushPrefEnv({
    set: [["network.lna.address_space.public.override", "127.0.0.1:4443"]],
  });
  registerCleanupFunction(async () => {
    SvalBlocking.setLevel("off");
    await restartLibrary();
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });

  await restartLibrary();
  SvalScriptlets.pin = await testPin(TRUSTED_PROBE_FILES);
  ok(await SvalScriptlets.update(), "the stand-in scriptlets load");

  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled(BUILTIN, true);
  ({ id: userId } = SvalBlocking.addList(USER_URL, "other"));
  SvalBlocking.flush();
  ok(await SvalBlockingLists.update(BUILTIN), "uBlock Origin's list downloads");
  ok(await SvalBlockingLists.update(userId), "the added list downloads");
  await BrowserTestUtils.withNewTab(SCRIPTLETS_PAGE, browser =>
    untilBlocked(browser, USER_MARK, "the added list in force")
  );
});

add_task(async function only_ublock_origins_own_list_is_trusted() {
  Assert.deepEqual(
    await ranInNewTab(),
    { builtin: true, user: false },
    "uBlock Origin's list runs a trusted scriptlet and the added list cannot"
  );
});

add_task(async function a_trusted_name_needs_trust_without_the_mark() {
  // uBlock Origin registers `trusted-prevent-xhr` without `requiresTrust`,
  // as the stand-in `trusted-sval-unmarked` is.
  await BrowserTestUtils.withNewTab(SCRIPTLETS_PAGE, async browser => {
    Assert.deepEqual(
      await SpecialPowers.spawn(browser, [], () => ({
        builtin: content.wrappedJSObject.svalBuiltinProbeUnmarked === true,
        user: content.wrappedJSObject.svalUserProbeUnmarked === true,
      })),
      { builtin: true, user: false },
      "only uBlock Origin's list runs a scriptlet named trusted"
    );
  });
});

add_task(async function trust_from_another_device_waits_for_this_one() {
  const apply = await syncedSettings({ branches: [USER_LIST_BRANCH] });
  const key = USER_LIST_BRANCH + userId;
  const entry = JSON.parse(Services.prefs.getStringPref(key));
  const heard = TestUtils.topicObserved("sval-blocking-changed");
  await apply({ [key]: JSON.stringify({ ...entry, trusted: true }) });
  await within(heard, 5000, "blocking hearing the synced list");
  Assert.deepEqual(
    await ranInNewTab(),
    { builtin: true, user: false },
    "a list trusted on another device runs no trusted scriptlet here"
  );

  const ui = await openBlocking();
  const trustSwitch = ui
    .byId("sval-blocking-lists")
    .querySelector(`[data-sval-trust="${userId}"]`);
  ok(!trustSwitch.checked, "its switch says it is not trusted here");
  const row = trustSwitch.closest(".sval-blocking-row");
  ok(
    row.querySelector('[data-note="trusted-elsewhere"]'),
    "and the list says another device trusts it"
  );
  BrowserTestUtils.removeTab(ui.tab);
});

add_task(async function trusting_an_added_list_confirms_first() {
  const ui = await openBlocking();
  const dialog = ui.byId("sval-blocking-dialog");
  const trustSwitch = () =>
    ui
      .byId("sval-blocking-lists")
      .querySelector(`[data-sval-trust="${userId}"]`);
  ok(!trustSwitch().checked, "an added list starts untrusted");

  trustSwitch().click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens");
  is(dialog.dataset.confirm, "trust", "it says what the publisher could do");
  ok(!trustSwitch().checked, "the switch waits for the answer");
  await closeDialog(
    dialog,
    () => ui.byId("sval-blocking-dialog-cancel").click(),
    "Cancel closes it"
  );
  ok(
    !SvalBlocking.catalog().find(list => list.id == userId).trusted,
    "and leaves the list untrusted"
  );

  trustSwitch().click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens again");
  ui.byId("sval-blocking-dialog-confirm").click();
  ok(
    SvalBlocking.catalog().find(list => list.id == userId).trusted,
    "confirming trusts the list"
  );
  await TestUtils.waitForCondition(
    () => trustSwitch()?.checked,
    "and its switch shows it"
  );
  BrowserTestUtils.removeTab(ui.tab);
  await untilEachLoad(
    SCRIPTLETS_PAGE,
    ran,
    { builtin: true, user: true },
    "the trusted list runs a trusted scriptlet"
  );
});

add_task(async function private_windows_behave_the_same() {
  Assert.deepEqual(
    await ranInPrivateWindow(),
    { builtin: true, user: true },
    "both trusted lists run their scriptlet"
  );
});

add_task(async function trust_withdrawn_anywhere_is_asked_again_here() {
  const apply = await syncedSettings({ branches: [USER_LIST_BRANCH] });
  const key = USER_LIST_BRANCH + userId;
  const entry = JSON.parse(Services.prefs.getStringPref(key));
  const untrusted = { ...entry };
  delete untrusted.trusted;

  await apply({ [key]: JSON.stringify(untrusted) });
  await untilEachLoad(
    SCRIPTLETS_PAGE,
    ran,
    { builtin: true, user: false },
    "trust withdrawn on another device stops it here"
  );
  const heard = TestUtils.topicObserved("sval-blocking-changed");
  await apply({ [key]: JSON.stringify(entry) });
  await within(heard, 5000, "blocking hearing the list trusted again");
  Assert.deepEqual(
    await ranInNewTab(),
    { builtin: true, user: false },
    "trust another device withdrew and gave again waits for this device"
  );

  await apply({ [key]: null });
  await apply({ [key]: JSON.stringify(entry) });
  ok(
    SvalBlocking.catalog().find(list => list.id == userId).trustedElsewhere,
    "and so does a list removed and added again"
  );
});

add_task(async function the_switch_off_trusts_no_list() {
  const ui = await openBlocking();
  const toggle = ui.byId("sval-trusted-scriptlets");
  ok(!toggle.checkVisibility(), "tucked away in the card's Advanced");
  ui.byId("sval-blocking-advanced").querySelector("summary").click();
  ok(toggle.checkVisibility(), "shown once Advanced opens");
  ok(toggle.checked, "on by default");
  toggle.click();
  ok(!SvalBlocking.trustedScriptlets, "turning it off sets the pref");
  BrowserTestUtils.removeTab(ui.tab);
  await untilEachLoad(
    SCRIPTLETS_PAGE,
    ran,
    { builtin: false, user: false },
    "no list runs a trusted scriptlet"
  );
  Assert.deepEqual(
    await ranInPrivateWindow(),
    { builtin: false, user: false },
    "nor in a private window"
  );
});
