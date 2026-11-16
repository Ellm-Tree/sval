/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
 * Copyright 2026 Ellm Tree, Inc. */

"use strict";

/**
 * A tab copied from another is a node of its own. The session store copies a
 * tab's custom values, its node id among them, wherever it copies the tab, so
 * a copy arrives carrying its original's id; sharing it, the copy would be
 * closed with its original. Each task copies a tab one of the ways Firefox
 * does, closes the original, and checks the copy stays as its own node, in
 * the window's own document through its own observer.
 */

const { SvalTabs } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalTabs.sys.mjs"
);
const { childrenByParent } = ChromeUtils.importESModule(
  "moz-src:///browser/components/sval/SvalPanelModel.sys.mjs"
);

/* import-globals-from ../../sval-panel.js */

/**
 * A workspace of this task's in the window's own document, shown in the
 * window by its own switch, with the window's own observer filing into it.
 *
 * @returns {Promise<object>} `{ engine, workspace, observer }`.
 */
async function fixture() {
  await within(SvalPanel.started, 40_000, "the panel's startup");
  const { engine } = SvalPanel;
  const workspace = await engine.mutate({
    kind: "addWorkspace",
    name: "Work",
    id: crypto.randomUUID(),
    now: Date.now(),
  });
  expectWorkspaceTabs();
  Assert.ok(
    await within(
      SvalPanel.switchTo(workspace),
      10_000,
      "the switch to the task's workspace"
    ),
    "the window shows the task's workspace"
  );
  const { observer } = SvalPanel;
  await within(observer.settled(), 10_000, "observer settling");
  return { engine, workspace, observer };
}

/**
 * Opens `url` in a tab of `win` and waits for its load and its filing.
 *
 * @param {object} observer The observer on `win`.
 * @param {string} url
 * @param {DOMWindow} [win]
 */
async function openFiled(observer, url, win = window) {
  const tab = BrowserTestUtils.addTab(win.gBrowser, url);
  await within(
    BrowserTestUtils.browserLoaded(tab.linkedBrowser, false, url),
    10_000,
    "the tab's load"
  );
  await within(observer.settled(), 10_000, "observer settling");
  ok(taggedId(tab), "the tab is filed");
  return tab;
}

/**
 * Waits for `copy`'s state to have been restored into it, and for every
 * observer to have seen that.
 *
 * @param {object} copy A tab the session store is restoring.
 * @param {object[]} observers
 * @param {string} [event] What says the restore happened: `SSTabRestoring`
 *   for a tab left unloaded.
 */
async function restored(copy, observers, event = "SSTabRestored") {
  await within(
    BrowserTestUtils.waitForEvent(copy, event),
    10_000,
    "the copy's restore"
  );
  for (const observer of observers) {
    await within(observer.settled(), 10_000, "observer settling");
  }
}

/**
 * Closes `original` and runs the orphan sweep a redraw runs, then checks
 * `copy` is still open, as a node of its own under `parent`.
 *
 * @param {object} options
 * @param {object} options.original The tab copied.
 * @param {object} options.copy Its copy.
 * @param {object[]} options.observers Every observer in the fixture.
 * @param {object} options.engine Their engine.
 * @param {string} options.parent Where the copy should be filed.
 */
async function closeOriginal({ original, copy, observers, engine, parent }) {
  const id = taggedId(original);
  Assert.notEqual(taggedId(copy), id, "the copy carries an id of its own");
  BrowserTestUtils.removeTab(original);
  for (const observer of observers) {
    await within(observer.settled(), 10_000, "observer settling");
  }
  const after = await nodes(engine);
  ok(!(id in after), "closing the original deleted its node");
  for (const observer of observers) {
    Assert.deepEqual(
      observer.closeOrphanTabs(after),
      [],
      "the orphan sweep closes nothing"
    );
  }
  ok(copy.documentGlobal.gBrowser.tabs.includes(copy), "the copy is open");
  const copyId = taggedId(copy);
  ok(copyId in after, "and is a node of the document");
  Assert.equal(
    after[copyId].placement.parent,
    parent,
    "filed beside where its original was"
  );
}

