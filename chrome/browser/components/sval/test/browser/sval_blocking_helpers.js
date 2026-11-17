/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from head.js */

/**
 * What the blocking test files share: the prefs that let Gecko's content
 * classifier block in a test, waits for the engine to rebuild, uBlock Origin
 * stand-in files and their pin, and a fresh scriptlet library. Each file
 * loads this with `loadSubScript` into its own scope.
 */

/* exported CONTENT_BLOCKING_TEST_PREFS, LISTS_LOADED, UBO_BASE, READY_URL, TRUSTED_PROBE_FILES, untilEachLoad, REQUEST_PAGE, testPin, restartLibrary, syncedSettings, serveLists, listAddress, downloads, serveUboFiles, requestLoads, untilBlocked, untilLoads, listsInForce */

/** What lets the content classifier block a test page's requests. */
const CONTENT_BLOCKING_TEST_PREFS = [
  ["privacy.trackingprotection.content.testing", true],
  ["privacy.trackingprotection.content.protection.enabled", true],
  [
    "privacy.trackingprotection.urlclassifier.disable_for_channel_classifier",
    true,
  ],
];

/** Notified with the features whose lists the classifier has installed. */
const LISTS_LOADED = "test-content-classifier-filter-lists-loaded";

/** The test publisher of every list and uBlock Origin file a test serves. */
const LIST_SERVER =
  "https://example.com/browser/browser/components/sval/test/browser/sval_blocking_list.sjs";

/** Where the stand-in uBlock Origin files are served from. */
const UBO_BASE = `${LIST_SERVER}?ubo/`;

/**
 * A page on a harness host that every list `serveLists` serves blocks, and
 * that no test loads for itself.
 */
const READY_URL =
  "https://sub2.test2.example.com/browser/browser/components/sval/test/browser/sval_agent_page.html";

/** The page the waits below make their requests from. */
const REQUEST_PAGE =
  "https://example.net/browser/browser/components/sval/test/browser/sval_agent_page.html";

const LIST_URL_BRANCH = "browser.sval.adblock.list.";

/** uBlock Origin's resource files, with one scriptlet that needs trust. */
const TRUSTED_PROBE_FILES = {
  "src/js/resources/base.js": [
    "export const registeredScriptlets = [];",
    "export const registerScriptlet = (fn, details) => {",
    "    details.fn = fn;",
    "    fn.details = details;",
    "    details.dependencies = details.dependencies ?? [];",
    "    registeredScriptlets.push(details);",
    "};",
    "",
  ].join("\n"),
  "src/js/resources/scriptlets.js": [
    "import {",
    "    registerScriptlet,",
    "    registeredScriptlets as all,",
    "} from './base.js';",
    "export const builtinScriptlets = all;",
    "function trustedSvalProbe(name = '') {",
    "    window[name] = true;",
    "}",
    "registerScriptlet(trustedSvalProbe, {",
    "    name: 'trusted-sval-probe.js',",
    "    requiresTrust: true,",
    "});",
    "function trustedSvalUnmarked(name = '') {",
    "    window[name] = true;",
    "}",
    "registerScriptlet(trustedSvalUnmarked, {",
    "    name: 'trusted-sval-unmarked.js',",
    "});",
    "",
  ].join("\n"),
};

/**
 * @param {string} id A curated list's id.
 * @param {string} body What the test publisher serves for it.
 * @returns {string} The address the test publisher serves `body` from, as
 *   list `id`, with `READY_URL`'s host blocked after it.
 */
function listAddress(id, body) {
  const text = `${body}\n||${new URL(READY_URL).host}^\n`;
  return `${LIST_SERVER}?list=${encodeURIComponent(id)}&body=${encodeURIComponent(text)}`;
}

/**
 * Points every curated list's address and Privacy Badger's groups at the test
 * publisher until the file ends, so that no download reaches a real one. A
 * list in `bodies` is served its text, and every other a list with no rule of
 * its own.
 *
 * @param {object} [bodies] List id to text.
 */
async function serveLists(bodies = {}) {
  const set = Services.prefs.getChildList(LIST_URL_BRANCH).map(pref => {
    const id = pref.slice(LIST_URL_BRANCH.length, -".url".length);
    return [pref, listAddress(id, bodies[id] ?? "! Title: Nothing")];
  });
  set.push([
    "browser.sval.adblock.source.firstParties",
    `${LIST_SERVER}?list=first-parties&body=`,
  ]);
  await SpecialPowers.pushPrefEnv({ set });
}

/**
 * @param {string} id A list id.
 * @returns {Promise<number>} How many times the test publisher has served it.
 */
async function downloads(id) {
  const response = await fetch(
    `${LIST_SERVER}?count=${encodeURIComponent(id)}`
  );
  return Number(await response.text());
}

/**
 * Has the test publisher serve `files` under `UBO_BASE` at any commit.
 *
 * @param {object} files Path to text.
 */
async function serveUboFiles(files) {
  await fetch(`${LIST_SERVER}?ubo-files`, {
    method: "POST",
    body: JSON.stringify(files),
  });
}

/**
 * @param {Browser} browser
 * @param {string} url
 * @returns {Promise<boolean>} Whether a request the page makes for `url`
 *   loads.
 */
