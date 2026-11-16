/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* globals browser */

/**
 * An extension off on a site reaches nothing in a tab showing that site, and
 * works as before everywhere else (`SvalExtensionSites`,
 * extension-blocked-sites.patch).
 */

const { SvalExtensionSites } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalExtensionSites.sys.mjs"
);

const ID = "blocked-sites@sval.invalid";
const REDIRECT =
  "https://example.org/browser/browser/components/sval/test/browser/sval_agent_redirect.sjs?";

const page = (host, html) =>
  `https://${host}/document-builder.sjs?html=${encodeURIComponent(html)}`;
const COM = page("example.com", "<p>com</p>");
const ORG = page("example.org", "<p>org</p>");
const COM_FRAMING_ORG = page(
  "example.com",
  `<iframe src="${page("example.org", "<p>framed org</p>")}"></iframe>`
);
const ORG_FRAMING_COM = page(
  "example.org",
  `<iframe src="${page("example.com", "<p>framed com</p>")}"></iframe>`
);

/**
 * Loads an extension whose content script marks every document it runs in,
 * in every frame, at `document_end`.
 *
 * @param {object} [options]
 * @param {number} [options.manifestVersion]
 * @param {string[]} [options.matches] The content script's and the host
 *   permissions' patterns.
 * @param {string[]} [options.permissions]
 * @param {Function} [options.background]
 * @param {object} [options.extra] More manifest keys.
 * @param {object} [options.files] More files.
 * @returns {Promise<object>}
 */