/** Duplicate, a copying drag in the strip, and Duplicate Tabs. */
add_task(async function a_duplicate_outlives_its_original() {
  const { engine, workspace, observer } = await fixture();
  const original = await openFiled(observer, "https://example.com/original");
  const later = await openFiled(observer, "https://example.com/later");

  const copy = gBrowser.duplicateTab(original, true, {
    tabIndex: original._tPos + 1,
  });
  await restored(copy, [observer]);

  const ours = [taggedId(original), taggedId(copy), taggedId(later)];
  const order = childrenByParent(await nodes(engine))
    .get(workspace)
    .filter(id => ours.includes(id));
  Assert.deepEqual(order, ours, "the copy is filed right after its original");

  await closeOriginal({
    original,
    copy,
    observers: [observer],
    engine,
    parent: workspace,
  });
});

/**
 * A duplicate into another window: a copying drag onto it, or Back and
 * Forward middle-clicked into a new one. That window shows a workspace of
 * its own (spec §10.7), and the copy is filed there.
 */
add_task(async function a_duplicate_in_another_window_outlives_its_original() {
  const { engine, observer } = await fixture();
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a new window opening"
  );
  expectWorkspaceTabs(other);
  await within(other.SvalPanel.started, 20_000, "the other window's startup");
  const otherObserver = other.SvalPanel.observer;
  await within(otherObserver.settled(), 10_000, "otherObserver settling");
  const elsewhere = other.SvalPanel.workspaceId;
  Assert.ok(elsewhere, "the other window shows a workspace");
  const original = await openFiled(observer, "https://example.com/original");

  const copy = SessionStore.duplicateTab(other, original);
  await restored(copy, [observer, otherObserver]);

  await closeOriginal({
    original,
    copy,
    observers: [observer, otherObserver],
    engine,
    parent: elsewhere,
  });
});

/**
 * A copy closed while its filing is still on the observer's queue takes only
 * its own node with it, never its original's.
 *
 * The copy is closed on the turn its own id lands (`#claimCopy`), checked
 * once a turn, before the add of its node can come back from the engine's
 * worker, which takes a turn of its own.
 */
add_task(async function closing_a_fresh_copy_keeps_its_originals_node() {
  const { engine, observer } = await fixture();
  const original = await openFiled(observer, "https://example.com/original");
  const id = taggedId(original);
  const copy = gBrowser.duplicateTab(original, true);
  await within(
    (async () => {
      while (!taggedId(copy)) {
        await new Promise(resolve => Services.tm.dispatchToMainThread(resolve));
      }
    })(),
    10_000,
    "the copy's state landing"
  );
  // The session store says as the copied values land, and the copy is
  // tagged again before anything else runs (`#claimCopy`).
  Assert.notEqual(taggedId(copy), id, "the copy carries an id of its own");
  Assert.notEqual(
    SvalTabs.nodeIdOf(copy),
    id,
    "and never stands for its original's"
  );
  Assert.equal(observer.tabFor(id), original, "the node's tab is the original");
  BrowserTestUtils.removeTab(copy);
  await within(observer.settled(), 10_000, "observer settling");
  const after = await nodes(engine);
  ok(id in after, "the original keeps its node");
  Assert.deepEqual(observer.closeOrphanTabs(after), [], "and its tab");
});

/**
 * Another tab's state set onto a tab already filed, as `setTabState` does.
 * The tab keeps the node it had.
 */
add_task(async function a_tab_given_another_tabs_state_keeps_its_node() {
  const { engine, workspace, observer } = await fixture();
  const original = await openFiled(observer, "https://example.com/original");
  const copy = await openFiled(observer, "https://example.com/copy");
  const own = taggedId(copy);

  const restoring = restored(copy, [observer], "SSTabRestoring");
  SessionStore.setTabState(copy, SessionStore.getTabState(original));
  await restoring;
  Assert.equal(taggedId(copy), own, "the tab keeps its own node");

  await closeOriginal({
    original,
    copy,
    observers: [observer],
    engine,
    parent: workspace,
  });
});

