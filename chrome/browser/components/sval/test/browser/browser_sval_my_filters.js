/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_preferences_helpers.js */
/* import-globals-from sval_blocking_helpers.js */

// My filters: the user's own rules, saved from the blocking card, block
// requests and hide elements, and saving again rebuilds the engine; clearing
// them rebuilds it once, without them. A trusted scriptlet in them runs only
// once the user trusts them through the confirmation, and the Use trusted
// scriptlets switch off stops it. Private windows get the same. Rules that
// arrive from another device are `browser_sval_my_filters_synced.js`'s. The
// uBlock Origin files are stand-ins written for the test
// (`TRUSTED_PROBE_FILES`).

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);
Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_preferences_helpers.js",
  this
);

const { SvalBlocking, CUSTOM_LIST_BRANCH, MY_FILTERS_PREF } =
  ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlocking.sys.mjs"
  );
const { SvalBlockingLists } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
);
const { SvalScriptlets } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalScriptlets.sys.mjs"
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
 * Resolves once a request for `AD_URL` is blocked as `blocked` says. Each
 * edit here adds or removes `BLOCK`, so this tells which rules are in force.
 *
 * @param {boolean} blocked
 * @returns {Promise<void>}
 */
async function adBlocked(blocked) {
  await BrowserTestUtils.withNewTab(RULES_PAGE, browser =>
    blocked
      ? untilBlocked(browser, AD_URL, "the saved rules in force")
      : untilLoads(browser, AD_URL, "the saved rules in force")
  );
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
 * Loads `url` in a new private window's own tab and reads it with `read`. A
 * second tab would leave that first one on about:privatebrowsing, whose
 * window waits on its process's last session-store flush to close.
 *
 * @param {string} url
 * @param {Function} read Given the browser.
 * @returns {Promise<*>} what `read` returns.
 */
async function inPrivateWindow(url, read) {
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a private window opening"
  );
  try {
    const browser = win.gBrowser.selectedBrowser;
    await within(
      BrowserTestUtils.loadURIString({ browser, uriString: url }),
      15_000,
      "the page loading in a private window"
    );
    return await read(browser);
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the private window closing"
    );
  }
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

/**
 * Types `text` into the box, as the user would.
 *
 * @param {object} ui From `openBlocking`.
 * @param {string} text
 */
function type(ui, text) {
  const box = ui.byId("sval-my-filters-text");
  box.value = text;
  box.dispatchEvent(new ui.page.Event("input"));
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
      ["browser.sval.adblock.myFilters"],
      ["browser.sval.adblock.myFiltersTrustedHere"],
    ],
  });
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

add_task(async function saved_rules_block_and_hide() {
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    Assert.deepEqual(
      await rulesOn(browser),
      { blocked: false, hidden: false },
      "the list alone blocks and hides nothing"
    );
  });

  const ui = await openBlocking();
  const save = ui.byId("sval-my-filters-save");
  ok(
    ui.byId("sval-my-filters").checkVisibility(),
    "shown in the open Advanced"
  );
  ok(save.disabled, "nothing to save yet");

  type(ui, "x".repeat(1024 * 1024 + 1));
  ok(!save.disabled, "an edit can be saved");
  save.click();
  is(
    ui.byId("sval-my-filters-status").dataset.state,
    "too-large",
    "rules past the pref store's limit are refused"
  );
  ok(!SvalBlocking.myFilters, "and nothing is stored");

  type(ui, `${BLOCK}\n${HIDE}\n`);
  save.click();
  await adBlocked(true);
  is(SvalBlocking.myFilters, `${BLOCK}\n${HIDE}\n`, "Save stores the rules");
  ok(save.disabled, "and leaves nothing to save");
  ui.byId("sval-blocking-advanced").open = false;
  ok(
    !ui.byId("sval-my-filters").checkVisibility(),
    "tucked away when Advanced closes"
  );
  BrowserTestUtils.removeTab(ui.tab);

  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    Assert.deepEqual(
      await rulesOn(browser),
      { blocked: true, hidden: true },
      "the rules block the request and hide the element"
    );
  });
});

add_task(async function saving_again_rebuilds_the_engine() {
  const ui = await openBlocking();
  type(ui, HIDE);
  ui.byId("sval-my-filters-save").click();
  await adBlocked(false);
  BrowserTestUtils.removeTab(ui.tab);

  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    Assert.deepEqual(
      await rulesOn(browser),
      { blocked: false, hidden: true },
      "the removed rule no longer blocks"
    );
  });
});

add_task(async function a_trusted_scriptlet_runs_once_trusted() {
  SvalBlocking.setMyFilters(`${BLOCK}\n${HIDE}\n${TRUSTED}\n`);
  await adBlocked(true);
  ok(
    !(await BrowserTestUtils.withNewTab(SCRIPTLETS_PAGE, scriptletRan)),
    "an untrusted rule cannot run a trusted scriptlet"
  );

  const ui = await openBlocking();
  const dialog = ui.byId("sval-blocking-dialog");
  const toggle = ui.byId("sval-my-filters-trusted");
  ok(!toggle.checked, "my filters start untrusted");
  toggle.click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens");
  is(dialog.dataset.list, MY_FILTERS, "it names my filters");
  is(dialog.dataset.confirm, "trust", "in the words trusting a list uses");
  ok(!toggle.checked, "the switch waits for the answer");
  await closeDialog(
    dialog,
    () => ui.byId("sval-blocking-dialog-cancel").click(),
    "Cancel closes it"
  );
  ok(!SvalBlocking.myFiltersTrusted, "and leaves them untrusted");

  toggle.click();
  await TestUtils.waitForCondition(() => dialog.open, "the dialog opens again");
  ui.byId("sval-blocking-dialog-confirm").click();
  ok(SvalBlocking.myFiltersTrusted, "confirming trusts them");
  await TestUtils.waitForCondition(() => toggle.checked, "the switch shows it");
  BrowserTestUtils.removeTab(ui.tab);
  await untilEachLoad(
    SCRIPTLETS_PAGE,
    scriptletRan,
    true,
    "the trusted scriptlet runs"
  );
});

add_task(async function private_windows_behave_the_same() {
  Assert.deepEqual(
    await inPrivateWindow(RULES_PAGE, rulesOn),
    { blocked: true, hidden: true },
    "the rules block and hide in a private window"
  );
  ok(
    await inPrivateWindow(SCRIPTLETS_PAGE, scriptletRan),
    "and the trusted scriptlet runs there"
  );
});

add_task(async function the_global_switch_off_stops_it() {
  SvalBlocking.setTrustedScriptlets(false);
  ok(SvalBlocking.myFiltersTrusted, "my filters keep their trust");
  await untilEachLoad(
    SCRIPTLETS_PAGE,
    scriptletRan,
    false,
    "but the trusted scriptlet does not run"
  );
  ok(
    !(await inPrivateWindow(SCRIPTLETS_PAGE, scriptletRan)),
    "nor in a private window"
  );
  await BrowserTestUtils.withNewTab(RULES_PAGE, async browser => {
    Assert.deepEqual(
      await rulesOn(browser),
      { blocked: true, hidden: true },
      "the other rules still apply"
    );
  });
});

add_task(async function clearing_them_rebuilds_the_engine_without_them() {
  SvalBlocking.setMyFilters(`${HIDE}\n! cleared next\n`);
  await adBlocked(false);

  SvalBlocking.setMyFilters("");
  await untilEachLoad(
    RULES_PAGE,
    rulesOn,
    { blocked: false, hidden: false },
    "and none of them applies"
  );
});