async function loadExtension({
  manifestVersion = 2,
  matches = ["<all_urls>"],
  permissions = [],
  background,
  extra = {},
  files = {},
} = {}) {
  const hostPermissions = matches;
  const manifest = {
    manifest_version: manifestVersion,
    browser_specific_settings: { gecko: { id: ID } },
    content_scripts: [
      { matches, js: ["cs.js"], all_frames: true, run_at: "document_end" },
    ],
    ...extra,
  };
  if (manifestVersion >= 3) {
    manifest.host_permissions = hostPermissions;
    manifest.permissions = permissions;
  } else {
    manifest.permissions = [...permissions, ...hostPermissions];
  }
  const extension = ExtensionTestUtils.loadExtension({
    manifest,
    background,
    files: {
      "cs.js": () => {
        document.documentElement.setAttribute("data-sval-cs", "ran");
      },
      ...files,
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(() => extension.unload());
  return extension;
}

/**
 * Turns the extension off on `site` until the task ends.
 *
 * @param {string} site
 */
async function blockOn(site) {
  atTaskEnd(() => SvalExtensionSites.setOff(ID, site, false));
  await within(
    SvalExtensionSites.setOff(ID, site, true),
    10_000,
    "the switch reaching every process"
  );
}

/**
 * Loads a second extension, never turned off, whose content script marks
 * every document in every frame at `document_idle`.
 *
 * Every extension's content scripts are matched against a document at once,
 * when its root element is inserted (`ExtensionPolicyService::CheckDocument`).
 * A matched `document_end` script runs once `DOMContentLoaded` has fired and
 * its compile has resolved (`Script.injectInto` and `Script.inject` in
 * ExtensionContent.sys.mjs). This `document_idle` script runs only after
 * `DOMContentLoaded` (`promiseDocumentIdle`, `promiseDocumentLoaded`), so its
 * mark shows the document got that far in a process that runs content
 * scripts.
 */
async function loadControl() {
  const extension = ExtensionTestUtils.loadExtension({
    manifest: {
      browser_specific_settings: { gecko: { id: "control@sval.invalid" } },
      content_scripts: [
        {
          matches: ["<all_urls>"],
          js: ["control.js"],
          all_frames: true,
          run_at: "document_idle",
        },
      ],
      permissions: ["<all_urls>"],
    },
    files: {
      "control.js": () => {
        document.documentElement.setAttribute("data-sval-control", "ran");
      },
    },
    useAddonManager: "temporary",
  });
  await extension.startup();
  atTaskEnd(() => extension.unload());
}

/**
 * Waits for a content script to set `attribute` on `bc`'s document.
 *
 * @param {BrowsingContext} bc
 * @param {string} attribute
 */
function marked(bc, attribute) {
  return within(
    SpecialPowers.spawn(bc, [attribute], name => {
      const root = content.document.documentElement;
      if (root.hasAttribute(name)) {
        return undefined;
      }
      return new Promise(resolve => {
        new content.MutationObserver((records, observer) => {
          observer.disconnect();
          resolve();
        }).observe(root, { attributeFilter: [name] });
      });
    }),
    10_000,
    "a content script marking the document"
  );
}

/**
 * Waits for the content script under test to run in `bc`. The page's load
 * event does not wait for it: `Script.inject` awaits the script's compile
 * (`ChromeUtils.compileScript`) after `DOMContentLoaded`, and only a
 * `document_start` script blocks the parser meanwhile.
 *
 * @param {BrowsingContext} bc
 */
function ran(bc) {
  return marked(bc, "data-sval-cs");
}

/**
 * @param {BrowsingContext} bc
 * @returns {Promise<boolean>} Whether the content script under test stayed
 *   out of `bc`, read once `loadControl`'s script has run there.
 */
async function keptOut(bc) {
  await marked(bc, "data-sval-control");
  return SpecialPowers.spawn(
    bc,
    [],
    () => !content.document.documentElement.hasAttribute("data-sval-cs")
  );
}

/**
 * Opens `url` in a new tab and waits for its top-level load.
 *
 * @param {string} url
 * @returns {Promise<Element>} The tab.
 */
function openLoaded(url) {
  return within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url),
    10_000,
    "the page loading"
  );
}

add_task(async function test_content_script_blocked() {
  await loadExtension();
  await loadControl();
  await blockOn("example.com");
  const com = await openLoaded(COM);
  Assert.ok(await keptOut(com.linkedBrowser.browsingContext), "off here");
  const org = await openLoaded(ORG);
  await ran(org.linkedBrowser.browsingContext);
  Assert.ok(true, "on elsewhere");
});

add_task(async function test_frame_in_blocked_tab() {
  await loadExtension();
  await loadControl();
  await blockOn("example.com");
  const tab = await openLoaded(COM_FRAMING_ORG);
  const [frame] = tab.linkedBrowser.browsingContext.children;
  Assert.ok(await keptOut(frame), "no script in a frame of the tab");
});

add_task(async function test_frame_of_blocked_site_elsewhere_runs() {
  await loadExtension();
  await blockOn("example.com");
  const tab = await openLoaded(ORG_FRAMING_COM);
  const [frame] = tab.linkedBrowser.browsingContext.children;
  await ran(frame);
  Assert.ok(true, "the site framed elsewhere is as before");
});

add_task(async function test_broad_pattern_one_site_blocked() {
  await loadExtension({
    matches: ["*://*.example.com/*", "*://example.org/*"],
  });
  await loadControl();
  await blockOn("example.com");
  const com = await openLoaded(COM);
  Assert.ok(await keptOut(com.linkedBrowser.browsingContext), "off here");
  const org = await openLoaded(ORG);
  await ran(org.linkedBrowser.browsingContext);
  Assert.ok(true, "on elsewhere");
});

add_task(async function test_unblocked_again() {
  await loadExtension();
  await blockOn("example.com");
  await within(
    SvalExtensionSites.setOff(ID, "example.com", false),
    10_000,
    "the switch reaching every process"
  );
  const com = await openLoaded(COM);
  await ran(com.linkedBrowser.browsingContext);
  Assert.ok(true, "on again");
});

/**
 * An extension that records the URL of each request it sees, answering
 * before the request goes on, so the requests a page made are all recorded
 * by the time it has loaded.
 */
function recordingBackground() {
  const seen = [];
  browser.webRequest.onBeforeRequest.addListener(
    details => {
      seen.push(details.url);
      return {};
    },
    { urls: ["<all_urls>"] },
    ["blocking"]
  );
  browser.test.onMessage.addListener(msg => {
    if (msg === "seen") {
      browser.test.sendMessage("seen", seen.splice(0));
    }
  });
}

async function seenBy(extension) {
  extension.sendMessage("seen");
  return within(extension.awaitMessage("seen"), 10_000, "the requests seen");
}

add_task(async function test_webrequest_blocked() {
  const extension = await loadExtension({
    permissions: ["webRequest", "webRequestBlocking"],
    background: recordingBackground,
  });
  await blockOn("example.com");
  await openLoaded(COM_FRAMING_ORG);
  Assert.deepEqual(
    await seenBy(extension),
    [],
    "none of the tab's requests, its frame's included"
  );
  await openLoaded(ORG);
  Assert.ok(
    (await seenBy(extension)).includes(ORG),
    "another site's tab is seen"
  );
});

add_task(async function test_redirect_to_blocked_site() {
  const extension = await loadExtension({
    permissions: ["webRequest", "webRequestBlocking"],
    background: recordingBackground,
  });
  await blockOn("example.com");
  const tab = await openLoaded(ORG);
  await seenBy(extension);
  const loaded = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, COM);
  BrowserTestUtils.startLoadingURIString(
    tab.linkedBrowser,
    REDIRECT + encodeURIComponent(COM)
  );
  await within(loaded, 10_000, "the redirect landing");
  Assert.ok(
    !(await seenBy(extension)).includes(COM),
    "the load that lands on the blocked site is not seen there"
  );
  const toOrg = BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, ORG);
  BrowserTestUtils.startLoadingURIString(
    tab.linkedBrowser,
    REDIRECT + encodeURIComponent(ORG)
  );
  await within(toOrg, 10_000, "the other redirect landing");
  Assert.ok(
    (await seenBy(extension)).includes(ORG),
    "a redirect to another site is seen"
  );
});

