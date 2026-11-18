/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */
/* import-globals-from sval_blocking_helpers.js */

// My filters as they arrive from another device, through settings sync: lines
// changed on two devices are all kept, rules another device writes run no
// trusted scriptlet until the user trusts them on this device, even while the
// question is open, and a line that is too large or not plain text is
// refused.
// The uBlock Origin files are stand-ins written for the test
// (`TRUSTED_PROBE_FILES`).

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalBlocking, CUSTOM_LIST_BRANCH, MY_FILTER_BRANCH } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
  );
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { SvalScriptlets } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalScriptlets.sys.mjs"
);
const { lineKey, lines, orderBetween } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalMyFilters.sys.mjs"
);

const MY_FILTERS = "sval-my-filters";
const DIR = "https://example.net/browser/browser/components/sval/test/browser/";
const RULES_PAGE = `${DIR}sval_page_rules.html`;
const SCRIPTLETS_PAGE = `${DIR}sval_scriptlets.html`;
const AD_URL =
  "https://example.org/browser/browser/components/sval/test/browser/sval_agent_page.html";

const BLOCK = "||example.org^";
const HIDE = "example.net##.sval-test-specific";
const TRUSTED = "example.net##+js(trusted-sval-probe, svalMineProbe)";

/**
 * The setting another device writes to add `line` after the last line.
 *
 * @param {string} line
 * @returns {object} `{ pref: value }`, as `syncedSettings` applies it.
 */
function lineAdded(line) {
  const last = lines().at(-1)?.order ?? "";
  return {
    [MY_FILTER_BRANCH + lineKey(line, 0)]: JSON.stringify({
      line,
      order: orderBetween(last, null),
    }),
  };
}

/**
 * The setting another device writes to remove the first line of `line`.
 *
 * @param {string} line
 * @returns {object} As `lineAdded` returns.
 */
function lineRemoved(line) {
  return { [MY_FILTER_BRANCH + lineKey(line, 0)]: null };
}

/**
 * What the user's rules did on a page.
 *
 * @param {Element} browser Showing the page rules page.
 * @returns {Promise<{blocked: boolean, hidden: boolean}>}
 */
async function rulesOn(browser) {
  return SpecialPowers.spawn(browser, [AD_URL], async url => {
    let blocked = false;
    try {
      await content.fetch(`${url}?${Math.random()}`, { mode: "no-cors" });
    } catch {
      blocked = true;
    }
    const el = content.document.getElementById("specific");
    return { blocked, hidden: content.getComputedStyle(el).display == "none" };
  });
}

/**
 * @param {Element} browser Showing the scriptlets page.
 * @returns {Promise<boolean>} whether the trusted scriptlet ran.
 */
async function scriptletRan(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.wrappedJSObject.svalMineProbe === true
  );
}

/**
 * Resolves once a fresh load of the scriptlets page runs the trusted
 * scriptlet as `runs` says.
 *
 * @param {boolean} runs
 * @returns {Promise<void>}
 */
function untilTrustedRuns(runs) {
  return untilEachLoad(
    SCRIPTLETS_PAGE,
    scriptletRan,
    runs,
    runs ? "the trusted scriptlet runs" : "the trusted scriptlet does not run"
  );
}
/**
 * Opens settings at Privacy and protection with the blocking card's Advanced open.
 *
 * @returns {Promise<object>} the tab, the page and `byId`.
 */
async function openBlocking() {
  const ui = await openPane(
    "privacy",
    ({ byId }) => byId("sval-blocking")?.checkVisibility(),
    "the blocking card is showing"
  );
  ui.byId("sval-blocking-advanced").open = true;
  return ui;
}

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
      ["browser.sval.adblock.myFiltersTrustedHere"],
    ],
  });
  registerCleanupFunction(() => clearPrefBranches(MY_FILTER_BRANCH));
  clearPrefBranches(CUSTOM_LIST_BRANCH);
  await serveLists();
  await serveUboFiles(TRUSTED_PROBE_FILES);
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
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  ok(await SvalBlockingLists.update("sval-easylist"), "a list downloads");
  await listsInForce();
});

add_task(async function lines_changed_on_two_devices_are_all_kept() {
  SvalBlocking.setMyFilters(`${BLOCK}\n! one\n! two`);
  const apply = await syncedSettings({ branches: [MY_FILTER_BRANCH] });
  // Each device changes a different line before the next pass.
  SvalBlocking.setMyFilters(`${BLOCK}\n! one\n! two, edited here`);
  await apply({ ...lineRemoved("! one"), ...lineAdded("! three") });
  is(
    SvalBlocking.myFilters,
    `${BLOCK}\n! two, edited here\n! three`,
    "both devices' changes hold"
  );
  SvalBlocking.setMyFilters("");
});

add_task(async function rules_another_device_writes_wait_for_trust_here() {
  SvalBlocking.setMyFilters(`${BLOCK}\n${HIDE}\n${TRUSTED}\n`);
  await BrowserTestUtils.withNewTab(REQUEST_PAGE, browser =>
    untilBlocked(browser, AD_URL, "my filters in force")
  );
  SvalBlocking.setMyFiltersTrusted(true, SvalBlocking.myFilters);
  SvalBlocking.flush();
  await untilTrustedRuns(true);

  const apply = await syncedSettings({ branches: [MY_FILTER_BRANCH] });
  await apply(lineAdded("! changed elsewhere"));
  await untilTrustedRuns(false);

  const ui = await openBlocking();
  const toggle = ui.byId("sval-my-filters-trusted");
  ok(!toggle.checked, "the switch says they are not trusted here");
  is(
    ui.byId("sval-my-filters-note").dataset.changedElsewhere,
    "true",
    "and settings says why"
  );
  toggle.click();
  const dialog = ui.byId("sval-blocking-dialog");
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens");

  // Another device changes them while the question is open.
  await apply(lineAdded("! changed again"));
  ui.byId("sval-blocking-dialog-confirm").click();
  ok(dialog.open, "a yes to rules that changed since asks again");
  is(dialog.dataset.confirm, "trust-changed", "and says why");
  ok(!SvalBlocking.myFiltersTrusted, "trusting nothing yet");

  ui.byId("sval-blocking-dialog-confirm").click();
  ok(SvalBlocking.myFiltersTrusted, "the second yes trusts the rules shown");
  BrowserTestUtils.removeTab(ui.tab);
  await untilTrustedRuns(true);
});

add_task(async function bad_synced_lines_are_refused() {
  SvalBlocking.setMyFilters(HIDE);
  const apply = await syncedSettings({ branches: [MY_FILTER_BRANCH] });
  const before = SvalBlocking.myFilters;

  await apply(lineAdded("!".repeat(1024 * 1024)));
  is(SvalBlocking.myFilters, before, "an oversized line is not stored");

  await apply({ [MY_FILTER_BRANCH + lineKey(BLOCK, 0)]: 42 });
  is(SvalBlocking.myFilters, before, "nor is a value that is not text");

  await apply({ [MY_FILTER_BRANCH + lineKey(BLOCK, 0)]: "not a line" });
  is(SvalBlocking.myFilters, before, "nor is text that is not a line");

  await apply(lineAdded(`${BLOCK}\u0001`));
  is(SvalBlocking.myFilters, before, "a control character is not used");
  await untilEachLoad(
    RULES_PAGE,
    rulesOn,
    { blocked: false, hidden: true },
    "and the engine has none of it"
  );
  SvalBlocking.setMyFilters("");
});
