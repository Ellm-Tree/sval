/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/* import-globals-from ../../sval-panel.js */
/* import-globals-from head.js */
/* import-globals-from sval_switcher_helpers.js */

/**
 * Work the user has not saved survives a hidden workspace's idle unload
 * (spec §10.7). A tab the unload releases comes back from its node's address
 * alone, so a page the user typed into, or one that says it holds unsaved
 * work, stays loaded while its workspace is hidden, with no dialog, and the
 * user comes back to it as they left it. Every other page is unloaded.
 */

Services.scriptloader.loadSubScript(
  getRootDirectory(gTestPath) + "sval_switcher_helpers.js",
  this
);

const FORM = `<textarea></textarea>`;

// A rich editor that keeps its text where no form field is, and asks to stay
// while it holds any, as a web mail or document editor does.
const EDITOR =
  `<div contenteditable>x</div><script>` +
  `addEventListener("beforeunload", event => {` +
  `if (document.querySelector("div").textContent.length > 1) {` +
  `event.preventDefault(); }});</script>`;

// A page that asks to stay whatever it holds, as many do.
const NEEDLESS =
  `<script>addEventListener("beforeunload", event => {` +
  `event.preventDefault(); });</script>`;

add_task(async function text_typed_into_a_form_survives_a_switch() {
  const { ids, observer } = await withSwitcherTabs({ body: FORM });
  const [first, second] = ids.workspaces;

  const tab = observer.tabFor(ids.tabs[0]);
  await typeInto(tab, "textarea", "half a reply");
  await markPage(tab);

  Assert.ok(await SvalPanel.switchTo(second), "the window switched away");
  await releaseHiddenNow(observer);
  Assert.ok(
    gBrowser.tabs.includes(tab) && tab.linkedPanel,
    "and the page with the reply in it is still loaded"
  );
  Assert.equal(dialogsOver(tab), 0, "with no dialog");
  Assert.notEqual(gBrowser.selectedTab, tab, "out of sight");

  Assert.ok(await SvalPanel.switchTo(first), "and switched back");
  Assert.equal(gBrowser.selectedTab, tab, "the user is back on that page");
  Assert.deepEqual(
    await pageState(tab, "textarea"),
    { text: "half a reply", marked: true },
    "the same document, with the reply as they left it"
  );
});

add_task(async function a_rich_editor_holding_unsaved_text_survives_a_switch() {
  const { ids, observer } = await withSwitcherTabs({ body: EDITOR });
  const [first, second] = ids.workspaces;

  const tab = observer.tabFor(ids.tabs[0]);
  await typeInto(tab, "div", "a draft");
  await markPage(tab);

  Assert.ok(await SvalPanel.switchTo(second), "the window switched away");
  await releaseHiddenNow(observer);
  Assert.ok(
    gBrowser.tabs.includes(tab) && tab.linkedPanel,
    "and the editor is still loaded"
  );
  Assert.equal(dialogsOver(tab), 0, "with no dialog");

  Assert.ok(await SvalPanel.switchTo(first), "and switched back");
  Assert.equal(gBrowser.selectedTab, tab, "the user is back in the editor");
  const { text, marked } = await pageState(tab, "div");
  Assert.ok(text.includes("a draft"), "with the draft in it");
  Assert.ok(marked, "in the same document");

  // The editor asks before it is closed while it holds a draft, which is
  // right, and would stop this file's teardown at that prompt.
  await SpecialPowers.spawn(tab.linkedBrowser, [], () => {
    content.document.querySelector("div").textContent = "x";
  });
});

add_task(async function an_untouched_page_asking_to_stay_is_unloaded() {
  const { ids, observer } = await withSwitcherTabs({ body: NEEDLESS });
  const [, second] = ids.workspaces;

  const tab = observer.tabFor(ids.tabs[0]);
  await untilRestored(tab);
  Assert.ok(
    tab.linkedBrowser.hasBeforeUnload,
    "the page holds a beforeunload handler"
  );

  Assert.ok(await SvalPanel.switchTo(second), "the window switched away");
  await releaseHiddenNow(observer);
  Assert.ok(
    !gBrowser.tabs.includes(tab),
    "and the page left the window: nobody worked in it, so it holds " +
      "nothing to lose"
  );
  Assert.ok(
    observer.tabFor(ids.tabs[1]),
    "the other workspace's tab is the one in the window"
  );
});

add_task(async function a_kept_page_is_unloaded_once_the_user_leaves_it() {
  const { ids, observer } = await withSwitcherTabs({ body: FORM });
  const [first, second] = ids.workspaces;

  const tab = observer.tabFor(ids.tabs[0]);
  await typeInto(tab, "textarea", "sent");
  Assert.ok(await SvalPanel.switchTo(second), "the window switched away");
  await releaseHiddenNow(observer);
  Assert.ok(gBrowser.tabs.includes(tab), "keeping the page typed into");
  Assert.ok(await SvalPanel.switchTo(first), "and switched back");

  // The user goes on from the page they typed into.
  const after = "data:text/html,%3Ctitle%3ETab%20in%201%3C/title%3Edone";
  const loaded = BrowserTestUtils.browserLoaded(
    tab.linkedBrowser,
    false,
    after
  );
  BrowserTestUtils.startLoadingURIString(tab.linkedBrowser, after);
  await within(loaded, 10_000, "the next page loading");

  Assert.ok(await SvalPanel.switchTo(second), "the window switched away");
  await releaseHiddenNow(observer);
  Assert.ok(
    !gBrowser.tabs.includes(tab),
    "and the page left the window, as any page does"
  );
});
