/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * A tab a switch keeps loaded belongs to the workspace it was left in (spec
 * §10.7). The window shows another workspace, so nothing that walks the
 * window's tabs reaches it from there, and the user finds it again, the same
 * document, when they go back.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const FORM = `<textarea></textarea>`;

// A rich editor that asks to stay while it holds a draft, so the discard
// itself refuses it.
const EDITOR =
  `<div contenteditable>x</div><script>` +
  `addEventListener("beforeunload", event => {` +
  `if (document.querySelector("div").textContent.length > 1) {` +
  `event.preventDefault(); }});</script>`;

/**
 * Every tab Ctrl+Tab can land on: the recently used tabs it lists, and each
 * tab it lands on in panel order, pressed once more than the window has tabs.
 *
 * @returns {Promise<Set<Element>>}
 */
async function tabsCtrlTabReaches() {
  const reached = new Set(window.ctrlTab.tabList);
  await SpecialPowers.pushPrefEnv({
    set: [["browser.ctrlTab.sortByRecentlyUsed", false]],
  });
  for (let i = 0; i <= gBrowser.tabs.length; i++) {
    EventUtils.synthesizeKey("KEY_Tab", { ctrlKey: true });
    reached.add(gBrowser.selectedTab);
  }
  await SpecialPowers.popPrefEnv();
  return reached;
}

/**
 * The document without its use stamps. Ctrl+Tab is the user picking a tab,
 * which stamps that tab used for the idle Archive (`markUsed`), so the stamp
 * moving is right; where every tab lives is what has to stay put.
 *
 * @param {string} json `quiet`'s result.
 * @returns {string}
 */
function withoutUse(json) {
  const nodes = JSON.parse(json);
  for (const node of Object.values(nodes)) {
    delete node.touched_at;
    delete node.touched_by;
  }
  return JSON.stringify(nodes);
}

/**
 * Switches away from `tab`'s workspace and asserts the tab stays loaded and
 * out of reach of the workspace the window then shows, then switches back and
 * asserts the user finds it, the same document, with the document unchanged
 * throughout.
 *
 * @param {object} fixture `withSwitcherTabs`'s result.
 * @param {Element} tab The first workspace's tab, marked.
 * @param {string} selector What the user typed into.
 * @param {string} typed
 */
async function assertKeptOutOfReach(fixture, tab, selector, typed) {
  const { ids, engine, observer, baseline } = fixture;
  const [first, second] = ids.workspaces;

  Assert.ok(await SvalPanel.switchTo(second), "the window switched away");
  Assert.ok(
    gBrowser.tabs.includes(tab) && tab.linkedPanel,
    "the page is still loaded"
  );
  Assert.ok(
    !gBrowser.visibleTabs.includes(tab),
    "and not among the tabs the window shows"
  );
  Assert.ok(
    gBrowser.visibleTabs.includes(observer.tabFor(ids.tabs[1])),
    "which hold the other workspace's tab"
  );
  Assert.ok(
    !(await tabsCtrlTabReaches()).has(tab),
    "Ctrl+Tab never reaches it"
  );
  Assert.equal(
    withoutUse(await quiet(engine, observer)),
    withoutUse(baseline),
    "and the document is as it was: the tab is still its workspace's"
  );

  Assert.ok(await SvalPanel.switchTo(first), "and switched back");
  Assert.equal(gBrowser.selectedTab, tab, "the user is back on that page");
  Assert.ok(gBrowser.visibleTabs.includes(tab), "among the window's tabs");
  const { text, marked } = await pageState(tab, selector);
  Assert.ok(text.includes(typed), "with what they typed");
  Assert.ok(marked, "in the same document");
  Assert.ok(SvalPanel._rowElementFor(ids.tabs[0]), "and its row is drawn");
  Assert.equal(
    withoutUse(await quiet(engine, observer)),
    withoutUse(baseline),
    "with the document as it was"
  );
}

// Pressing Ctrl+Tab records that it was used (tabbox.js). Undone when the
// file ends.
add_setup(async function ctrl_tab_leaves_no_record() {
  await SpecialPowers.pushPrefEnv({
    clear: [["browser.engagement.ctrlTab.has-used"]],
  });
});

add_task(async function a_page_typed_into_is_out_of_reach_while_away() {
  const fixture = await withSwitcherTabs({ body: FORM });
  const tab = fixture.observer.tabFor(fixture.ids.tabs[0]);
  await typeInto(tab, "textarea", "half a reply");
  await markPage(tab);
  await assertKeptOutOfReach(fixture, tab, "textarea", "half a reply");
});

add_task(async function a_page_that_refuses_to_unload_is_out_of_reach() {
  const fixture = await withSwitcherTabs({ body: EDITOR });
  const tab = fixture.observer.tabFor(fixture.ids.tabs[0]);
  await typeInto(tab, "div", "a draft");
  await markPage(tab);
  await assertKeptOutOfReach(fixture, tab, "div", "a draft");

  // The editor asks before it is closed while it holds a draft, which is
  // right, and would stop this file's teardown at that prompt.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.querySelector("div").textContent = "x";
  });
});

add_task(async function a_hung_page_does_not_hold_up_a_switch() {
  const { ids, observer } = await withSwitcherTabs();
  const [first, second] = ids.workspaces;

  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  await markPage(tab);

  // The page's process is busy for longer than any switch takes, as a page
  // stuck in a script is. The switch's request for the page's state goes to
  // that process after this message, on the same channel, so the page cannot
  // answer it until the script ends.
  const hung = SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    const until = Date.now() + 8_000;
    while (Date.now() < until) {
      // Busy, as a page stuck in a script is.
    }
    return Date.now();
  });

  Assert.ok(await SvalPanel.switchTo(second), "the window switched away");
  const switched = Date.now();
  Assert.ok(
    gBrowser.tabs.includes(tab) && tab.linkedPanel,
    "keeping the page loaded, since whether it holds work is unknown"
  );
  Assert.ok(!gBrowser.visibleTabs.includes(tab), "out of reach");
  const recovered = await within(hung, 30_000, "the page's script ending");
  Assert.less(switched, recovered, "the switch finished while the page hung");

  Assert.ok(await SvalPanel.switchTo(first), "and switched back");
  Assert.equal(gBrowser.selectedTab, tab, "the user is back on that page");
  Assert.ok(
    (await pageState(tab, "title")).marked,
    "the same document, nothing lost"
  );
});