function requestLoads(browser, url) {
  return SpecialPowers.spawn(browser, [url], async target => {
    try {
      await content.fetch(`${target}?${Math.random()}`, { mode: "no-cors" });
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Resolves once a request the page in `browser` makes for `url` loads as
 * `wanted` says: the engines answer a change on a later rebuild, and a
 * request is the user's view of it.
 *
 * @param {Browser} browser
 * @param {string} url
 * @param {boolean} wanted
 * @param {string} what
 * @returns {Promise<void>}
 */
function untilRequest(browser, url, wanted, what) {
  return within(
    TestUtils.waitForCondition(
      async () => (await requestLoads(browser, url)) == wanted,
      what,
      100,
      300
    ),
    30_000,
    what
  );
}

/**
 * @param {Browser} browser
 * @param {string} url
 * @param {string} what
 * @returns {Promise<void>} once a request for `url` is blocked.
 */
function untilBlocked(browser, url, what) {
  return untilRequest(browser, url, false, what);
}

/**
 * @param {Browser} browser
 * @param {string} url
 * @param {string} what
 * @returns {Promise<void>} once a request for `url` loads.
 */
function untilLoads(browser, url, what) {
  return untilRequest(browser, url, true, what);
}

/**
 * Resolves once the engines block what every served list blocks, which a
 * served list in force does.
 *
 * @returns {Promise<void>}
 */
async function listsInForce() {
  await BrowserTestUtils.withNewTab(REQUEST_PAGE, browser =>
    untilBlocked(browser, READY_URL, "the served lists in force")
  );
}

/**
 * Resolves once a fresh load of `url` gives what `check` reads of it as
 * `wanted`. Page rules apply as a page loads, so each try loads it anew.
 *
 * @param {string} url
 * @param {Function} check Takes the browser showing the page.
 * @param {*} wanted Compared as JSON.
 * @param {string} what
 * @returns {Promise<void>}
 */
function untilEachLoad(url, check, wanted, what) {
  return within(
    TestUtils.waitForCondition(
      async () =>
        JSON.stringify(await BrowserTestUtils.withNewTab(url, check)) ==
        JSON.stringify(wanted),
      what,
      200,
      140
    ),
    30_000,
    what
  );
}
/**
 * The pin for `files` at the test commit.
 *
 * @param {object} files Path to text.
 * @param {string|null} [wrong] A path whose hash is made not to match.
 * @returns {Promise<object>}
 */
async function testPin(files, wrong = null) {
  const hashes = {};
  for (const [path, text] of Object.entries(files)) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(path == wrong ? text + "\n" : text)
    );
    hashes[path] = new Uint8Array(digest).toHex();
  }
  return { base: UBO_BASE, commit: "test-commit", files: hashes };
}

/** Starts the scriptlet library afresh, with nothing cached. */
async function restartLibrary() {
  const { SvalScriptlets } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalScriptlets.sys.mjs"
  );
  const { SvalBlockingLists } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalBlockingLists.sys.mjs"
  );
  SvalScriptlets.resetForTesting();
  await IOUtils.remove(
    PathUtils.join(SvalBlockingLists.dir, "ubo-scriptlets.json"),
    { ignoreAbsent: true }
  );
  await SvalScriptlets.start();
}

/**
 * Another device that shares a folder with a device on this profile's prefs,
 * which runs settings sync on an engine of its own, so a value arrives as
 * another device's does: written to the settings document there, carried by
 * both passes, and applied here in settings sync's own time. The other device
 * writes as settings sync writes a change (`setSetting`), which carries any
 * JSON value, as a device on another build can.
 *
 * @param {object} options
 * @param {string[]} [options.keys] The prefs it syncs.
 * @param {string[]} [options.branches] The pref branches it syncs.
 * @returns {Promise<Function>} writes `{ name: value }` on the other device,
 *   a null value clearing it, and resolves once this device has applied it.
 */
async function syncedSettings({ keys = [], branches = [] }) {
  const { SvalEngine } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
  );
  const { SvalSettingsSync } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsSync.sys.mjs"
  );
  const { SvalLocalSettings } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalLocalSettings.sys.mjs"
  );
  const { SETTINGS_DOCUMENT } = ChromeUtils.importESModule(
    "moz-src:///browser/components/sval/SvalSettingsRegistry.sys.mjs"
  ).SvalSettingsRegistry;
  const folder = await makeTempDir("sval-synced-settings");
  const keyBytes = crypto.getRandomValues(new Uint8Array(32));
  // Both devices' profiles are the folder they share, so a profile pass is
  // the pass that merges what they share, with no shared folder helper.
  const engineIn = () => {
    const engine = new SvalEngine({
      root: folder,
      sharedRoot: folder,
      keyBytes,
      deviceId: crypto.getRandomValues(new Uint8Array(16)),
    });
    registerCleanupFunction(() => stopEngine(engine));
    return engine;
  };
  const pass = engine =>
    within(engine.sync("synced-settings"), 10_000, "a settings sync pass");

  const here = engineIn();
  const sync = await SvalSettingsSync.made(here, {
    settings: await SvalLocalSettings.open(tempPath("sval-synced", ".json")),
    keys,
    branches,
    requestPass: () => {},
  });
  registerCleanupFunction(() => sync.stop());
  await sync.start();
  const settle = async () => {
    for (let i = 0; i < 2; i++) {
      await new Promise(resolve => executeSoon(resolve));
      await within(sync.whenIdle(), 10_000, "settings sync going idle");
    }
  };
  await pass(here);
  await settle();

  const there = engineIn();
  await there.addDocument(SETTINGS_DOCUMENT);
  await pass(there);
  return async synced => {
    await there.mutate({
      kind: "batch",
      document: SETTINGS_DOCUMENT,
      ops: Object.entries(synced).map(([key, value]) => ({
        kind: "setSetting",
        key,
        valueJson: value === null ? null : JSON.stringify(value),
      })),
    });
    await pass(there);
    await pass(here);
    await settle();
  };
}