add_task(async function test_filter_response_data_blocked() {
  const extension = await loadExtension({
    permissions: ["webRequest", "webRequestBlocking"],
    background() {
      let filtered = 0;
      browser.webRequest.onBeforeRequest.addListener(
        details => {
          if (details.type === "main_frame") {
            try {
              const filter = browser.webRequest.filterResponseData(
                details.requestId
              );
              filter.ondata = event => {
                filtered++;
                filter.write(event.data);
              };
              filter.onstop = () => filter.close();
            } catch (e) {}
          }
          return {};
        },
        { urls: ["<all_urls>"] },
        ["blocking"]
      );
      browser.test.onMessage.addListener(() =>
        browser.test.sendMessage("filtered", filtered)
      );
    },
  });
  await blockOn("example.com");
  await openLoaded(COM);
  extension.sendMessage("filtered?");
  Assert.equal(
    await within(extension.awaitMessage("filtered"), 10_000, "the count"),
    0,
    "no response body of the blocked tab is read"
  );
});

add_task(async function test_execute_script_blocked() {
  const extension = await loadExtension({
    matches: ["https://example.net/*"],
    permissions: ["<all_urls>", "tabs"],
    background() {
      browser.test.onMessage.addListener(async () => {
        const [tab] = await browser.tabs.query({ active: true });
        try {
          await browser.tabs.executeScript(tab.id, { code: "1" });
          browser.test.sendMessage("ran", true);
        } catch (e) {
          browser.test.sendMessage("ran", false);
        }
      });
    },
  });
  await blockOn("example.com");
  await openLoaded(COM);
  extension.sendMessage("run");
  Assert.equal(
    await within(extension.awaitMessage("ran"), 10_000, "executeScript"),
    false,
    "executeScript is refused"
  );
});

/**
 * Opens `url` in a new tab and waits for its load to stop, as it does when a
 * rule blocks it.
 *
 * @param {string} url
 * @returns {Promise<boolean>} Whether the page loaded.
 */
async function loadsIn(url) {
  const tab = await within(
    BrowserTestUtils.openNewForegroundTab(gBrowser, url, false),
    10_000,
    "a tab opening"
  );
  atTaskEnd(() => BrowserTestUtils.removeTab(tab));
  await within(
    BrowserTestUtils.browserStopped(tab.linkedBrowser, url, true),
    10_000,
    "the load stopping"
  );
  return tab.linkedBrowser.currentURI.spec === url;
}

