/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * A tab's address in the tree is the one it was opened at, then each page it
 * commits (decision 0050). A load that is refused or cancelled before its
 * page commits leaves the tab on the blank document every browser starts
 * with, and that blank page was never the user's: the node keeps its
 * address, and the next restore brings the page back.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

/**
 * Refuses every top-level load of an address containing `path` the way the
 * agent gate refuses a first load it held (`SvalAgentGate`'s
 * `holdForFiling`): suspended at `http-on-modify-request`, held until
 * `until` settles, then cancelled with `NS_ERROR_ABORT` and resumed.
 *
 * @param {string} path Part of the address to refuse.
 * @param {Function} [until] What the hold waits for.
 * @returns {{done: number, stop: Function}} how many loads were refused,
 *   and the end of the refusal.
 */
function refuseLoadsOf(path, until = () => TestUtils.waitForTick()) {
  const refused = { done: 0 };
  const observe = subject => {
    const channel = subject.QueryInterface(Ci.nsIHttpChannel);
    if (
      channel.loadInfo.externalContentPolicyType !==
        Ci.nsIContentPolicy.TYPE_DOCUMENT ||
      !channel.URI.spec.includes(path)
    ) {
      return;
    }
    channel.suspend();
    Promise.resolve(until()).then(() => {
      channel.cancel(Cr.NS_ERROR_ABORT);
      channel.resume();
      refused.done++;
    });
  };
  Services.obs.addObserver(observe, "http-on-modify-request");
  let stopped = false;
  refused.stop = () => {
    if (!stopped) {
      stopped = true;
      Services.obs.removeObserver(observe, "http-on-modify-request");
    }
  };
  registerCleanupFunction(refused.stop);
  return refused;
}

add_task(async function a_refused_first_load_keeps_the_address_it_opened_at() {
  const { observer, engine } = await withSwitcherTabs();
  const url = `${ROOT}sval_switcher_page.sjs?%3Ctitle%3ERefused%3C/title%3E`;
  const refused = refuseLoadsOf("Refused", () => observer.settled());
  const tab = BrowserTestUtils.addTab(gBrowser, url);
  await within(
    TestUtils.waitForCondition(() => refused.done > 0, "the load is refused"),
    10_000,
    "the refusal"
  );
  refused.stop();
  await TestUtils.waitForCondition(
    () => !tab.linkedBrowser.webProgress.isLoadingDocument,
    "the refused load has stopped"
  );
  Assert.equal(
    tab.linkedBrowser.currentURI.spec,
    "about:blank",
    "the tab is left on its blank page"
  );
  await within(observer.settled(), 10_000, "observer settling");
  const id = observer.nodeIdFor(tab);
  Assert.ok(id, "the tab is filed");
  Assert.equal(
    (await engine.tree()).nodes[id]?.content?.url,
    url,
    "its node holds the address it was opened at"
  );
  BrowserTestUtils.removeTab(tab);
  await within(observer.settled(), 10_000, "observer settling");
});

add_task(async function a_cancelled_restore_keeps_the_nodes_address() {
  const { ids, observer, engine } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;
  const id = ids.tabs[0];
  const before = (await engine.tree()).nodes[id].content;

  Assert.ok(await SvalPanel.switchTo(second), "the window switches away");
  // The tab it left is let go, as the idle unload does, so the switch back
  // restores it. Only its page is refused: the second workspace's tab may
  // still be loading its own.
  await releaseHiddenNow(observer);
  Assert.ok(!observer.tabFor(id), "the first workspace's tab is let go");
  const refused = refuseLoadsOf(before.url);
  Assert.ok(await SvalPanel.switchTo(first), "and back");
  const tab = observer.tabFor(id);
  Assert.equal(gBrowser.selectedTab, tab, "on the workspace's tab");
  await within(
    TestUtils.waitForCondition(() => refused.done > 0, "its load is refused"),
    10_000,
    "the refusal"
  );
  await within(observer.settled(), 10_000, "observer settling");
  Assert.deepEqual(
    (await engine.tree()).nodes[id].content,
    before,
    "the node keeps the page it is for"
  );

  // What the tab commits next is the user's again.
  refused.stop();
  const movedTitle = "Moved to";
  const next = before.url.replace("Tab%20in", encodeURIComponent(movedTitle));
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, next);
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, next),
    10_000,
    "the next page's load"
  );
  await TestUtils.waitForCondition(
    () => tab.label.startsWith(movedTitle),
    "the page's title arrives"
  );
  await within(observer.settled(), 10_000, "observer settling");
  const after = (await engine.tree()).nodes[id].content;
  Assert.equal(after.url, next, "the node follows the page it committed");
  Assert.equal(after.name, tab.label, "and takes its title");
});
