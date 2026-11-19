/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

const { onContextGone, onTabGone } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentTabLife.sys.mjs"
);
const { isUserInControl, takeControl } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalAgentControl.sys.mjs"
);

/**
 * @param {boolean} chrome Whether the browser is a chrome one.
 * @returns {{browser: object, context: BrowsingContext}} A browser with no
 *   window, and its top context.
 */
function windowless(chrome) {
  const browser = Services.appShell.createWindowlessBrowser(chrome);
  return { browser, context: browser.browsingContext };
}

/**
 * @returns {{tabs: number[], contexts: number[], stop: Function}} What was
 *   heard to be gone from here on.
 */
function listening() {
  const heard = { tabs: [], contexts: [] };
  const stops = [
    onTabGone(id => heard.tabs.push(id)),
    onContextGone(id => heard.contexts.push(id)),
  ];
  heard.stop = () => stops.forEach(stop => stop());
  return heard;
}

add_task(function a_discarded_top_content_context_is_a_tab_gone() {
  const { browser, context } = windowless(false);
  const { id, browserId } = context;
  Assert.ok(browserId, "the content has a browser id");
  const heard = listening();
  browser.close();
  Assert.ok(heard.tabs.includes(browserId), "the tab is gone");
  Assert.ok(heard.contexts.includes(id), "its context is gone");
  heard.stop();
});

/** A frame's context ends without its tab ending. */
add_task(function a_discarded_frame_is_a_context_gone_alone() {
  const { browser, context } = windowless(false);
  const doc = browser.document;
  const frame = doc.documentElement.appendChild(doc.createElement("iframe"));
  const frameId = frame.browsingContext.id;
  const heard = listening();
  frame.remove();
  Assert.ok(heard.contexts.includes(frameId), "the frame's context is gone");
  Assert.ok(!heard.tabs.includes(context.browserId), "its tab is not");
  heard.stop();
  browser.close();
});

add_task(function a_chrome_context_is_no_tab() {
  const { browser, context } = windowless(true);
  const { id, browserId } = context;
  const heard = listening();
  browser.close();
  Assert.ok(heard.contexts.includes(id), "the context is gone");
  Assert.ok(!heard.tabs.includes(browserId), "no tab went with it");
  heard.stop();
});

add_task(function a_stopped_listener_hears_no_more() {
  const { browser } = windowless(false);
  const heard = listening();
  heard.stop();
  browser.close();
  Assert.deepEqual(heard.tabs, []);
  Assert.deepEqual(heard.contexts, []);
});

/** One listener's fault costs the others nothing. */
add_task(function a_throwing_listener_stops_no_other() {
  const stop = onTabGone(() => {
    throw new Error("a fault");
  });
  const { browser, context } = windowless(false);
  const { browserId } = context;
  const heard = listening();
  browser.close();
  Assert.ok(heard.tabs.includes(browserId), "the later listener heard");
  heard.stop();
  stop();
});

/** A module's record of a tab ends with the tab, with no gate open. */
add_task(function a_take_ends_with_its_tab() {
  const { browser, context } = windowless(false);
  const { browserId } = context;
  takeControl(browserId);
  Assert.ok(isUserInControl(browserId), "the user took the tab");
  browser.close();
  Assert.ok(!isUserInControl(browserId), "the gone tab's take is dropped");
});