/**
 * Undo Close Tab brings a closed tab back under its own id, and a duplicate
 * made of it before it closed is still a node of its own.
 */
add_task(async function a_reopened_tab_and_its_duplicate_are_two_nodes() {
  const { engine, workspace, observer } = await fixture();
  const original = await openFiled(observer, "https://example.com/original");
  const id = taggedId(original);
  const copy = gBrowser.duplicateTab(original, true);
  await restored(copy, [observer]);

  await closeOriginal({
    original,
    copy,
    observers: [observer],
    engine,
    parent: workspace,
  });

  const reopened = SessionStore.undoCloseTab(window, 0);
  await within(
    BrowserTestUtils.waitForEvent(reopened, "SSTabRestored"),
    10_000,
    "the reopened tab's restore"
  );
  await within(observer.settled(), 10_000, "observer settling");
  Assert.equal(taggedId(reopened), id, "the reopened tab has its id back");
  const after = await nodes(engine);
  ok(id in after, "and its node");
  ok(taggedId(copy) in after, "the duplicate keeps its own node");
  Assert.notEqual(taggedId(copy), id, "under an id of its own");
});

/**
 * A pass of lookups (`withTabLookups`) answers what each read alone answers:
 * a copy not yet given a node of its own stands for none, in this window or
 * another, and a tab carried to another window during the pass is found
 * there and no longer here.
 */
add_task(async function a_pass_of_lookups_answers_as_each_read_alone() {
  const { observer } = await fixture();
  const other = await within(
    BrowserTestUtils.openNewBrowserWindow(),
    15_000,
    "a new window opening"
  );
  expectWorkspaceTabs(other);
  await within(other.SvalPanel.started, 20_000, "the other window's startup");
  await within(
    other.SvalPanel.observer.settled(),
    10_000,
    "the other window's observer settling"
  );
  const original = await openFiled(observer, "https://example.com/original");
  const second = await openFiled(observer, "https://example.com/second");
  const copy = await openFiled(observer, "https://example.com/copy");
  const carried = await openFiled(observer, "https://example.com/carried");
  await observer.unfile(copy);
  const id = taggedId(original);
  const secondId = taggedId(second);
  const carriedId = taggedId(carried);
  const alone = crypto.randomUUID();
  const elsewhereCopy = BrowserTestUtils.addTab(other.gBrowser, "about:blank");
  const elsewhereAlone = BrowserTestUtils.addTab(other.gBrowser, "about:blank");

  // Tagged as the session store tags a copy it makes.
  SessionStore.setCustomTabValue(copy, SvalTabs.NODE_ID_KEY, id);
  SessionStore.setCustomTabValue(elsewhereCopy, SvalTabs.NODE_ID_KEY, secondId);
  SessionStore.setCustomTabValue(elsewhereAlone, SvalTabs.NODE_ID_KEY, alone);
  const tabs = [original, second, copy, elsewhereCopy, elsewhereAlone];
  const expected = [id, secondId, null, null, alone];
  Assert.deepEqual(
    tabs.map(tab => SvalTabs.nodeIdOf(tab)),
    expected,
    "each tab stands for its node, and each copy for none"
  );
  observer.withTabLookups(() => {
    Assert.deepEqual(
      tabs.map(tab => observer.nodeIdFor(tab)),
      expected,
      "and the pass answers the same"
    );
    Assert.equal(observer.tabFor(id), original, "the original holds its node");
    Assert.equal(observer.tabFor(alone), null, "a tab elsewhere is not here");

    Assert.equal(observer.tabFor(carriedId), carried, "a tab holds its node");
    const moved = other.gBrowser.adoptTab(carried);
    Assert.equal(
      observer.tabFor(carriedId),
      null,
      "and leaves the pass when carried to another window"
    );
    Assert.equal(
      observer.nodeIdFor(moved),
      carriedId,
      "where it stands for its node"
    );
  });

  await within(
    BrowserTestUtils.closeWindow(other),
    10_000,
    "the other window closing"
  );
});