add_task(async function test_dnr_rules_skip_blocked_tab() {
  const extension = await loadExtension({
    manifestVersion: 3,
    matches: ["https://example.net/*"],
    permissions: ["declarativeNetRequest"],
    async background() {
      await browser.declarativeNetRequest.updateSessionRules({
        addRules: [
          {
            id: 1,
            condition: {
              urlFilter: "dnr-target",
              resourceTypes: ["main_frame"],
            },
            action: { type: "block" },
          },
        ],
      });
      browser.test.sendMessage("rules");
    },
  });
  await within(extension.awaitMessage("rules"), 10_000, "the rules added");
  await blockOn("example.com");
  Assert.ok(
    await loadsIn(page("example.com", "dnr-target")),
    "its rules skip the blocked tab"
  );
  Assert.ok(
    !(await loadsIn(page("example.org", "dnr-target"))),
    "and act elsewhere"
  );
});

/**
 * An extension whose background answers "url" with the active tab's URL as
 * the tabs API gives it.
 */
function tabUrlBackground() {
  browser.test.onMessage.addListener(async () => {
    const [tab] = await browser.tabs.query({
      active: true,
      currentWindow: true,
    });
    browser.test.sendMessage("url", tab.url ?? null);
  });
}

async function tabUrlSeenBy(extension) {
  extension.sendMessage("url");
  return within(extension.awaitMessage("url"), 10_000, "the tab's URL");
}

add_task(async function test_tab_url_hidden_without_tabs_permission() {
  const extension = await loadExtension({
    matches: ["*://example.com/*", "*://example.org/*"],
    background: tabUrlBackground,
  });
  await blockOn("example.com");
  await openLoaded(COM);
  Assert.equal(await tabUrlSeenBy(extension), null, "no URL on the site");
  await openLoaded(ORG);
  Assert.equal(await tabUrlSeenBy(extension), ORG, "the URL elsewhere");
});

add_task(async function test_capture_blocked() {
  const extension = await loadExtension({
    permissions: ["tabs"],
    background() {
      browser.test.onMessage.addListener(async how => {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        try {
          if (how === "tab") {
            await browser.tabs.captureTab(tab.id);
          } else {
            await browser.tabs.captureVisibleTab();
          }
          browser.test.sendMessage("captured", true);
        } catch (e) {
          browser.test.sendMessage("captured", false);
        }
      });
    },
  });
  const captures = async how => {
    extension.sendMessage(how);
    return within(extension.awaitMessage("captured"), 10_000, "the capture");
  };
  await blockOn("example.com");
  await openLoaded(COM);
  Assert.equal(await captures("visible"), false, "no capture of the tab");
  Assert.equal(await captures("tab"), false, "by either API");
  await openLoaded(ORG);
  Assert.equal(await captures("visible"), true, "a capture elsewhere");
  Assert.equal(await captures("tab"), true, "by either API");
});

add_task(async function test_active_tab_blocked() {
  const extension = await loadExtension({
    matches: ["https://example.net/*"],
    permissions: ["activeTab"],
    extra: { browser_action: {} },
    background() {
      browser.test.onMessage.addListener(async () => {
        const [tab] = await browser.tabs.query({
          active: true,
          currentWindow: true,
        });
        try {
          await browser.tabs.executeScript(tab.id, { code: "1" });
          browser.test.sendMessage("ran", true);
        } catch (e) {
          browser.test.sendMessage("ran", false);
        }
      });
    },
  });
  await blockOn("example.com");
  const tab = await openLoaded(COM);
  // What clicking the extension's button does (`unified-extensions-item`).
  WebExtensionPolicy.getByID(ID).extension.tabManager.addActiveTabPermission(
    tab
  );
  extension.sendMessage("run");
  Assert.equal(
    await within(extension.awaitMessage("ran"), 10_000, "executeScript"),
    false,
    "a click grants nothing on the site"
  );
});
