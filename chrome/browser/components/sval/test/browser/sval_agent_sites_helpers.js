/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * What the agent site-policy test files share: the modules they drive, the
 * pages they load, and watching an agent window's loads and tabs. Each file
 * loads this with `loadSubScript` into its own scope.
 */

/* exported ask, SvalAgents, SvalEngine, SvalTabs, tabsIn, moveIntoTarget,
            fullWindowShowing, stopsIn, refused,
            clickIn, documentURL, goOn */

const { ask } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentAlerts.sys.mjs"
);
const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);
const { SvalEngine } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalEngine.sys.mjs"
);
const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { tabsIn } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentSession.sys.mjs"
);
const { moveIntoTarget } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);
const { fullWindowShowing } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentTabs.sys.mjs"
);

/**
 * Records every top-level load that stops in `win`'s tabs, with its status.
 *
 * @param {Window} win
 * @returns {Array<{browser: object, url: string, status: number}>}
 */
function stopsIn(win) {
  const stops = [];
  const listener = {
    onStateChange(browser, webProgress, request, flags, status) {
      if (
        webProgress.isTopLevel &&
        flags & Ci.nsIWebProgressListener.STATE_STOP &&
        flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW
      ) {
        let url = "";
        try {
          url = request.QueryInterface(Ci.nsIChannel).originalURI.spec;
        } catch {}
        stops.push({ browser, url, status });
      }
    },
  };
  win.gBrowser.addTabsProgressListener(listener);
  atTaskEnd(() => {
    if (!win.closed) {
      win.gBrowser.removeTabsProgressListener(listener);
    }
  });
  return stops;
}

/**
 * Waits until a load of `url` (by prefix) stops in `browser` with a failure.
 *
 * @param {Array} stops From {@link stopsIn}.
 * @param {object} browser
 * @param {string} url
 */
async function refused(stops, browser, url) {
  await TestUtils.waitForCondition(
    () =>
      stops.some(
        s => s.browser === browser && s.url.startsWith(url) && s.status !== 0
      ),
    `the load of ${url} stopped with an error`
  );
}

/**
 * Waits for `browser` to show about:agentblocked, the page a load the agent
 * gate refused shows at the refused address, and resolves with its text.
 *
 * @param {object} browser
 * @param {"blockedByUser"|"tabNotFiled"} [reason] The page's `e`.
 * @returns {Promise<string>}
 */
async function blockedPage(browser, reason = "blockedByUser") {
  let page;
  await TestUtils.waitForCondition(() => {
    const windowGlobal = browser.browsingContext.currentWindowGlobal;
    page = windowGlobal?.documentURI?.spec;
    return (
      !!windowGlobal?.failedChannel &&
      !!page?.startsWith(`about:agentblocked?e=${reason}&`)
    );
  }, "the tab shows about:agentblocked");
  // An error page's document stays at "interactive" in a web content
  // process, as about:neterror's does, so the page is waited on for the
  // reason its script marks once it has written the text.
  return within(
    SpecialPowers.spawn(browser, [page, reason], async (href, why) => {
      await ContentTaskUtils.waitForCondition(
        () =>
          content.document.documentURI === href &&
          content.document.body?.dataset.reason === why,
        "the page's text"
      );
      return content.document.body.innerText;
    }),
    10_000,
    "about:agentblocked's text"
  );
}

/**
 * Clicks `selector` in `browser` as a person would.
 *
 * @param {object} browser
 * @param {string} selector
 */
async function clickIn(browser, selector) {
  await BrowserTestUtils.synthesizeMouseAtCenter(selector, {}, browser);
}

/**
 * Has the links page finish what its last click set going: the load a
 * button holds back until the test is watching for it.
 *
 * @param {object} browser A tab showing `sval_agent_links.html`.
 */
function goOn(browser) {
  return SpecialPowers.spawn(browser, [], () => content.postMessage("go", "*"));
}

/**
 * @param {object} browser
 * @returns {Promise<string>} What `browser`'s document says its URL is.
 */
function documentURL(browser) {
  return SpecialPowers.spawn(browser, [], () => content.document.URL);
}
