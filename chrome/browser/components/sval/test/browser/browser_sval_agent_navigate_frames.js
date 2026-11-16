/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */

/**
 * An agent's navigation is the top-level document's: a frame that fails to
 * load while the page loads fails only itself, and the page around it
 * loads as usual.
 */

const { SvalAgents } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgents.sys.mjs"
);

const BROKEN = ROOT + "sval_agent_broken_frame.html";

add_setup(async function () {
  await within(SvalPanel.started, 10_000, "the panel's startup");
  SvalAgents.registerPageActorForTests();
});

/**
 * @param {object} browser
 * @returns {string|undefined} The address of the document in the page's
 *   frame.
 */
const frameDocument = browser =>
  browser.browsingContext.children[0]?.currentWindowGlobal?.documentURI?.spec;

add_task(async function a_frame_that_fails_leaves_the_navigation_alone() {
  const { call, tabs, agent } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await within(
    call("open_tab", { url: PAGE }),
    10_000,
    "open_tab"
  );
  const { browser } = await tabs.tabIn(agent, tab);

  // Whether the page was still loading when its frame's error page came.
  // The frame's document reaches the parent before its location change
  // does (`nsDocShell::CreateDocumentViewer` embeds it first), so the test
  // waits for the location change itself.
  const { webProgress } = browser;
  let errorPage;
  const loadingAtError = new Promise(resolve => {
    errorPage = {
      onLocationChange(progress, request, location, flags) {
        if (
          !progress.isTopLevel &&
          flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE
        ) {
          resolve(webProgress.isLoadingDocument);
        }
      },
      QueryInterface: ChromeUtils.generateQI([
        "nsIWebProgressListener",
        "nsISupportsWeakReference",
      ]),
    };
  });
  webProgress.addProgressListener(errorPage, Ci.nsIWebProgress.NOTIFY_LOCATION);
  atTaskEnd(() => webProgress.removeProgressListener(errorPage));

  const going = call("navigate_tab", { tab, to: BROKEN });
  going.catch(() => {});
  Assert.strictEqual(
    await within(loadingAtError, 10_000, "the frame's error page"),
    true,
    "the frame's error page came while the page still loaded"
  );
  Assert.ok(
    frameDocument(browser)?.startsWith("about:neterror"),
    "the frame shows an error page"
  );
  const moved = await within(going, 10_000, "navigate_tab");
  Assert.equal(moved.url, BROKEN, "navigate_tab loads the page");
  Assert.equal(moved.status, 200, "with its own status");
});

/**
 * A step back through an entry a frame's own navigation added moves only
 * the frame, and ends when the frame has moved.
 */
add_task(async function a_step_back_that_moves_only_a_frame_ends() {
  const { call, tabs, agent } = await agentSetup({
    sites: { "example.com": "full" },
  });
  const { tab } = await within(
    call("open_tab", { url: PAGE }),
    10_000,
    "open_tab"
  );
  const { browser } = await tabs.tabIn(agent, tab);
  const second = PAGE2 + "?second";
  // Loaded once the page has, so the frame's next load adds an entry.
  await SpecialPowers.spawn(browser, [PAGE2], src => {
    const frame = content.document.createElement("iframe");
    const loaded = new Promise(r => (frame.onload = r));
    frame.src = src;
    content.document.body.append(frame);
    return loaded.then(() => null);
  });
  const entries = browser.browsingContext.sessionHistory.count;
  await SpecialPowers.spawn(browser, [second], src => {
    const frame = content.document.querySelector("iframe");
    const loaded = new Promise(r => (frame.onload = r));
    frame.src = src;
    return loaded.then(() => null);
  });
  Assert.equal(
    browser.browsingContext.sessionHistory.count,
    entries + 1,
    "the frame's load added an entry"
  );

  const back = call("navigate_tab", { tab, to: "back" });
  back.catch(() => {});
  const moved = await within(back, 10_000, "navigate_tab back");
  Assert.equal(moved.url, PAGE, "the page stays");
  Assert.equal(frameDocument(browser), PAGE2, "the frame is back");
});
