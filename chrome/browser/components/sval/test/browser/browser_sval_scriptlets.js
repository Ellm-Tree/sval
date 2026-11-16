/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */
/* import-globals-from sval_blocking_helpers.js */

// The scriptlet library (protections spec §5.3): uBlock Origin's scriptlets
// load only when every fetched file matches the pin, and then a `##+js(...)`
// rule runs one before the page's first script; a rule naming a scriptlet the
// library lacks is skipped and leaves the page and the other rules alone; the
// stored copy serves the build that stored it as it is, and another build
// checks it against the pin first; private windows get the same.
// The uBlock Origin files here are stand-ins written for the test, laid out
// as uBlock Origin lays out its modules.

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_blocking_helpers.js",
  this
);

const { SvalBlocking } = ChromeUtils.importESModule(
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

const TEST_LIST = [
  "! Title: Test scriptlets",
  "example.net##+js(sval-no-such-scriptlet)",
  "example.net##+js(sval-probe, svalUboProbe)",
  "",
].join("\n");

const UBO_FILES = {
  "src/js/resources/base.js": [
    "export const registeredScriptlets = [];",
    "export const registerScriptlet = (fn, details) => {",
    "    details.fn = fn;",
    "    fn.details = details;",
    "    details.dependencies = (details.dependencies ?? []).map(dep =>",
    "        typeof dep === 'function' ? dep.details.name : dep);",
    "    registeredScriptlets.push(details);",
    "};",
    "",
  ].join("\n"),
  "src/js/resources/flag.js": [
    "import { registerScriptlet } from './base.js';",
    "export function setFlagFn(name) {",
    "    window[name] = true;",
    "}",
    "registerScriptlet(setFlagFn, { name: 'set-flag.fn' });",
    "",
  ].join("\n"),
  "src/js/resources/scriptlets.js": [
    "import {",
    "    registerScriptlet,",
    "    registeredScriptlets as all,",
    "} from './base.js';",
    "import { setFlagFn } from './flag.js';",
    "export const builtinScriptlets = all;",
    "function svalProbe(name = '') {",
    "    setFlagFn(name);",
    "}",
    "registerScriptlet(svalProbe, {",
    "    name: 'sval-probe.js',",
    "    dependencies: [ setFlagFn ],",
    "});",
    "",
  ].join("\n"),
};

async function ranBeforePage(browser) {
  return SpecialPowers.spawn(
    browser,
    [],
    () => content.wrappedJSObject.uboBeforePage
  );
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
  });
  await serveLists({ "sval-easylist": TEST_LIST });
  await serveUboFiles(UBO_FILES);
  registerCleanupFunction(async () => {
    SvalBlocking.setLevel("off");
    await restartLibrary();
    await IOUtils.remove(SvalBlockingLists.dir, {
      recursive: true,
      ignoreAbsent: true,
    });
  });

  await restartLibrary();
  SvalBlocking.setLevel("off");
  SvalBlocking.setListEnabled("sval-easylist", true);
  SvalBlocking.flush();
  await SvalBlockingLists.update("sval-easylist");
  await listsInForce();
});

add_task(async function no_scriptlet_runs_without_a_fetch() {
  ok(!SvalScriptlets.hasUbo, "no uBlock Origin scriptlets without a fetch");
  await BrowserTestUtils.withNewTab(SCRIPTLETS_PAGE, async browser => {
    is(
      await ranBeforePage(browser),
      false,
      "the page loads and no scriptlet ran"
    );
  });
});

add_task(async function a_ubo_file_that_does_not_match_is_refused() {
  await restartLibrary();
  SvalScriptlets.pin = await testPin(UBO_FILES, "src/js/resources/flag.js");
  ok(!(await SvalScriptlets.update()), "the fetch is refused");
  ok(!SvalScriptlets.hasUbo, "no uBlock Origin scriptlet is in the library");
  ok(
    !(await IOUtils.exists(
      PathUtils.join(SvalBlockingLists.dir, "ubo-scriptlets.json")
    )),
    "nothing is stored"
  );
  await BrowserTestUtils.withNewTab(SCRIPTLETS_PAGE, async browser => {
    is(
      await ranBeforePage(browser),
      false,
      "uBlock Origin's scriptlet does not run"
    );
  });
});

add_task(async function a_pinned_ubo_scriptlet_loads() {
  await restartLibrary();
  const pin = await testPin(UBO_FILES);
  SvalScriptlets.pin = pin;
  ok(await SvalScriptlets.update(), "the fetch matches the pin");
  await BrowserTestUtils.withNewTab(SCRIPTLETS_PAGE, async browser => {
    is(
      await ranBeforePage(browser),
      true,
      "the scriptlet ran before the page's first script, past the unknown one"
    );
  });

  // A start of the same build uses the stored copy as it is.
  SvalScriptlets.resetForTesting();
  SvalScriptlets.pin = pin;
  await SvalScriptlets.reload();
  ok(SvalScriptlets.hasUbo, "the stored copy is used");
  await BrowserTestUtils.withNewTab(SCRIPTLETS_PAGE, async browser => {
    is(await ranBeforePage(browser), true, "and its scriptlet runs");
  });

  // Another build checks the stored files against the pin, and converts
  // them itself.
  const path = PathUtils.join(SvalBlockingLists.dir, "ubo-scriptlets.json");
  const stored = await IOUtils.readJSON(path);
  const fromAnotherBuild = () =>
    IOUtils.writeJSON(path, { ...stored, build: "another", resources: [] });
  await fromAnotherBuild();
  SvalScriptlets.pin = await testPin(UBO_FILES, "src/js/resources/base.js");
  await SvalScriptlets.reload();
  ok(!SvalScriptlets.hasUbo, "another build's copy that does not match is not");
  await fromAnotherBuild();
  SvalScriptlets.pin = pin;
  await SvalScriptlets.reload();
  ok(SvalScriptlets.hasUbo, "another build's copy that matches is used");
  Assert.deepEqual(
    (await IOUtils.readJSON(path)).resources,
    stored.resources,
    "and stored as this build converts it"
  );
  SvalScriptlets.pin = { ...pin, commit: "another-commit" };
  await SvalScriptlets.reload();
  ok(!SvalScriptlets.hasUbo, "a copy of another pin is not used");
  SvalScriptlets.pin = pin;
  await SvalScriptlets.reload();
});

add_task(async function private_windows_behave_the_same() {
  ok(SvalScriptlets.hasUbo, "uBlock Origin's scriptlets are in the library");
  const win = await within(
    BrowserTestUtils.openNewBrowserWindow({ private: true }),
    15_000,
    "a new private window opening"
  );
  try {
    const tab = await within(
      BrowserTestUtils.openNewForegroundTab(win.gBrowser, SCRIPTLETS_PAGE),
      15_000,
      "the new tab opening and loading"
    );
    is(
      await ranBeforePage(tab.linkedBrowser),
      true,
      "the scriptlet ran before the page's first script"
    );
  } finally {
    await within(
      BrowserTestUtils.closeWindow(win),
      10_000,
      "the test window closing"
    );
  }
});
